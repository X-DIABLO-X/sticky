# AI Models, Free APIs & Hardware Budgets (`models.md`)

Every model below is **free/open-weight** (for local execution) or **zero-cost free tier** (for cloud escalation), with verified late-2026 benchmarks and licenses.

---

## 1. Local TTS Models (Zero-Cost Voice Output)

| Model | Hugging Face / Repo ID | Params / Size | VRAM / RAM | Latency / RTF | License | Recommended Role |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Kokoro-82M** *(Default)* | [`hexgrad/Kokoro-82M`](https://huggingface.co/hexgrad/Kokoro-82M) / [`Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) | 82M (~326 MB FP32) | ~0.5–3 GB VRAM or ~2.6 GB CPU RSS | **0.014–0.03 RTF** GPU (`28–40 ms` TTFA); ~0.33 RTF CPU ([GigaGPU](https://gigagpu.com/tts-latency-benchmarks/), [VoxRT](https://huggingface.co/blog/VoxRT/small-cpu-text-to-speech-models-compared-piper-kok)) | **Apache 2.0** | **Primary TTS.** Runs in-process via `ort` ONNX on CPU, leaving GPU free for vision. |
| **Piper TTS** *(Ultra-Lite)* | [`OHF-Voice/piper1-gpl`](https://github.com/OHF-voice/piper1-gpl) | ~16M (~64 MB ONNX) | CPU-only (<500 MB RAM) | **~0.06 RTF** on 1 CPU core; `<120 ms` TTFA ([VoxRT](https://huggingface.co/blog/VoxRT/small-cpu-text-to-speech-models-compared-piper-kok), [PromptQuorum](https://www.promptquorum.com/power-local-llm/piper-tts-review)) | **GPL-3.0-or-later** | Low-RAM / battery-saver CPU fallback. |
| **Chatterbox-Turbo** *(Voice Clone)* | [`ResembleAI/chatterbox-turbo`](https://huggingface.co/ResembleAI/chatterbox-turbo) / [`chatterbox-turbo-ONNX`](https://huggingface.co/ResembleAI/chatterbox-turbo-ONNX) | 350M | ~4–6 GB VRAM | **~0.17 RTF** (~6x real-time), `~75 ms` GPU latency ([The Rundown AI](https://www.therundown.ai/tools/chatterbox-turbo)) | **MIT** | Optional expressive TTS with zero-shot voice cloning & `[laugh]`/`[whisper]` tags. |
| **Orpheus 3B** | [`canopylabs/orpheus-3b-0.1-ft`](https://huggingface.co/canopylabs/orpheus-3b-0.1-ft) / [`GGUF`](https://huggingface.co/Mungert/orpheus-3b-0.1-ft-GGUF) | 3B | ~4 GB VRAM (Q4) | Low-latency token streaming via `llama.cpp` ([CanopyAI](https://github.com/canopyai/Orpheus-TTS)) | **Apache 2.0** | High-expressiveness alternative if GPU is idle. |
| **MeloTTS** | [`myshell-ai/MeloTTS-English-v3`](https://huggingface.co/myshell-ai/MeloTTS-English-v3) | Lightweight VITS | CPU or ~4 GB VRAM | ~0.3x RTF CPU; ~0.02–0.05x RTF GPU ([Clore.ai](https://docs.clore.ai/guides/audio-and-voice/melotts)) | **MIT** | Multilingual VITS fallback. |

*(Note: Avoid F5-TTS for commercial distribution as its weights carry a **CC-BY-NC-4.0** non-commercial license ([SWivid/F5-TTS](https://huggingface.co/SWivid/F5-TTS)).)*

---

## 2. Local VAD & STT / ASR Models

| Model | Repo / Model ID | Size | Speed & Accuracy | License | Recommended Role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Silero VAD** *(Default)* | [`snakers4/silero-vad`](https://github.com/snakers4/silero-vad) | ~2 MB ONNX | `<1 ms` per 30 ms chunk on CPU | **MIT** | Primary voice activity gate (tune trailing silence to `200 ms`). |
| **TEN VAD** *(Low-Tail Alt)* | [`ten-framework/ten-vad`](https://github.com/ten-framework/ten-vad) | Lightweight | Faster end-of-speech transition than Silero's 50–100 ms tail | **Apache 2.0** | Optional drop-in replacement if tighter endpointing is needed. |
| **Moonshine Streaming** *(Default STT)* | [`moonshine-ai/moonshine`](https://github.com/moonshine-ai/moonshine) (`streaming-tiny` 34M, `small` 123M) / [`GGUF`](https://huggingface.co/cstr/moonshine-streaming-tiny-GGUF) | 27M–123M | **~107 ms latency** on edge CPU vs 11,286 ms for Whisper Large V3 ([ModelsLab](https://modelslab.com/blog/audio-generation/moonshine-vs-whisper-asr-real-time-speech-2026), [Moonshine v2 Paper](https://arxiv.org/html/2602.12241v1)) | **MIT** (EN) | **Primary live-streaming STT** for Talk & Dictation on CPU. |
| **Parakeet-TDT 0.6B** *(High-Acc STT)* | [`nvidia/parakeet-tdt-0.6b-v2`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) (EN) / [`v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (Multi) / [`INT8`](https://huggingface.co/sonic-speech/parakeet-tdt-0.6b-v3-int8) | 600M (INT8 uses 58% less mem) | **6.05% WER** (v2) / **6.34% WER** (v3); **RTFx 3386** ([NVIDIA](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)) | **CC-BY-4.0** | High-accuracy multilingual dictation & noisy environments. |
| **Faster-Whisper / Whisper.cpp** | [`SYSTRAN/faster-whisper`](https://github.com/SYSTRAN/faster-whisper) / [`ggerganov/whisper.cpp`](https://github.com/ggerganov/whisper.cpp) | 1.5–3 GB VRAM / GGUF | Up to 4x faster than OpenAI Whisper ([PromptQuorum](https://www.promptquorum.com/power-local-llm/faster-whisper-review)) | **MIT** | 83+ language fallback when non-Moonshine languages are spoken. |

---

## 3. Local VLMs, LLMs & GUI Grounding Models

| Model | Model ID | Params | VRAM (Q4/INT4) | Capabilities & Benchmarks | License |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Qwen3-VL-4B-Instruct** *(Default Local VLM)* | [`Qwen/Qwen3-VL-4B-Instruct`](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct) | 4B | **~3–4 GB VRAM** | 256K context, native PC/mobile GUI agent; **94.0% ScreenSpot**, **95.3% DocVQA** ([LLM Stats](https://llm-stats.com/models/compare/qwen3-vl-4b-instruct-vs-qwen3.5-2b)) | **Apache 2.0** |
| **Qwen3-VL-2B-Instruct** *(Ultra-Lite VLM)* | [`Qwen/Qwen3-VL-2B-Instruct`](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct) | 2B | ~2 GB VRAM | Fast screen Q&A on 4 GB GPUs or integrated graphics | **Apache 2.0** |
| **OmniParser v2.0** *(UI Box Detector)* | [`microsoft/OmniParser-v2.0`](https://huggingface.co/microsoft/OmniParser-v2.0) | `icon_detect_v3` (YOLOv9-E) + `icon_caption` (Florence-2) | ~1.5–2 GB VRAM | Extracts clickable UI bounding boxes + labels. `icon_detect_v3` replaces older AGPL YOLOv8 for **100% MIT** compliance ([Hugging Face](https://huggingface.co/microsoft/OmniParser-v2.0)) | **MIT** |
| **UI-TARS-1.5-7B** *(GUI Grounding)* | [`ByteDance-Seed/UI-TARS-1.5-7B`](https://huggingface.co/ByteDance-Seed/UI-TARS-1.5-7B) / [`GGUF`](https://huggingface.co/Mungert/UI-TARS-1.5-7B-GGUF) | 7B | **~5–6 GB VRAM** (Q4) | **49.6% on ScreenSpot-Pro** (vs Claude 3.7's 27.7%) ([Lilting](https://lilting.ch/en/articles/ui-tars-gui-agent)) | **Apache 2.0** |
| **Phi-4 Multimodal** | [`microsoft/Phi-4-multimodal-instruct`](https://huggingface.co/microsoft/Phi-4-multimodal-instruct) | 5.6B | ~3.1 GB weights (~6–8 GB w/ KV cache) | Unified text + image + audio ([Aquanode](https://www.aquanode.io/models/phi-4/phi-4-multimodal-instruct), [ZimaSpace](https://shop.zimaspace.com/pages/phi-4-multimodal-hardware-requirements)) | **MIT** |
| **Gemma 4 (E4B / 12B)** | [`google/gemma-4-12B`](https://huggingface.co/google/gemma-4-12B) | 4B–12B | 3–8 GB VRAM | Strong local reasoning & multimodal ([Google AI Docs](https://ai.google.dev/gemma/docs/core)) | **Apache 2.0** |

---

## 4. Zero-Cost Cloud API Tiers (Hybrid Escalation)

| Provider | Free Tier Limits | Best Models & Speed | Role in Router |
| :--- | :--- | :--- | :--- |
| **Groq Free Plan** ([Rate Limits](https://console.groq.com/docs/rate-limits)) | **30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD** | `openai/gpt-oss-20b` (`~1,000 tok/s`), `openai/gpt-oss-120b` (`~500 tok/s`), `qwen/qwen3.6-27b` ([Klymentiev](https://klymentiev.com/blog/groq-pricing)) | Ultra-fast dictation cleanup, text-only Talk, & A11y-tree action planning. *(Note: `llama-3.1-8b-instant` & `llama-3.3-70b-versatile` were removed from Groq Free on Aug 16, 2026.)* |
| **Google Gemini API** ([AI Studio Limits](https://aistudio.google.com/docs/rate-limits)) | Project-specific; typically **~15 RPM / 500 RPD** (Flash-Lite) and **~5 RPM / 20 RPD** (Flash) ([AIFreeAPI](https://www.aifreeapi.com/en/posts/google-gemini-api-free-tier)) | `gemini-2.5-flash-lite` / `gemini-2.5-flash` (native image + audio + text) | Complex multi-screen vision & PDF reasoning when local VLM is insufficient. |
| **OpenRouter `:free`** ([Free Models](https://openrouter.ai/collections/free-models)) | **20 RPM, 50 RPD** (jumps to **1,000 RPD** after a one-time $10 credit) ([TeamDay](https://www.teamday.ai/blog/best-free-ai-models-openrouter-2026)) | `google/gemma-4-31b-it:free` (262K ctx, image+video), `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, `openrouter/free` ([Buldrr](https://buldrr.com/openrouter-free-api-keys-free-models-simple-guide)) | Automatic cloud failover pool. |

---

## 5. Hardware Profile Presets (Configured in `config.toml`)
1. **`profile = "laptop_6gb"` (Default for RTX 4050 / 6 GB VRAM + 16–32 GB RAM):**
   - **CPU:** Silero VAD + Moonshine Streaming + Kokoro-82M ONNX (`~2.6 GB` RAM).
   - **GPU:** `Qwen3-VL-4B-Instruct` Q4_K_M (`~3.5 GB` VRAM) via `llama-server`, OR on-demand OmniParser v2 (`~1.8 GB` VRAM).
2. **`profile = "cpu_only_hybrid"` (No dGPU / Ultrabook):**
   - **CPU:** Silero VAD + Moonshine Streaming + Kokoro-82M ONNX (`~2.6 GB` RAM).
   - **Cloud Free:** Groq (`openai/gpt-oss-20b`) for text/A11y + Gemini Flash-Lite / OpenRouter `:free` for vision.
3. **`profile = "workstation_16gb_plus"` (16+ GB VRAM):**
   - **GPU:** `UI-TARS-1.5-7B` Q4 (`~5.5 GB`) + `Qwen3-VL-8B` / `Gemma-4-12B` + `Chatterbox-Turbo` (`~4 GB`).
