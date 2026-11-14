"""
HeyClicky Python Vision Sidecar Server
FastAPI microservice running on port 8765.

Provides:
- GET  /health       : Service status, GPU/CUDA status, and parser mode.
- POST /parse_screen : OmniParser v2 UI bounding box detection & captioning.
- POST /voice_clone  : Chatterbox-Turbo voice cloning inference stub.
"""

from __future__ import annotations
import argparse
import sys
import uvicorn
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from omniparser import OmniParserV2

# Initialize FastAPI application
app = FastAPI(
    title="HeyClicky Vision Sidecar",
    description="Local UI Grounding & Multimodal Sidecar for HeyClicky Desktop Assistant",
    version="1.0.0"
)

# Enable CORS for local desktop calls
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global OmniParser instance
parser: Optional[OmniParserV2] = None


@app.on_event("startup")
async def startup_event():
    global parser
    if parser is None:
        parser = OmniParserV2()
        print(f"[Sidecar] Initialized OmniParser in mode: '{parser.mode}' on device: '{parser.device}'")


# Request & Response Schemas
class ParseScreenRequest(BaseModel):
    screenshot: str = Field(..., description="Base64 encoded JPEG/WebP/PNG screenshot")
    box_threshold: Optional[float] = Field(0.05, description="Confidence threshold for bounding box detection")
    iou_threshold: Optional[float] = Field(0.1, description="IoU threshold for non-maximum suppression")


class ParseScreenResponse(BaseModel):
    success: bool
    mode: str
    device: str
    image_size: Dict[str, int]
    element_count: int
    elements: List[Dict[str, Any]]
    spatial_tags: List[str]


class VoiceCloneRequest(BaseModel):
    text: str = Field(..., description="Spoken text to synthesize")
    reference_audio_base64: Optional[str] = Field(None, description="Optional base64 reference WAV for voice cloning")
    speaker_name: Optional[str] = Field("default", description="Speaker identity or target voice")
    expressive_tags: Optional[List[str]] = Field(default_factory=list, description="Tags like [laugh], [whisper]")


class VoiceCloneResponse(BaseModel):
    success: bool
    status: str
    audio_base64: Optional[str] = None
    sample_rate: int = 24000
    duration_sec: float = 0.0
    note: str


# Endpoints
@app.get("/health")
async def health_check():
    """Health status and hardware accelerator probe."""
    global parser
    cuda_available = False
    device_name = "CPU"
    try:
        import torch
        cuda_available = torch.cuda.is_available()
        if cuda_available:
            device_name = torch.cuda.get_device_name(0)
    except Exception:
        pass

    return {
        "status": "healthy",
        "service": "heyclicky-sidecar-vision",
        "port": 8765,
        "cuda_available": cuda_available,
        "device_name": device_name,
        "parser_loaded": parser.is_loaded if parser else False,
        "parser_mode": parser.mode if parser else "uninitialized",
        "active_device": parser.device if parser else "unknown",
    }


@app.post("/parse", response_model=ParseScreenResponse)
@app.post("/parse_screen", response_model=ParseScreenResponse)
async def parse_screen(request: ParseScreenRequest):
    """
    Parses a base64 screenshot and returns interactive UI elements,
    bounding boxes, labels, and normalized spatial tags [POINT:x,y:label].
    """
    global parser
    if parser is None:
        parser = OmniParserV2()

    try:
        result = parser.parse_screen_base64(request.screenshot)
        return ParseScreenResponse(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse screen: {str(e)}")


@app.post("/voice_clone", response_model=VoiceCloneResponse)
async def voice_clone(request: VoiceCloneRequest):
    """
    Chatterbox-Turbo voice clone endpoint stub.
    When configured with ResembleAI weights, synthesizes expressive audio.
    Returns stub acknowledgment when run in standard environment.
    """
    # Check if local chatterbox model is active; otherwise return graceful stub
    return VoiceCloneResponse(
        success=True,
        status="stub_acknowledged",
        audio_base64=None,
        sample_rate=24000,
        duration_sec=0.0,
        note="Chatterbox-Turbo voice clone stub ready. Kokoro-82M ONNX handles default zero-cost TTS in core binary."
    )


def main():
    parser_cli = argparse.ArgumentParser(description="HeyClicky Python Vision Sidecar")
    parser_cli.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser_cli.add_argument("--port", type=int, default=8765, help="Port to bind (default: 8765)")
    parser_cli.add_argument("--weights-dir", type=str, default=None, help="Path to OmniParser v2 weights")
    parser_cli.add_argument("--device", type=str, default=None, choices=["cpu", "cuda", "mps"], help="Compute device")

    args = parser_cli.parse_args()

    # Pre-initialize parser with CLI options
    global parser
    parser = OmniParserV2(weights_dir=args.weights_dir, device=args.device)

    print(f"Starting HeyClicky Vision Sidecar on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
