# Complete Feature Specification (`features.md`)

Every feature below is derived from [HeyClicky](https://www.heyclicky.com/), the [HeyClicky Changelog](https://www.heyclicky.com/changelog), and the original [`farzaa/clicky` AGENTS.md](https://github.com/farzaa/clicky/blob/main/AGENTS.md), adapted for our local-first cross-platform clone.

---

## 1. Talk Mode (Screen-Aware Voice Assistant)
- **Trigger:** Push-to-talk global hotkey (`Ctrl+Alt` on Windows/Linux, `Control+Option` on macOS) or **Always-On Headphone Mode** (triple-tap `Ctrl`, requires AEC3 + headphone flag to prevent speaker feedback) ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
- **Behavior:**
  1. On hotkey press, immediately capture the active monitor's screenshot + active window's OS Accessibility Tree (pre-warmed).
  2. Stream microphone audio through AEC3 -> Silero VAD -> Moonshine Streaming STT.
  3. On hotkey release (or 200 ms VAD trailing silence in Always-On mode), finalize transcript and send `[User Transcript + Screen Context + Conversation History]` to the Model Router.
  4. Stream LLM response tokens at sentence boundaries into **Kokoro-82M ONNX** TTS and play audio immediately (`<300 ms` TTFA).
  5. Display optional live captions in a compact floating pill near the cursor.
- **Barge-In:** Speaking during TTS playback or pressing `Esc` immediately flushes the `rtrb` audio ring buffer and cancels the active LLM/TTS stream.

---

## 2. Spatial Context: On-Screen Pointing, 2D Drawing & 3D Models
- **Animated Cursor Pointing (`[POINT:x,y:label:screenN]`):**
  - The LLM/VLM emits structured point tags (e.g., `[POINT:1420,380:Export Button:screen0]`).
  - The full-screen transparent overlay parses these tags in real time and animates a glowing pointer along a smooth **cubic Bezier curve** to `(x, y)` with a floating label pill ([AGENTS.md](https://github.com/farzaa/clicky/blob/main/AGENTS.md)).
- **2D Excalidraw-Style Annotations:**
  - The assistant can draw circles, arrows, bounding boxes, and freehand highlights (`[DRAW:circle:x,y,r:color]`, `[DRAW:arrow:x1,y1,x2,y2:label]`) directly on the transparent overlay to explain UI layouts, code, or diagrams ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
  - **User Scribble-to-Focus:** While holding push-to-talk, the user can hold `Shift` (or toggle Draw-to-Focus) to scribble/circle a region on screen; that region's bounding box is cropped at full resolution and passed to the VLM ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
- **Interactive 3D Model Viewer:**
  - When explaining physical/spatial concepts (engines, molecules, 3D geometry, hardware circuits), the overlay opens a draggable, rotatable, clickable **Three.js / React-Three-Fiber** floating widget with annotated part callouts ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
- **Guided Step-by-Step Walkthroughs (Up to 15 Steps):**
  - For "how do I do X in [App]?" queries, the agent generates a structured step list (`Step 1/N ... Step N/N`).
  - It points to Step 1's target UI element and listens for a **click event** (or Accessibility Tree state change) inside the target bounding box; once the user clicks the right control, it **auto-advances** to Step 2 and speaks the next instruction ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).

---

## 3. System-Wide & Screen-Aware Dictation
- **Trigger:** Hold `Fn+Ctrl` (or `Alt+Shift+D` on Windows/Linux) for push-to-dictate, or double-tap for hands-free continuous dictation ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
- **Streaming Insertion:** Streams cleaned speech-to-text into the currently focused input field (via OS clipboard-paste fallback or synthetic keystrokes) at `<450 ms` latency across **83+ languages** ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
- **Automatic Cleanup:** Strips filler words ("um", "uh", "like"), fixes punctuation, and formats lists/paragraphs via a fast text-cleanup pass (local small LLM or Groq `gpt-oss-20b`).
- **Screen-Aware Dictation:** Reads the active window (e.g., an email thread, Slack DM, or PR comment) so the user can ramble informally (*"tell them I'll ship the fix by Friday morning"*) and insert a polished, context-matched reply in the user's tone ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
- **Self-Learning Dictionary:** Monitors the active text field / clipboard for **20 seconds** after dictation insertion; if the user edits a transcribed word (e.g., `Kube` -> `Kubernetes`, or a teammate's name), it stores the `(spoken_phonetic -> corrected_spelling)` pair in local SQLite and injects it as a custom hotword/prompt bias for future STT & cleanup runs ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).

---

## 4. Desktop UI Automation ("Drive Mode")
- **Trigger:** Voice or text command like *"Click export and save it as MP4"* or *"Fill out this form from the PDF"*.
- **Safety Gate:** Requires explicit user confirmation (`[Confirm Action]` pill or voice "Yes") before taking mouse/keyboard control ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
- **Execution Loop:**
  1. Query OS Accessibility Tree (`uiautomation` / `atspi` / `AXUIElement`) first to find exact element coordinates.
  2. Fall back to OmniParser v2 / Qwen3-VL-4B / UI-TARS-1.5-7B if the app is custom-rendered (e.g., games, canvas apps, Electron without a11y).
  3. Execute action via `enigo` (`SendInput` / `CGEventPost` / `libei` or `ydotool`), displaying a glowing "AI Driving" border around the screen.
- **Instant Human Override:** Any physical mouse movement (`>15px`), keyboard press (`Esc`), or voice barge-in **immediately aborts** Drive Mode and returns control to the user ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).

---

## 5. Background Agents ("Clickys"), Scheduled Routines & Memory
- **Named Sub-Agents:** Users can spawn independent agents (e.g., *"Invoice Checker"*, *"PR Reviewer"*, *"Research Buddy"*), each with its own:
  - Avatar, system prompt, and model preference.
  - Isolated SQLite chat history & working folder (`~/.heyclicky/agents/<agent_id>/workspace/`).
  - Assigned MCP tools & browser permissions ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
- **Scheduled Routines (Cron):** Natural language voice scheduling (*"Every Tuesday and Thursday at 5 PM, check my Gmail for invoices"*) parsed into standard cron expressions stored in SQLite and executed by a Tokio background scheduler ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
- **Persistent Memory:**
  - **User Preferences:** Answer length, formatting, tone, forbidden actions.
  - **Episodic Screen Memory:** Summarized context from recent screens within a session (raw screenshots are discarded immediately after processing unless explicitly saved by the user) ([Trust & Privacy](https://www.heyclicky.com/trust)).
  - **Document/File Drop:** Drag-and-drop PDFs, Markdown, CSVs, or URLs onto the Home Pill for whole-document indexing into local SQLite + embeddings (`fastembed-rs`) ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).

---

## 6. Browser Extension & MCP Integrations
- **Chrome/Chromium Extension (MV3):** Connects to the local Rust daemon via **Chrome Native Messaging** (zero open public ports) ([Privacy Policy](https://www.heyclicky.com/privacy-policy)) and optional **CDP (`chromiumoxide`)**.
  - Lets agents read DOM/page text, click elements, navigate tabs, and upload files in signed-in sessions.
  - **Hard Security Redaction:** Automatically masks and refuses to read or type into `input[type="password"]`, `autocomplete="one-time-code"`, `autocomplete="cc-*"`, and banking/OTP fields ([Privacy Policy](https://www.heyclicky.com/privacy-policy)).
- **MCP (Model Context Protocol) Client:** Supports both **local stdio MCP servers** (filesystem, git, local scripts, Apple Notes/Calendar) and **remote SSE/HTTP MCP servers** (Gmail, Google Calendar, Drive/Sheets, Notion, Linear, Stripe) ([HeyClicky Changelog](https://www.heyclicky.com/changelog), [Hokai](https://hokai.io/hub/tools/heyclicky)).
