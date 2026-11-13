# Product Vision & Core Idea (`idea.md`)

## 1. What Is HeyClicky?
**[HeyClicky](https://www.heyclicky.com/)** (originally launched as **[Clicky](https://github.com/farzaa/clicky)** by Farza Majeed / Humansongs, Inc., YC Spring 2026) is a screen-aware desktop AI companion for macOS and Windows ([Hokai](https://hokai.io/hub/tools/heyclicky), [HeyClicky Changelog](https://www.heyclicky.com/changelog)). It solves the **"interface problem"** of modern AI: instead of alt-tabbing to a browser chat window, taking manual screenshots, and pasting context, the assistant lives directly beside your cursor and in a top-edge notch/pill ([YC Launch](https://www.ycombinator.com/launches/QNN-this-is-heyclicky-an-ai-buddy-that-lives-next-to-your-computer-cursor)).

With a single global hotkey, it:
1. Captures your active screen context (gated strictly by hotkey, never recording silently in the background) ([Trust & Privacy](https://www.heyclicky.com/trust)).
2. Listens to your voice with ultra-low latency and responds out loud via streaming TTS ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
3. **Points, draws 2D annotations, and renders interactive 3D models** directly on a transparent overlay over any application to visually teach or guide you ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
4. **Dictates text system-wide** with screen-aware context and a self-learning dictionary ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
5. **Drives the desktop & browser** (with explicit confirmation and instant mouse/Esc interrupt) and spawns **named background agents ("Clickys")** with persistent memory, scheduled routines, and MCP tool integrations ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).

---

## 2. Why We Are Cloning It (And Our Differentiators)
While HeyClicky has strong UX, its commercial version has four major limitations reported by users ([r/macapps](https://www.reddit.com/r/macapps/comments/1srzk5a/has_anyone_tried_clicky/), [Trust & Privacy](https://www.heyclicky.com/trust), [Hokai](https://hokai.io/hub/tools/heyclicky)):
1. **100% Cloud-Processed & Closed Source:** Every screenshot and audio stream is sent to US cloud servers, raising privacy concerns around Screen Recording and Accessibility permissions.
2. **Expensive Subscription Quotas:** Pro costs $20/mo (capped at 150 agent messages/mo) and Max costs $100/mo ([HeyClicky](https://www.heyclicky.com/)).
3. **No Linux Support:** Commercial HeyClicky only supports macOS and Windows ([HeyClicky Changelog](https://www.heyclicky.com/changelog)).
4. **Pure Vision Reliance:** Visual pointing can misclick or miss state changes that OS Accessibility Trees detect deterministically ([The Rundown AI](https://www.therundown.ai/tools/clicky)).

### Our Clone's Design Pillars
1. **Zero-Cost Local-First Audio & Vision:** VAD (**Silero VAD**), STT (**Moonshine Streaming** / **Parakeet-TDT**), and TTS (**Kokoro-82M ONNX** / **Chatterbox-Turbo**) run 100% locally at zero cost.
2. **Hybrid Free-Tier Cloud + Local VLM Routing:** Simple/private screen tasks use local **Qwen3-VL-4B (Q4)** + **OmniParser v2 (`icon_detect_v3` + `icon_caption`)**; heavy reasoning or multi-step planning optionally routes to zero-cost API tiers (**Groq**, **Google Gemini Flash/Flash-Lite**, **OpenRouter `:free`**).
3. **Accessibility-First, Vision-Fallback Grounding:** Read native OS UI trees (`uiautomation` on Windows, `atspi` on Linux, `AXUIElement` on macOS) in `~80 ms` before invoking VLM vision, cutting latency and token usage dramatically.
4. **Cross-Platform Native Rust Core (Tauri v2):** Single `~5–15 MB` binary supporting **Windows 10/11, Linux (X11 + Wayland/PipeWire), and macOS**.
5. **100% Open, Extensible, & Auditable:** Local SQLite + vector memory, local MCP server support, and strict sensitive-field redaction.

---

## 3. Target Hardware Baseline
The default configuration is engineered to run smoothly on a **mid-range consumer laptop** (e.g., **6 GB VRAM GPU** like NVIDIA RTX 4050 + 16–32 GB RAM, or **Apple Silicon 16 GB+**, or **CPU-only + Free Cloud APIs**):
- **CPU handles Audio:** Silero VAD + Moonshine Streaming + Kokoro-82M ONNX (~2.6 GB RAM, `<150 ms` latency), leaving the GPU completely free.
- **GPU handles Local Vision (Optional):** Qwen3-VL-4B-Instruct Q4 (~3–4 GB VRAM) or OmniParser v2 (~1.5–2 GB VRAM).
- **Zero-GPU Fallback:** Switch VLM/LLM profile to Free Cloud APIs (Gemini Flash-Lite / Groq / OpenRouter `:free`) while keeping all audio 100% local.
