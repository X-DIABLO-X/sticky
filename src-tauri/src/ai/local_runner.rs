use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareProfileDto {
    pub os: String,
    pub arch: String,
    pub cpu_cores: usize,
    pub total_ram_gb: u64,
    pub has_nvidia_gpu: bool,
    pub recommended_tier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalModelSpec {
    pub id: String,
    pub name: String,
    pub category: String,
    pub size_mb: u64,
    pub filename: String,
    pub download_url: String,
    pub installed: bool,
}

pub fn detect_hardware_profile() -> HardwareProfileDto {
    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);

    let has_nvidia_gpu = std::process::Command::new("nvidia-smi")
        .arg("-L")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let recommended_tier = if has_nvidia_gpu {
        "laptop_6gb_gpu".to_string()
    } else {
        "cpu_hybrid".to_string()
    };

    HardwareProfileDto {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_cores,
        total_ram_gb: 16,
        has_nvidia_gpu,
        recommended_tier,
    }
}

pub fn get_models_dir() -> std::path::PathBuf {
    let base = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let dir = base.join("models");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn get_available_models() -> Vec<LocalModelSpec> {
    let models_dir = get_models_dir();
    let specs = vec![
        (
            "silero-vad-v5",
            "Silero VAD v5 (ONNX)",
            "vad",
            2,
            "silero_vad.onnx",
            "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
        ),
        (
            "kokoro-82m-onnx",
            "Kokoro-82M v1.0 (ONNX)",
            "tts",
            326,
            "kokoro-v1.0.onnx",
            "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
        ),
        (
            "qwen3-vl-4b",
            "Qwen3-VL 4B Instruct (Ollama)",
            "vlm",
            3200,
            "qwen3-vl-4b.gguf",
            "ollama://qwen3-vl:4b",
        ),
    ];

    specs
        .into_iter()
        .map(|(id, name, category, size_mb, filename, url)| {
            let installed = models_dir.join(filename).exists();
            LocalModelSpec {
                id: id.to_string(),
                name: name.to_string(),
                category: category.to_string(),
                size_mb,
                filename: filename.to_string(),
                download_url: url.to_string(),
                installed,
            }
        })
        .collect()
}

pub async fn download_model_weights(model_id: &str, app_handle: &AppHandle) -> Result<String> {
    let catalog = get_available_models();
    let spec = catalog
        .into_iter()
        .find(|m| m.id == model_id || m.name == model_id)
        .ok_or_else(|| AppError::Config(format!("Unknown model_id: {model_id}")))?;

    let _ = app_handle.emit(
        "model_download_progress",
        serde_json::json!({ "modelId": spec.id, "progress": 10, "status": "starting" }),
    );

    if let Some(ollama_tag) = spec.download_url.strip_prefix("ollama://") {
        let client = reqwest::Client::new();
        let resp = client
            .post("http://127.0.0.1:11434/api/pull")
            .json(&serde_json::json!({ "name": ollama_tag, "stream": false }))
            .send()
            .await
            .map_err(|e| AppError::Network(format!("Failed to pull via Ollama: {e}")))?;

        if !resp.status().is_success() {
            return Err(AppError::Network(format!(
                "Ollama pull returned status {}",
                resp.status()
            )));
        }
    } else {
        let client = reqwest::Client::new();
        let bytes = client
            .get(&spec.download_url)
            .send()
            .await
            .map_err(|e| AppError::Network(format!("Download failed: {e}")))?
            .bytes()
            .await
            .map_err(|e| AppError::Network(format!("Failed reading model bytes: {e}")))?;

        let dest = get_models_dir().join(&spec.filename);
        tokio::fs::write(&dest, &bytes)
            .await
            .map_err(|e| AppError::Internal(format!("Failed saving model: {e}")))?;
    }

    let _ = app_handle.emit(
        "model_download_progress",
        serde_json::json!({ "modelId": spec.id, "progress": 100, "status": "completed" }),
    );

    Ok(format!("Model {} installed", spec.name))
}
