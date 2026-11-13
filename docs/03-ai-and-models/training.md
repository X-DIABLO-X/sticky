# Fine-Tuning, Adaptation & Evaluation (`training.md`)

While the default stack works out-of-the-box with zero training using pre-trained weights, this document specifies how to fine-tune and adapt models for higher GUI grounding accuracy, custom voice cloning, and personalized dictation.

---

## 1. GUI Grounding Fine-Tuning (`Qwen3-VL-4B` / `UI-TARS-1.5-7B`)
To improve `[POINT:x,y:label:screenN]` coordinate accuracy on specialized software (e.g., DaVinci Resolve, Blender, KiCad, custom enterprise apps):

### Dataset Format (Normalized `0..1000` Coordinates)
Use the standard multimodal ShareGPT/OpenAI messages format with **1000x1000 normalized bounding boxes** so coordinates remain resolution-independent across 1080p, 1440p, and 4K monitors:
```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are a screen-aware assistant. When pointing to UI elements, output [POINT:x,y:label:screen0] using 0-1000 normalized coordinates."
    },
    {
      "role": "user",
      "content": [
        {"type": "image", "image": "screenshots/resolve_0042.webp"},
        {"type": "text", "text": "Where do I add a Gaussian blur node?"}
      ]
    },
    {
      "role": "assistant",
      "content": "Open the Effects library in the top-left [POINT:115,48:Effects Library:screen0] and drag Gaussian Blur onto the node graph."
    }
  ]
}
```

### Public Datasets to Bootstrap Training
- **OS-Atlas / ScreenSpot / ScreenSpot-Pro:** Desktop and web GUI grounding datasets used to benchmark [Qwen3-VL-4B](https://llm-stats.com/models/compare/qwen3-vl-4b-instruct-vs-qwen3.5-2b) (94.0% ScreenSpot) and [UI-TARS-1.5-7B](https://lilting.ch/en/articles/ui-tars-gui-agent) (49.6% ScreenSpot-Pro).
- **Self-Generated Traces:** Log every successful **Guided Walkthrough** and **A11y-verified Drive Mode click** locally (with user opt-in) as `(screenshot, instruction, verified_click_xy)` tuples.

### QLoRA Training Recipe (Fits on 1x 16–24 GB GPU or Free Colab/Kaggle T4/P100)
- **Framework:** `Unsloth` or `LLaMA-Factory` (`qwen3_vl` template).
- **Hyperparameters:**
  - Quantization: `4-bit NF4` (`bitsandbytes`)
  - LoRA Rank `r = 16`, `lora_alpha = 32`, `target_modules = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]`
  - Learning Rate: `2e-4` (cosine decay, 5% warmup), Batch Size: `16` (grad accum), Epochs: `2–3`
- **Export for Local Inference:** Merge LoRA -> export to GGUF -> quantize to `Q4_K_M` via `llama.cpp` `llama-quantize` so it runs in `~3.5 GB VRAM` on the user's laptop.

---

## 2. STT & Dictation Personalization (Zero-Training + Hotword Biasing)
Full acoustic fine-tuning of Moonshine or Parakeet-TDT is **not required** for personal vocabulary (names, acronyms, code symbols). Instead, implement a **2-stage adaptation**:
1. **Self-Learning Dictionary (Runtime):**
   - Capture user edits within 20 seconds of dictation insertion (see `pipelines.md` Pipeline 4).
   - Store in SQLite `dictionary_corrections(wrong TEXT, right TEXT, frequency INT)`.
2. **Prompt & Decoder Biasing:**
   - Pass the top-50 `right` terms as a compact `glossary` list to the **Dictation Cleanup LLM** (`Groq gpt-oss-20b` / local `Qwen3-1.7B`) so phonetic misrecognitions (e.g., *"hey clicky"* -> *"HeyClicky"*, *"tauri"* -> *"Tauri"*) are corrected deterministically in `<50 ms`.
   - When using **Whisper.cpp / Faster-Whisper**, inject the top-30 terms into `initial_prompt` for native decoder biasing.

---

## 3. Custom Voice / TTS Adaptation
- **Zero-Shot Voice Cloning (No Training):** Use **[Chatterbox-Turbo](https://huggingface.co/ResembleAI/chatterbox-turbo)** (`MIT`, 350M) or **[Orpheus 3B](https://huggingface.co/canopylabs/orpheus-3b-0.1-ft)** (`Apache 2.0`). Provide a single `5–10 second` clean `.wav` reference clip in `~/.heyclicky/voices/custom.wav` to clone any persona voice at `~75 ms` GPU latency ([The Rundown AI](https://www.therundown.ai/tools/chatterbox-turbo)).
- **Kokoro-82M Speaker Blending (CPU-Friendly):** Kokoro-82M supports interpolating pre-computed `.npy`/`.bin` voice style vectors (`af_heart`, `af_bella`, `am_adam`, etc.) at runtime with zero training cost ([hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)).

---

## 4. Automated Evaluation Suite (`tests/eval/`)
Before shipping any model update or prompt change, run these 3 automated checks:
1. **Pointing Accuracy (`eval_pointing.py`):** Evaluate `[POINT:x,y]` predictions against a held-out 100-screenshot test set; pass criterion = click falls inside ground-truth `bbox` `>= 85%` of the time.
2. **Audio Latency (`cargo test --release bench_audio_ttfa`):** Measure `VAD_end -> Kokoro_first_PCM_frame`; pass criterion = `< 300 ms` on target CPU.
3. **Tag-Stream Integrity (`cargo test tag_stream`):** Verify `TagStreamParser` strips 100% of `[POINT:...]`, `[DRAW:...]`, and `[3D:...]` tags before TTS synthesis while emitting valid JSON events.
