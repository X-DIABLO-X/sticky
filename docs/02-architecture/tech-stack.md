# Fast & Optimized Tech Stack (`tech-stack.md`)

This document locks in the exact libraries, Rust crates, and OS-level APIs so the implementation model never has to choose between competing frameworks.

---

## 1. Desktop App & Overlay Shell
- **Framework:** **[Tauri v2](https://v2.tauri.app/develop/calling-rust/)** (Rust backend + React 19 + TypeScript + Vite + TailwindCSS).
  - **Why:** `~5–15 MB` binary, `~1/3–1/5` RAM of Electron, `0.5–1 s` cold start ([Oflight](https://www.oflight.co.jp/en/columns/tauri-v2-vs-electron-comparison), [Rustify](https://rustify.rs/articles/rust-tauri-vs-electron-2026)).
- **Global Hotkeys:** [`tauri-plugin-global-shortcut`](https://v2.tauri.app/plugin/global-shortcut/) (backed by `global-hotkey`) ([Tauri Release](https://v2.tauri.app/release/global-shortcut/)).
- **Binary IPC:** Use `tauri::ipc::Response::new(bytes)` and `tauri::ipc::Channel<ArrayBuffer>` for waveforms and image thumbnails, bypassing JSON serialization ([Tauri Core API](https://v2.tauri.app/reference/javascript/api/namespacecore/)).
- **Transparent Click-Through Overlay:** `window.set_ignore_cursor_events(true)` ([Tauri v2 Config](https://v2.tauri.app/reference/config/)). For interactive sub-regions (like the 3D viewer or Draw-to-Focus), poll cursor coordinates at `60 Hz` in Rust or toggle `set_ignore_cursor_events(false)` when entering interactive bounding boxes ([GitHub #13070](https://github.com/tauri-apps/tauri/issues/13070)).
  - **Linux/Wayland Note:** Scope floating pills to small surfaces rather than relying on fullscreen transparent input pass-through on Wayland compositors with strict input-region rules ([Tauri Window Customization](https://v2.tauri.app/learn/window-customization/)).

---

## 2. Audio Capture, AEC & Streaming Playback
- **PCM Audio I/O:** [`cpal`](https://github.com/RustAudio/cpal) (PipeWire > PulseAudio > ALSA on Linux; WASAPI on Windows; CoreAudio on macOS).
- **TTS Playback Sink:** [`rodio`](https://github.com/rustaudio/rodio) layered over `cpal`—**must override** the [default 100 ms buffer](https://docs.rs/rodio/latest/rodio/stream/index.html) down to **`10–20 ms`** for real-time responsiveness.
- **Lock-Free Audio Ring Buffer:** [`rtrb`](https://docs.rs/rtrb/) (wait-free single-producer single-consumer ring buffer). Zero mutexes and zero heap allocations on the audio callback thread.
- **Acoustic Echo Cancellation (AEC3) & Noise Suppression:** [`sonora`](https://docs.rs/sonora) (pure-Rust WebRTC AudioProcessing with AEC3, NS, and AGC2) or [`webrtc-audio-processing`](https://docs.rs/crate/webrtc-audio-processing/latest). Essential for Always-On headphone/speaker barge-in.
- **In-Process ONNX Inference:** `ort` (Rust `onnxruntime` crate) running Silero VAD, Moonshine Streaming STT, and Kokoro-82M TTS directly inside the Rust process (with optional `cuda` / `directml` / `coreml` execution providers).
- **Python Alternative (if prototyping audio in Python):** Use [`python-sounddevice`](https://python-sounddevice.readthedocs.io/en/latest/api/streams.html) with `latency='low'` (or [`rtmixer`](https://pypi.org/project/rtmixer/) to bypass the GIL), never legacy PyAudio ([LegalCodx](https://legalcodx.com/pyaudio.html)).

---

## 3. Screen Capture, Accessibility Trees & Input Simulation
- **Multi-Monitor Screen Capture:**
  - **Primary Crate:** [`scap`](https://github.com/CapSoftware/scap) (or [`open-gpui-scap`](https://lib.rs/crates/open-gpui-scap)) or [`xcap`](https://crates.io/crates/xcap), wrapping **Windows.Graphics.Capture / DXGI Desktop Duplication**, **ScreenCaptureKit** (macOS 12.3+), and **PipeWire** (Linux).
  - **Granular OS Fallback Crates:** [`dxgi-capture-rs`](https://docs.rs/dxgi-capture-rs) (Windows, zero-frame-on-idle), [`screencapturekit`](https://crates.io/crates/screencapturekit) (macOS), and [`ashpd`](https://docs.rs/ashpd/latest/ashpd/) + [`lamco-wayland`](https://lamco.ai/open-source/lamco-wayland/) (Linux Wayland XDG ScreenCast Portal + PipeWire).
  - *(Note: If using Python sidecar capture, use [`DXcam`](https://github.com/ra1nty/DXcam) on Windows for 240+ FPS or [`python-mss`](https://screenshotone.com/blog/mss-python-screen-capture/) on X11; avoid `mss` on macOS as it uses deprecated `CGWindowListCreateImage` ([GitHub #451](https://github.com/BoboTiG/python-mss/issues/451)).)*
- **OS Accessibility Trees (80 ms Deterministic Grounding):**
  - Modeled after [Screenpipe](https://docs.screenpipe.com/architecture) and [`terminator-rs`](https://crates.io/crates/terminator-rs/0.9.2):
    - **Windows:** [`uiautomation`](https://docs.rs/uiautomation) (Microsoft UI Automation).
    - **Linux:** [`atspi`](https://docs.rs/atspi) (pure-Rust, `zbus`-based AT-SPI2 client).
    - **macOS:** [`macos-accessibility-client`](https://crates.io/crates/macos-accessibility-client) (`AXUIElement`).
- **Input Simulation (Drive Mode):**
  - **Primary Crate:** [`enigo`](https://github.com/enigo-rs/enigo) (`SendInput` on Windows, `CGEventPost` on macOS, X11 and experimental Wayland/`libei` on Linux).
  - **Linux Wayland Fallback:** Kernel-level `uinput` via `ydotool` when the compositor lacks `libei` ([kdotool docs](https://crates.io/crates/kdotool)).

---

## 4. Browser Automation, Storage & Local Inference
- **Direct Browser Control (CDP):** [`chromiumoxide`](https://crates.io/crates/chromiumoxide) in Rust connects directly over Chrome DevTools Protocol, eliminating Playwright's Node.js WebSocket relay hop ([Browser Use](https://browser-use.com/posts/playwright-to-cdp)).
- **Extension Bridge:** Chrome MV3 Extension communicating via **Chrome Native Messaging** (stdin/stdout JSON over OS pipe with the Rust binary, zero open ports) ([Privacy Policy](https://www.heyclicky.com/privacy-policy)).
- **Local Database & Vector Memory:** `rusqlite` (SQLite with `bundled` + FTS5) + `fastembed` (Rust local embeddings) for persistent memory, agent workspaces, and self-learning dictionary.
- **Local LLM/VLM Runtime:** [`llama.cpp`](https://github.com/ggerganov/llama.cpp) (`llama-server` OpenAI-compatible HTTP/SSE endpoint) or **Ollama**, managed as a child process or background service.
- **Optional Python Vision Sidecar:** FastAPI over Unix Domain Socket (`UDS`) / `127.0.0.1` running **Microsoft OmniParser v2** (`icon_detect_v3` + `icon_caption`) and **Chatterbox-Turbo** when GPU voice cloning is enabled.
