# Deterministic Build & Implementation Guide for Flash Models (`build-and-flash-guide.md`)

Follow these **6 sequential phases** strictly in order. Do not skip verification checks between phases.

---

## Phase 1: Tauri v2 Workspace & Multi-Window Shell
1. Initialize Tauri v2 + React 19 + TypeScript + Vite + TailwindCSS (`npm create tauri-app@latest`).
2. Configure `src-tauri/Cargo.toml` with core crates:
   - `tauri = { version = "2", features = ["macos-private-api", "tray-icon"] }`
   - `tauri-plugin-global-shortcut = "2"`
   - `tokio = { version = "1", features = ["full"] }`
   - `serde`, `serde_json`, `thiserror`, `anyhow`, `toml`
   - `cpal`, `rodio`, `sonora`, `rtrb`, `ort`
   - `scap`, `enigo`, `chromiumoxide`, `rusqlite = { version = "0.32", features = ["bundled"] }`
   - Platform-gated A11y: `uiautomation` (`cfg(windows)`), `atspi` (`cfg(target_os = "linux")`), `macos-accessibility-client` (`cfg(target_os = "macos")`).
3. Create the 4 windows (`pill`, `bubble`, `overlay`, `quick_input`) in `src-tauri/tauri.conf.json` and `src/main.tsx`.
4. **Verify:** `cargo check` passes and `overlay` passes mouse clicks through via `set_ignore_cursor_events(true)`.

---

## Phase 2: Lock-Free Audio Pipeline (VAD + Moonshine STT + Kokoro TTS)
1. Implement `scripts/download_models.py` to fetch:
   - `silero_vad.onnx` ([snakers4/silero-vad](https://github.com/snakers4/silero-vad))
   - `moonshine-streaming-tiny` ONNX ([moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine))
   - `Kokoro-82M-v1.0-ONNX` ([onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX))
2. Implement `src-tauri/src/audio/ring_buffer.rs` (`rtrb`), `io.rs` (`cpal` + `rodio` with `15 ms` buffer), `aec.rs` (`sonora`), `vad.rs`, `stt.rs`, and `tts.rs`.
3. **Verify:** Run unit test feeding a `.wav` file -> Moonshine outputs transcript -> Kokoro synthesizes PCM -> `rodio` plays with `< 300 ms` latency.

---

## Phase 3: Screen Capture, A11y Tree & Pre-Warming
1. Implement `src-tauri/src/screen/capture.rs` using `scap` (WebP/JPEG downscaled to `1280px` + full-res crop).
2. Implement `src-tauri/src/screen/a11y/` for Windows (`uiautomation`), Linux (`atspi`), and macOS (`macos-accessibility-client`).
3. Implement `ContextPrewarmer` (`src-tauri/src/screen/mod.rs`) caching the active window's A11y tree every `500 ms` on focus change.
4. **Verify:** Hotkey press prints A11y JSON (`< 100 ms`) and saves a valid `1280px` WebP screenshot.

---

## Phase 4: Spatial Overlay, Pointing & Guided Walkthroughs
1. Implement `src-tauri/src/ai/tag_stream.rs` to strip `[POINT:...]`, `[DRAW:...]`, `[3D:...]`, and `[STEP:...]` from LLM tokens before TTS.
2. Implement `AnimatedPointer.tsx`, `DrawingCanvas.tsx`, `GuidedStepBox.tsx`, and `Model3DViewer.tsx` (`three` + `@react-three/fiber`).
3. Implement `src-tauri/src/features/walkthrough.rs` click/A11y listener to auto-advance steps.
4. **Verify:** Emit a mock `[POINT:500,500:Test:screen0]` event and confirm the pointer animates smoothly along a Bezier curve without blocking clicks underneath.

---

## Phase 5: Hybrid Model Router, Talk Mode, Dictation & Drive Mode
1. Implement `src-tauri/src/ai/router.rs` + `providers/` (`local_llamacpp.rs`, `groq.rs`, `gemini.rs`, `openrouter.rs`) with `429` automatic failover.
2. Implement `features/talk.rs` (speculative prefill + barge-in flush), `features/dictation.rs` (clipboard paste + 20 s edit-monitoring dictionary), and `features/drive.rs` (confirmation pill + `15 px` mouse / `Esc` abort watchdog).
3. **Verify:** Full Talk Mode voice round-trip + Dictation paste + Drive Mode `Esc` abort.

---

## Phase 6: Background Clickys, Cron, SQLite Memory, Browser Extension & MCP
1. Implement `storage/mod.rs` SQLite schema (`agents`, `messages`, `memories`, `dictionary_corrections`, `cron_jobs`) and `features/scheduler.rs`.
2. Implement `tools/mcp_client.rs` (stdio + SSE) and `tools/browser_tools.rs` (`chromiumoxide` + Native Messaging).
3. Build `browser-extension/` (`manifest.json`, `background.js`, `content.js` with sensitive-field redaction) and `native-host/com.heyclicky.clone.json`.
4. **Verify:** Spawn a named Clicky agent, schedule a 1-minute test cron job, and read a non-sensitive browser tab via the extension.
