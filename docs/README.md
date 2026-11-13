# HeyClicky Clone — Complete Engineering & Architecture Blueprint

This documentation suite is a **deterministic, zero-ambiguity engineering specification** for building an open-source, cross-platform (Windows, Linux, macOS), privacy-first clone of **[HeyClicky](https://www.heyclicky.com/)** (originally launched as [`farzaa/clicky`](https://github.com/farzaa/clicky)).

It is structured specifically so a smaller, fast coding model (e.g., Gemini Flash) can read any section and implement the codebase module-by-module without needing to make architectural decisions or guess interfaces.

---

## How to Traverse This Documentation

Read and implement in the following numbered order:

### `01-overview/` — Product & Feature Specification
1. **[`01-overview/idea.md`](./01-overview/idea.md)** — Core product vision, how HeyClicky works, why we are cloning it with local-first privacy & zero-cost AI, and key architectural improvements over the commercial version.
2. **[`01-overview/features.md`](./01-overview/features.md)** — Exhaustive functional specification for every feature: Talk Mode, Spatial Context (2D drawing, pointing, 3D models, guided walkthroughs), System-Wide & Screen-Aware Dictation, Desktop UI Automation ("Drive"), Background Agents ("Clickys"), Scheduled Routines, Persistent Memory, Browser Extension, and MCP Integrations.

### `02-architecture/` — System Design, Tech Stack & File Layout
3. **[`02-architecture/architecture.md`](./02-architecture/architecture.md)** — High-level system architecture, Tauri v2 + Rust Core + Local ONNX/Inference sidecar, IPC channels, audio/capture threading model, and hybrid cloud/local routing.
4. **[`02-architecture/tech-stack.md`](./02-architecture/tech-stack.md)** — Exact libraries, Rust crates, Python/ONNX packages, and OS-specific APIs with justification and latency benchmarks.
5. **[`02-architecture/folders.md`](./02-architecture/folders.md)** — Complete monorepo directory and file tree with the exact responsibility of every single file.

### `03-ai-and-models/` — Models, Pipelines & Fine-Tuning
6. **[`03-ai-and-models/models.md`](./03-ai-and-models/models.md)** — Exact Hugging Face model IDs, licenses, VRAM/RAM budgets, quantization formats, and free-tier cloud API configurations (Groq, Gemini, OpenRouter).
7. **[`03-ai-and-models/pipelines.md`](./03-ai-and-models/pipelines.md)** — Step-by-step execution pipelines, state machines, tag protocols (`[POINT:x,y:label:screenN]`), and audio/vision data flows.
8. **[`03-ai-and-models/training.md`](./03-ai-and-models/training.md)** — Fine-tuning Qwen3-VL / UI-TARS for GUI grounding, self-learning dictation dictionary adaptation, and voice cloning / speaker embedding customization.

### `04-implementation/` — Tools, Optimizations, UI & Build Order
9. **[`04-implementation/tools.md`](./04-implementation/tools.md)** — Exact JSON schemas, Rust structs, TypeScript types, and MCP tool definitions for all OS, screen, overlay, browser, and agent actions.
10. **[`04-implementation/optimizations.md`](./04-implementation/optimizations.md)** — End-to-end `<300ms` TTFA latency budget, lock-free `rtrb` ring buffers, AEC3-before-VAD, speculative LLM prefill, context pre-warming, and 6 GB VRAM memory management.
11. **[`04-implementation/ui-ux-overlay.md`](./04-implementation/ui-ux-overlay.md)** — Windowing, transparent click-through hit-testing, Notch/Top-Edge Pill, Cursor Bubble, Excalidraw 2D annotations, Three.js 3D viewer, and Guided Walkthroughs.
12. **[`04-implementation/browser-and-mcp.md`](./04-implementation/browser-and-mcp.md)** — Chrome MV3 Extension, Chrome Native Messaging host, `chromiumoxide` CDP bridge, sensitive-field redaction, and MCP server client.
13. **[`04-implementation/build-and-flash-guide.md`](./04-implementation/build-and-flash-guide.md)** — Deterministic 6-phase implementation checklist, exact `Cargo.toml` & `package.json` manifests, environment variables, and verification tests for the coding model.
