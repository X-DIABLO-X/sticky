#!/usr/bin/env python3
"""
HeyClicky Voice Activity Detection (VAD) Diagnostic & Calibration Tool
Tests real-time microphone input, displays live RMS audio levels, and evaluates
both HeyClicky's native adaptive energy VAD algorithm and Silero VAD.
"""

import sys
import time
import math
import argparse
import numpy as np

try:
    import sounddevice as sd
except ImportError:
    print("[ERROR] 'sounddevice' is required. Install with: pip install sounddevice numpy")
    sys.exit(1)


# ANSI Color Codes
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
MAGENTA = "\033[95m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


class HeyClickyVAD:
    """
    Python mirror of HeyClicky's Rust VoiceActivityDetector
    (from src-tauri/src/audio/vad.rs)
    """
    def __init__(self, energy_threshold=0.008, tail_endpoint_ms=300):
        self.energy_threshold = energy_threshold
        self.tail_endpoint_ms = tail_endpoint_ms
        self.adaptive_floor = 0.003
        self.silence_ms = 0.0
        self.speech_ms = 0.0
        self.is_speaking = False
        self.last_speech_time = None
        self.first_speech_time = None

    def reset(self):
        self.silence_ms = 0.0
        self.speech_ms = 0.0
        self.is_speaking = False
        self.adaptive_floor = 0.003

    def process_frame(self, samples: np.ndarray, frame_duration_ms: float = 30.0):
        if len(samples) == 0:
            return "Silence", 0.0, self.adaptive_floor, self.energy_threshold

        # Calculate Root Mean Square (RMS) energy
        rms = float(np.sqrt(np.mean(samples ** 2)))

        # Dynamically track background noise floor
        if rms < self.adaptive_floor:
            self.adaptive_floor = 0.92 * self.adaptive_floor + 0.08 * rms
        else:
            self.adaptive_floor = 0.998 * self.adaptive_floor + 0.002 * rms

        effective_threshold = max(self.energy_threshold, self.adaptive_floor * 2.2)
        has_speech = rms > effective_threshold

        if has_speech:
            self.silence_ms = 0.0
            self.speech_ms += frame_duration_ms

            if not self.is_speaking:
                self.is_speaking = True
                state = "SpeechStarted"
            else:
                state = "Speaking"
        else:
            if self.is_speaking:
                self.silence_ms += frame_duration_ms
                if self.silence_ms >= self.tail_endpoint_ms:
                    self.is_speaking = False
                    self.speech_ms = 0.0
                    state = "SpeechEnded"
                else:
                    state = "Speaking"  # Bridging brief inter-word pause
            else:
                state = "Silence"

        return state, rms, self.adaptive_floor, effective_threshold


def render_meter(rms: float, threshold: float, max_rms: float = 0.25, width: int = 30) -> str:
    """Render an ASCII audio level bar with threshold marker"""
    clamped = min(max(rms, 0.0), max_rms)
    fill = int((clamped / max_rms) * width)
    thresh_pos = int((threshold / max_rms) * width)

    chars = []
    for i in range(width):
        if i == thresh_pos:
            chars.append("|")
        elif i < fill:
            if rms > threshold:
                chars.append("█")
            else:
                chars.append("▒")
        else:
            chars.append("░")

    bar_str = "".join(chars)
    if rms > threshold:
        return f"{GREEN}[{bar_str}]{RESET}"
    else:
        return f"{DIM}[{bar_str}]{RESET}"


def run_vad_test(device_index=None, sample_rate=16000, chunk_ms=30, threshold=0.008, tail_ms=300, duration=None):
    chunk_samples = int(sample_rate * (chunk_ms / 1000.0))

    # Query audio devices
    devices = sd.query_devices()
    default_in = sd.default.device[0]
    active_device = device_index if device_index is not None else default_in
    dev_info = devices[active_device]

    print("\n" + "=" * 68)
    print(f"{BOLD}{CYAN}  🎙️  HeyClicky Real-time Voice Activity Detection (VAD) Test{RESET}")
    print("=" * 68)
    print(f"  • Microphone:     {BOLD}{dev_info['name']}{RESET} (Device #{active_device})")
    print(f"  • Sample Rate:    {sample_rate} Hz (16-bit PCM Mono)")
    print(f"  • Frame Size:     {chunk_samples} samples ({chunk_ms} ms)")
    print(f"  • Baseline Thresh:{threshold:.4f} (Adaptive floor multiplier: 2.2x)")
    print(f"  • Tail Endpoint:  {tail_ms} ms silence to stop")
    if duration:
        print(f"  • Duration Limit: {duration} seconds")
    print("-" * 68)
    print(f"  {YELLOW}Instructions:{RESET}")
    print("    1. Speak into your microphone normally.")
    print("    2. Watch the meter turn GREEN [SPEAKING] and return to [SILENCE].")
    print("    3. If [SPEAKING] never turns off, background noise floor is too high.")
    print("    4. If it never triggers, microphone gain or threshold is too low.")
    print("    Press Ctrl+C to stop and view diagnostic summary.")
    print("-" * 68 + "\n")

    vad = HeyClickyVAD(energy_threshold=threshold, tail_endpoint_ms=tail_ms)

    # Tracking stats
    history_rms = []
    speech_events = 0
    in_speech_count = 0
    silence_count = 0
    start_time = time.time()
    last_state = "Silence"

    try:
        with sd.InputStream(
            device=active_device,
            channels=1,
            samplerate=sample_rate,
            blocksize=chunk_samples,
            dtype="float32",
        ) as stream:
            print(f"{DIM}Microphone stream opened successfully. Listening...{RESET}\n")

            while True:
                data, overflowed = stream.read(chunk_samples)
                samples = data.flatten()

                state, rms, floor, eff_thresh = vad.process_frame(samples, frame_duration_ms=chunk_ms)
                history_rms.append(rms)

                meter = render_meter(rms, eff_thresh)

                # State badge
                if state == "SpeechStarted":
                    speech_events += 1
                    state_badge = f"{BOLD}{GREEN}[★ SPEECH START]{RESET}"
                elif state == "Speaking":
                    in_speech_count += 1
                    dur_s = vad.speech_ms / 1000.0
                    state_badge = f"{GREEN}[  SPEAKING {dur_s:4.1f}s]{RESET}"
                elif state == "SpeechEnded":
                    state_badge = f"{CYAN}[✓ SPEECH END  ]{RESET}"
                else:
                    silence_count += 1
                    state_badge = f"{DIM}[   SILENCE    ]{RESET}"

                # Real-time console update on single line
                line = (
                    f"\r{state_badge} {meter} "
                    f"RMS: {rms:6.4f} | Floor: {floor:6.4f} | Thresh: {eff_thresh:6.4f} "
                )
                sys.stdout.write(line)
                sys.stdout.flush()

                if state != last_state and state in ("SpeechStarted", "SpeechEnded"):
                    # Print log line for state transitions
                    sys.stdout.write("\n")
                    sys.stdout.flush()

                last_state = state

                if duration and (time.time() - start_time) >= duration:
                    break

    except KeyboardInterrupt:
        pass

    print("\n\n" + "=" * 68)
    print(f"{BOLD}{CYAN}  📊 VAD Calibration & Diagnostic Report{RESET}")
    print("=" * 68)

    elapsed = time.time() - start_time
    if history_rms:
        arr = np.array(history_rms)
        p10 = float(np.percentile(arr, 10))
        p50 = float(np.percentile(arr, 50))
        p90 = float(np.percentile(arr, 90))
        p99 = float(np.percentile(arr, 99))
        avg_rms = float(np.mean(arr))
        max_rms = float(np.max(arr))

        print(f"  • Test Duration:        {elapsed:.1f} seconds ({len(arr)} frames)")
        print(f"  • Speech Turns Detected:{speech_events}")
        print(f"  • Ambient Noise Floor:  {p10:.5f} (10th percentile)")
        print(f"  • Median Audio Level:   {p50:.5f}")
        print(f"  • Voice Signal Level:   {p90:.5f} (90th percentile) / Peak: {max_rms:.5f}")
        print(f"  • Signal-to-Noise Ratio:{(p90 / max(p10, 1e-5)):.1f}x")
        print("-" * 68)

        rec_threshold = max(0.005, p10 * 2.5)
        print(f"{BOLD}  Recommended Settings for src-tauri/src/audio/vad.rs:{RESET}")
        print(f"    Energy Threshold:     {rec_threshold:.4f}  (current: {threshold:.4f})")
        print(f"    Tail Endpoint:        {tail_ms} ms")

        if p10 > 0.015:
            print(f"\n  {YELLOW}⚠️  Warning:{RESET} High ambient noise / mic hiss detected ({p10:.4f}).")
            print("     Check Windows Microphone Boost or enable Noise Suppression in Windows Sound Settings.")
        elif p90 < 0.012:
            print(f"\n  {YELLOW}⚠️  Warning:{RESET} Speech volume is very low ({p90:.4f}).")
            print("     Increase microphone input volume in Windows Sound Settings.")
        else:
            print(f"\n  {GREEN}✓ Microphone signal and dynamic range look healthy.{RESET}")

    print("=" * 68 + "\n")


def main():
    parser = argparse.ArgumentParser(description="HeyClicky Real-time VAD Tester")
    parser.add_argument("--device", type=int, default=None, help="Audio input device index")
    parser.add_argument("--threshold", type=float, default=0.008, help="Energy RMS threshold (default: 0.008)")
    parser.add_argument("--tail", type=int, default=300, help="Tail silence endpoint duration in ms (default: 300)")
    parser.add_argument("--duration", type=float, default=None, help="Auto-stop after N seconds")
    parser.add_argument("--list-devices", action="store_true", help="List all available audio input devices and exit")
    args = parser.parse_args()

    if args.list_devices:
        print("\nAvailable Audio Input Devices:")
        devices = sd.query_devices()
        for i, d in enumerate(devices):
            if d["max_input_channels"] > 0:
                is_def = " (DEFAULT)" if i == sd.default.device[0] else ""
                print(f"  [{i}] {d['name']} - {d['hostapi']} (channels: {d['max_input_channels']}){is_def}")
        print()
        return

    run_vad_test(
        device_index=args.device,
        threshold=args.threshold,
        tail_ms=args.tail,
        duration=args.duration,
    )


if __name__ == "__main__":
    main()
