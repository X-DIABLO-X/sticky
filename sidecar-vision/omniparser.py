"""
OmniParser v2 Wrapper & UI Element Grounder
Part of the HeyClicky Desktop Assistant Vision Pipeline.

Wraps Microsoft's OmniParser v2.0 (icon_detect_v3 + Florence-2 captioner)
with a robust fallback bounding-box heuristic that functions out-of-the-box
even before multi-gigabyte neural weights are downloaded.
"""

from __future__ import annotations
import base64
import io
import math
import os
import sys
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Optional, Tuple

from PIL import Image, ImageFilter, ImageOps


@dataclass
class UIElement:
    id: int
    type: str  # "icon", "button", "input", "text", "container"
    bbox: List[int]  # [x1, y1, x2, y2] in pixels
    normalized_bbox: List[int]  # [x1, y1, x2, y2] in 0..1000 scale
    center: List[int]  # [cx, cy] in pixels
    normalized_center: List[int]  # [cx, cy] in 0..1000 scale
    label: str
    confidence: float
    interactivity: bool


class OmniParserV2:
    def __init__(
        self,
        weights_dir: Optional[str] = None,
        device: Optional[str] = None,
        box_threshold: float = 0.05,
        iou_threshold: float = 0.1,
    ):
        self.weights_dir = weights_dir or os.environ.get(
            "OMNIPARSER_WEIGHTS_DIR",
            os.path.join(os.path.expanduser("~"), ".heyclicky", "models", "omniparser_v2")
        )
        self.device = device or self._detect_device()
        self.box_threshold = box_threshold
        self.iou_threshold = iou_threshold

        self.detect_model = None
        self.caption_model = None
        self.caption_processor = None
        self.mode = "fallback_heuristic"
        self.is_loaded = False

        self._try_load_weights()

    def _detect_device(self) -> str:
        try:
            import torch
            if torch.cuda.is_available():
                return "cuda"
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                return "mps"
        except Exception:
            pass
        return "cpu"

    def _try_load_weights(self):
        """Attempt loading full OmniParser v2 weights; fallback gracefully if absent."""
        detect_path = os.path.join(self.weights_dir, "icon_detect", "model.pt")
        detect_onnx = os.path.join(self.weights_dir, "icon_detect", "model.onnx")
        caption_dir = os.path.join(self.weights_dir, "icon_caption")

        if os.path.exists(detect_path) or os.path.exists(detect_onnx):
            try:
                # Attempt importing torch / transformers
                import torch
                from transformers import AutoProcessor, AutoModelForCausalLM

                print(f"[OmniParserV2] Loading icon detection from {self.weights_dir} on {self.device}...")
                # If YOLO model exists:
                if os.path.exists(detect_path):
                    from ultralytics import YOLO
                    self.detect_model = YOLO(detect_path)
                
                # If Florence-2 captioner exists:
                if os.path.exists(caption_dir):
                    print(f"[OmniParserV2] Loading Florence-2 captioner from {caption_dir}...")
                    self.caption_processor = AutoProcessor.from_pretrained(caption_dir, trust_remote_code=True)
                    self.caption_model = AutoModelForCausalLM.from_pretrained(
                        caption_dir,
                        torch_dtype=torch.float16 if self.device == "cuda" else torch.float32,
                        trust_remote_code=True
                    ).to(self.device).eval()

                self.mode = "model"
                self.is_loaded = True
                print("[OmniParserV2] Model loaded successfully.")
                return
            except Exception as e:
                print(f"[OmniParserV2] Could not initialize neural weights ({e}). Falling back to heuristic mode.")

        # Fallback heuristic mode
        self.mode = "fallback_heuristic"
        self.is_loaded = True
        print(f"[OmniParserV2] Running in fallback bounding-box heuristic mode (device: {self.device}).")

    def parse_screen_base64(self, b64_string: str) -> Dict[str, Any]:
        """Decode base64 image data and parse UI elements."""
        if "," in b64_string:
            b64_string = b64_string.split(",", 1)[1]
        raw_bytes = base64.b64decode(b64_string)
        image = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
        return self.parse_image(image)

    def parse_image(self, image: Image.Image) -> Dict[str, Any]:
        """Parse image using either OmniParser v2 neural models or heuristic edge detector."""
        width, height = image.size

        if self.mode == "model" and self.detect_model is not None:
            elements = self._parse_with_model(image)
        else:
            elements = self._parse_with_heuristic(image)

        # Generate spatial tags for Clicky Agent routing: [POINT:x,y:label]
        tag_lines = []
        for el in elements:
            cx_norm, cy_norm = el.normalized_center
            tag_lines.append(f"[POINT:{cx_norm},{cy_norm}:{el.label}]")

        return {
            "success": True,
            "mode": self.mode,
            "device": self.device,
            "image_size": {"width": width, "height": height},
            "element_count": len(elements),
            "elements": [asdict(el) for el in elements],
            "spatial_tags": tag_lines
        }

    def _parse_with_model(self, image: Image.Image) -> List[UIElement]:
        """Inference with YOLOv9-E icon_detect and Florence-2 captioner."""
        width, height = image.size
        elements: List[UIElement] = []

        try:
            results = self.detect_model(image, conf=self.box_threshold, iou=self.iou_threshold)[0]
            boxes = results.boxes.xyxy.cpu().numpy()
            confs = results.boxes.conf.cpu().numpy()
            classes = results.boxes.cls.cpu().numpy()

            for idx, (box, conf, cls_idx) in enumerate(zip(boxes, confs, classes)):
                x1, y1, x2, y2 = [int(v) for v in box]
                # Clamp coordinates
                x1 = max(0, min(width - 1, x1))
                y1 = max(0, min(height - 1, y1))
                x2 = max(0, min(width, x2))
                y2 = max(0, min(height, y2))

                if x2 - x1 < 6 or y2 - y1 < 6:
                    continue

                cx = (x1 + x2) // 2
                cy = (y1 + y2) // 2
                nx1 = int((x1 / width) * 1000)
                ny1 = int((y1 / height) * 1000)
                nx2 = int((x2 / width) * 1000)
                ny2 = int((y2 / height) * 1000)
                ncx = (nx1 + nx2) // 2
                ncy = (ny1 + ny2) // 2

                # Optional captioning via Florence-2 if crop is valid
                label = f"UI Element #{idx + 1}"
                if self.caption_model and self.caption_processor:
                    try:
                        crop = image.crop((x1, y1, x2, y2))
                        inputs = self.caption_processor(
                            text="<CAPTION>",
                            images=crop,
                            return_tensors="pt"
                        ).to(self.device)
                        generated_ids = self.caption_model.generate(
                            input_ids=inputs["input_ids"],
                            pixel_values=inputs["pixel_values"],
                            max_new_tokens=24
                        )
                        caption = self.caption_processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
                        if caption and len(caption.strip()) > 0:
                            label = caption.strip()
                    except Exception:
                        pass

                elements.append(
                    UIElement(
                        id=idx + 1,
                        type="icon" if int(cls_idx) == 0 else "button",
                        bbox=[x1, y1, x2, y2],
                        normalized_bbox=[nx1, ny1, nx2, ny2],
                        center=[cx, cy],
                        normalized_center=[ncx, ncy],
                        label=label,
                        confidence=round(float(conf), 3),
                        interactivity=True,
                    )
                )
        except Exception as e:
            print(f"[OmniParserV2] Inference error: {e}. Falling back to heuristic.")
            return self._parse_with_heuristic(image)

        return elements

    def _parse_with_heuristic(self, image: Image.Image) -> List[UIElement]:
        """
        Fast, lightweight heuristic detector.
        Identifies high-contrast UI regions, buttons, search bars, and icons
        without requiring neural network weights.
        """
        width, height = image.size
        # Downscale for fast grid analysis if image is huge
        max_dim = 1280
        scale = 1.0
        if max(width, height) > max_dim:
            scale = max_dim / max(width, height)
            proc_w = int(width * scale)
            proc_h = int(height * scale)
            proc_img = image.resize((proc_w, proc_h), Image.Resampling.BILINEAR)
        else:
            proc_w, proc_h = width, height
            proc_img = image

        # Grayscale and edge filter
        gray = ImageOps.grayscale(proc_img)
        edges = gray.filter(ImageFilter.FIND_EDGES)

        # Discretize screen into candidate UI blocks
        block_w = max(16, proc_w // 40)
        block_h = max(16, proc_h // 30)
        
        edge_data = edges.load()
        candidates: List[Tuple[int, int, int, int]] = []

        # Find regions with high gradient activity (indicative of icons, buttons, text clusters)
        for gy in range(0, proc_h - block_h, block_h):
            for gx in range(0, proc_w - block_w, block_w):
                # Sample edge intensity in block
                intensity = 0
                sample_count = 0
                step = max(2, block_w // 4)
                for py in range(gy, gy + block_h, step):
                    for px in range(gx, gx + block_w, step):
                        intensity += edge_data[px, py]
                        sample_count += 1
                
                avg_intensity = intensity / max(1, sample_count)
                if avg_intensity > 28:
                    candidates.append((gx, gy, gx + block_w, gy + block_h))

        # Merge adjacent candidate blocks
        merged = self._merge_boxes(candidates, iou_thresh=0.08)

        elements: List[UIElement] = []
        for idx, (bx1, by1, bx2, by2) in enumerate(merged[:40]):  # Cap at top 40 candidates
            # Map back to original image coordinates
            orig_x1 = int(bx1 / scale)
            orig_y1 = int(by1 / scale)
            orig_x2 = min(width, int(bx2 / scale))
            orig_y2 = min(height, int(by2 / scale))

            bw = orig_x2 - orig_x1
            bh = orig_y2 - orig_y1

            if bw < 10 or bh < 10:
                continue

            # Classify element type based on geometry
            aspect = bw / max(1, bh)
            if aspect > 3.0 and bh < 60:
                el_type = "input"
                label = f"Text Field / Input #{idx + 1}"
            elif 0.7 <= aspect <= 1.4 and bw <= 70:
                el_type = "icon"
                label = f"Icon Button #{idx + 1}"
            elif 1.4 < aspect <= 3.5 and bh <= 70:
                el_type = "button"
                label = f"Button #{idx + 1}"
            else:
                el_type = "container"
                label = f"Interactive Region #{idx + 1}"

            cx = (orig_x1 + orig_x2) // 2
            cy = (orig_y1 + orig_y2) // 2
            nx1 = int((orig_x1 / width) * 1000)
            ny1 = int((orig_y1 / height) * 1000)
            nx2 = int((orig_x2 / width) * 1000)
            ny2 = int((orig_y2 / height) * 1000)
            ncx = (nx1 + nx2) // 2
            ncy = (ny1 + ny2) // 2

            elements.append(
                UIElement(
                    id=idx + 1,
                    type=el_type,
                    bbox=[orig_x1, orig_y1, orig_x2, orig_y2],
                    normalized_bbox=[nx1, ny1, nx2, ny2],
                    center=[cx, cy],
                    normalized_center=[ncx, ncy],
                    label=label,
                    confidence=0.85,
                    interactivity=True,
                )
            )

        return elements

    def _merge_boxes(self, boxes: List[Tuple[int, int, int, int]], iou_thresh: float) -> List[Tuple[int, int, int, int]]:
        """Greedy non-maximum clustering for bounding boxes."""
        if not boxes:
            return []

        merged: List[List[int]] = []
        for b in boxes:
            bx1, by1, bx2, by2 = b
            matched = False
            for m in merged:
                # Check proximity / intersection
                inter_x1 = max(bx1, m[0])
                inter_y1 = max(by1, m[1])
                inter_x2 = min(bx2, m[2])
                inter_y2 = min(by2, m[3])

                is_intersecting = (inter_x1 <= inter_x2 + 8) and (inter_y1 <= inter_y2 + 8)
                if is_intersecting:
                    m[0] = min(m[0], bx1)
                    m[1] = min(m[1], by1)
                    m[2] = max(m[2], bx2)
                    m[3] = max(m[3], by2)
                    matched = True
                    break
            if not matched:
                merged.append([bx1, by1, bx2, by2])

        return [(m[0], m[1], m[2], m[3]) for m in merged]
