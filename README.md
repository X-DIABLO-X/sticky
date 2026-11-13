# HeyClicky Clone: Zero-Latency Desktop AI Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows | macOS | Linux](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](README.md)
[![Audio Latency: <300ms TTFA](https://img.shields.io/badge/Voice%20TTFA-%3C300ms-brightgreen.svg)](docs/03-ai-and-models/pipelines.md)
[![100% Zero-Cost Models](https://img.shields.io/badge/Models-Open--Weight%20%2F%20Free--Tier-orange.svg)](docs/03-ai-and-models/models.md)

HeyClicky Clone is an ultra-fast, privacy-first desktop voice and screen AI agent. Built on **Tauri v2**, **Rust**, **React 19**, and in-process **ONNX Runtime**, it provides sub-300ms spoken conversation, Excalidraw-style spatial screen annotations, system-wide smart dictation with self-learning vocabulary, desktop UI automation with safety watchdogs, background scheduled routines ("Clickys"), and dual browser automation via CDP and Chrome MV3 Native Messaging with hard credential redaction.

---

## Architecture Overview

```text
+-----------------------------------------------------------------------------------+
|                        TAURI v2 DESKTOP SHELL (React 19 + Vite)                   |
|  [Notch / Top Pill]   [Cursor Bubble]   [Full-Screen Transparent Click-Through]   |
|  - Chat & Agents UI   - Live Captions   - Bezier Pointer ([POINT:x,y])            |
|  - Cron & Memory UI   - Dictation Pill  - Excalidraw 2D + Three.js 3D Viewer      |
+-----------------------------------------+-----------------------------------------+
                                          | Tauri Raw IPC (ArrayBuffer) + Channel<T>
+-----------------------------------------v-----------------------------------------+
|                           RUST CORE ENGINE (Tokio Async)                          |
|                                                                                   |
|  [Audio Engine]                 [Screen & OS Engine]        [Agent & Memory Core] |
|  - cpal (Mic/Spk I/O)           - scap / xcap (Screen)      - SQLite (rusqlite)   |
|  - sonora (WebRTC AEC3/NS)      - uiautomation / atspi /    - Cron Scheduler      |
|  - rtrb (Lock-free RingBuf)       AXUIElement (A11y Tree)   - MCP Client (stdio)  |
|  - rodio (15ms Sink)            - enigo / ydotool (Input)   - Native Msg Host     |
+--------+-----------------------------------+--------------------------+-----------+
         | In-Process ONNX (ort)             | HTTP / UDS / gRPC        | CDP / Stdio
         v                                   v                          v
+------------------------+    +------------------------------+    +-----------------+
| LOCAL AUDIO PIPELINE   |    | MODEL ROUTER & INFERENCE     |    | BROWSER & MCP   |
| - Silero VAD (ONNX)    |    | Local: llama.cpp / Ollama    |    | - Chrome MV3    |
| - Moonshine STT (ONNX) |    |   (Qwen3-VL-4B / UI-TARS)    |    | - chromiumoxide |
| - Kokoro-82M (ONNX)    |    |   + OmniParser v2 Sidecar    |    | - External MCPs |
+------------------------+    | Cloud Free: Groq / Gemini /  |    +-----------------+
                              |   OpenRouter (:free)         |
                              +------------------------------+
```

---

## Key Highlights

- **Sub-300ms Voice Turnaround (TTFA):** In-process audio DSP running on OS real-time threads using wait-free `rtrb` SPSC ring buffers, `sonora` WebRTC Acoustic Echo Cancellation (AEC3), `Silero VAD` (<1ms chunk), and `Moonshine Streaming` STT (~107ms latency).
- **Dual Zero-Cost Audio Models:** Sentence-buffered streaming synthesis using `Kokoro-82M-v1.0` ONNX (~28–40ms TTFA on CPU) with `Piper TTS` ultra-lite fallback.
- **A11y-First Screen Grounding:** Fast OS accessibility tree extraction (`uiautomation` on Windows, `atspi` on Linux, `AXUIElement` on macOS) takes ~80ms without invoking heavy vision models unless necessary.
- **Spatial Screen Overlay:** Full-screen transparent click-through window rendering Bezier animated pointer trails, 2D callouts, Three.js 3D viewers, and 15-step interactive guided walkthroughs.
- **Dual Browser Control & Mandatory Redaction:** Direct Chrome DevTools Protocol (`chromiumoxide`) and an everyday MV3 extension communicating over length-prefixed stdio. Passwords, OTPs, and payment fields are **strictly redacted** and refuse automated typing.
- **Drive Mode Safety Watchdog:** Mutating OS actions require confirmation and feature a 60Hz watchdog that immediately aborts if the mouse is moved >15px, `Esc` is pressed, or voice barge-in occurs.
- **Self-Learning Dictation:** Injects text at active caret, polls subsequent user edits at 5s/10s/20s, and automatically registers vocabulary corrections into a local SQLite dictionary.

---

## The 6 Core Runtime Pipelines

### 1. Speculative Voice-to-Action & Talk Mode
```text
Mic (16kHz) -> rtrb_mic -> sonora (AEC3) -> Silero VAD (30ms) -> Moonshine STT
                                                                       |
     +-----------------------------------------------------------------+
     v (Stable partial >= 4 words)
Speculative Prefill to ModelRouter (Warm KV cache)
     |
     v (VAD 200ms silence or hotkey release)
Final Transcript + Pre-warmed Screen Context -> ModelRouter Stream
     |
     +---> [TagStreamParser] ---> [POINT:x,y] / [DRAW:...] -> OverlayWindow
     |
     +---> [Sentence Chunker] --> Kokoro-82M ONNX (24kHz) -> rodio (15ms sink)
                                                                 |
                                                       (AEC3 Reference Loop)
```
- **Tag Stream Separation:** Inline tags `[POINT:...]` and `[DRAW:...]` are intercepted, stripped from spoken audio, and routed directly to the overlay.
- **Sentence-Boundary Flush:** Synthesis starts playing on punctuation (`.`, `!`, `?`, `\n`) while the LLM is still generating subsequent tokens.
- **Instant Barge-In:** Voice activity for >120ms or pressing `Esc` immediately flushes the audio ring buffer and cancels running LLM generation.

### 2. Accessibility-First, Vision-Fallback Grounding
1. Reads the focused window's A11y tree (`~80ms`) and active Chromium DOM elements.
2. If the user request is UI navigation ("Click Export", "Focus search"), passes JSON hierarchy directly to ultra-fast text models (`Groq gpt-oss-20b` or local `Qwen3-4B`).
3. Only triggers screenshot capture and VLM inference (`Qwen3-VL-4B`, `Gemini Flash-Lite`, or `OmniParser v2`) when A11y nodes are insufficient (<3 elements), for visual queries, or during **Shift-Scribble-to-Focus**.

### 3. Spatial Overlay Protocol
The model outputs normalized coordinates (`0..1000`) mapped to physical displays:
- `[POINT:x,y:label:screenN]`: Cubic Bezier animated pointer with callout label.
- `[DRAW:circle:x,y,r:color]`: Excalidraw-style sketchy circle.
- `[DRAW:box:x1,y1,x2,y2:label]`: Highlighted bounding box.
- `[DRAW:arrow:x1,y1,x2,y2:label]`: Curved directional arrow.
- `[3D:preset:title]`: Interactive Three.js model viewer.
- `[STEP:idx/total:x1,y1,x2,y2:instruction]`: Step-by-step interactive walkthrough that auto-advances on target bbox clicks.

### 4. Smart Dictation & 20s Self-Learning Dictionary
1. User presses dictation shortcut (`Alt+Shift+D`).
2. Moonshine STT transcribes locally in ~107ms.
3. Fast LLM cleans transcript (removes stutters, formats technical terms, matches context).
4. Text is inserted at the active caret via clipboard simulation (`enigo`).
5. A background task samples the text field at 5s, 10s, and 20s. Any manual edits made by the user are computed via Levenshtein word diffs and upserted into SQLite `dictionary_corrections`.

### 5. Desktop Drive Mode & Safety Watchdog
1. Agent proposes mutating actions (`mouse_click`, `type_text`, `press_hotkey`).
2. Floating confirmation pill prompts: `[Allow AI to Drive? (Enter / Esc)]`.
3. Watchdog monitors at 60Hz: aborts execution if physical mouse delta exceeds 15px, `Esc` is pressed, or voice barge-in occurs.
4. UI state is verified after each step before executing the next action.

### 6. Background Clickys & Cron Scheduler
- Autonomous background agents running on SQLite-persisted schedules (`tokio-cron-scheduler`).
- Executes headless tasks, invokes local/remote MCP tools (Gmail, GitHub, Filesystem), and writes summaries to agent workspaces with non-intrusive notch notifications.

---

## Hardware Profile Presets

Configured via `CLICKY_PROFILE` in `.env` or `~/.heyclicky/config.toml`:

| Profile | Target Hardware | Audio Pipeline | Vision & Reasoning Models |
| :--- | :--- | :--- | :--- |
| **`laptop_6gb`** *(Default)* | RTX 3050 / 4050 / 4060 (6 GB VRAM) + 16–32 GB RAM | Silero VAD + Moonshine + Kokoro-82M on CPU (~2.6 GB RAM) | `Qwen3-VL-4B-Instruct` Q4_K_M (~3.5 GB VRAM) on GPU or OmniParser v2 sidecar |
| **`cpu_only_hybrid`** | Ultrabooks & iGPU (Intel / AMD Radeon 780M / Apple Silicon) | Silero VAD + Moonshine + Kokoro-82M on CPU (~2.6 GB RAM) | Groq Free (`gpt-oss-20b`) for text + Gemini Flash-Lite / OpenRouter `:free` for vision |
| **`workstation_16gb_plus`** | 16+ GB VRAM GPUs | Silero VAD + Moonshine + Kokoro-82M on CPU | `UI-TARS-1.5-7B` Q4 + `Qwen3-VL-8B` + `Chatterbox-Turbo` voice cloning on GPU |

---

## Global Hotkey Cheat Sheet

| Action | Windows / Linux | macOS | Behavior |
| :--- | :--- | :--- | :--- |
| **Talk Mode** | `Ctrl + Space` *(Hold)* | `Cmd + Space` *(Hold)* | Speak while holding; release to run speculative turn. |
| **Dictation** | `Alt + Shift + D` | `Option + Shift + D` | Transcribes and pastes cleaned text at active caret. |
| **Toggle Notch / Pill** | `Ctrl + Alt + A` | `Ctrl + Cmd + A` | Expands or collapses the top-edge agent drawer. |
| **Quick Input** | `Ctrl` `Ctrl` *(Double-tap)* | `Cmd` `Cmd` *(Double-tap)* | Opens floating prompt bar with drag-and-drop file input. |
| **Scribble to Focus** | `Shift + Drag` | `Shift + Drag` | Draws region; crops area at 100% native resolution for VLM. |
| **Emergency Abort** | `Escape` | `Escape` | Immediately halts TTS playback, cancels LLM, and stops Drive mode. |

---

## Getting Started

### 1. Prerequisites
- **Node.js** v20+ and **npm**
- **Rust** 1.80+ (`rustup default stable`)
- **Python** 3.10+ (for model downloader and vision sidecar)
- OS Build Tools:
  - **Windows:** Visual Studio C++ Build Tools
  - **Linux:** `libwebkit2gtk-4.1-dev build-essential libasound2-dev libssl-dev libxdo-dev`
  - **macOS:** Xcode Command Line Tools

### 2. Clone & Setup
```bash
git clone https://github.com/heyclicky/heyclicky-clone.git
cd heyclicky-clone

# Install frontend dependencies
npm install

# Copy environment template
cp .env.example .env
```

### 3. Download Local AI Models
Download open-weight models (Silero VAD, Moonshine, Kokoro-82M, and Qwen3-VL-4B) to `~/.heyclicky/models`:
```bash
# For 6 GB RTX Laptop:
python scripts/download_models.py --profile laptop_6gb

# For CPU-only ultrabooks:
python scripts/download_models.py --profile cpu_only_hybrid
```

### 4. Run Development Server
```bash
npm run tauri dev
```

### 5. Setup Browser Extension (Optional for tab automation)
1. Navigate to `chrome://extensions/` in Chrome, Brave, or Edge.
2. Enable **Developer mode** -> **Load unpacked** -> select `D:\cliky\browser-extension`.
3. Note your 32-character Extension ID.
4. Register the Native Messaging Host:
   - **Windows:** Run `.\scripts\build_release.ps1` or see [browser-extension/README.md](file:///D:/cliky/browser-extension/README.md).
   - **macOS / Linux:** Run `bash scripts/build_release.sh`.

### 6. Run Python Vision Sidecar (Optional for OmniParser v2)
```bash
cd sidecar-vision
python -m venv .venv
# Activate virtual environment (.venv\Scripts\Activate.ps1 on Windows or source .venv/bin/activate on Unix)
pip install -e .
python server.py --port 8765
```

---

## Building a Release Bundle

### Windows (PowerShell)
```powershell
.\scripts\build_release.ps1 -Zip
```
Generates self-contained distribution bundle in `dist/release-bundle/` and `dist/heyclicky-windows-x64.zip`.

### macOS & Linux (Bash)
```bash
bash scripts/build_release.sh
```
Generates release bundle in `dist/release-bundle/` and `dist/heyclicky-unix-x64.tar.gz`.

---

## Security Model & Data Privacy

- **Mandatory Credential Redaction:** The Chrome MV3 extension (`content.js`) intercepts password inputs, OTP fields, credit card numbers, and SSNs. They are converted to non-interactive redacted nodes before DOM trees reach AI models. Automated typing into sensitive fields is strictly rejected.
- **Air-Gapped Local-Only Mode:** Switching `CLICKY_PRIVACY_MODE=local_only` disables all external HTTP requests, running all VAD, STT, TTS, and reasoning completely offline on your local CPU/GPU.
- **Drive Mode Confirmation Gate:** Desktop mouse/keyboard automation requires explicit user confirmation and provides hardware watchdog monitoring with physical mouse movement interrupts.

---

## License

This project is licensed under the [MIT License](LICENSE).
Kokoro-82M is licensed under Apache 2.0. Silero VAD is licensed under MIT. Moonshine STT is licensed under MIT. OmniParser v2.0 is licensed under MIT.
