use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use std::io::Cursor;
use crate::error::{AppError, Result};

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
        Self {
            groq_api_key,
            client: reqwest::Client::new(),
        }
    }

    pub fn set_groq_api_key(&mut self, key: Option<String>) {
        self.groq_api_key = key;
    }

    /// Transcribe 16kHz f32 audio samples
    pub async fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String> {
        if samples.is_empty() {
            return Ok(String::new());
        }

        // Convert f32 samples to 16-bit PCM WAV bytes
        let wav_bytes = encode_wav_pcm16(samples, sample_rate, 1)?;

        // 1. If Groq API key is configured, use cloud Whisper
        if let Some(ref api_key) = self.groq_api_key {
            if let Ok(text) = self.transcribe_groq_whisper(wav_bytes.clone(), api_key).await {
                if !text.is_empty() {
                    return Ok(text);
                }
            }
        }

        // 2. Local offline fallback using faster-whisper via local_stt.py
        let script_path = resolve_script_path("local_stt.py");
        let temp_wav = std::env::temp_dir().join(format!("stt_{}.wav", uuid::Uuid::new_v4()));
        if std::fs::write(&temp_wav, &wav_bytes).is_ok() {
            let output = tokio::process::Command::new("python")
                .arg(&script_path)
                .arg(temp_wav.to_string_lossy().to_string())
                .output()
                .await;
            let _ = std::fs::remove_file(&temp_wav);

            if let Ok(out) = output {
                if out.status.success() {
                    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !text.is_empty() && !text.starts_with("Error:") {
                        return Ok(text);
                    }
                }
            }
        }

        Ok(String::new())
    }

    async fn transcribe_groq_whisper(&self, wav_bytes: Vec<u8>, api_key: &str) -> Result<String> {
        let part = Part::bytes(wav_bytes)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|e| AppError::Audio(format!("Failed to build audio part: {}", e)))?;

        let form = Form::new()
            .part("file", part)
            .text("model", "whisper-large-v3-turbo")
            .text("response_format", "json");

        let response = self.client
            .post("https://api.groq.com/openai/v1/audio/transcriptions")
            .bearer_auth(api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| AppError::Audio(format!("Whisper request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let err_body = response.text().await.unwrap_or_default();
            return Err(AppError::Audio(format!("Whisper error ({}): {}", status, err_body)));
        }

        let result: WhisperResponse = response.json().await
            .map_err(|e| AppError::Audio(format!("Failed to parse Whisper response: {}", e)))?;

        Ok(result.text.trim().to_string())
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
        .map_err(|e| AppError::Audio(format!("Failed to init WAV writer: {}", e)))?;

    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let s16 = (clamped * 32767.0) as i16;
        writer.write_sample(s16)
            .map_err(|e| AppError::Audio(format!("Failed to write sample: {}", e)))?;
    }

    writer.finalize()
        .map_err(|e| AppError::Audio(format!("Failed to finalize WAV: {}", e)))?;

    Ok(cursor.into_inner())
}

pub fn resolve_script_path(filename: &str) -> std::path::PathBuf {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts").join(filename));
        candidates.push(cwd.join("..").join("scripts").join(filename));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("scripts").join(filename));
            candidates.push(dir.join("..").join("scripts").join(filename));
        }
    }
    candidates.push(std::path::PathBuf::from(format!("D:\\cliky\\scripts\\{}", filename)));

    for c in candidates {
        if c.exists() {
            return c;
        }
    }
    std::path::PathBuf::from(format!("D:\\cliky\\scripts\\{}", filename))
}
