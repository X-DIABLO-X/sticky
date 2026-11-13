import sys
import os
import warnings

# Suppress HuggingFace hub symlink and token warnings
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
warnings.filterwarnings("ignore")

def transcribe_audio(wav_path: str) -> str:
    try:
        from faster_whisper import WhisperModel
        # Use tiny.en for ultra-fast real-time speech transcription on CPU
        model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
        segments, _ = model.transcribe(wav_path, beam_size=1)
        return " ".join(s.text for s in segments).strip()
    except Exception as e:
        return f"Error: {e}"

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python local_stt.py <wav_path>")
        sys.exit(1)
    wav_file = sys.argv[1]
    res = transcribe_audio(wav_file)
    print(res)
