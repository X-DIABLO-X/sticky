import asyncio
import base64
import contextlib
import io
import json
import os
import sys
import wave
from typing import Optional, Tuple

DEFAULT_KOKORO_VOICE = os.environ.get("STICKY_KOKORO_VOICE", "af_heart")
try:
    DEFAULT_KOKORO_SPEED = float(os.environ.get("STICKY_KOKORO_SPEED", "1.0"))
except ValueError:
    DEFAULT_KOKORO_SPEED = 1.0

DEFAULT_EDGE_VOICE = os.environ.get("STICKY_TTS_VOICE", "en-US-AvaMultilingualNeural")
DEFAULT_EDGE_RATE = os.environ.get("STICKY_TTS_RATE", "+10%")

_raw_length_scale = os.environ.get("STICKY_PIPER_LENGTH_SCALE", "").strip()
try:
    PIPER_LENGTH_SCALE: Optional[float] = float(_raw_length_scale) if _raw_length_scale else None
except ValueError:
    PIPER_LENGTH_SCALE = None


def load_kokoro_pipeline():
    """Load and warm up Kokoro-82M neural TTS pipeline using CUDA GPU or CPU."""
    try:
        import torch
        from kokoro import KPipeline

        device = "cuda" if torch.cuda.is_available() else "cpu"
        with contextlib.redirect_stdout(sys.stderr):
            pipeline = KPipeline(lang_code="a", device=device)
            # Warm up pipeline with a micro-utterance
            try:
                for _ in pipeline("ok", voice=DEFAULT_KOKORO_VOICE):
                    pass
            except Exception as warm_exc:
                print(f"[neural_tts] Kokoro warmup warning: {warm_exc}", file=sys.stderr, flush=True)

        print(f"[neural_tts] Kokoro-82M loaded successfully on {device.upper()}", file=sys.stderr, flush=True)
        return pipeline, device
    except Exception as exc:
        print(f"[neural_tts] Kokoro unavailable ({exc}); fallback to Piper/Edge-TTS", file=sys.stderr, flush=True)
        return None, "none"


def synthesize_kokoro_pcm(
    pipeline,
    text: str,
    voice: str = DEFAULT_KOKORO_VOICE,
    speed: float = DEFAULT_KOKORO_SPEED,
) -> Tuple[bytes, int, int]:
    """Synthesize text in-memory with Kokoro-82M into raw 24kHz mono PCM16 bytes."""
    import numpy as np

    chunks = []
    generator = pipeline(text, voice=voice, speed=speed)
    for gs, ps, audio in generator:
        if audio is not None and len(audio) > 0:
            chunks.append(audio)

    if not chunks:
        raise RuntimeError("Kokoro produced empty audio")

    total_audio = np.concatenate(chunks)
    pcm_i16 = (np.clip(total_audio, -1.0, 1.0) * 32767.0).astype("<i2", copy=False)
    return pcm_i16.tobytes(), 24000, 1


def find_piper_model() -> Optional[str]:
    env_model = os.environ.get("STICKY_PIPER_MODEL", "").strip()
    if env_model and os.path.isfile(env_model):
        return env_model

    piper_dir = os.path.expanduser("~/.heyclicky/models/piper")
    preferred = os.path.join(piper_dir, "en_US-lessac-medium.onnx")
    if os.path.isfile(preferred):
        return preferred

    if os.path.isdir(piper_dir):
        for name in sorted(os.listdir(piper_dir)):
            if name.endswith(".onnx"):
                candidate = os.path.join(piper_dir, name)
                if os.path.isfile(candidate):
                    return candidate

    return None


def load_piper_voice():
    """Load and warm up local Piper ONNX neural voice if installed and model is present."""
    model_path = find_piper_model()
    if not model_path:
        return None

    try:
        from piper import PiperVoice

        with contextlib.redirect_stdout(sys.stderr):
            voice = PiperVoice.load(model_path)
            try:
                if hasattr(voice, "synthesize"):
                    for _ in voice.synthesize("ok"):
                        pass
                elif hasattr(voice, "synthesize_stream_raw"):
                    for _ in voice.synthesize_stream_raw("ok"):
                        pass
            except Exception as warm_exc:
                print(f"[neural_tts] Piper warmup warning: {warm_exc}", file=sys.stderr, flush=True)
        return voice
    except Exception as exc:
        print(f"[neural_tts] Piper unavailable ({exc}); will use Edge-TTS fallback.", file=sys.stderr, flush=True)
        return None


def synthesize_piper_pcm(voice, text: str) -> Tuple[bytes, int, int]:
    """Synthesize text in-memory with local Piper ONNX into raw mono PCM16 bytes."""
    default_sr = int(getattr(getattr(voice, "config", None), "sample_rate", 22050) or 22050)

    if hasattr(voice, "synthesize"):
        syn_cfg = None
        if PIPER_LENGTH_SCALE is not None:
            try:
                from piper import SynthesisConfig

                syn_cfg = SynthesisConfig(length_scale=PIPER_LENGTH_SCALE)
            except Exception:
                syn_cfg = None

        chunks = []
        sample_rate = default_sr
        channels = 1
        with contextlib.redirect_stdout(sys.stderr):
            iterator = (
                voice.synthesize(text, syn_config=syn_cfg)
                if syn_cfg is not None
                else voice.synthesize(text)
            )
            for chunk in iterator:
                if hasattr(chunk, "audio_int16_bytes"):
                    chunks.append(chunk.audio_int16_bytes)
                    sample_rate = int(getattr(chunk, "sample_rate", sample_rate) or sample_rate)
                    channels = int(getattr(chunk, "sample_channels", channels) or channels)
                elif isinstance(chunk, (bytes, bytearray)):
                    chunks.append(bytes(chunk))

        pcm = b"".join(chunks)
        if not pcm:
            raise RuntimeError("Piper returned empty audio")
        return pcm, sample_rate, channels

    if hasattr(voice, "synthesize_stream_raw"):
        with contextlib.redirect_stdout(sys.stderr):
            pcm = b"".join(voice.synthesize_stream_raw(text))
        if not pcm:
            raise RuntimeError("Piper returned empty audio stream")
        return pcm, default_sr, 1

    raise RuntimeError("Unsupported PiperVoice API")


async def synthesize_edge_pcm(
    text: str,
    voice: str = DEFAULT_EDGE_VOICE,
    rate: str = DEFAULT_EDGE_RATE,
) -> Tuple[bytes, int, int]:
    """Synthesize text via warm edge-tts and decode MP3 -> 24kHz mono PCM16 in-memory."""
    import av
    import edge_tts
    import numpy as np

    comm = edge_tts.Communicate(text, voice=voice, rate=rate)
    mp3_buf = bytearray()
    async for chunk in comm.stream():
        if chunk.get("type") == "audio":
            mp3_buf.extend(chunk["data"])

    if not mp3_buf:
        raise RuntimeError("Edge-TTS returned empty audio stream")

    container = av.open(io.BytesIO(mp3_buf))
    try:
        resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=24000)
        pcm_chunks = []
        for frame in container.decode(audio=0):
            for resampled in resampler.resample(frame):
                pcm_chunks.append(resampled.to_ndarray().flatten())
        for resampled in resampler.resample(None):
            pcm_chunks.append(resampled.to_ndarray().flatten())
    finally:
        container.close()

    if not pcm_chunks:
        raise RuntimeError("Failed to decode MP3 audio from Edge-TTS")

    pcm_i16 = np.concatenate(pcm_chunks).astype("<i2", copy=False)
    return pcm_i16.tobytes(), 24000, 1


def write_wav_file(out_wav: str, pcm_bytes: bytes, sample_rate: int, channels: int = 1) -> None:
    with wave.open(out_wav, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)


async def synthesize_to_wav(
    text: str,
    out_wav: str,
    voice: str = DEFAULT_EDGE_VOICE,
    rate: str = DEFAULT_EDGE_RATE,
) -> None:
    pcm_bytes, sample_rate, channels = await synthesize_edge_pcm(text, voice=voice, rate=rate)
    write_wav_file(out_wav, pcm_bytes, sample_rate, channels)


def _write_protocol_response(out_buf, header: dict, pcm_bytes: bytes = b"") -> None:
    line = (json.dumps(header, separators=(",", ":")) + "\n").encode("utf-8")
    out_buf.write(line)
    if pcm_bytes:
        out_buf.write(pcm_bytes)
    out_buf.flush()


def run_daemon() -> None:
    """Persistent warm stdio TTS daemon.

    Startup: writes `READY kokoro\\n` or `READY piper\\n` or `READY edge\\n`.
    Request (JSON line on stdin): `{"text": "...", "engine": "auto"}`
    Response (stdout): JSON header line `{"ok": true, "sample_rate": 24000, "channels": 1, "pcm_len": N, "engine": "kokoro"}\\n`
                       immediately followed by `N` raw little-endian PCM16 bytes.
    """
    proto_out = sys.stdout.buffer
    proto_in = sys.stdin.buffer

    kokoro_pipeline, kokoro_device = load_kokoro_pipeline()
    piper_voice = load_piper_voice()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    if kokoro_pipeline is not None:
        ready_engine = "kokoro"
    elif piper_voice is not None:
        ready_engine = "piper"
    else:
        ready_engine = "edge"

    proto_out.write(f"READY {ready_engine}\n".encode("utf-8"))
    proto_out.flush()

    try:
        while True:
            raw_line = proto_in.readline()
            if not raw_line:
                break

            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                req = json.loads(line)
            except Exception as exc:
                _write_protocol_response(proto_out, {"ok": False, "error": f"Invalid JSON: {exc}"})
                continue

            if not isinstance(req, dict):
                _write_protocol_response(proto_out, {"ok": False, "error": "Request must be a JSON object"})
                continue

            if req.get("cmd") in ("quit", "exit", "shutdown"):
                _write_protocol_response(proto_out, {"ok": True, "sample_rate": 24000, "channels": 1, "pcm_len": 0, "engine": "none"})
                break

            text = str(req.get("text", "")).strip()
            engine = str(req.get("engine", "auto")).strip().lower() or "auto"
            edge_voice = str(req.get("voice") or DEFAULT_EDGE_VOICE).strip() or DEFAULT_EDGE_VOICE
            edge_rate = str(req.get("rate") or DEFAULT_EDGE_RATE).strip() or DEFAULT_EDGE_RATE

            if not text:
                _write_protocol_response(
                    proto_out,
                    {"ok": True, "sample_rate": 24000, "channels": 1, "pcm_len": 0, "engine": "none"},
                )
                continue

            pcm_bytes = b""
            sample_rate = 24000
            channels = 1
            used_engine = ""
            last_error: Optional[str] = None

            # 1. Kokoro-82M High-Quality Expressive Neural TTS (24kHz on CUDA GPU ~0.02 RTF)
            if engine in ("auto", "kokoro") and kokoro_pipeline is not None:
                try:
                    k_voice = str(req.get("voice") or DEFAULT_KOKORO_VOICE).strip() or DEFAULT_KOKORO_VOICE
                    try:
                        k_speed = float(req.get("speed") or DEFAULT_KOKORO_SPEED)
                    except ValueError:
                        k_speed = DEFAULT_KOKORO_SPEED

                    pcm_bytes, sample_rate, channels = synthesize_kokoro_pcm(
                        kokoro_pipeline, text, voice=k_voice, speed=k_speed
                    )
                    used_engine = "kokoro"
                except Exception as exc:
                    last_error = f"Kokoro failed: {exc}"
                    print(f"[neural_tts] {last_error}", file=sys.stderr, flush=True)

            # 2. Local Piper ONNX neural voice (~60-120ms, zero network)
            if not used_engine and engine in ("auto", "piper") and piper_voice is not None:
                try:
                    pcm_bytes, sample_rate, channels = synthesize_piper_pcm(piper_voice, text)
                    used_engine = "piper"
                except Exception as exc:
                    p_err = f"Piper failed: {exc}"
                    last_error = f"{last_error}; {p_err}" if last_error else p_err
                    print(f"[neural_tts] {p_err}", file=sys.stderr, flush=True)

            # 3. Warm Edge-TTS in-memory fallback (zero temp files)
            if not used_engine and engine in ("auto", "edge"):
                try:
                    with contextlib.redirect_stdout(sys.stderr):
                        pcm_bytes, sample_rate, channels = loop.run_until_complete(
                            synthesize_edge_pcm(text, voice=edge_voice, rate=edge_rate)
                        )
                    used_engine = "edge"
                except Exception as exc:
                    edge_err = f"Edge-TTS failed: {exc}"
                    last_error = f"{last_error}; {edge_err}" if last_error else edge_err
                    print(f"[neural_tts] {edge_err}", file=sys.stderr, flush=True)

            if not used_engine:
                _write_protocol_response(
                    proto_out,
                    {"ok": False, "error": last_error or f"No TTS engine available for '{engine}'"},
                )
                continue

            # Ensure even PCM16 byte alignment
            if len(pcm_bytes) % 2 != 0:
                pcm_bytes = pcm_bytes[:-1]

            _write_protocol_response(
                proto_out,
                {
                    "ok": True,
                    "sample_rate": sample_rate,
                    "channels": channels,
                    "pcm_len": len(pcm_bytes),
                    "engine": used_engine,
                },
                pcm_bytes,
            )
    finally:
        try:
            loop.close()
        except Exception:
            pass


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "--daemon":
        run_daemon()
        return

    if len(sys.argv) < 3:
        print(
            "Usage: python neural_tts.py --daemon | python neural_tts.py <text_base64> <out_wav> [voice]",
            file=sys.stderr,
        )
        sys.exit(1)

    b64_text = sys.argv[1]
    out_wav = sys.argv[2]
    explicit_voice = sys.argv[3].strip() if len(sys.argv) >= 4 and sys.argv[3].strip() else ""

    text = base64.b64decode(b64_text).decode("utf-8").strip()
    if not text:
        sys.exit(0)

    try:
        kokoro_pipeline, _ = load_kokoro_pipeline()
        if kokoro_pipeline is not None:
            v = explicit_voice or DEFAULT_KOKORO_VOICE
            pcm_bytes, sample_rate, channels = synthesize_kokoro_pcm(kokoro_pipeline, text, voice=v)
            write_wav_file(out_wav, pcm_bytes, sample_rate, channels)
            return

        piper_voice = load_piper_voice()
        if piper_voice is not None:
            pcm_bytes, sample_rate, channels = synthesize_piper_pcm(piper_voice, text)
            write_wav_file(out_wav, pcm_bytes, sample_rate, channels)
            return

        v = explicit_voice or DEFAULT_EDGE_VOICE
        asyncio.run(synthesize_to_wav(text, out_wav, voice=v))
    except Exception as exc:
        print(f"neural_tts error: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
