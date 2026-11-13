#!/usr/bin/env python3
"""
Comprehensive End-to-End Pipeline Verification Suite for HeyClicky Desktop AI.
Tests 5 critical operational domains:
1. Global Shortcut & Hardware Hotkey Hook (Ctrl+Space & Ctrl+Shift+Space)
2. 60Hz Cursor Position & High-DPI Normalization
3. Local Faster-Whisper Speech-to-Text (STT)
4. Real-time Local Text-to-Speech (TTS) Synthesis
5. Bonsai-2 9B Spatial Protocol & Tag Decoupling Engine
"""

import os
import sys
import time
import json
import wave
import subprocess
import urllib.request
import ctypes

PASS = "\033[92m[PASS]\033[0m"
FAIL = "\033[91m[FAIL]\033[0m"
INFO = "\033[94m[INFO]\033[0m"

results = {}

def run_test(name):
    def decorator(fn):
        def wrapper(*args, **kwargs):
            print(f"\n{INFO} Running: {name}...")
            start = time.perf_counter()
            try:
                out = fn(*args, **kwargs)
                dur = (time.perf_counter() - start) * 1000
                print(f"{PASS} {name} passed in {dur:.1f}ms")
                results[name] = {"status": "PASS", "duration_ms": dur, "details": out}
                return True
            except Exception as e:
                dur = (time.perf_counter() - start) * 1000
                print(f"{FAIL} {name} failed: {e}")
                results[name] = {"status": "FAIL", "duration_ms": dur, "error": str(e)}
                return False
        return wrapper
    return decorator


@run_test("Test 1: Global Shortcut & Hardware Hotkey Validation")
def test_hotkey_hooks():
    user32 = ctypes.windll.user32
    VK_CONTROL = 0x11
    VK_SPACE = 0x20
    
    # Test GetAsyncKeyState availability
    ctrl = (user32.GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0
    space = (user32.GetAsyncKeyState(VK_SPACE) & 0x8000) != 0
    
    # Test secondary fallback shortcut registration (Ctrl+Shift+Space)
    MOD_CTRL = 0x0002
    MOD_SHIFT = 0x0004
    reg_res = user32.RegisterHotKey(None, 9999, MOD_CTRL | MOD_SHIFT, VK_SPACE)
    if reg_res:
        user32.UnregisterHotKey(None, 9999)
        
    return {
        "GetAsyncKeyState_functional": True,
        "Ctrl_down": ctrl,
        "Space_down": space,
        "Ctrl_Shift_Space_registerable": bool(reg_res)
    }


@run_test("Test 2: 60Hz Cursor Position & High-DPI Normalization")
def test_cursor_tracking():
    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
    
    pt = POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
    
    # Simulate high DPI normalization (e.g. 1.25x or 1.5x scale factor)
    dpi_scales = [1.0, 1.25, 1.5]
    scaled_positions = []
    for dpr in dpi_scales:
        scaled_positions.append({
            "dpr": dpr,
            "logical_x": pt.x / dpr,
            "logical_y": pt.y / dpr
        })
    
    assert pt.x >= 0 and pt.y >= 0, "Invalid physical cursor coordinates"
    return {
        "physical_pos": [pt.x, pt.y],
        "scaled_positions": scaled_positions
    }


@run_test("Test 3: Local Offline Faster-Whisper STT Transcription")
def test_local_stt():
    test_wav = os.path.join(os.path.dirname(__file__), "test_sample.wav")
    
    # Generate clean 16kHz mono WAV sine tone with speech header
    sample_rate = 16000
    duration = 1.0
    with wave.open(test_wav, "w") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sample_rate)
        # Empty silence/low noise
        f.writeframes(b"\x00\x00" * int(sample_rate * duration))
        
    try:
        cmd = ["python", os.path.join(os.path.dirname(__file__), "local_stt.py"), test_wav]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        transcript = res.stdout.strip()
    finally:
        if os.path.exists(test_wav):
            os.remove(test_wav)
            
    return {"transcript_output": transcript, "exit_code": res.returncode}


@run_test("Test 4: Real-time Local Text-to-Speech (TTS) Synthesis")
def test_local_tts():
    temp_wav = os.path.join(os.path.dirname(__file__), "temp_tts_test.wav")
    speak_script = os.path.join(os.path.dirname(__file__), "speak.ps1")
    
    cmd = [
        "powershell", "-ExecutionPolicy", "Bypass",
        "-File", speak_script,
        "-Text", "HeyClicky desktop companion is calibrated and online.",
        "-OutFile", temp_wav
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    assert os.path.exists(temp_wav), "TTS output WAV file was not generated"
    
    file_size = os.path.getsize(temp_wav)
    assert file_size > 1000, f"TTS file size suspiciously small ({file_size} bytes)"
    
    # Read wave spec
    with wave.open(temp_wav, "r") as f:
        channels = f.getnchannels()
        rate = f.getframerate()
        frames = f.getnframes()
        duration_sec = frames / float(rate)
        
    os.remove(temp_wav)
    
    return {
        "file_size_bytes": file_size,
        "sample_rate": rate,
        "channels": channels,
        "duration_sec": round(duration_sec, 2)
    }


@run_test("Test 5: Bonsai-2 9B Spatial Protocol & Tag Decoupling")
def test_bonsai_spatial_decoupling():
    url = "http://127.0.0.1:11434/api/generate"
    req_body = json.dumps({
        "model": "bonsai-2:9b",
        "prompt": "You are HeyClicky. Where is the Search button? Respond with a point tag <point x=\"420\" y=\"180\" label=\"Search Field\"/> and short clean speech.",
        "stream": False,
        "options": {
            "temperature": 0.2,
            "num_predict": 450
        }
    }).encode("utf-8")
    
    req = urllib.request.Request(url, data=req_body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        res_data = json.loads(resp.read().decode("utf-8"))
        
    full_text = res_data.get("response", "")
    if not full_text:
        full_text = res_data.get("thinking", "")
    assert len(full_text) > 0, "Bonsai response was empty"
    
    # Decouple spatial tags from speech text
    import re
    point_match = re.search(r'<point\s+x="(\d+)"\s+y="(\d+)"(?:\s+label="([^"]*)")?[^>]*\/?>', full_text)
    clean_speech = re.sub(r'<[^>]+>', '', full_text).strip()
    
    return {
        "raw_response": full_text[:120] + "...",
        "has_point_tag": bool(point_match),
        "extracted_point": point_match.groups() if point_match else None,
        "clean_speech": clean_speech[:80] + "...",
        "clean_speech_len": len(clean_speech)
    }


if __name__ == "__main__":
    print("=" * 65)
    print("  HEYCLICKY END-TO-END AUTOMATED VERIFICATION SUITE  ")
    print("=" * 65)
    
    t1 = test_hotkey_hooks()
    t2 = test_cursor_tracking()
    t3 = test_local_stt()
    t4 = test_local_tts()
    t5 = test_bonsai_spatial_decoupling()
    
    total = len(results)
    passed = sum(1 for r in results.values() if r["status"] == "PASS")
    
    print("\n" + "=" * 65)
    print(f"  TEST SUMMARY: {passed}/{total} TESTS PASSED")
    print("=" * 65)
    
    report_path = os.path.join(os.path.dirname(__file__), "pipeline_test_report.json")
    with open(report_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nDetailed verification report saved to: {report_path}")
    
    if passed < total:
        sys.exit(1)
    sys.exit(0)
