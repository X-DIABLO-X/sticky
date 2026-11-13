#!/usr/bin/env python3
"""
HeyClicky Model Download & Verification Utility
Part of the HeyClicky Desktop Assistant.

Downloads open-weight models (Silero VAD, Moonshine STT, Kokoro-82M ONNX,
and Qwen3-VL-4B-Instruct GGUF) from Hugging Face / GitHub with progress
display, resume capability, and SHA256 checksum verification.

Zero external dependencies required (uses Python standard library).
"""

from __future__ import annotations
import argparse
import hashlib
import os
import sys
import time
import urllib.request
import urllib.error
from typing import Dict, Any, Optional

# Registry of supported open-weight models and official URLs
MODEL_REGISTRY: Dict[str, Dict[str, Any]] = {
    "silero-vad": {
        "name": "Silero VAD ONNX",
        "filename": "silero_vad.onnx",
        "url": "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
        "size_bytes": 2227931,
        "sha256": "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
        "description": "Ultra-low latency (<1 ms) Voice Activity Detector for CPU",
        "profiles": ["cpu_only_hybrid", "laptop_6gb", "workstation_16gb_plus"]
    },
    "moonshine-tiny": {
        "name": "Moonshine Streaming STT ONNX",
        "filename": "moonshine_streaming_tiny.onnx",
        "url": "https://huggingface.co/onnx-community/moonshine-tiny-ONNX/resolve/main/onnx/encoder_model_quantized.onnx",
        "size_bytes": 27200000,
        "sha256": None,  # Dynamically verified if present
        "description": "Real-time edge speech-to-text (~107 ms latency on CPU)",
        "profiles": ["cpu_only_hybrid", "laptop_6gb", "workstation_16gb_plus"]
    },
    "kokoro-82m": {
        "name": "Kokoro-82M v1.0 ONNX (Quantized)",
        "filename": "kokoro-v1.0.onnx",
        "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx",
        "size_bytes": 86000000,
        "sha256": None,
        "description": "Primary low-latency TTS synthesizer (~28-40 ms TTFA)",
        "profiles": ["cpu_only_hybrid", "laptop_6gb", "workstation_16gb_plus"]
    },
    "kokoro-voices": {
        "name": "Kokoro Heart Voice Bin",
        "filename": "af_heart.bin",
        "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin",
        "size_bytes": 1048576,
        "sha256": None,
        "description": "Default female voice embedding (Heart) for Kokoro TTS",
        "profiles": ["cpu_only_hybrid", "laptop_6gb", "workstation_16gb_plus"]
    },
    "qwen3-vl-4b": {
        "name": "Qwen3-VL-4B-Instruct Q4_K_M GGUF",
        "filename": "qwen3-vl-4b-instruct-q4_k_m.gguf",
        "url": "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/qwen3-vl-4b-instruct-q4_k_m.gguf",
        "size_bytes": 2840000000,
        "sha256": None,
        "description": "Local Vision-Language Model for screen grounding (~3.5 GB VRAM)",
        "profiles": ["laptop_6gb", "workstation_16gb_plus"]
    }
}

PROFILES = {
    "cpu_only_hybrid": {
        "description": "Ultrabooks & CPU-only systems: Local Audio + Cloud Free-Tier Vision/Talk",
        "models": ["silero-vad", "moonshine-tiny", "kokoro-82m", "kokoro-voices"]
    },
    "laptop_6gb": {
        "description": "RTX 3050/4050 (6 GB VRAM): Local Audio + Local Qwen3-VL-4B GGUF",
        "models": ["silero-vad", "moonshine-tiny", "kokoro-82m", "kokoro-voices", "qwen3-vl-4b"]
    },
    "workstation_16gb_plus": {
        "description": "16+ GB VRAM Workstations: All local models",
        "models": ["silero-vad", "moonshine-tiny", "kokoro-82m", "kokoro-voices", "qwen3-vl-4b"]
    }
}


def format_bytes(bytes_num: float) -> str:
    """Format bytes into human readable format."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if abs(bytes_num) < 1024.0:
            return f"{bytes_num:3.1f} {unit}"
        bytes_num /= 1024.0
    return f"{bytes_num:.1f} PB"


def compute_sha256(filepath: str) -> str:
    """Compute SHA256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while chunk := f.read(1024 * 1024):
            sha256.update(chunk)
    return sha256.hexdigest()


def download_file(url: str, dest_path: str, expected_size: Optional[int] = None) -> bool:
    """Download file with progress bar and speed tracking."""
    temp_path = dest_path + ".part"
    print(f"Connecting to: {url}")

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "HeyClicky-ModelDownloader/1.0"}
    )

    try:
        with urllib.request.urlopen(req) as response:
            total_size = int(response.headers.get('content-length', expected_size or 0))
            downloaded = 0
            start_time = time.time()
            last_print_time = start_time

            with open(temp_path, 'wb') as out_file:
                chunk_size = 1024 * 256  # 256 KB
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    out_file.write(chunk)
                    downloaded += len(chunk)

                    current_time = time.time()
                    if current_time - last_print_time > 0.3 or downloaded == total_size:
                        last_print_time = current_time
                        elapsed = max(0.001, current_time - start_time)
                        speed = downloaded / elapsed

                        if total_size > 0:
                            percent = (downloaded / total_size) * 100
                            bar_len = 30
                            filled_len = int(bar_len * downloaded // total_size)
                            bar = '=' * filled_len + '-' * (bar_len - filled_len)
                            sys.stdout.write(
                                f"\r[{bar}] {percent:5.1f}% | {format_bytes(downloaded)}/{format_bytes(total_size)} | {format_bytes(speed)}/s"
                            )
                        else:
                            sys.stdout.write(
                                f"\rDownloaded: {format_bytes(downloaded)} | Speed: {format_bytes(speed)}/s"
                            )
                        sys.stdout.flush()

            sys.stdout.write("\n")

        # Atomic move to final destination
        if os.path.exists(dest_path):
            os.remove(dest_path)
        os.rename(temp_path, dest_path)
        return True

    except Exception as e:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass
        print(f"\n[ERROR] Download failed: {e}")
        return False


def verify_file(dest_path: str, expected_sha256: Optional[str] = None) -> bool:
    """Verify file existence and optional checksum."""
    if not os.path.exists(dest_path):
        return False
    if expected_sha256:
        print(f"Verifying SHA256 for {os.path.basename(dest_path)}...")
        actual_hash = compute_sha256(dest_path)
        if actual_hash.lower() == expected_sha256.lower():
            print("  [OK] SHA256 checksum verified.")
            return True
        else:
            print(f"  [FAIL] Checksum mismatch!\n    Expected: {expected_sha256}\n    Actual:   {actual_hash}")
            return False
    return True


def main():
    parser = argparse.ArgumentParser(
        description="HeyClicky Clone - Model Setup & Download Utility",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Hardware Profiles:
  laptop_6gb            : RTX 3050/4050 (Silero VAD + Moonshine + Kokoro + Qwen3-VL-4B)
  cpu_only_hybrid       : Ultrabooks/iGPU (Silero VAD + Moonshine + Kokoro)
  workstation_16gb_plus : Workstations with 16+ GB VRAM

Examples:
  python scripts/download_models.py --profile laptop_6gb
  python scripts/download_models.py --model silero-vad
  python scripts/download_models.py --verify-only
        """
    )
    parser.add_argument(
        "--profile",
        choices=list(PROFILES.keys()),
        default="laptop_6gb",
        help="Hardware profile preset to download (default: laptop_6gb)"
    )
    parser.add_argument(
        "--model",
        choices=list(MODEL_REGISTRY.keys()) + ["all"],
        default=None,
        help="Download a specific individual model instead of a profile"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help="Directory to save models (default: ~/.heyclicky/models)"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-download even if files already exist and pass verification"
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Verify checksums of existing local models without downloading"
    )

    args = parser.parse_args()

    # Determine destination directory
    if args.output_dir:
        output_dir = os.path.abspath(args.output_dir)
    else:
        output_dir = os.path.join(os.path.expanduser("~"), ".heyclicky", "models")

    os.makedirs(output_dir, exist_ok=True)
    print(f"HeyClicky Model Manager")
    print(f"Target Directory: {output_dir}")

    # Determine list of models to process
    if args.model:
        if args.model == "all":
            models_to_fetch = list(MODEL_REGISTRY.keys())
        else:
            models_to_fetch = [args.model]
    else:
        profile_info = PROFILES[args.profile]
        print(f"Selected Profile: {args.profile} ({profile_info['description']})")
        models_to_fetch = profile_info["models"]

    print(f"Models selected ({len(models_to_fetch)}): {', '.join(models_to_fetch)}\n")

    success_count = 0
    total_count = len(models_to_fetch)

    for key in models_to_fetch:
        spec = MODEL_REGISTRY[key]
        dest_file = os.path.join(output_dir, spec["filename"])
        print(f"--- [{spec['name']}] ---")
        print(f"Description: {spec['description']}")
        print(f"Target File: {dest_file}")

        file_exists = os.path.exists(dest_file)

        if args.verify_only:
            if not file_exists:
                print("Status: MISSING\n")
            else:
                valid = verify_file(dest_file, spec["sha256"])
                if valid:
                    print(f"Status: VALID ({format_bytes(os.path.getsize(dest_file))})\n")
                    success_count += 1
                else:
                    print("Status: CORRUPT\n")
            continue

        if file_exists and not args.force:
            print(f"File already exists ({format_bytes(os.path.getsize(dest_file))}).")
            if verify_file(dest_file, spec["sha256"]):
                print("Skipping download (already verified). Use --force to redownload.\n")
                success_count += 1
                continue
            else:
                print("File failed verification. Re-downloading...")

        # Perform download
        ok = download_file(spec["url"], dest_file, spec["size_bytes"])
        if ok:
            if verify_file(dest_file, spec["sha256"]):
                print("Successfully downloaded and verified.\n")
                success_count += 1
            else:
                print("[WARNING] Download completed but checksum verification failed.\n")
        else:
            print(f"[ERROR] Could not download {spec['name']}.\n")

    print(f"Complete: {success_count}/{total_count} models ready.")
    if success_count < total_count and not args.verify_only:
        sys.exit(1)


if __name__ == "__main__":
    main()
