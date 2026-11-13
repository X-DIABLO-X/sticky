# System Architecture (`architecture.md`)

## 1. High-Level Topology
Our clone uses a **2-tier local architecture** that keeps all latency-critical I/O (audio, screen capture, global hotkeys, accessibility trees, input simulation, transparent overlay) inside a **single compiled Rust binary ([Tauri v2](https://v2.tauri.app/develop/calling-rust/))**, paired with an optional **Local AI Inference Sidecar** (for GPU Python/vLLM/OmniParser models if not using `llama.cpp` / ONNX Runtime directly in Rust) and **Free-Tier Cloud APIs**.

```text
+-----------------------------------------------------------------------------------+
|                        TAURI v2 DESKTOP SHELL (React + Vite)                      |
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
|  - rodio (10-20ms TTS Play)     - enigo / ydotool (Input)   - Native Msg Host     |
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

## 2. Why This Architecture Beats Electron + Python
1. **Memory & Startup:** Tauri v2 uses the OS native WebView (`WebView2` on Windows, `WebKitGTK` on Linux, `WKWebView` on macOS), yielding a **`~5–15 MB` installer**, **`~1/5` the RAM of Electron**, and **`0.5–1 s` startup** ([Oflight](https://www.oflight.co.jp/en/columns/tauri-v2-vs-electron-comparison), [Rustify](https://rustify.rs/articles/rust-tauri-vs-electron-2026)).
2. **Zero-Copy Real-Time Audio:** Audio callbacks in `cpal` run on a dedicated OS real-time thread pushing PCM16/f32 frames into a wait-free **`rtrb` SPSC ring buffer**—no Python GIL, no garbage collection pauses, no mutex locks ([rtrb docs](https://docs.rs/rtrb/)).
3. **Raw Binary IPC:** Audio waveforms and dirty-region thumbnails bypass JSON serialization using `tauri::ipc::Response::new(bytes)` and `tauri::ipc::Channel` ([Tauri Core API](https://v2.tauri.app/reference/javascript/api/namespacecore/)).
4. **In-Process ONNX Audio:** Running Silero VAD, Moonshine Streaming, and Kokoro-82M via **`ort`** (Rust ONNX Runtime bindings) eliminates inter-process WebSocket/gRPC hops for the entire voice loop.

---

## 3. Windowing & Overlay Architecture
The Tauri app manages **4 distinct window surfaces** (configured in `tauri.conf.json` and dynamically spawned/toggled in `src-tauri/src/ui/windows.rs`):

| Window ID | Role | Always-On-Top | Click-Through | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `pill` | Notch / Top-Edge Home Pill & Agent Drawer | Yes | No | Collapses to tiny pill; expands on `Ctrl+Cmd+A` / `Ctrl+Alt+A` or click. |
| `bubble` | Cursor-Side Floating Status & Captions | Yes | Dynamic | Follows cursor or active caret during Talk/Dictation; shows waveform & captions. |
| `overlay` | Full-Screen Transparent Spatial Overlay | Yes | **Yes** (`set_ignore_cursor_events(true)`) | Renders `[POINT:x,y]` Bezier cursor, 2D drawings, guided walkthrough boxes, and 3D viewer. Toggles click-through off *only* when user hovers the 3D widget or clicks "Draw-to-Focus". |
| `quick_input` | Double-Tap `Ctrl` Text Prompt Bar | Yes | No | Spotlight-style floating input bar with file drag-and-drop. |

---

## 4. Threading & Concurrency Model
To guarantee zero UI stutter and `<300 ms` voice responsiveness:
1. **OS Audio Input Thread (`cpal`):** Real-time priority. Reads mic frames -> pushes to `mic_ring_tx` (`rtrb`). Never allocates, never locks.
2. **OS Audio Output Thread (`cpal`/`rodio`):** Real-time priority. Reads synthesized PCM from `tts_ring_rx` (`rtrb`) AND feeds a copy to `aec_ref_tx` for Acoustic Echo Cancellation ([sonora](https://docs.rs/sonora)).
3. **Audio DSP Worker (`tokio::task::spawn_blocking` / dedicated thread):** Pulls from `mic_ring_rx` + `aec_ref_rx` -> runs `sonora` AEC3 + NS -> runs `Silero VAD` -> feeds `Moonshine STT` -> emits `TranscriptEvent` to Tokio broadcast channel.
4. **Tokio Async Runtime (Main Orchestrator):** Handles hotkey events, screen/a11y pre-warming, Model Router HTTP/SSE streams, tool execution, MCP stdio/HTTP calls, and SQLite writes (via `spawn_blocking` or `sqlx`/`rusqlite` pool).
5. **TTS Synthesis Worker:** Consumes sentence-buffered LLM tokens -> runs `Kokoro-82M` ONNX inference -> pushes PCM chunks to `tts_ring_tx`.

---

## 5. Hybrid Model Router Architecture
The `ModelRouter` (`src-tauri/src/ai/router.rs`) selects the optimal execution backend per request based on **Privacy Mode**, **Task Type**, and **Hardware Profile**:

| Task Type | Local-Only Mode (Zero Cloud) | Hybrid Zero-Cost Mode (Default) |
| :--- | :--- | :--- |
| **VAD + STT + TTS** | Silero VAD + Moonshine + Kokoro-82M (CPU) | Silero VAD + Moonshine + Kokoro-82M (CPU) |
| **Dictation Cleanup** | Qwen3-1.7B / Phi-4-mini (Q4) | **Groq** `openai/gpt-oss-20b` (~1,000 tok/s, free tier) |
| **Fast Talk (Text + A11y Tree)** | Qwen3-4B (Q4) | **Groq** `openai/gpt-oss-20b` or `qwen/qwen3.6-27b` |
| **Screen Vision & Pointing** | **Qwen3-VL-4B-Instruct (Q4)** + **OmniParser v2** | **Gemini Flash-Lite** (free tier) or **OpenRouter** `google/gemma-4-31b-it:free` |
| **Complex GUI Driving** | **UI-TARS-1.5-7B (Q4)** + OS A11y Tree | **Qwen3-VL-4B (local)** / **Gemini Flash** |

If a free-tier cloud API hits a rate limit (429), the router **automatically fails over** to the next free provider or the local `llama.cpp` model within `50 ms` without dropping the user's session.
