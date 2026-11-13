# Core Execution Pipelines (`pipelines.md`)

This document defines the exact step-by-step data flows and state machines for all 6 runtime pipelines.

---

## Pipeline 1: Speculative Voice-to-Action & Talk Mode (`<300 ms` TTFA)

```text
Mic (cpal 16kHz f32) -> rtrb_mic -> sonora (AEC3 + NS) -> Silero VAD (30ms chunks)
                                                               |
    +----------------------------------------------------------+
    v (Speech Active)
Moonshine Streaming STT -> Partial Transcripts -> [Speculative Prefill to LLM]
    |
    v (Hotkey Release OR 200ms VAD Trailing Silence)
Final Transcript + Pre-Warmed Screen/A11y Context -> ModelRouter (Stream SSE)
    |
    +---> [TagStreamParser] ---> [POINT:x,y:label:screenN] / [DRAW:...] -> OverlayWindow
    |
    +---> [Sentence Chunker] --> Kokoro-82M ONNX (24kHz PCM) -> rtrb_tts -> rodio (15ms sink)
                                                                   |
                                                         (Copy to AEC3 Ref Buffer)
```

### Deterministic Rules for Flash Implementation:
1. **Context Pre-Warming:** `ContextPrewarmer` (`src-tauri/src/screen/mod.rs`) keeps the active window's Accessibility Tree + last dirty-region screenshot warm in memory so `hotkey_down` adds `0 ms` capture delay.
2. **Speculative Prefill:** While the user is still speaking, once Moonshine emits a stable partial (`>= 4` words), send the system prompt + screen context to the LLM provider to warm KV cache / prompt prefill ([ElevenLabs](https://elevenlabs.io/blog/voice-agent-latency-optimization)).
3. **Tag Stream Separation (`tag_stream.rs`):** As LLM tokens stream in:
   - Never send `[POINT:...]` or `[DRAW:...]` or `[3D:...]` tags to TTS!
   - `TagStreamParser` buffers `[` until `]` (max 128 chars), parses the tag, emits a `Tauri` event to `OverlayWindow` immediately, and strips the tag from the spoken text stream.
4. **Sentence-Boundary TTS Flush:** Flush accumulated spoken text to `Kokoro-82M` on `.`, `!`, `?`, `:`, `;`, or `\n` (provided buffer length `>= 18` chars) so audio starts playing before the LLM finishes generating.
5. **Barge-In Interrupt:** If `Silero VAD` detects speech for `> 120 ms` (with AEC3 active) OR user presses `Esc`:
   - Cancel `tokio_util::sync::CancellationToken` for LLM + TTS tasks.
   - Clear `rtrb_tts` ring buffer immediately (`audio_engine.flush_playback()`).

---

## Pipeline 2: Accessibility-First, Vision-Fallback Screen Grounding

Never run a heavy Vision-Language Model when the OS Accessibility Tree already gives exact coordinates ([Screenpipe](https://docs.screenpipe.com/architecture), [terminator-rs](https://crates.io/crates/terminator-rs/0.9.2)).

1. **Step A (OS A11y Tree — `~80 ms`):**
   - Call `a11y::get_focused_window_tree(max_depth = 8)`.
   - Serialize interactive elements (`Button`, `TextField`, `MenuItem`, `Link`, `Tab`) into compact JSON: `[{ id: 12, role: "Button", name: "Export", bbox: [1400, 360, 1480, 396] }]`.
   - If the active window is a Chromium browser with our extension/CDP attached, merge the **sanitized DOM interactive elements** (excluding password/OTP/card inputs).
2. **Step B (Text-Only Fast Path):**
   - If the user's intent is purely text/UI control (e.g., *"Click Export"*, *"Read this error"*), send **A11y JSON + active window title** to the fast text LLM (`Groq gpt-oss-20b` or local `Qwen3-4B`).
3. **Step C (Vision Fallback):**
   - Trigger screenshot + VLM (`Qwen3-VL-4B` / `Gemini Flash-Lite` / `OmniParser v2`) **only when**:
     - The A11y tree returns `< 3` interactive nodes (e.g., canvas apps, games, video editors like DaVinci Resolve/Blender, remote desktop), OR
     - The user asks a visual question (*"What's wrong with this CSS layout?"*, *"Explain this diagram"*), OR
     - The user used **Shift-Scribble-to-Focus** (crop the scribbled bounding box at 100% native resolution, downscale the rest of the screen to `1280px` max width).

---

## Pipeline 3: Spatial Overlay Tag Protocol (`[POINT]`, `[DRAW]`, `[3D]`)

The system prompt instructs the LLM/VLM to embed exact inline tags using normalized `0..1000` coordinates (or pixel coordinates mapped to `screenN`):

| Tag Syntax | Overlay Action |
| :--- | :--- |
| `[POINT:x,y:label:screenN]` | Animates pointer along a cubic Bezier curve from current pos to `(x, y)` on monitor `N`, showing `label` pill ([AGENTS.md](https://github.com/farzaa/clicky/blob/main/AGENTS.md)). |
| `[DRAW:circle:x,y,r:color]` | Draws an Excalidraw-style sketchy circle centered at `(x, y)` with radius `r`. |
| `[DRAW:box:x1,y1,x2,y2:label]` | Draws a highlighted bounding rectangle with optional callout label. |
| `[DRAW:arrow:x1,y1,x2,y2:label]` | Draws a curved hand-drawn arrow from `(x1,y1)` to `(x2,y2)`. |
| `[3D:preset_or_gltf:title]` | Opens `Model3DViewer` floating widget with interactive Three.js geometry/annotations. |
| `[STEP:idx/total:x1,y1,x2,y2:instruction]` | Registers a Guided Walkthrough step; highlights `(x1,y1,x2,y2)` and waits for user click inside bbox to auto-advance. |

---

## Pipeline 4: System-Wide & Screen-Aware Dictation + Self-Learning Dictionary

1. **Hotkey Down (`Fn+Ctrl` / `Alt+Shift+D`):** Capture active app name + focused A11y text context (if Screen-Aware mode is enabled).
2. **Stream STT:** Moonshine Streaming transcribes audio locally (`~107 ms` latency).
3. **Cleanup Pass:** Send raw transcript + `[Self-Learning Dictionary Hotwords]` + `[Optional Screen Context]` to `Groq gpt-oss-20b` (or local `Qwen3-1.7B`) with a strict prompt: *remove fillers, fix punctuation, match tone, output ONLY the final text*.
4. **Insert at Caret:** Save previous clipboard -> write cleaned text to clipboard -> simulate `Ctrl+V` (`Cmd+V` on macOS) via `enigo` -> restore previous clipboard after `150 ms`.
5. **20-Second Self-Learning Hook:**
   - Snapshot the inserted string `S_inserted`.
   - Poll the focused A11y text element (or `Ctrl+C` selection/window text) at `t = 5s, 10s, 20s`.
   - If the user edited `S_inserted` -> `S_edited` with Levenshtein word diff (e.g., `kube control` -> `kubectl`), upsert `(wrong_phrase, right_phrase, app_context)` into SQLite `dictionary_corrections` table ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).

---

## Pipeline 5: Drive Mode (Desktop UI Automation + Safety Watchdog)

1. **Plan:** Agent generates a tool call (`mouse_click`, `type_text`, `press_hotkey`).
2. **Confirm:** `DriveController` pauses and shows a floating `[Allow AI to Drive? (Yes / Esc)]` confirmation pill.
3. **Watchdog Thread:** On confirmation, spawn a `60 Hz` input monitor checking:
   - Physical mouse delta `> 15 px` from the last `enigo` synthetic move.
   - `Esc` key press.
   - Voice barge-in (`Silero VAD` trigger).
4. **Execute & Verify:** Run `enigo` action -> wait `150 ms` -> re-read A11y tree (or dirty screenshot) to verify UI state changed before proceeding to the next step.

---

## Pipeline 6: Background Agents ("Clickys") & Cron Scheduler

1. User says: *"Every Tuesday and Thursday at 5 PM, check my Gmail for invoices and save summaries."*
2. `AgentRuntime` creates a row in SQLite `cron_jobs` (`cron_expr = "0 17 * * 2,4"`, `agent_id = "invoice-checker"`, `prompt = "..."`).
3. `SchedulerService` (`tokio-cron-scheduler`) wakes up at trigger time -> instantiates `AgentRuntime` in headless mode (no overlay, no TTS unless urgent notification) -> calls assigned MCP tools (e.g., Gmail MCP) -> writes output to `~/.heyclicky/agents/invoice-checker/workspace/` -> sends a non-intrusive toast notification to `PillWindow`.
