# HeyClicky Python Vision Sidecar (`sidecar-vision`)

The **Vision Sidecar** is a high-performance FastAPI microservice running on `http://127.0.0.1:8765`. It provides **OmniParser v2.0** UI element detection and captioning for visual screen grounding, plus a **Chatterbox-Turbo** zero-shot voice cloning endpoint.

---

## 1. Quick Start

### Option A: CPU Mode (Default / Ultralight)
```bash
cd sidecar-vision

# Create virtual environment
python -m venv .venv

# Activate environment
# Windows:
.\.venv\Scripts\Activate.ps1
# Linux / macOS:
source .venv/bin/activate

# Install dependencies for CPU
pip install --upgrade pip
pip install fastapi "uvicorn[standard]" pydantic pillow transformers numpy python-multipart
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install onnxruntime
```

### Option B: NVIDIA GPU Acceleration (CUDA 12.x)
For systems with an NVIDIA RTX GPU (6 GB+ VRAM):
```bash
# In your active virtual environment:
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
pip install onnxruntime-gpu
pip install ultralytics timm einops
```

---

## 2. Running the Server

Start the sidecar using standard Python:
```bash
python server.py --host 127.0.0.1 --port 8765
```

Command-Line Options:
- `--host`: Interface to bind (default: `127.0.0.1`).
- `--port`: Port number (default: `8765`).
- `--device`: Compute device: `cuda`, `cpu`, or `mps`.
- `--weights-dir`: Path to OmniParser v2 weights directory.

---

## 3. Dual Detection Modes: Model vs Fallback Heuristic

The sidecar features a **zero-crash dual execution mode**:
1. **Model Mode (OmniParser v2):** Active when `microsoft/OmniParser-v2.0` weights exist in `~/.heyclicky/models/omniparser_v2/`. It runs YOLOv9-E (`icon_detect_v3`) for icon/button detection and Florence-2 for semantic element captioning.
2. **Fallback Heuristic Mode:** Automatically engages when neural weights are absent. It uses pure PIL edge detection, gradient clustering, and geometric analysis to locate interactive buttons, search inputs, icons, and menus without consuming GPU VRAM or requiring multi-gigabyte downloads.

---

## 4. API Endpoints

### 1. `GET /health`
Returns service status, GPU availability, active device, and detection mode.
```bash
curl -X GET http://127.0.0.1:8765/health
```

**Example Response:**
```json
{
  "status": "healthy",
  "service": "heyclicky-sidecar-vision",
  "port": 8765,
  "cuda_available": true,
  "device_name": "NVIDIA GeForce RTX 4050 Laptop GPU",
  "parser_loaded": true,
  "parser_mode": "fallback_heuristic",
  "active_device": "cuda"
}
```

### 2. `POST /parse_screen`
Accepts a base64 encoded screenshot and returns detected UI elements with bounding boxes and normalized spatial tags (`[POINT:x,y:label]`).
```bash
curl -X POST http://127.0.0.1:8765/parse_screen \
  -H "Content-Type: application/json" \
  -d '{"screenshot": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}'
```

**Example Response:**
```json
{
  "success": true,
  "mode": "fallback_heuristic",
  "device": "cuda",
  "image_size": { "width": 1920, "height": 1080 },
  "element_count": 12,
  "elements": [
    {
      "id": 1,
      "type": "button",
      "bbox": [1400, 360, 1480, 396],
      "normalized_bbox": [729, 333, 770, 366],
      "center": [1440, 378],
      "normalized_center": [750, 350],
      "label": "Button #1",
      "confidence": 0.85,
      "interactivity": true
    }
  ],
  "spatial_tags": [
    "[POINT:750,350:Button #1]"
  ]
}
```

### 3. `POST /voice_clone`
Stub endpoint for optional Chatterbox-Turbo zero-shot voice cloning.
```bash
curl -X POST http://127.0.0.1:8765/voice_clone \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is HeyClicky speaking."}'
```
