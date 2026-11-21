import asyncio
import base64
import io
import os
import sys
import wave

import av
import edge_tts
import numpy as np

DEFAULT_VOICE = os.environ.get("STICKY_TTS_VOICE", "en-US-AvaMultilingualNeural")
DEFAULT_RATE = os.environ.get("STICKY_TTS_RATE", "+5%")


async def synthesize_to_wav(text: str, out_wav: str, voice: str = DEFAULT_VOICE, rate: str = DEFAULT_RATE) -> None:
    comm = edge_tts.Communicate(text, voice=voice, rate=rate)
    mp3_buf = bytearray()
    async for chunk in comm.stream():
        if chunk.get("type") == "audio":
            mp3_buf.extend(chunk["data"])

    if not mp3_buf:
        raise RuntimeError("Edge-TTS returned empty audio stream")

    container = av.open(io.BytesIO(mp3_buf))
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=24000)
    pcm_chunks = []
    for frame in container.decode(audio=0):
        for resampled in resampler.resample(frame):
            pcm_chunks.append(resampled.to_ndarray().flatten())

    if not pcm_chunks:
        raise RuntimeError("Failed to decode MP3 audio from Edge-TTS")

    pcm_i16 = np.concatenate(pcm_chunks).astype(np.int16)

    with wave.open(out_wav, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)
        wf.writeframes(pcm_i16.tobytes())


def main() -> None:
    if len(sys.argv) < 3:
        print("Usage: python neural_tts.py <text_base64> <out_wav> [voice]", file=sys.stderr)
        sys.exit(1)

    b64_text = sys.argv[1]
    out_wav = sys.argv[2]
    voice = sys.argv[3] if len(sys.argv) >= 4 and sys.argv[3].strip() else DEFAULT_VOICE

    text = base64.b64decode(b64_text).decode("utf-8").strip()
    if not text:
        sys.exit(0)

    try:
        asyncio.run(synthesize_to_wav(text, out_wav, voice=voice))
    except Exception as exc:
        print(f"neural_tts error: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
