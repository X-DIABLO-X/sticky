use std::io::Cursor;
use std::path::PathBuf;
use std::time::Duration;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use crate::error::{AppError, Result};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone)]
pub struct SttService {
    groq_api_key: Option<String>,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct WhisperResponse {
    text: String,
}

impl SttService {
    pub fn new(groq_api_key: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            groq_api_key,
            client,
        }
    }

    pub fn set_groq_api_key(&mut self, key: Option<String>) {
        self.groq_api_key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    }

    /// Transcribe 16kHz f32 mono audio samples. Surfaces exact diagnostics instead of silently returning empty.
    pub async fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String> {
        if samples.is_empty() {
            return Ok(String::new());
        }

        let peak = samples
            .iter()
            .fold(0.0f32, |acc, &s| acc.max(s.abs()));
        if peak < 0.002 {
            return Err(AppError::Audio(
                "Microphone audio was silent (peak < 0.002). Check OS microphone permissions & input device.".into(),
            ));
        }

        let wav_bytes = encode_wav_pcm16(samples, sample_rate, 1)?;
        let mut errors = Vec::new();

        // 1. Groq Whisper Large v3 Turbo (free tier) if key is configured
        if let Some(api_key) = self
            .groq_api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
        {
            match self.transcribe_groq_whisper(wav_bytes.clone(), api_key).await {
                Ok(text) if !text.is_empty() => return Ok(text),
                Ok(_) => errors.push("Groq Whisper returned empty text".to_string()),
                Err(e) => {
                    eprintln!("[STT] Groq Whisper failed: {e}");
                    errors.push(format!("Groq STT: {e}"));
                }
            }
        }

        // 2. Local offline fallback via scripts/local_stt.py
        match self.transcribe_local_python(&wav_bytes).await {
            Ok(text) if !text.is_empty() => return Ok(text),
            Ok(_) => errors.push("Local STT returned empty transcript".to_string()),
            Err(e) => {
                eprintln!("[STT] Local Python STT failed: {e}");
                errors.push(format!("Local STT: {e}"));
            }
        }

        Err(AppError::Audio(format!(
            "All STT backends failed: {}",
            errors.join(" | ")
        )))
    }

    async fn transcribe_local_python(&self, wav_bytes: &[u8]) -> Result<String> {
        let script_path = resolve_script_path("local_stt.py");
        if !script_path.exists() {
            return Err(AppError::Audio(format!(
                "local_stt.py not found (checked {:?})",
                script_path
            )));
        }

        let temp_wav = std::env::temp_dir().join(format!("sticky_stt_{}.wav", uuid::Uuid::new_v4()));
        tokio::fs::write(&temp_wav, wav_bytes)
            .await
            .map_err(|e| AppError::Audio(format!("Failed to write temp WAV: {e}")))?;

        let python_bin = resolve_python_executable();
        let mut cmd = tokio::process::Command::new(&python_bin);
        cmd.arg(&script_path).arg(&temp_wav);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .await
            .map_err(|e| AppError::Audio(format!("Failed to run {python_bin:?}: {e}")))?;

        let _ = tokio::fs::remove_file(&temp_wav).await;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if !output.status.success() || stdout.starts_with("Error:") {
            return Err(AppError::Audio(format!(
                "local_stt.py failed (exit {:?}): {} {}",
                output.status.code(),
                stdout,
                stderr
            )));
        }

        Ok(stdout)
    }

    async fn transcribe_groq_whisper(&self, wav_bytes: Vec<u8>, api_key: &str) -> Result<String> {
        let part = Part::bytes(wav_bytes)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|e| AppError::Audio(format!("Failed to build audio part: {e}")))?;

        let form = Form::new()
            .part("file", part)
            .text("model", "whisper-large-v3-turbo")
            .text("response_format", "json");

        let response = self
            .client
            .post("https://api.groq.com/openai/v1/audio/transcriptions")
            .bearer_auth(api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| AppError::Audio(format!("Groq Whisper request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let err_body = response.text().await.unwrap_or_default();
            return Err(AppError::Audio(format!("Groq Whisper HTTP {status}: {err_body}")));
        }

        let result: WhisperResponse = response
            .json()
            .await
            .map_err(|e| AppError::Audio(format!("Failed to parse Whisper JSON: {e}")))?;

        Ok(result.text.trim().to_string())
    }
}

pub fn resolve_python_executable() -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        for rel in [
            ".venv/Scripts/python.exe",
            "venv/Scripts/python.exe",
            "../.venv/Scripts/python.exe",
            ".venv/bin/python",
            "venv/bin/python",
        ] {
            let p = cwd.join(rel);
            if p.exists() {
                return p;
            }
        }
    }
    if cfg!(windows) {
        PathBuf::from("python")
    } else {
        PathBuf::from("python3")
    }
}

pub fn encode_wav_pcm16(samples: &[f32], sample_rate: u32, channels: u16) -> Result<Vec<u8>> {
    let mut cursor = Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = hound::WavWriter::new(&mut cursor, spec)
        .map_err(|e| AppError::Audio(format!("Failed to init WAV writer: {e}")))?;

    for &sample in samples {
        let s16 = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        writer
            .write_sample(s16)
            .map_err(|e| AppError::Audio(format!("Failed to write WAV sample: {e}")))?;
    }

    writer
        .finalize()
        .map_err(|e| AppError::Audio(format!("Failed to finalize WAV: {e}")))?;

    Ok(cursor.into_inner())
}

pub fn resolve_script_path(filename: &str) -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts").join(filename));
        candidates.push(cwd.join("..").join("scripts").join(filename));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("scripts").join(filename));
            candidates.push(dir.join("resources").join("scripts").join(filename));
            candidates.push(dir.join("..").join("scripts").join(filename));
        }
    }

    for c in candidates {
        if c.exists() {
            return c;
        }
    }
    PathBuf::from("scripts").join(filename)
}
