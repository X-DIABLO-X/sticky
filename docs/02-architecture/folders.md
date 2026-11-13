# Complete Monorepo Folder & File Structure (`folders.md`)

A smaller Flash model must follow this **exact directory and file layout**. Every file has a single, well-defined responsibility.

```text
heyclicky-clone/
├── package.json                          # Root workspace scripts (dev, build, lint, test)
├── README.md                             # Project setup & run instructions
├── .env.example                          # Optional free API keys (GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY)
│
├── src/                                  # Frontend (React 19 + TypeScript + Vite + TailwindCSS)
│   ├── main.tsx                          # React entrypoint; routes to Pill, Bubble, Overlay, or QuickInput by window label
│   ├── index.css                         # Tailwind base + transparent window styles
│   ├── types/
│   │   ├── events.ts                     # TS interfaces matching Rust Tauri events (Transcript, OverlayCmd, AgentStatus)
│   │   ├── tools.ts                      # Tool call & confirmation payload types
│   │   └── models.ts                     # Model profile, hardware tier, & API config types
│   ├── lib/
│   │   ├── ipc.ts                        # Typed wrappers around Tauri invoke() and Channel<ArrayBuffer>
│   │   ├── pointParser.ts                # Streaming regex parser for [POINT:x,y:label:screenN] & [DRAW:...] tags
│   │   └── bezier.ts                     # Cubic Bezier interpolation math for smooth pointer animation
│   ├── windows/
│   │   ├── PillWindow.tsx                # Top-edge notch/pill UI, agent switcher, settings, & cron list
│   │   ├── BubbleWindow.tsx              # Cursor-side floating waveform & live caption bubble
│   │   ├── QuickInputWindow.tsx          # Double-tap Ctrl text prompt bar + file drag-and-drop
│   │   └── OverlayWindow.tsx             # Full-screen transparent overlay orchestrator
│   └── components/
│       ├── overlay/
│       │   ├── AnimatedPointer.tsx       # Glowing cursor + label pill animated along Bezier curves
│       │   ├── DrawingCanvas.tsx         # Excalidraw-style 2D annotations + Shift-scribble-to-focus capture
│       │   ├── GuidedStepBox.tsx         # Highlighted target bounding box + step counter (1..15)
│       │   ├── DriveBorder.tsx           # Glowing screen border + "Press Esc or move mouse to stop" badge
│       │   └── Model3DViewer.tsx         # Three.js / React-Three-Fiber interactive 3D object viewer
│       ├── agents/
│       │   ├── AgentList.tsx             # Named background agents ("Clickys") with avatars & status
│       │   ├── AgentChat.tsx             # Per-agent conversation & workspace file browser
│       │   └── CronManager.tsx           # Natural-language scheduled routines viewer/editor
│       └── settings/
│           ├── ModelSettings.tsx         # Toggle Local-Only vs Hybrid Free APIs + download local ONNX/GGUF models
│           ├── HotkeySettings.tsx        # Customize Talk, Dictation, Pill, and Quick-Input shortcuts
│           └── McpSettings.tsx           # Add/remove local stdio & remote HTTP MCP servers
│
├── src-tauri/                            # Rust Core Backend (Tauri v2)
│   ├── Cargo.toml                        # All Rust dependencies (cpal, rodio, sonora, rtrb, ort, scap, enigo, etc.)
│   ├── tauri.conf.json                   # Multi-window config (transparent, decorations:false, macOSPrivateApi:true)
│   ├── capabilities/
│   │   └── default.json                  # Tauri v2 ACL permissions for global-shortcut, fs, shell, windows
│   └── src/
│       ├── main.rs                       # Binary entry -> calls lib::run()
│       ├── lib.rs                        # Tauri Builder, state initialization, hotkey registration, tray setup
│       ├── config.rs                     # AppConfig struct, ~/.heyclicky/config.toml load/save
│       ├── error.rs                      # Unified AppError enum (thiserror) serializable to Tauri IPC
│       │
│       ├── audio/                        # Real-time Audio & DSP
│       │   ├── mod.rs                    # AudioEngine orchestrator (start/stop streams, barge-in flush)
│       │   ├── io.rs                     # cpal input/output streams + rodio low-latency (15ms) sink
│       │   ├── ring_buffer.rs            # Lock-free rtrb SPSC ring buffer wrappers
│       │   ├── aec.rs                    # sonora (WebRTC AEC3 + NS + AGC2) processor
│       │   ├── vad.rs                    # Silero VAD ONNX runner (30ms chunks, configurable 200ms tail)
│       │   ├── stt.rs                    # Moonshine Streaming ONNX & Parakeet-TDT INT8 runner
│       │   └── tts.rs                    # Kokoro-82M ONNX sentence-streaming synthesizer (+ Piper fallback)
│       │
│       ├── screen/                       # Screen Capture, A11y Trees & Input
│       │   ├── mod.rs                    # ContextPrewarmer (rolling dirty-region + A11y cache)
│       │   ├── capture.rs                # scap / xcap multi-monitor screenshot + region crop + JPEG/WebP encode
│       │   ├── a11y/
│       │   │   ├── mod.rs                # Unified A11yNode struct & cross-platform trait
│       │   │   ├── windows.rs            # uiautomation (Windows UI Automation) implementation
│       │   │   ├── linux.rs              # atspi (Linux AT-SPI2 over zbus) implementation
│       │   │   └── macos.rs              # macos-accessibility-client (AXUIElement) implementation
│       │   └── input.rs                  # enigo mouse/keyboard + Wayland ydotool fallback + Drive Mode safety monitor
│       │
│       ├── ai/                           # Model Routing, Prompts & Streaming
│       │   ├── mod.rs                    # AgentRuntime & turn loop
│       │   ├── router.rs                 # ModelRouter (Local llama.cpp/Ollama vs Groq/Gemini/OpenRouter failover)
│       │   ├── providers/
│       │   │   ├── mod.rs                # Unified LlmProvider async trait (stream_chat)
│       │   │   ├── local_llamacpp.rs     # OpenAI-compatible local llama-server / Ollama client
│       │   │   ├── groq.rs               # Groq REST/SSE client (gpt-oss-20b, qwen3.6-27b)
│       │   │   ├── gemini.rs             # Google Gemini Flash / Flash-Lite REST/SSE client
│       │   │   └── openrouter.rs         # OpenRouter :free models REST/SSE client
│       │   ├── prompts.rs                # System prompts for Talk, Dictation Cleanup, Walkthrough, Drive, & Agents
│       │   └── tag_stream.rs             # Streaming parser separating spoken text from [POINT:...]/[DRAW:...] tags
│       │
│       ├── tools/                        # Agent Tool Registry & Execution
│       │   ├── mod.rs                    # ToolRegistry & JSON schema definitions
│       │   ├── os_tools.rs               # capture_screen, get_a11y_tree, mouse_click, type_text, press_hotkey
│       │   ├── overlay_tools.rs          # overlay_point, overlay_draw, overlay_3d, start_walkthrough
│       │   ├── browser_tools.rs          # CDP (chromiumoxide) + Chrome Native Messaging bridge
│       │   └── mcp_client.rs             # MCP stdio & HTTP/SSE client for external tools
│       │
│       ├── features/                     # High-Level Feature Controllers
│       │   ├── talk.rs                   # Talk Mode state machine (speculative prefill, TTS flush, barge-in)
│       │   ├── dictation.rs              # Dictation stream, active-caret paste, & 20s self-learning dictionary hook
│       │   ├── drive.rs                  # Drive Mode confirmation gate + 15px mouse/Esc interrupt watchdog
│       │   ├── walkthrough.rs            # Guided 15-step walkthrough click/A11y auto-advance monitor
│       │   └── scheduler.rs              # Tokio cron scheduler for recurring background Clicky agents
│       │
│       ├── storage/                      # Persistence & Memory
│       │   ├── mod.rs                    # SQLite connection pool (rusqlite) & migrations
│       │   ├── memory.rs                 # User preferences, self-learning dictionary, & episodic screen summaries
│       │   └── agents_repo.rs            # CRUD for named Clickys, chat history, & workspace paths
│       │
│       └── ui/                           # Tauri Window & Hotkey Controllers
│           ├── windows.rs                # Show/hide/position Pill, Bubble, QuickInput, & Overlay click-through toggle
│           └── hotkeys.rs                # tauri-plugin-global-shortcut handlers (press/release/double/triple tap)
│
├── sidecar-vision/                       # Optional Python Sidecar (for OmniParser v2 / Chatterbox-Turbo)
│   ├── pyproject.toml                    # FastAPI / gRPC / UDS dependencies (onnxruntime-gpu, ultralytics, transformers)
│   ├── server.py                         # Unix Domain Socket / localhost HTTP server for OmniParser v2 & Chatterbox
│   └── omniparser.py                     # icon_detect_v3 (YOLOv9-E) + icon_caption (Florence-2) pipeline
│
├── browser-extension/                    # Chrome / Edge / Brave / Arc / Vivaldi MV3 Extension
│   ├── manifest.json                     # MV3 manifest (activeTab, scripting, nativeMessaging)
│   ├── background.js                     # Service worker relaying commands between Native Messaging & content.js
│   ├── content.js                        # DOM reader, element clicker, & HARD sensitive-field redaction
│   └── native-host/
│       └── com.heyclicky.clone.json      # Chrome Native Messaging host manifest pointing to Rust binary
│
└── scripts/                              # Setup & Model Download Scripts
    ├── download_models.py                # Downloads Silero VAD, Moonshine, Kokoro-82M ONNX, & Qwen3-VL-4B GGUF
    └── build_release.sh                  # Cross-platform Tauri + sidecar bundle script
```
