import os
import sys
import warnings

os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
warnings.filterwarnings("ignore")


def transcribe_audio(wav_path: str) -> str:
    if not os.path.exists(wav_path):
        print(f"WAV file not found: {wav_path}", file=sys.stderr)
        sys.exit(2)

    # 1. Preferred: faster-whisper (CTranslate2 INT8 on CPU)
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
        segments, _ = model.transcribe(wav_path, beam_size=1, vad_filter=True)
        return " ".join(s.text for s in segments).strip()
    except ImportError:
        pass
    except Exception as exc:
        print(f"faster-whisper error: {exc}", file=sys.stderr)
        sys.exit(3)

    # 2. Fallback: openai-whisper if installed
    try:
        import whisper

        model = whisper.load_model("tiny.en")
        res = model.transcribe(wav_path, fp16=False)
        return str(res.get("text", "")).strip()
    except ImportError:
        print(
            "No local STT Python package found. Install faster-whisper (`pip install faster-whisper`) "
            "or add a free Groq API key in Sticky Settings.",
            file=sys.stderr,
        )
        sys.exit(4)
    except Exception as exc:
        print(f"openai-whisper error: {exc}", file=sys.stderr)
        sys.exit(5)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python local_stt.py <wav_path>", file=sys.stderr)
        sys.exit(1)
    transcript = transcribe_audio(sys.argv[1])
    print(transcript)
