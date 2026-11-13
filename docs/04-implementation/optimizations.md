# Latency & Resource Optimizations (`optimizations.md`)

Target: **End-to-end Time-to-First-Audio (TTFA) `< 300 ms`** and **<= 4 GB VRAM + <= 3 GB RAM** on consumer laptops.

---

## 1. End-to-End `< 300 ms` TTFA Latency Budget

| Stage | Target Budget | Optimization Technique |
| :--- | :--- | :--- |
| **Screen & A11y Capture** | **`0 ms` (on hotkey)** | **Event-Driven Pre-Warming:** `ContextPrewarmer` refreshes active window A11y tree + dirty-region capture on window focus change (`500 ms` debounce), so context is already in RAM on hotkey press ([Screenpipe](https://docs.screenpipe.com/architecture)). |
| **Audio Input -> VAD** | **`< 15 ms`** | **Lock-Free `rtrb` + AEC3-before-VAD:** `cpal` pushes `f32` frames into `rtrb` with zero locks ([rtrb](https://docs.rs/rtrb/)). `sonora` AEC3 + NS runs *before* Silero VAD so speaker TTS never triggers false speech ([LiveKit](https://livekit.com/blog/noise-cancellation)). |
| **Endpointing** | **`0–200 ms`** | **Push-to-Talk Commit / 200 ms Tail:** Commit immediately on hotkey release ([ElevenLabs](https://elevenlabs.io/blog/voice-agent-latency-optimization)). In Always-On mode, lower VAD trailing silence from default `500–800 ms` to **`200 ms`** ([Prodinit](https://prodinit.com/blog/production-voice-ai-agents-latency-architecture)). |
| **STT** | **`~107 ms`** | **Moonshine Streaming:** Encodes audio incrementally while user speaks; finalization takes `< 40 ms` after endpoint ([ModelsLab](https://modelslab.com/blog/audio-generation/moonshine-vs-whisper-asr-real-time-speech-2026)). |
| **LLM First Token** | **`~80–150 ms`** | **Speculative Prefill + Persistent HTTP/2:** Prefill system prompt + screen context while user is speaking. Keep persistent `reqwest` HTTP/2 connection pools to Groq/Gemini/local `llama-server` ([ElevenLabs](https://elevenlabs.io/blog/voice-agent-latency-optimization)). |
| **TTS First Audio** | **`~30–40 ms`** | **Sentence-Boundary Chunking + Kokoro-82M:** Flush at first clause (`.`, `!`, `?`, `:`, `;`, `\n`, `>= 18` chars). Override `rodio` default `100 ms` sink buffer down to **`15 ms`** ([rodio docs](https://docs.rs/rodio/latest/rodio/stream/index.html), [GigaGPU](https://gigagpu.com/tts-latency-benchmarks/)). |

---

## 2. Memory & 6 GB VRAM Optimization Rules
1. **CPU/GPU Split:** Keep **Silero VAD + Moonshine Streaming + Kokoro-82M ONNX** strictly on **CPU** (`~2.6 GB` RAM total). Never load Whisper Large or Chatterbox onto a 6 GB GPU alongside a VLM.
2. **VLM Quantization & KV Cache:** Run `Qwen3-VL-4B-Instruct` at **`Q4_K_M`** (`~3.5 GB` VRAM) with `--ctx-size 8192` and `--flash-attn` in `llama-server` so it fits safely inside 6 GB VRAM with headroom for the OS compositor.
3. **Dynamic Image Scaling:**
   - Full monitor screenshots: downscale to `1280px` max width, WebP quality `78` (`~60–120 KB`, `~3x` faster VLM vision encoding than 4K PNG).
   - **Scribble-to-Focus:** Crop the user's scribbled region at **100% native resolution** so small UI text/icons stay crisp without encoding a full 4K frame.
4. **Raw Binary IPC:** Never base64-encode audio waveforms or screen thumbnails across Tauri IPC. Use `tauri::ipc::Response::new(bytes)` and `Channel<ArrayBuffer>` ([Tauri Core API](https://v2.tauri.app/reference/javascript/api/namespacecore/)).

---

## 3. Fast-Path Routing (Skip Vision When Possible)
Before invoking any VLM:
1. Query the OS Accessibility Tree (`~80 ms`) ([terminator-rs](https://crates.io/crates/terminator-rs/0.9.2)).
2. If the user's command matches an interactive A11y element or browser DOM node, route to **text-only Groq (`openai/gpt-oss-20b`, ~1,000 tok/s)** or local `Qwen3-4B`—saving `500–1,500 ms` of vision encoding.
