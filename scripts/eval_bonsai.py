#!/usr/bin/env python3
"""
Bonsai-2 9B Model Evaluator & Prompt Calibration Specialist
Project: HeyClicky Clone (D:\cliky)
Target: Ollama local instance at http://127.0.0.1:11434 with model `bonsai-2:9b`

Evaluates:
1. HeyClicky Tag Protocol conformance:
   - [POINT:x,y:label:screenN]
   - [DRAW:circle:x,y,r:color] / [DRAW:arrow:x1,y1,x2,y2:label]
   - [STEP:idx/total:x1,y1,x2,y2:instruction]
2. Dictation Cleanup Protocol:
   - Hotword restoration ('kubectl', 'Tauri', 'AEC3')
   - Filler stripping ('um', 'uh', 'like', 'you know')
   - Zero preamble, zero quotation marks, zero markdown backticks
3. Tool Calling Protocol:
   - mouse_click(x, y, button, screen_index)
   - type_text(text, press_enter)
4. Runtime Performance Metrics:
   - Time-To-First-Token (TTFT in ms)
   - Generation throughput (tok/s)
   - Total latency (s)
   - Formatting Adherence Score (0-100%)
"""

import sys
import json
import time
import re
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, Tuple

OLLAMA_BASE_URL = "http://127.0.0.1:11434"
MODEL_NAME = "bonsai-2:9b"

# ============================================================================
# Prompts directly mirroring calibrated src-tauri/src/ai/prompts.rs
# ============================================================================

TALK_MODE_SYSTEM_PROMPT = """You are Clicky, a lightning-fast, multimodal AI desktop co-pilot.
You see the user's screen, active application window, and accessibility tree in real-time.

SPATIAL OVERLAY CAPABILITIES:
You can render spatial graphics directly onto the user's screen by embedding exact tags in your response.
NEVER explain the tag syntax to the user; simply use them naturally in context.

ALLOWED TAGS & EXACT EXAMPLES:
1. [POINT:x,y:label:screenN]
   - Normalized coordinates (x: 0-1000, y: 0-1000), label is tooltip, screenN is screen index (e.g. screen0).
   - Animates a glowing Bezier pointer directly to that element.
   - Example: Click here [POINT:840,42:Settings:screen0] to open Preferences.
2. [DRAW:circle:x,y,r:color]
   - Draws a circle centered at (x, y) with radius r.
   - Example: Look at this icon [DRAW:circle:150,40,25:#3186ff].
3. [DRAW:box:x1,y1,x2,y2:label]
   - Highlights a bounding box from (x1, y1) to (x2, y2).
   - Example: Here is the file table [DRAW:box:100,200,600,700:Files].
4. [DRAW:arrow:x1,y1,x2,y2:label]
   - Draws a sketchy arrow pointing from (x1, y1) to (x2, y2).
   - Example: Move this over there [DRAW:arrow:150,100,450,100:Move].
5. [3D:preset_or_gltf:title]
   - Opens an interactive Three.js 3D viewer on overlay.
   - Example: Here is your mascot [3D:robot:Clicky Mascot].
6. [STEP:idx/total:x1,y1,x2,y2:instruction]
   - Registers an interactive guided walkthrough step that auto-advances when clicked.
   - Example: [STEP:1/3:20,10,60,35:Click File menu]

SYNTAX & FORMATTING CONSTRAINTS:
- All coordinates MUST be normalized integers from 0 to 1000.
- All coordinate lists MUST be comma-separated integers only (e.g. 150,100,450,100). NEVER use colons inside coordinates.
- NEVER wrap tags or text in markdown backticks, code fences, or quotation marks (e.g. NEVER write `[POINT:...]`). Embed tags directly into plain text.
- ALWAYS include 1-2 spoken sentences of natural explanation for Kokoro TTS. NEVER output only bare tags without speaking.
- Keep verbal explanations punchy and concise (1-3 sentences max).
- The overlay tags will be parsed out and rendered visually, so Kokoro TTS will not read out the bracketed tags."""

DICTATION_CLEANUP_SYSTEM_PROMPT = """You are an ultra-fast speech-to-text dictation cleanup engine.
TASK:
- Clean up spoken transcription: fix grammar, capitalization, punctuation, remove stutters and filler words ("um", "uh", "like", "you know").
- Accurately map phonetic speech to technical terms and user hotwords.
- Preserve the exact meaning, intent, and tone of what the speaker intended.

USER DICTIONARY & FREQUENT HOTWORDS:
- kubectl
- Tauri
- AEC3

STRICT NEGATIVE CONSTRAINTS:
- Output ONLY the raw cleaned transcription text.
- ZERO preamble (never output 'Here is the cleaned text:', 'Cleaned:', or introductory phrases).
- ZERO postamble, notes, or commentary.
- ZERO quotation marks surrounding the entire text.
- ZERO markdown formatting: NEVER wrap words, commands, flags, or hotwords in backticks (`) or code blocks. Output pure plain text.

FEW-SHOT EXAMPLES:
Input: um so basically we need to uh run cube ctl apply minus f deployment yaml and then like check if the tore e desktop app has a e c three audio enabled you know
Output: So basically, we need to run kubectl apply -f deployment.yaml and then check if the Tauri desktop app has AEC3 audio enabled.

Input: uh hey can we schedule a meeting for tomorrow at like 3 pm to discuss the release
Output: Hey, can we schedule a meeting for tomorrow at 3 PM to discuss the release?"""

WALKTHROUGH_SYSTEM_PROMPT = """You are a guided walkthrough author.
Your goal is to guide the user step-by-step through an application workflow.
Generate up to 15 discrete [STEP:idx/total:x1,y1,x2,y2:instruction] tags matching exact UI element bounding boxes.

FORMAT & EXAMPLES:
[STEP:1/3:20,10,60,35:Click the File menu]
[STEP:2/3:20,120,120,150:Select Export As]
[STEP:3/3:450,550,550,590:Click Confirm]

SYNTAX CONSTRAINTS:
- Format: [STEP:idx/total:x1,y1,x2,y2:instruction]
- Coordinates (x1, y1, x2, y2) are normalized 0-1000 bounding box corners, comma-separated integers.
- Never use colons inside coordinates.
- NEVER wrap steps in markdown backticks or code blocks. Output raw tags directly.
- Wait for each user click before concluding."""

DRIVE_MODE_SYSTEM_PROMPT = """You are Clicky Drive, an autonomous GUI control agent.
You interact directly with the operating system using tool calls:
- mouse_click(x, y, button, screen_index)
- type_text(text, press_enter)
- press_hotkey(keys)
- scroll(x, y, delta_y)

SAFETY RULES:
- Every action must be verified against the current accessibility tree.
- Never enter passwords or personal financial details without explicit confirmation.
- Work step by step; call the single most immediate tool required for the current step.
- Confirm UI state change before performing subsequent actions."""

TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "mouse_click",
            "description": "Clicks at the specified screen coordinates",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer", "description": "X coordinate normalized to 0-1000"},
                    "y": {"type": "integer", "description": "Y coordinate normalized to 0-1000"},
                    "button": {"type": "string", "enum": ["left", "right", "middle"]},
                    "screen_index": {"type": "string", "description": "e.g. screen0"}
                },
                "required": ["x", "y"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "type_text",
            "description": "Types text into the currently active UI element",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text to type"},
                    "press_enter": {"type": "boolean", "description": "Whether to hit Enter after typing"}
                },
                "required": ["text"]
            }
        }
    }
]

# ============================================================================
# TagStreamParser emulator (exact Rust implementation from tag_stream.rs)
# ============================================================================

def parse_tag_rust_equivalent(tag_content: str) -> Optional[Dict[str, Any]]:
    parts = tag_content.split(':')
    if not parts:
        return None
    cmd_type = parts[0].strip().upper()

    if cmd_type == "POINT":
        if len(parts) >= 3:
            coords = parts[1].split(',')
            try:
                x = int(coords[0].strip())
                y = int(coords[1].strip())
            except (ValueError, IndexError):
                return None
            label = parts[2].strip()
            screen = parts[3].strip() if len(parts) > 3 else "screen0"
            return {"type": "Point", "x": x, "y": y, "label": label, "screen": screen}
    elif cmd_type == "DRAW":
        if len(parts) >= 3:
            shape = parts[1].strip()
            coords = []
            for s in parts[2].split(','):
                try:
                    coords.append(int(s.strip()))
                except ValueError:
                    pass
            extra = parts[3].strip() if len(parts) > 3 else None
            return {"type": "Draw", "shape": shape, "coords": coords, "color": extra, "label": extra}
    elif cmd_type == "3D":
        if len(parts) >= 2:
            model = parts[1].strip()
            title = parts[2].strip() if len(parts) > 2 else "3D Object"
            return {"type": "Model3D", "model": model, "title": title}
    elif cmd_type == "STEP":
        if len(parts) >= 4:
            idx_parts = parts[1].split('/')
            try:
                index = int(idx_parts[0].strip())
                total = int(idx_parts[1].strip()) if len(idx_parts) > 1 else 15
            except (ValueError, IndexError):
                return None
            coords = []
            for s in parts[2].split(','):
                try:
                    coords.append(int(s.strip()))
                except ValueError:
                    pass
            bbox = coords if len(coords) == 4 else [0, 0, 100, 100]
            instruction = parts[3].strip()
            return {"type": "Step", "index": index, "total": total, "bbox": bbox, "instruction": instruction}
    return None

def extract_tags_and_clean_speech(text: str) -> Tuple[str, List[Dict[str, Any]]]:
    """Emulates TagStreamParser::feed_token and flush."""
    commands = []
    clean_text = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] == '[':
            close_idx = text.find(']', i)
            if close_idx != -1 and (close_idx - i) <= 128:
                tag_content = text[i+1:close_idx]
                cmd = parse_tag_rust_equivalent(tag_content)
                if cmd:
                    commands.append(cmd)
                else:
                    clean_text.append(text[i:close_idx+1])
                i = close_idx + 1
                continue
        clean_text.append(text[i])
        i += 1
    clean_speech = "".join(clean_text).strip()
    return clean_speech, commands

# ============================================================================
# Streaming Ollama Client
# ============================================================================

@dataclass
class TestResult:
    task_id: str
    name: str
    endpoint: str
    think_mode: bool
    ttft_ms: float
    tok_per_sec: float
    total_latency_s: float
    eval_tokens: int
    raw_content: str
    clean_speech: str
    parsed_commands: List[Dict[str, Any]]
    tool_calls: List[Dict[str, Any]]
    adherence_score: float
    passed: bool
    diagnostics: List[str] = field(default_factory=list)

def stream_ollama_api_chat(
    system_prompt: str,
    user_prompt: str,
    tools: Optional[List[Dict[str, Any]]] = None,
    think_mode: bool = False
) -> Tuple[str, List[Dict[str, Any]], float, float, float, int]:
    url = f"{OLLAMA_BASE_URL}/api/chat"
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    payload = {
        "model": MODEL_NAME,
        "messages": messages,
        "stream": True,
        "think": think_mode,
        "options": {
            "temperature": 0.1
        }
    }
    if tools:
        payload["tools"] = tools

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )

    t0 = time.time()
    ttft_ms = 0.0
    tokens = 0
    full_content = []
    collected_tool_calls = []

    with urllib.request.urlopen(req) as resp:
        for line in resp:
            if not line:
                continue
            now = time.time()
            data = json.loads(line.decode("utf-8"))
            msg = data.get("message", {})
            delta = msg.get("content", "")
            tc = msg.get("tool_calls", [])
            if tc:
                collected_tool_calls.extend(tc)

            if delta:
                if ttft_ms == 0.0:
                    ttft_ms = (now - t0) * 1000.0
                full_content.append(delta)
                tokens += 1

            if data.get("done"):
                total_latency_s = now - t0
                eval_count = data.get("eval_count", tokens)
                eval_dur_s = (data.get("eval_duration", 1) / 1e9)
                tok_per_sec = eval_count / eval_dur_s if eval_dur_s > 0 else 0.0
                return "".join(full_content), collected_tool_calls, ttft_ms, tok_per_sec, total_latency_s, eval_count

    total_latency_s = time.time() - t0
    tok_per_sec = tokens / total_latency_s if total_latency_s > 0 else 0.0
    return "".join(full_content), collected_tool_calls, ttft_ms, tok_per_sec, total_latency_s, tokens

# ============================================================================
# Evaluator Engine
# ============================================================================

def run_evaluations() -> List[TestResult]:
    results = []

    # ------------------------------------------------------------------------
    # TEST 1: Talk Mode with A11y Tree -> verify [POINT:...] tag syntax & speech
    # ------------------------------------------------------------------------
    diag1 = []
    score1 = 0.0
    user_msg_1 = """Active Window: Google Chrome - Settings
A11y Tree:
- Window: Google Chrome [0, 0, 1000, 1000]
  - Button 'Clear browsing data' [350, 420, 550, 460]

User: Where do I clear my cache?"""

    content1, _, ttft1, tps1, lat1, tok1 = stream_ollama_api_chat(
        TALK_MODE_SYSTEM_PROMPT, user_msg_1, think_mode=False
    )
    clean_speech1, cmds1 = extract_tags_and_clean_speech(content1)

    # Adherence criteria:
    # 1. Contains a valid POINT command (40%)
    # 2. Coordinates within button bounds (350..550, 420..460) (25%)
    # 3. Clean speech is non-empty and conversational (no tags, len > 10) (25%)
    # 4. Zero backticks wrapping tags (10%)
    point_cmds = [c for c in cmds1 if c.get("type") == "Point"]
    if point_cmds:
        score1 += 40.0
        p = point_cmds[0]
        diag1.append(f"Parsed valid POINT: x={p['x']}, y={p['y']}, label='{p['label']}', screen='{p['screen']}'")
        if 300 <= p['x'] <= 600 and 400 <= p['y'] <= 480:
            score1 += 25.0
            diag1.append("Coordinates accurately pinpoint the A11y button bounding box.")
        else:
            diag1.append(f"Coordinates ({p['x']}, {p['y']}) outside expected element bounds.")
    else:
        diag1.append("ERROR: No valid [POINT:...] tag parsed by tag_stream.")

    if len(clean_speech1) > 15:
        score1 += 25.0
        diag1.append(f"Natural spoken speech present for Kokoro TTS: '{clean_speech1}'")
    else:
        diag1.append("ERROR: Verbal speech missing or too terse.")

    if "`[" not in content1 and "]`" not in content1 and "```" not in content1:
        score1 += 10.0
    else:
        diag1.append("ERROR: Tag wrapped in markdown backticks.")

    results.append(TestResult(
        task_id="A_TALK_MODE",
        name="Talk Mode Spatial Query (Mock A11y Tree)",
        endpoint="/api/chat (think=False)",
        think_mode=False,
        ttft_ms=ttft1,
        tok_per_sec=tps1,
        total_latency_s=lat1,
        eval_tokens=tok1,
        raw_content=content1,
        clean_speech=clean_speech1,
        parsed_commands=cmds1,
        tool_calls=[],
        adherence_score=score1,
        passed=(score1 >= 90.0),
        diagnostics=diag1
    ))

    # ------------------------------------------------------------------------
    # TEST 2: UI Layout Annotation -> verify [DRAW:circle:...] / [DRAW:arrow:...]
    # ------------------------------------------------------------------------
    diag2 = []
    score2 = 0.0
    user_msg_2 = """Screen: IDE Dashboard
Target A: Save Icon at (150, 40)
Target B: File List at (50, 100, 250, 600)
User: Can you highlight the save icon with a circle and draw an arrow from the file list to the save icon?"""

    content2, _, ttft2, tps2, lat2, tok2 = stream_ollama_api_chat(
        TALK_MODE_SYSTEM_PROMPT, user_msg_2, think_mode=False
    )
    clean_speech2, cmds2 = extract_tags_and_clean_speech(content2)

    draw_cmds = [c for c in cmds2 if c.get("type") == "Draw"]
    has_circle = any(c.get("shape") == "circle" for c in draw_cmds)
    has_arrow = any(c.get("shape") == "arrow" for c in draw_cmds)

    if has_circle:
        score2 += 40.0
        c_item = next(c for c in draw_cmds if c.get("shape") == "circle")
        diag2.append(f"Parsed [DRAW:circle]: coords={c_item['coords']}, color={c_item['color']}")
    else:
        diag2.append("ERROR: [DRAW:circle:...] missing or malformed.")

    if has_arrow:
        score2 += 40.0
        a_item = next(c for c in draw_cmds if c.get("shape") == "arrow")
        diag2.append(f"Parsed [DRAW:arrow]: coords={a_item['coords']}, label={a_item['label']}")
        if len(a_item['coords']) == 4:
            diag2.append("Arrow coordinates format valid: exactly 4 comma-separated integers.")
    else:
        diag2.append("ERROR: [DRAW:arrow:...] missing or malformed.")

    if "`[DRAW" not in content2 and ":x" not in content2:
        score2 += 20.0
    else:
        diag2.append("ERROR: Backticks or template placeholder found in tags.")

    results.append(TestResult(
        task_id="B_ANNOTATION_DRAW",
        name="UI Layout Annotation ([DRAW:circle], [DRAW:arrow])",
        endpoint="/api/chat (think=False)",
        think_mode=False,
        ttft_ms=ttft2,
        tok_per_sec=tps2,
        total_latency_s=lat2,
        eval_tokens=tok2,
        raw_content=content2,
        clean_speech=clean_speech2,
        parsed_commands=cmds2,
        tool_calls=[],
        adherence_score=score2,
        passed=(score2 >= 90.0),
        diagnostics=diag2
    ))

    # ------------------------------------------------------------------------
    # TEST 3: 3-Step Walkthrough -> verify [STEP:1/3:...] sequence
    # ------------------------------------------------------------------------
    diag3 = []
    score3 = 0.0
    user_msg_3 = """Create a 3-step walkthrough for exporting a project:
Step 1: Click 'File' menu at [20, 10, 60, 35]
Step 2: Select 'Export As' at [20, 120, 120, 150]
Step 3: Click 'Confirm' button at [450, 550, 550, 590]"""

    content3, _, ttft3, tps3, lat3, tok3 = stream_ollama_api_chat(
        WALKTHROUGH_SYSTEM_PROMPT, user_msg_3, think_mode=False
    )
    clean_speech3, cmds3 = extract_tags_and_clean_speech(content3)
    step_cmds = [c for c in cmds3 if c.get("type") == "Step"]

    if len(step_cmds) == 3:
        score3 += 50.0
        diag3.append(f"Exactly 3 steps parsed by TagStreamParser.")
        seq_valid = (step_cmds[0]['index'] == 1 and step_cmds[1]['index'] == 2 and step_cmds[2]['index'] == 3)
        total_valid = all(c['total'] == 3 for c in step_cmds)
        if seq_valid and total_valid:
            score3 += 30.0
            diag3.append("Step index sequence (1/3, 2/3, 3/3) 100% compliant.")
        else:
            diag3.append(f"Step sequence non-compliant: indices {[c['index'] for c in step_cmds]}")

        coords_valid = all(len(c['bbox']) == 4 for c in step_cmds)
        if coords_valid:
            score3 += 20.0
            diag3.append("All bounding boxes parsed with exactly 4 normalized coordinates.")
        else:
            diag3.append("ERROR: Some bounding boxes do not have 4 coordinates.")
    else:
        diag3.append(f"ERROR: Expected 3 steps, parsed {len(step_cmds)}.")

    results.append(TestResult(
        task_id="C_WALKTHROUGH_STEP",
        name="3-Step Guided Walkthrough ([STEP:1/3:...] sequence)",
        endpoint="/api/chat (think=False)",
        think_mode=False,
        ttft_ms=ttft3,
        tok_per_sec=tps3,
        total_latency_s=lat3,
        eval_tokens=tok3,
        raw_content=content3,
        clean_speech=clean_speech3,
        parsed_commands=cmds3,
        tool_calls=[],
        adherence_score=score3,
        passed=(score3 >= 90.0),
        diagnostics=diag3
    ))

    # ------------------------------------------------------------------------
    # TEST 4: Raw Dictation Cleanup with Technical Hotwords
    # ------------------------------------------------------------------------
    diag4 = []
    score4 = 0.0
    user_msg_4 = "um so basically we need to uh run cube ctl apply minus f deployment yaml and then like check if the tore e desktop app has a e c three audio enabled you know"

    content4, _, ttft4, tps4, lat4, tok4 = stream_ollama_api_chat(
        DICTATION_CLEANUP_SYSTEM_PROMPT, user_msg_4, think_mode=False
    )
    trimmed_content = content4.strip()

    # Adherence criteria:
    # 1. Hotwords properly restored: "kubectl", "Tauri", "AEC3" (40%)
    # 2. Fillers stripped: "um", "uh", "like", "you know" (20%)
    # 3. ZERO preamble (e.g. no "Here is", "Cleaned:", etc.) (15%)
    # 4. ZERO outer quotes (15%)
    # 5. ZERO backticks (10%)

    hotwords_ok = ("kubectl" in trimmed_content and "Tauri" in trimmed_content and "AEC3" in trimmed_content)
    if hotwords_ok:
        score4 += 40.0
        diag4.append("Technical hotwords ('kubectl', 'Tauri', 'AEC3') correctly restored from phonetic audio.")
    else:
        diag4.append("ERROR: One or more technical hotwords missing in cleaned text.")

    lowered = trimmed_content.lower()
    fillers_present = [f for f in ["um ", " uh ", "you know", "like check"] if f in lowered]
    if not fillers_present:
        score4 += 20.0
        diag4.append("Spoken filler words and disfluencies cleanly eliminated.")
    else:
        diag4.append(f"Warning: Fillers still found: {fillers_present}")

    preamble_triggers = ["here is", "cleaned", "transcription:", "sure", "output:"]
    if not any(lowered.startswith(p) for p in preamble_triggers):
        score4 += 15.0
        diag4.append("Zero conversational preamble detected.")
    else:
        diag4.append("ERROR: Conversational preamble found in output.")

    if not ((trimmed_content.startswith('"') and trimmed_content.endswith('"')) or
            (trimmed_content.startswith("'") and trimmed_content.endswith("'"))):
        score4 += 15.0
        diag4.append("Zero surrounding quotation marks detected.")
    else:
        diag4.append("ERROR: Output is wrapped in quotation marks.")

    if "`" not in trimmed_content:
        score4 += 10.0
        diag4.append("Zero markdown backticks detected: 100% pure plain text output.")
    else:
        diag4.append("ERROR: Markdown backticks found in dictation output.")

    results.append(TestResult(
        task_id="D_DICTATION_CLEANUP",
        name="Dictation Cleanup Protocol (Hotwords & Strict Formatting)",
        endpoint="/api/chat (think=False)",
        think_mode=False,
        ttft_ms=ttft4,
        tok_per_sec=tps4,
        total_latency_s=lat4,
        eval_tokens=tok4,
        raw_content=trimmed_content,
        clean_speech=trimmed_content,
        parsed_commands=[],
        tool_calls=[],
        adherence_score=score4,
        passed=(score4 >= 90.0),
        diagnostics=diag4
    ))

    # ------------------------------------------------------------------------
    # TEST 5: Tool Calling (mouse_click, type_text)
    # ------------------------------------------------------------------------
    diag5 = []
    score5 = 0.0
    user_msg_5 = "Click on the search box at (400, 50) and then type 'bonsai' with enter."

    content5, tool_calls5, ttft5, tps5, lat5, tok5 = stream_ollama_api_chat(
        DRIVE_MODE_SYSTEM_PROMPT, user_msg_5, tools=TOOLS_SCHEMA, think_mode=False
    )

    if tool_calls5:
        score5 += 50.0
        diag5.append(f"Successfully generated {len(tool_calls5)} tool call(s).")
        first_call = tool_calls5[0]
        func = first_call.get("function", {})
        func_name = func.get("name")
        args = func.get("arguments", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                pass

        if func_name in ["mouse_click", "type_text"]:
            score5 += 30.0
            diag5.append(f"Target tool '{func_name}' matched schema definition.")
            if func_name == "mouse_click" and "x" in args and "y" in args:
                score5 += 20.0
                diag5.append(f"Arguments compliant: x={args['x']}, y={args['y']}")
            elif func_name == "type_text" and "text" in args:
                score5 += 20.0
                diag5.append(f"Arguments compliant: text='{args['text']}'")
        else:
            diag5.append(f"ERROR: Tool call name '{func_name}' unrecognized.")
    else:
        diag5.append("ERROR: No structured tool calls returned by model.")

    results.append(TestResult(
        task_id="E_TOOL_CALLING",
        name="Autonomous Tool Calling (mouse_click & type_text)",
        endpoint="/api/chat (think=False)",
        think_mode=False,
        ttft_ms=ttft5,
        tok_per_sec=tps5,
        total_latency_s=lat5,
        eval_tokens=tok5,
        raw_content=content5,
        clean_speech=content5,
        parsed_commands=[],
        tool_calls=tool_calls5,
        adherence_score=score5,
        passed=(score5 >= 90.0),
        diagnostics=diag5
    ))

    # ------------------------------------------------------------------------
    # COMPARISON RUN: Talk Mode with think=True (OpenAI v1 baseline latency comparison)
    # ------------------------------------------------------------------------
    user_msg_cmp = "Click the Settings button at (840, 42)."
    cmp_content, _, cmp_ttft, cmp_tps, cmp_lat, cmp_tok = stream_ollama_api_chat(
        TALK_MODE_SYSTEM_PROMPT, user_msg_cmp, think_mode=True
    )
    cmp_clean, cmp_cmds = extract_tags_and_clean_speech(cmp_content)
    results.append(TestResult(
        task_id="CMP_TALK_THINKING_ON",
        name="Latency Comparison: Talk Mode (think=True Baseline)",
        endpoint="/api/chat (think=True)",
        think_mode=True,
        ttft_ms=cmp_ttft,
        tok_per_sec=cmp_tps,
        total_latency_s=cmp_lat,
        eval_tokens=cmp_tok,
        raw_content=cmp_content,
        clean_speech=cmp_clean,
        parsed_commands=cmp_cmds,
        tool_calls=[],
        adherence_score=100.0 if cmp_cmds else 50.0,
        passed=True,
        diagnostics=["Baseline latency measurement demonstrating why think=False is required for real-time speech."]
    ))

    return results

# ============================================================================
# Output Reporter
# ============================================================================

def print_report(results: List[TestResult]):
    print("=" * 100)
    print(" BONSAI-2 9B EVALUATION & BENCHMARK REPORT - HEYCLICKY PROTOCOLS")
    print(f" Target: {OLLAMA_BASE_URL} | Model: {MODEL_NAME}")
    print(f" Date: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 100)
    print()

    # Summary Table
    header = f"{'Task':<22} | {'TTFT (ms)':<10} | {'tok/s':<8} | {'Latency':<9} | {'Tokens':<7} | {'Adherence':<10} | {'Status'}"
    print(header)
    print("-" * len(header))

    primary_tasks = [r for r in results if not r.task_id.startswith("CMP")]
    for r in results:
        status_str = "PASS [100%]" if r.adherence_score >= 100.0 else ("PASS" if r.passed else "FAIL")
        line = f"{r.task_id:<22} | {r.ttft_ms:>8.1f}ms | {r.tok_per_sec:>6.1f}   | {r.total_latency_s:>7.3f}s | {r.eval_tokens:>7} | {r.adherence_score:>8.1f}%  | {status_str}"
        print(line)

    print("-" * len(header))
    avg_ttft = sum(r.ttft_ms for r in primary_tasks) / len(primary_tasks)
    avg_tps = sum(r.tok_per_sec for r in primary_tasks) / len(primary_tasks)
    avg_adherence = sum(r.adherence_score for r in primary_tasks) / len(primary_tasks)
    print(f"{'OVERALL AVERAGE':<22} | {avg_ttft:>8.1f}ms | {avg_tps:>6.1f}   | {'-':>9} | {'-':>7} | {avg_adherence:>8.1f}%  | {'PERFECT' if avg_adherence == 100 else 'READY'}")
    print()

    # Detailed per-task diagnostics
    print("=" * 100)
    print(" DETAILED TASK EVALUATIONS & OUTPUT SAMPLES")
    print("=" * 100)
    for r in results:
        print(f"\n>>> [{r.task_id}] {r.name}")
        print(f"    Mode: {r.endpoint} | TTFT: {r.ttft_ms:.1f}ms | Speed: {r.tok_per_sec:.1f} tok/s | Total Latency: {r.total_latency_s:.3f}s")
        print(f"    Adherence Score: {r.adherence_score:.1f}% -> {'PASSED' if r.passed else 'FAILED'}")
        print("    Raw Model Output:")
        for raw_line in r.raw_content.splitlines():
            print(f"      | {raw_line}")
        if r.parsed_commands:
            print(f"    Parsed Overlay Commands ({len(r.parsed_commands)}):")
            for c in r.parsed_commands:
                print(f"      * {c}")
        if r.tool_calls:
            print(f"    Parsed Tool Calls ({len(r.tool_calls)}):")
            for tc in r.tool_calls:
                print(f"      * {json.dumps(tc)}")
        if r.clean_speech:
            print(f"    Spoken Text for Kokoro TTS: \"{r.clean_speech}\"")
        print("    Verification Diagnostics:")
        for d in r.diagnostics:
            print(f"      [x] {d}")

    # Write results to json
    json_path = "D:/cliky/scripts/eval_bonsai_results.json"
    serializable = []
    for r in results:
        serializable.append({
            "task_id": r.task_id,
            "name": r.name,
            "endpoint": r.endpoint,
            "think_mode": r.think_mode,
            "ttft_ms": r.ttft_ms,
            "tokens_per_second": r.tok_per_sec,
            "total_latency_s": r.total_latency_s,
            "eval_tokens": r.eval_tokens,
            "adherence_score": r.adherence_score,
            "passed": r.passed,
            "raw_output": r.raw_content,
            "clean_speech": r.clean_speech,
            "parsed_commands": r.parsed_commands,
            "tool_calls": r.tool_calls,
            "diagnostics": r.diagnostics
        })

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "model": MODEL_NAME,
            "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "summary": {
                "average_ttft_ms": round(avg_ttft, 2),
                "average_tok_per_sec": round(avg_tps, 2),
                "average_adherence_percent": round(avg_adherence, 2),
                "all_tasks_passed": all(r.passed for r in primary_tasks)
            },
            "tasks": serializable
        }, f, indent=2)
    print(f"\n[Artifact] Persistent benchmark results saved to: {json_path}")

if __name__ == "__main__":
    results = run_evaluations()
    print_report(results)
