#!/usr/bin/env python3
"""
End-to-End Set-of-Mark (SoM) Grounding & Overlay Benchmark for Sticky (D:\cliky)
Target Model: Local Ollama `bonsai-2:9b` via http://127.0.0.1:11434/api/chat

Reads Rust-generated grounded screenshots + detected element JSON tables from
`D:\cliky\ss\out\`, runs 6 realistic Chrome & Blender spatial-guidance test cases
with the exact Sticky Set-of-Mark system prompt, parses `[POINT:#ID:...]`,
`[DRAW:box:#ID:...]`, `[POINT:x,y:...]`, and `[GUIDE:continue|done]` tags,
resolves `#ID` references against the JSON `elements` table, grades PASS/FAIL,
renders neon-green visual verification overlays on the clean original screenshots
(`D:\cliky\ss\out\eval_<case_id>.jpg`), and writes a full JSON report to
`D:\cliky\ss\out\eval_som_report.json`.

Self-contained: uses Python standard library + Pillow (`PIL`) only.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

# ============================================================================
# Defaults & Exact Sticky Set-of-Mark System Prompt (mirrors src-tauri/src/ai/prompts.rs)
# ============================================================================

DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_MODEL = "bonsai-2:9b"
DEFAULT_SS_DIR = Path(r"D:\cliky\ss")
DEFAULT_OUT_DIR = Path(r"D:\cliky\ss\out")
DEFAULT_TOLERANCE = 10  # strict normalized 0..1000 units (prevents neighboring menu false-passes)

STICKY_SOM_SYSTEM_PROMPT = r"""You are Sticky, a warm, friendly companion looking at the user's screen with them.
Speak naturally and concisely (1-2 warm sentences, NEVER mention tag syntax or #ID numbers aloud).

SCREENSHOT #ID PILLS:
Detected UI elements have numbered solid pills (#1, #2, #3...) matching [Detected Screen Elements]:
- Green #ID = text buttons, menus, tabs, labels
- Magenta #ID = icons and toolbar buttons (listed as "icon (...)")
- Amber #ID = native OS controls

RULES:
1. Read the user's question carefully and answer ONLY their request. Ignore any floating "Sticky Ready" pill or old "STEP" banner if present in the image.
2. Inspect BOTH the screenshot pills AND the [Detected Screen Elements] list to pick the exact #ID whose label and position match the button/icon needed for the very first click.
3. ALWAYS emit BOTH [POINT:#ID:Short Label] AND [DRAW:box:#ID:#10b981] together for that exact #ID.
4. Give ONLY ONE step at a time — never list multiple future steps. End with [GUIDE:continue] if more clicks follow, or [GUIDE:done] if finished or answering a simple question.
5. Output raw tags inline without backticks or code fences. Use [DRAW:circle:#ID:#10b981], [DRAW:arrow:#ID1->#ID2:#10b981:Label], [DRAW:line:#ID1->#ID2:#10b981], [DRAW:text:#ID:#10b981:Note], or raw 0..1000 coords ([POINT:x,y:Label], [DRAW:curve:x1,y1,cx,cy,x2,y2:#10b981], [DRAW:polygon:...]) ONLY when pointing at unlabeled empty areas.

EXAMPLES:
User: How do I save my document?
[Detected Screen Elements]: #4 "File" (24,36), #12 "Edit" (58,36), #25 "icon (top-right)" (940,36)
Assistant: Go ahead and click the File menu at the top left to open the save options. [POINT:#4:File] [DRAW:box:#4:#10b981] [GUIDE:continue]

User: Where is the settings gear button?
[Detected Screen Elements]: #7 "Home" (40,60), #14 "icon (top-right)" (955,60), #20 "Help" (910,60)
Assistant: Right here—click the gear icon in the top-right corner to open Settings! [POINT:#14:Settings] [DRAW:box:#14:#10b981] [GUIDE:done]"""

# ============================================================================
# Benchmark Test Suite Definition (6 Realistic Chrome & Blender End-to-End Cases)
# ============================================================================


@dataclass
class TargetRegion:
    name: str
    bbox_norm: Tuple[int, int, int, int]  # (x1, y1, x2, y2) in 0..1000


@dataclass
class EvalCase:
    case_id: str
    title: str
    app_name: str
    query: str
    grounded_jpeg_name: str
    original_image_name: str
    target_regions: List[TargetRegion]
    expect_guide_continue: bool = True


EVAL_CASES: List[EvalCase] = [
    EvalCase(
        case_id="chrome_1_add_shortcut",
        title="Chrome Test 1: Add Shortcut",
        app_name="New Tab - Google Chrome",
        query="How do I add a shortcut in Chrome?",
        grounded_jpeg_name="grounded_Screenshot 2026-11-22 094019.jpg",
        original_image_name="Screenshot 2026-11-22 094019.png",
        target_regions=[
            TargetRegion("Add shortcut / + icon", (455, 615, 545, 715)),
        ],
    ),
    EvalCase(
        case_id="chrome_2_extensions",
        title="Chrome Test 2: Open / Add Extensions",
        app_name="New Tab - Google Chrome",
        query="How do I open extensions or add an extension in Chrome?",
        grounded_jpeg_name="grounded_Screenshot 2026-11-22 094019.jpg",
        original_image_name="Screenshot 2026-11-22 094019.png",
        target_regions=[
            TargetRegion("Extensions puzzle icon", (878, 50, 912, 85)),
            TargetRegion("Chrome 3-dot menu", (970, 50, 999, 85)),
        ],
    ),
    EvalCase(
        case_id="chrome_3_customize",
        title="Chrome Test 3: Customize Appearance",
        app_name="New Tab - Google Chrome",
        query="How do I customize Chrome's appearance?",
        grounded_jpeg_name="grounded_Screenshot 2026-11-22 094019.jpg",
        original_image_name="Screenshot 2026-11-22 094019.png",
        target_regions=[
            TargetRegion("Customize Chrome button", (880, 895, 995, 940)),
        ],
    ),
    EvalCase(
        case_id="blender_4_add_cube",
        title="Blender Test 4: Add a Cube",
        app_name="Blender 5.3.0",
        query="How do I add a cube in Blender?",
        grounded_jpeg_name="grounded_Screenshot 2026-11-22 094025.jpg",
        original_image_name="Screenshot 2026-11-22 094025.png",
        target_regions=[
            TargetRegion("Add menu", (162, 52, 192, 78)),
            TargetRegion("Add Cube left toolbar icon", (4, 415, 35, 452)),
        ],
    ),
    EvalCase(
        case_id="blender_5_delete_cube",
        title="Blender Test 5: Delete a Cube",
        app_name="Blender 5.3.0",
        query="How do I delete a cube in Blender?",
        grounded_jpeg_name="grounded_Screenshot 2026-11-22 094025.jpg",
        original_image_name="Screenshot 2026-11-22 094025.png",
        target_regions=[
            TargetRegion("Object menu", (190, 56, 218, 73)),
            TargetRegion("Select menu", (135, 56, 161, 71)),
            TargetRegion("Scene Collection / Outliner", (850, 82, 915, 122)),
        ],
    ),
    EvalCase(
        case_id="blender_6_subdiv_modifier",
        title="Blender Test 6: Add Subdivision Modifier",
        app_name="Blender 5.3.0",
        query="How do I add a subdivision modifier to my object in Blender?",
        grounded_jpeg_name="grounded_Screenshot 2026-11-22 094025.jpg",
        original_image_name="Screenshot 2026-11-22 094025.png",
        target_regions=[
            TargetRegion("Properties panel icon strip", (822, 345, 844, 460)),
            TargetRegion("Modeling workspace tab", (208, 31, 243, 46)),
            TargetRegion("Add menu", (166, 56, 184, 70)),
        ],
    ),
]

# ============================================================================
# TagStreamParser Equivalent (mirrors src-tauri/src/ai/tag_stream.rs)
# ============================================================================

VALID_DRAW_SHAPES = {"line", "arrow", "curve", "polygon", "circle", "box", "text"}


def _parse_color_and_label_slice(tail: List[str]) -> Tuple[Optional[str], Optional[str]]:
    color: Optional[str] = None
    label: Optional[str] = None
    if tail:
        first = tail[0].strip()
        if first.startswith("#"):
            color = first
            if len(tail) >= 2:
                lbl = ":".join(tail[1:]).strip()
                if lbl:
                    label = lbl
        elif first:
            lbl = ":".join(tail).strip()
            if lbl:
                label = lbl
        elif len(tail) >= 2:
            lbl = ":".join(tail[1:]).strip()
            if lbl:
                label = lbl
    return color, label


def _parse_element_id_token(raw: str) -> Optional[int]:
    trimmed = raw.strip()
    digits = trimmed[1:].strip() if trimmed.startswith("#") else trimmed
    return int(digits) if digits.isdigit() else None


def parse_tag(content: str) -> Optional[Dict[str, Any]]:
    parts = content.split(":")
    if not parts:
        return None
    kind = parts[0].strip().upper()

    if kind == "POINT":
        # [POINT:#12:Add], [POINT: #12 : Add], [POINT:12:Add], [POINT:#12:Add:screen0], [POINT:#12]
        if len(parts) >= 2:
            target = parts[1].strip()
            if "," not in target:
                element_id = _parse_element_id_token(target)
                if element_id is not None:
                    label = parts[2].strip() if len(parts) >= 3 else ""
                    screen = parts[3].strip() if len(parts) >= 4 and parts[3].strip() else "screen0"
                    return {
                        "type": "PointRef",
                        "element_id": element_id,
                        "label": label,
                        "screen": screen,
                    }

        # [POINT:x,y:label[:screenN]]
        if len(parts) >= 3:
            coord_parts = parts[1].split(",")
            if len(coord_parts) >= 2:
                try:
                    x = int(round(float(coord_parts[0].strip())))
                    y = int(round(float(coord_parts[1].strip())))
                except ValueError:
                    return None
                label = parts[2].strip()
                screen = parts[3].strip() if len(parts) >= 4 and parts[3].strip() else "screen0"
                return {
                    "type": "Point",
                    "x": x,
                    "y": y,
                    "label": label,
                    "screen": screen,
                }
        return None

    if kind in {"HIGHLIGHT", "BOX"}:
        # [HIGHLIGHT:#8], [HIGHLIGHT:#8:Add], [BOX:#8:#10b981]
        if len(parts) >= 2:
            target = parts[1].strip()
            if "," not in target:
                element_id = _parse_element_id_token(target)
                if element_id is not None:
                    color, label = _parse_color_and_label_slice(parts[2:])
                    return {
                        "type": "DrawRef",
                        "shape": "box",
                        "element_id": element_id,
                        "target_element_id": None,
                        "color": color or "#10b981",
                        "label": label,
                    }
        return None

    if kind == "DRAW":
        # [DRAW:clear]
        if len(parts) >= 2 and parts[1].strip().lower() == "clear":
            return {"type": "ClearDrawings"}

        if len(parts) >= 3:
            shape = parts[1].strip().lower()
            if shape not in VALID_DRAW_SHAPES:
                return None

            target_spec = parts[2].strip()
            if "->" in target_spec:
                src, dst = target_spec.split("->", 1)
                id1 = _parse_element_id_token(src)
                id2 = _parse_element_id_token(dst)
                if id1 is None or id2 is None:
                    return None
                color, label = _parse_color_and_label_slice(parts[3:])
                return {
                    "type": "DrawRef",
                    "shape": shape,
                    "element_id": id1,
                    "target_element_id": id2,
                    "color": color,
                    "label": label,
                }

            if "," not in target_spec:
                element_id = _parse_element_id_token(target_spec)
                if element_id is not None:
                    color, label = _parse_color_and_label_slice(parts[3:])
                    return {
                        "type": "DrawRef",
                        "shape": shape,
                        "element_id": element_id,
                        "target_element_id": None,
                        "color": color,
                        "label": label,
                    }

            coords: List[int] = []
            for token in target_spec.split(","):
                t = token.strip()
                if not t:
                    continue
                try:
                    coords.append(int(round(float(t))))
                except ValueError:
                    pass
            if not coords:
                return None

            color, label = _parse_color_and_label_slice(parts[3:])
            return {
                "type": "Draw",
                "shape": shape,
                "coords": coords,
                "color": color,
                "label": label,
            }
        return None

    if kind == "GUIDE":
        if len(parts) >= 2:
            val = parts[1].strip().lower()
            if val in {"continue", "next", "active"}:
                return {"type": "Guide", "active": True}
            if val in {"done", "complete", "stop"}:
                return {"type": "Guide", "active": False}
        return None

    return None


def parse_response_tags(raw_text: str) -> Tuple[str, List[Dict[str, Any]]]:
    """
    Faithfully mirrors `TagStreamParser::feed_token` + `flush` from Rust,
    stripping recognized `[POINT:...]`, `[DRAW:...]`, and `[GUIDE:...]` tags
    while keeping clean spoken text.
    """
    clean_chars: List[str] = []
    commands: List[Dict[str, Any]] = []
    tag_buffer: List[str] = []
    is_in_tag = False
    last_char_was_space = False
    just_closed_tag = False

    for ch in raw_text:
        if is_in_tag:
            if ch == "[":
                # Flush incomplete previous '[' buffer as plain text and start a new tag
                prev_text = "".join(tag_buffer)
                clean_chars.append(prev_text)
                last_char_was_space = prev_text.endswith(" ")
                tag_buffer = ["["]
                continue

            tag_buffer.append(ch)
            if ch == "]":
                tag_str = "".join(tag_buffer)
                inner = tag_str[1:-1]
                cmd = parse_tag(inner)
                if cmd is not None:
                    commands.append(cmd)
                    just_closed_tag = True
                else:
                    clean_chars.append(tag_str)
                    last_char_was_space = tag_str.endswith(" ")
                tag_buffer = []
                is_in_tag = False
            elif len(tag_buffer) > 512:
                tag_str = "".join(tag_buffer)
                clean_chars.append(tag_str)
                last_char_was_space = tag_str.endswith(" ")
                tag_buffer = []
                is_in_tag = False
        elif ch == "[":
            is_in_tag = True
            tag_buffer = ["["]
        else:
            if just_closed_tag and ch == " " and last_char_was_space:
                just_closed_tag = False
                continue
            just_closed_tag = False
            last_char_was_space = ch == " "
            clean_chars.append(ch)

    if is_in_tag and tag_buffer:
        tag_str = "".join(tag_buffer)
        inner = tag_str.strip("[]")
        cmd = parse_tag(inner)
        if cmd is not None:
            commands.append(cmd)
        else:
            clean_chars.append(tag_str)

    clean_speech = re.sub(r"[ \t]{2,}", " ", "".join(clean_chars)).strip()
    return clean_speech, commands


# ============================================================================
# Grounded JSON Loading & Element Formatting
# ============================================================================


def find_grounded_json_path(grounded_jpeg_path: Path) -> Optional[Path]:
    candidates = [
        grounded_jpeg_path.with_suffix(".json"),
        Path(f"{grounded_jpeg_path}.json"),
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def load_grounded_elements(json_path: Path) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    window_title: Optional[str] = None
    if isinstance(data, dict):
        raw_elements = data.get("elements", [])
        if isinstance(data.get("window_title"), str) and data["window_title"].strip():
            window_title = data["window_title"].strip()
    elif isinstance(data, list):
        raw_elements = data
    else:
        raise ValueError(f"Unsupported JSON structure in {json_path}: expected dict or list")

    elements: List[Dict[str, Any]] = []
    for item in raw_elements:
        if not isinstance(item, dict) or "id" not in item:
            continue
        bbox = item.get("bbox_norm")
        if not (isinstance(bbox, list) and len(bbox) == 4):
            continue
        x1, y1, x2, y2 = [int(round(float(v))) for v in bbox]
        center = item.get("center_norm")
        if isinstance(center, list) and len(center) == 2:
            cx, cy = int(round(float(center[0]))), int(round(float(center[1])))
        else:
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

        elements.append(
            {
                "id": int(item["id"]),
                "label": str(item.get("label", "")),
                "source": str(item.get("source", "unknown")),
                "bbox_norm": [x1, y1, x2, y2],
                "center_norm": [cx, cy],
            }
        )

    return elements, window_title


def build_compact_elements_prompt(
    query: str,
    window_title: str,
    elements: List[Dict[str, Any]],
) -> str:
    clean_title = window_title.replace('"', "'")
    entries = []
    for el in elements:
        lbl = el["label"].replace('"', "'")
        cx, cy = el["center_norm"]
        entries.append(f'#{el["id"]} "{lbl}" ({cx},{cy})')
    return (
        f"{query}\n\n"
        f'[Active Window: "{clean_title}"]\n'
        f'[Detected Screen Elements]: {", ".join(entries)}'
    )


# ============================================================================
# Local Ollama Vision Client (stream=False, think=False, temperature=0.1)
# ============================================================================


def call_ollama_vision(
    ollama_url: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    jpeg_bytes: bytes,
    timeout_s: float = 180.0,
    enable_think: bool = False,
) -> Dict[str, Any]:
    url = f"{ollama_url.rstrip('/')}/api/chat"
    img_b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": user_prompt,
                "images": [img_b64],
            },
        ],
        "stream": False,
        "think": enable_think,
        "options": {
            "temperature": 0.1,
            "num_ctx": 8192,
        },
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Ollama HTTP {e.code}: {err_body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Failed to connect to Ollama at {url}: {e}") from e

    elapsed_s = time.perf_counter() - t0
    data = json.loads(body)
    content = data.get("message", {}).get("content", "") or ""
    eval_count = int(data.get("eval_count", 0) or 0)
    eval_duration_ns = int(data.get("eval_duration", 0) or 0)
    prompt_eval_count = int(data.get("prompt_eval_count", 0) or 0)
    prompt_eval_duration_ns = int(data.get("prompt_eval_duration", 0) or 0)
    tok_per_sec = (
        eval_count / (eval_duration_ns / 1e9) if eval_duration_ns > 0 else 0.0
    )

    return {
        "content": content,
        "elapsed_s": elapsed_s,
        "eval_count": eval_count,
        "prompt_eval_count": prompt_eval_count,
        "prompt_eval_ms": prompt_eval_duration_ns / 1e6,
        "tok_per_sec": tok_per_sec,
    }


# ============================================================================
# Resolution, Spatial Grading & Speech Quality Verification
# ============================================================================


def clamp_norm(v: int) -> int:
    return max(0, min(1000, int(v)))


def resolve_commands(
    commands: List[Dict[str, Any]],
    element_map: Dict[int, Dict[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]], Optional[bool], List[str]]:
    """
    Resolves all parsed commands against `element_map` and selects the primary
    spatial target (preferring `#ID` references from `[POINT:#ID:...]` then
    `[DRAW:...:#ID:...]`, falling back to raw `[POINT:x,y:...]` / `[DRAW:...]`).
    """
    resolved_all: List[Dict[str, Any]] = []
    guide_signal: Optional[bool] = None
    warnings: List[str] = []

    primary_point_ref: Optional[Dict[str, Any]] = None
    primary_draw_ref: Optional[Dict[str, Any]] = None
    primary_raw_point: Optional[Dict[str, Any]] = None
    primary_raw_draw: Optional[Dict[str, Any]] = None

    for cmd in commands:
        ctype = cmd["type"]

        if ctype == "Guide":
            guide_signal = bool(cmd["active"])
            resolved_all.append(cmd)
            continue

        if ctype == "ClearDrawings":
            resolved_all.append(cmd)
            continue

        if ctype == "PointRef":
            eid = cmd["element_id"]
            el = element_map.get(eid)
            if el is None:
                warnings.append(f"Unknown element #{eid} in POINT tag")
                resolved_all.append({**cmd, "resolved": False})
                continue
            item = {
                "command_type": "PointRef",
                "used_som_id": True,
                "element_id": eid,
                "element_label": el["label"],
                "element_source": el["source"],
                "tag_label": cmd["label"] or el["label"],
                "center_norm": list(el["center_norm"]),
                "bbox_norm": list(el["bbox_norm"]),
                "resolved": True,
            }
            resolved_all.append(item)
            if primary_point_ref is None:
                primary_point_ref = item
            continue

        if ctype == "DrawRef":
            eid = cmd["element_id"]
            el = element_map.get(eid)
            if el is None:
                warnings.append(f"Unknown element #{eid} in DRAW {cmd['shape']} tag")
                resolved_all.append({**cmd, "resolved": False})
                continue
            item = {
                "command_type": f"DrawRef:{cmd['shape']}",
                "used_som_id": True,
                "element_id": eid,
                "element_label": el["label"],
                "element_source": el["source"],
                "tag_label": cmd.get("label") or el["label"],
                "center_norm": list(el["center_norm"]),
                "bbox_norm": list(el["bbox_norm"]),
                "resolved": True,
            }
            resolved_all.append(item)
            if primary_draw_ref is None:
                primary_draw_ref = item
            continue

        if ctype == "Point":
            cx = clamp_norm(cmd["x"])
            cy = clamp_norm(cmd["y"])
            bbox = [clamp_norm(cx - 18), clamp_norm(cy - 18), clamp_norm(cx + 18), clamp_norm(cy + 18)]
            item = {
                "command_type": "Point",
                "used_som_id": False,
                "element_id": None,
                "element_label": None,
                "element_source": "raw_coords",
                "tag_label": cmd["label"] or "Target",
                "center_norm": [cx, cy],
                "bbox_norm": bbox,
                "resolved": True,
            }
            resolved_all.append(item)
            if primary_raw_point is None:
                primary_raw_point = item
            continue

        if ctype == "Draw":
            shape = cmd["shape"]
            coords = cmd["coords"]
            cx: Optional[int] = None
            cy: Optional[int] = None
            bbox_norm: Optional[List[int]] = None
            if shape == "box" and len(coords) >= 4:
                x1, x2 = sorted([clamp_norm(coords[0]), clamp_norm(coords[2])])
                y1, y2 = sorted([clamp_norm(coords[1]), clamp_norm(coords[3])])
                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                bbox_norm = [x1, y1, x2, y2]
            elif shape == "circle" and len(coords) >= 3:
                cx, cy = clamp_norm(coords[0]), clamp_norm(coords[1])
                r = max(8, min(200, abs(coords[2])))
                bbox_norm = [clamp_norm(cx - r), clamp_norm(cy - r), clamp_norm(cx + r), clamp_norm(cy + r)]
            elif shape in {"arrow", "line"} and len(coords) >= 4:
                cx, cy = clamp_norm(coords[2]), clamp_norm(coords[3])
                bbox_norm = [clamp_norm(cx - 16), clamp_norm(cy - 16), clamp_norm(cx + 16), clamp_norm(cy + 16)]
            elif shape == "text" and len(coords) >= 2:
                cx, cy = clamp_norm(coords[0]), clamp_norm(coords[1])
                bbox_norm = [clamp_norm(cx - 16), clamp_norm(cy - 16), clamp_norm(cx + 16), clamp_norm(cy + 16)]

            if cx is not None and cy is not None and bbox_norm is not None:
                item = {
                    "command_type": f"Draw:{shape}",
                    "used_som_id": False,
                    "element_id": None,
                    "element_label": None,
                    "element_source": "raw_coords",
                    "tag_label": cmd.get("label") or shape,
                    "center_norm": [cx, cy],
                    "bbox_norm": bbox_norm,
                    "resolved": True,
                }
                resolved_all.append(item)
                if primary_raw_draw is None:
                    primary_raw_draw = item

    primary = primary_point_ref or primary_draw_ref or primary_raw_point or primary_raw_draw
    return primary, resolved_all, guide_signal, warnings


def distance_point_to_box(cx: int, cy: int, bbox: Tuple[int, int, int, int]) -> float:
    x1, y1, x2, y2 = bbox
    dx = max(x1 - cx, 0, cx - x2)
    dy = max(y1 - cy, 0, cy - y2)
    return math.hypot(dx, dy)


def evaluate_spatial_hit(
    primary: Optional[Dict[str, Any]],
    regions: List[TargetRegion],
    tolerance: int,
) -> Tuple[bool, Optional[str], Optional[float]]:
    if primary is None:
        return False, None, None

    cx, cy = primary["center_norm"]
    best_dist: Optional[float] = None
    best_region: Optional[str] = None
    hit = False

    for reg in regions:
        x1, y1, x2, y2 = reg.bbox_norm
        d = distance_point_to_box(cx, cy, reg.bbox_norm)
        in_box = (x1 - tolerance) <= cx <= (x2 + tolerance) and (y1 - tolerance) <= cy <= (y2 + tolerance)
        if best_dist is None or d < best_dist:
            best_dist = d
            best_region = reg.name
        if in_box:
            hit = True
            best_dist = d
            best_region = reg.name
            break

    return hit, best_region, round(best_dist, 2) if best_dist is not None else None


def evaluate_single_step_speech(raw_output: str, clean_speech: str) -> Tuple[bool, List[str]]:
    issues: List[str] = []
    stripped = clean_speech.strip()

    if len(stripped) < 12:
        issues.append("Spoken reply is empty or too short (<12 chars)")

    if "```" in raw_output or "`[" in raw_output or "]`" in raw_output:
        issues.append("Output wraps spatial tags in markdown backticks or code fences")

    if re.search(r"\[(POINT|DRAW|GUIDE):", stripped, re.IGNORECASE):
        issues.append("Unparsed or malformed overlay tag leaked into clean speech")

    if re.search(r"(?:^|\s)#\d+\b", stripped):
        issues.append("Raw Set-of-Mark #ID number was spoken aloud in clean speech")

    # Detect multi-step dumps (numbered lists, bullet lists, or explicit Step 2 / then-chain overload)
    if re.search(r"(?m)^\s*2[\.\)]\s+", stripped) or re.search(r"\bstep\s*2\b", stripped, re.IGNORECASE):
        issues.append("Response dumps multiple numbered steps instead of a single next action")

    bullet_lines = re.findall(r"(?m)^\s*[-*•]\s+", stripped)
    if len(bullet_lines) >= 2:
        issues.append("Response contains a multi-item bullet list instead of a single step")

    sentences = [s.strip() for s in re.split(r"[.!?]+", stripped) if s.strip()]
    if len(sentences) > 4:
        issues.append(f"Response has {len(sentences)} sentences (>4), likely too verbose for single-step voice")

    return len(issues) == 0, issues


# ============================================================================
# Visual Verification Overlay Renderer (PIL)
# ============================================================================


def load_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = (
        ["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"]
        if bold
        else ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"]
    )
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_dashed_rect(
    draw: ImageDraw.ImageDraw,
    box: Tuple[int, int, int, int],
    color: Tuple[int, int, int, int],
    width: int = 2,
    dash: int = 8,
    gap: int = 6,
) -> None:
    x1, y1, x2, y2 = box
    # Top and bottom edges
    x = x1
    while x < x2:
        ex = min(x + dash, x2)
        draw.line([(x, y1), (ex, y1)], fill=color, width=width)
        draw.line([(x, y2), (ex, y2)], fill=color, width=width)
        x += dash + gap
    # Left and right edges
    y = y1
    while y < y2:
        ey = min(y + dash, y2)
        draw.line([(x1, y), (x1, ey)], fill=color, width=width)
        draw.line([(x2, y), (x2, ey)], fill=color, width=width)
        y += dash + gap


def render_verification_overlay(
    base_image_path: Path,
    output_jpeg_path: Path,
    case: EvalCase,
    primary: Optional[Dict[str, Any]],
    passed: bool,
    spatial_hit: bool,
    clean_speech: str,
    distance_to_gt: Optional[float],
) -> None:
    base = Image.open(base_image_path).convert("RGBA")
    w, h = base.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")

    font_label = load_font(18, bold=True)
    font_small = load_font(14, bold=False)
    font_banner_title = load_font(20, bold=True)
    font_banner_body = load_font(16, bold=False)

    def nx(v: int) -> int:
        return int(round((v / 1000.0) * w))

    def ny(v: int) -> int:
        return int(round((v / 1000.0) * h))

    # 1. Draw subtle dashed cyan ground-truth target region(s) for visual comparison
    for reg in case.target_regions:
        gx1, gy1, gx2, gy2 = (
            nx(reg.bbox_norm[0]),
            ny(reg.bbox_norm[1]),
            nx(reg.bbox_norm[2]),
            ny(reg.bbox_norm[3]),
        )
        draw.rectangle([gx1, gy1, gx2, gy2], fill=(56, 189, 248, 28))
        draw_dashed_rect(draw, (gx1, gy1, gx2, gy2), (56, 189, 248, 210), width=2)
        gt_tag = f"GT: {reg.name}"
        tb = draw.textbbox((0, 0), gt_tag, font=font_small)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        tx = max(6, min(w - tw - 14, gx1))
        ty = gy2 + 4 if gy2 + th + 12 < h - 90 else max(6, gy1 - th - 10)
        draw.rounded_rectangle([tx, ty, tx + tw + 10, ty + th + 6], radius=6, fill=(8, 20, 34, 210), outline=(56, 189, 248, 210), width=1)
        draw.text((tx + 5, ty + 2), gt_tag, font=font_small, fill=(186, 230, 253, 255))

    # 2. Draw bright neon-green bounding box + target crosshair + label at exact model choice
    neon_green = (57, 255, 20, 255)
    neon_fill = (57, 255, 20, 48)
    neon_glow = (57, 255, 20, 120)

    if primary is not None:
        bx1, by1, bx2, by2 = primary["bbox_norm"]
        cx_n, cy_n = primary["center_norm"]

        px1, py1, px2, py2 = nx(bx1), ny(by1), nx(bx2), ny(by2)
        pcx, pcy = nx(cx_n), ny(cy_n)

        # Ensure visible minimum box dimensions for tiny icons
        if px2 - px1 < 16:
            px1, px2 = pcx - 10, pcx + 10
        if py2 - py1 < 16:
            py1, py2 = pcy - 10, pcy + 10

        # Outer glow + filled neon-green highlight box + crisp 4px neon-green border
        draw.rounded_rectangle([px1 - 4, py1 - 4, px2 + 4, py2 + 4], radius=10, outline=neon_glow, width=4)
        draw.rounded_rectangle([px1, py1, px2, py2], radius=8, fill=neon_fill, outline=neon_green, width=4)

        # Target crosshair at exact resolved center (pcx, pcy)
        arm = 22
        ring_r = 11
        # Dark outline halo under crosshair so it pops on light Chrome backgrounds too
        draw.ellipse([pcx - ring_r - 2, pcy - ring_r - 2, pcx + ring_r + 2, pcy + ring_r + 2], outline=(0, 0, 0, 200), width=5)
        draw.line([(pcx - arm, pcy), (pcx + arm, pcy)], fill=(0, 0, 0, 200), width=5)
        draw.line([(pcx, pcy - arm), (pcx, pcy + arm)], fill=(0, 0, 0, 200), width=5)

        draw.ellipse([pcx - ring_r, pcy - ring_r, pcx + ring_r, pcy + ring_r], outline=neon_green, width=3)
        draw.line([(pcx - arm, pcy), (pcx + arm, pcy)], fill=neon_green, width=3)
        draw.line([(pcx, pcy - arm), (pcx, pcy + arm)], fill=neon_green, width=3)
        draw.ellipse([pcx - 4, pcy - 4, pcx + 4, pcy + 4], fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), width=1)

        # Crisp dark-glass label pill near the chosen box
        if primary["used_som_id"] and primary["element_id"] is not None:
            id_part = f'#{primary["element_id"]} "{primary["tag_label"]}"'
        else:
            id_part = f'RAW "{primary["tag_label"]}"'
        verdict = "PASS" if passed else ("HIT" if spatial_hit else "MISS")
        pill_text = f"{id_part} ({cx_n},{cy_n}) [{verdict}]"

        tb = draw.textbbox((0, 0), pill_text, font=font_label)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        pad_x, pad_y = 12, 7
        pill_w, pill_h = tw + pad_x * 2, th + pad_y * 2

        # Smart placement: prefer above box, flip below if near top, clamp horizontally
        pill_x = max(10, min(w - pill_w - 10, px1))
        if py1 - pill_h - 10 >= 10:
            pill_y = py1 - pill_h - 10
        elif py2 + 10 + pill_h < h - 95:
            pill_y = py2 + 10
        else:
            pill_y = max(10, py1 - pill_h - 10)

        border_col = neon_green if passed else (255, 80, 80, 255)
        draw.rounded_rectangle(
            [pill_x, pill_y, pill_x + pill_w, pill_y + pill_h],
            radius=10,
            fill=(10, 14, 18, 232),
            outline=border_col,
            width=2,
        )
        draw.text((pill_x + pad_x, pill_y + pad_y - 1), pill_text, font=font_label, fill=(240, 255, 240, 255))

    # 3. Bottom verification summary strip (keeps top menus completely unobstructed)
    bar_h = 84
    bar_y1 = h - bar_h - 12
    bar_x1 = 16
    bar_x2 = w - 16
    # If chosen target itself is near bottom (e.g. Customize Chrome at y~915), place banner top-center instead!
    if primary is not None and primary["center_norm"][1] > 800:
        bar_y1 = 12
    bar_y2 = bar_y1 + bar_h

    badge_col = (34, 197, 94, 255) if passed else (239, 68, 68, 255)
    status_word = "PASS" if passed else "FAIL"
    draw.rounded_rectangle(
        [bar_x1, bar_y1, bar_x2, bar_y2],
        radius=12,
        fill=(9, 12, 18, 230),
        outline=badge_col,
        width=2,
    )

    # Status pill inside banner
    draw.rounded_rectangle([bar_x1 + 14, bar_y1 + 14, bar_x1 + 98, bar_y1 + 48], radius=8, fill=badge_col)
    draw.text((bar_x1 + 29, bar_y1 + 19), status_word, font=font_banner_title, fill=(8, 12, 14, 255))

    dist_str = f"dist={distance_to_gt:.1f}" if distance_to_gt is not None else "no target"
    header_line = f"{case.title}  |  Query: \"{case.query}\"  |  {dist_str}"
    speech_preview = clean_speech.replace("\n", " ").strip()
    if len(speech_preview) > 135:
        speech_preview = speech_preview[:132] + "..."
    body_line = f'Spoken: "{speech_preview}"' if speech_preview else "Spoken: <empty>"

    draw.text((bar_x1 + 114, bar_y1 + 14), header_line, font=font_banner_title, fill=(244, 244, 245, 255))
    draw.text((bar_x1 + 114, bar_y1 + 46), body_line, font=font_banner_body, fill=(203, 213, 225, 255))

    merged = Image.alpha_composite(base, overlay).convert("RGB")
    output_jpeg_path.parent.mkdir(parents=True, exist_ok=True)
    merged.save(output_jpeg_path, format="JPEG", quality=92)


# ============================================================================
# Main Runner & Reporting
# ============================================================================


@dataclass
class CaseReport:
    case_id: str
    title: str
    app_name: str
    query: str
    grounded_jpeg: str
    grounded_json: str
    element_count: int
    raw_output: str
    clean_speech: str
    parsed_commands: List[Dict[str, Any]]
    resolved_commands: List[Dict[str, Any]]
    primary_target: Optional[Dict[str, Any]]
    guide_signal: Optional[bool]
    spatial_hit: bool
    used_som_id: bool
    has_guide_continue: bool
    natural_single_step_speech: bool
    passed: bool
    matched_gt_region: Optional[str]
    distance_to_gt: Optional[float]
    tolerance: int
    latency_s: float
    prompt_eval_ms: float
    eval_tokens: int
    tok_per_sec: float
    render_path: str
    diagnostics: List[str] = field(default_factory=list)


def run_benchmark(
    ss_dir: Path,
    out_dir: Path,
    ollama_url: str,
    model: str,
    tolerance: int,
    case_filter: Optional[str] = None,
    timeout_s: float = 180.0,
    use_clean_wda: bool = False,
    enable_think: bool = False,
) -> int:
    selected_cases = [
        c for c in EVAL_CASES if not case_filter or case_filter.lower() in c.case_id.lower()
    ]
    if not selected_cases:
        print(f"[Error] No test cases matched filter '{case_filter}'.")
        return 2

    if not out_dir.exists():
        print(f"[Not Ready] Output directory does not exist yet: {out_dir}")
        print("Generate the Rust Set-of-Mark grounded screenshots & element JSONs first, then re-run:")
        print(f"  python {Path(__file__).name}")
        return 1

    def resolve_grounded_name(raw_name: str) -> str:
        if use_clean_wda and raw_name.startswith("grounded_"):
            return "grounded_clean_" + raw_name[len("grounded_"):]
        return raw_name

    # Verify all required grounded JPEGs and JSONs exist up front
    missing: List[str] = []
    seen_files: set[str] = set()
    for c in selected_cases:
        gname = resolve_grounded_name(c.grounded_jpeg_name)
        if gname in seen_files:
            continue
        seen_files.add(gname)
        jpg_path = out_dir / gname
        if not jpg_path.exists():
            missing.append(str(jpg_path))
        if find_grounded_json_path(jpg_path) is None:
            missing.append(str(jpg_path.with_suffix(".json")))

    if missing:
        print("[Not Ready] Missing required Rust-generated grounded artifact(s):")
        for m in missing:
            print(f"  - {m}")
        print("Run the Rust SoM calibration generator first to populate D:\\cliky\\ss\\out\\.")
        return 1

    mode_label = "WDA-CLEAN (Sticky HUD excluded)" if use_clean_wda else "RAW (original screenshots)"
    print("=" * 100)
    print(" STICKY SET-OF-MARK (SoM) END-TO-END VISION BENCHMARK — BONSAI-2 9B")
    print(f" Ollama: {ollama_url} | Model: {model} | Mode: {mode_label} | Think: {enable_think} | Tol: ±{tolerance}")
    print(f" Grounded Inputs: {out_dir} | Clean Originals: {ss_dir}")
    print("=" * 100)

    # Cache loaded element tables & JPEG bytes per grounded filename
    grounded_cache: Dict[str, Tuple[bytes, List[Dict[str, Any]], Dict[int, Dict[str, Any]], Optional[str], Path]] = {}
    reports: List[CaseReport] = []

    for case in selected_cases:
        gname = resolve_grounded_name(case.grounded_jpeg_name)
        jpg_path = out_dir / gname
        if gname not in grounded_cache:
            json_path = find_grounded_json_path(jpg_path)
            assert json_path is not None
            jpeg_bytes = jpg_path.read_bytes()
            elements, win_title = load_grounded_elements(json_path)
            el_map = {el["id"]: el for el in elements}
            grounded_cache[gname] = (jpeg_bytes, elements, el_map, win_title, json_path)

        jpeg_bytes, elements, element_map, json_win_title, json_path = grounded_cache[gname]
        window_title = json_win_title or case.app_name
        user_prompt = build_compact_elements_prompt(case.query, window_title, elements)

        print(f"\n>>> [{case.case_id}] {case.title}")
        print(f'    Query: "{case.query}" ({len(elements)} grounded elements)')

        resp = call_ollama_vision(
            ollama_url=ollama_url,
            model=model,
            system_prompt=STICKY_SOM_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            jpeg_bytes=jpeg_bytes,
            timeout_s=timeout_s,
            enable_think=enable_think,
        )

        raw_output = resp["content"]
        clean_speech, parsed_cmds = parse_response_tags(raw_output)
        primary, resolved_cmds, guide_signal, resolve_warnings = resolve_commands(parsed_cmds, element_map)

        spatial_hit, matched_region, dist = evaluate_spatial_hit(primary, case.target_regions, tolerance)
        used_som_id = bool(primary and primary["used_som_id"])
        has_guide_continue = (guide_signal is True) if case.expect_guide_continue else True
        speech_ok, speech_issues = evaluate_single_step_speech(raw_output, clean_speech)

        diagnostics: List[str] = []
        diagnostics.extend(resolve_warnings)
        if primary is None:
            diagnostics.append("FAIL: No resolvable [POINT:...] or [DRAW:...] overlay target emitted.")
        else:
            cx, cy = primary["center_norm"]
            src_desc = (
                f'#{primary["element_id"]} "{primary["element_label"]}" ({primary["element_source"]})'
                if used_som_id
                else f'raw {primary["command_type"]}'
            )
            if spatial_hit:
                diagnostics.append(
                    f"PASS spatial: {src_desc} -> ({cx}, {cy}) matched '{matched_region}' (dist={dist})."
                )
            else:
                diagnostics.append(
                    f"FAIL spatial: {src_desc} -> ({cx}, {cy}) missed GT (nearest '{matched_region}', dist={dist}, tol={tolerance})."
                )

        if has_guide_continue:
            diagnostics.append("PASS guide: [GUIDE:continue] present.")
        else:
            diagnostics.append(f"FAIL guide: expected [GUIDE:continue], got guide_signal={guide_signal}.")

        if speech_ok:
            diagnostics.append("PASS speech: natural single-step spoken response.")
        else:
            for issue in speech_issues:
                diagnostics.append(f"FAIL speech: {issue}")

        passed = spatial_hit and has_guide_continue and speech_ok

        # Draw visual verification overlay on clean original screenshot (fallback to grounded JPEG)
        orig_path = ss_dir / case.original_image_name
        base_img_path = orig_path if orig_path.exists() else jpg_path
        render_path = out_dir / f"eval_{case.case_id}.jpg"
        render_verification_overlay(
            base_image_path=base_img_path,
            output_jpeg_path=render_path,
            case=case,
            primary=primary,
            passed=passed,
            spatial_hit=spatial_hit,
            clean_speech=clean_speech,
            distance_to_gt=dist,
        )

        report = CaseReport(
            case_id=case.case_id,
            title=case.title,
            app_name=window_title,
            query=case.query,
            grounded_jpeg=str(jpg_path),
            grounded_json=str(json_path),
            element_count=len(elements),
            raw_output=raw_output,
            clean_speech=clean_speech,
            parsed_commands=parsed_cmds,
            resolved_commands=resolved_cmds,
            primary_target=primary,
            guide_signal=guide_signal,
            spatial_hit=spatial_hit,
            used_som_id=used_som_id,
            has_guide_continue=has_guide_continue,
            natural_single_step_speech=speech_ok,
            passed=passed,
            matched_gt_region=matched_region,
            distance_to_gt=dist,
            tolerance=tolerance,
            latency_s=round(resp["elapsed_s"], 3),
            prompt_eval_ms=round(resp["prompt_eval_ms"], 1),
            eval_tokens=resp["eval_count"],
            tok_per_sec=round(resp["tok_per_sec"], 2),
            render_path=str(render_path),
            diagnostics=diagnostics,
        )
        reports.append(report)

        status_badge = "PASS" if passed else "FAIL"
        target_summary = (
            f'#{primary["element_id"]} "{primary["element_label"]}" ({primary["center_norm"][0]},{primary["center_norm"][1]})'
            if primary and primary["used_som_id"]
            else (
                f'RAW ({primary["center_norm"][0]},{primary["center_norm"][1]})'
                if primary
                else "NONE"
            )
        )
        print(f"    Result : [{status_badge}] target={target_summary} | guide={guide_signal} | {report.latency_s:.2f}s ({report.tok_per_sec:.1f} tok/s)")
        print(f'    Speech : "{clean_speech}"')
        print(f"    Raw    : {raw_output.strip()}")
        print(f"    Overlay: {render_path}")
        for d in diagnostics:
            print(f"      * {d}")

    # Summary Table
    total = len(reports)
    passed_count = sum(1 for r in reports if r.passed)
    spatial_hits = sum(1 for r in reports if r.spatial_hit)
    som_id_hits = sum(1 for r in reports if r.used_som_id)
    guide_hits = sum(1 for r in reports if r.has_guide_continue)
    speech_hits = sum(1 for r in reports if r.natural_single_step_speech)
    avg_latency = sum(r.latency_s for r in reports) / total if total else 0.0
    avg_tps = sum(r.tok_per_sec for r in reports) / total if total else 0.0

    print("\n" + "=" * 100)
    print(f"{'Case ID':<28} | {'Target':<24} | {'Dist':<6} | {'SoM#':<4} | {'Guide':<5} | {'Speech':<6} | {'Lat':<6} | {'Status'}")
    print("-" * 100)
    for r in reports:
        if r.primary_target:
            cx, cy = r.primary_target["center_norm"]
            tgt = (
                f'#{r.primary_target["element_id"]} ({cx},{cy})'
                if r.used_som_id
                else f"raw ({cx},{cy})"
            )
        else:
            tgt = "none"
        dist_col = f"{r.distance_to_gt:.1f}" if r.distance_to_gt is not None else "n/a"
        print(
            f"{r.case_id:<28} | {tgt:<24} | {dist_col:<6} | "
            f"{'Y' if r.used_som_id else 'N':<4} | "
            f"{'Y' if r.has_guide_continue else 'N':<5} | "
            f"{'Y' if r.natural_single_step_speech else 'N':<6} | "
            f"{r.latency_s:>5.2f}s | {'PASS' if r.passed else 'FAIL'}"
        )
    print("-" * 100)
    print(
        f"SUMMARY: {passed_count}/{total} PASSED ({(passed_count / total * 100.0):.1f}%) | "
        f"Spatial: {spatial_hits}/{total} | SoM #ID: {som_id_hits}/{total} | "
        f"Guide: {guide_hits}/{total} | Speech: {speech_hits}/{total} | "
        f"Avg Latency: {avg_latency:.2f}s ({avg_tps:.1f} tok/s)"
    )
    print("=" * 100)

    report_path = out_dir / "eval_som_report.json"
    report_payload = {
        "benchmark": "sticky_som_bonsai_e2e",
        "model": model,
        "ollama_url": ollama_url,
        "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tolerance_norm": tolerance,
        "summary": {
            "total": total,
            "passed": passed_count,
            "failed": total - passed_count,
            "pass_rate_percent": round((passed_count / total) * 100.0, 2) if total else 0.0,
            "spatial_hits": spatial_hits,
            "som_id_used": som_id_hits,
            "guide_continue_present": guide_hits,
            "natural_single_step_speech": speech_hits,
            "avg_latency_s": round(avg_latency, 3),
            "avg_tok_per_sec": round(avg_tps, 2),
        },
        "cases": [asdict(r) for r in reports],
    }

    report_path.parent.mkdir(parents=True, exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report_payload, f, indent=2, ensure_ascii=False)
    print(f"[Report] Full JSON report written to: {report_path}")

    return 0 if passed_count == total else 1


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate Sticky Set-of-Mark grounding end-to-end against local Ollama bonsai-2:9b."
    )
    parser.add_argument("--ss-dir", type=Path, default=DEFAULT_SS_DIR, help="Directory with clean original screenshots")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR, help="Directory with grounded JPEGs/JSONs and eval outputs")
    parser.add_argument("--ollama-url", type=str, default=DEFAULT_OLLAMA_URL, help="Local Ollama base URL")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="Ollama vision model name")
    parser.add_argument("--tolerance", type=int, default=DEFAULT_TOLERANCE, help="Normalized 0..1000 hit tolerance around GT box")
    parser.add_argument("--case", type=str, default=None, help="Optional substring filter to run a subset of cases")
    parser.add_argument("--timeout", type=float, default=180.0, help="HTTP request timeout per case in seconds")
    parser.add_argument("--clean", action="store_true", help="Evaluate against WDA-clean grounded screenshots (old Sticky HUD excluded)")
    parser.add_argument("--think", action="store_true", help="Enable model reasoning (think=true)")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = parse_args()
    sys.exit(
        run_benchmark(
            ss_dir=args.ss_dir,
            out_dir=args.out_dir,
            ollama_url=args.ollama_url,
            model=args.model,
            tolerance=args.tolerance,
            case_filter=args.case,
            timeout_s=args.timeout,
            use_clean_wda=args.clean,
            enable_think=args.think,
        )
    )
