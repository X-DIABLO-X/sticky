use std::sync::Arc;
use base64::Engine;
use tokio::sync::Mutex;

use crate::audio::io::AudioOutputHandle;
use crate::error::{AppError, Result};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct KokoroTts {
    output_handle: Arc<Mutex<Option<AudioOutputHandle>>>,
    text_buffer: String,
}

impl KokoroTts {
    pub fn new(output_handle: Arc<Mutex<Option<AudioOutputHandle>>>) -> Self {
        Self {
            output_handle,
            text_buffer: String::new(),
        }
    }

    /// Buffer streamed tokens and flush cleanly at sentence boundaries.
    pub async fn push_token(&mut self, token: &str) -> Result<()> {
        self.text_buffer.push_str(token);

        let should_flush = self.text_buffer.len() >= 18
            && self
                .text_buffer
                .chars()
                .any(|c| matches!(c, '.' | '!' | '?' | '\n' | ':' | ';'));

        if should_flush {
            let chunk = std::mem::take(&mut self.text_buffer);
            self.synthesize_and_play(&chunk).await?;
        }
        Ok(())
    }

    pub async fn flush_remaining(&mut self) -> Result<()> {
        if !self.text_buffer.trim().is_empty() {
            let chunk = std::mem::take(&mut self.text_buffer);
            self.synthesize_and_play(&chunk).await?;
        }
        Ok(())
    }

    pub async fn abort_playback(&mut self) {
        self.text_buffer.clear();
        let guard = self.output_handle.lock().await;
        if let Some(ref out) = *guard {
            out.stop();
        }
    }

    /// Strips Markdown syntax so TTS speaks natural prose without reading asterisks/backticks.
    fn sanitize_for_speech(input: &str) -> String {
        input
            .replace("```", " ")
            .replace('`', "")
            .replace("**", "")
            .replace("__", "")
            .replace("###", "")
            .replace("##", "")
            .replace('#', "")
            .replace('\r', " ")
            .replace('\n', " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub async fn synthesize_and_play(&self, text: &str) -> Result<()> {
        let clean_text = Self::sanitize_for_speech(text);
        if clean_text.is_empty() {
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            let status = tokio::process::Command::new("say")
                .arg(&clean_text)
                .status()
                .await
                .map_err(|e| AppError::Audio(format!("macOS `say` TTS failed: {e}")))?;
            if !status.success() {
                return Err(AppError::Audio("macOS `say` exited with non-zero status".into()));
            }
            return Ok(());
        }

        #[cfg(target_os = "linux")]
        {
            let ok = tokio::process::Command::new("espeak-ng")
                .arg(&clean_text)
                .status()
                .await
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                tokio::process::Command::new("spd-say")
                    .arg("--wait")
                    .arg(&clean_text)
                    .status()
                    .await
                    .map_err(|e| AppError::Audio(format!("Linux TTS (`espeak-ng`/`spd-say`) failed: {e}")))?;
            }
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        {
            let b64_text = base64::engine::general_purpose::STANDARD.encode(clean_text.as_bytes());
            let script_path = crate::audio::stt::resolve_script_path("speak.ps1");
            let temp_wav = std::env::temp_dir().join(format!("sticky_tts_{}.wav", uuid::Uuid::new_v4()));

            let mut cmd = tokio::process::Command::new("powershell");
            cmd.creation_flags(CREATE_NO_WINDOW);

            if script_path.exists() {
                cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                    .arg(&script_path)
                    .args(["-TextBase64", &b64_text, "-OutFile"])
                    .arg(&temp_wav);
            } else {
                // Self-contained inline SAPI fallback if speak.ps1 is missing
                let wav_str = temp_wav.to_string_lossy().replace('\'', "''");
                let ps_inline = format!(
                    "Add-Type -AssemblyName System.Speech; \
                     $t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{b64_text}')); \
                     $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
                     $s.Rate = 1; $s.Volume = 100; \
                     $s.SetOutputToWaveFile('{wav_str}'); $s.Speak($t); $s.Dispose();"
                );
                cmd.args(["-NoProfile", "-Command", &ps_inline]);
            }

            let output = cmd
                .output()
                .await
                .map_err(|e| AppError::Audio(format!("PowerShell TTS failed to start: {e}")))?;

            if !output.status.success() || !temp_wav.exists() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(AppError::Audio(format!(
                    "Windows SAPI TTS failed (exit {:?}): {}",
                    output.status.code(),
                    stderr.trim()
                )));
            }

            let wav_bytes = tokio::fs::read(&temp_wav)
                .await
                .map_err(|e| AppError::Audio(format!("Failed reading synthesized WAV: {e}")))?;
            let _ = tokio::fs::remove_file(&temp_wav).await;

            let mut reader = hound::WavReader::new(std::io::Cursor::new(wav_bytes))
                .map_err(|e| AppError::Audio(format!("Invalid WAV from TTS: {e}")))?;
            let spec = reader.spec();
            let samples: Vec<f32> = match spec.sample_format {
                hound::SampleFormat::Int => reader
                    .samples::<i16>()
                    .filter_map(std::result::Result::ok)
                    .map(|s| s as f32 / i16::MAX as f32)
                    .collect(),
                hound::SampleFormat::Float => reader
                    .samples::<f32>()
                    .filter_map(std::result::Result::ok)
                    .collect(),
            };

            let guard = self.output_handle.lock().await;
            if let Some(ref out) = *guard {
                out.play_pcm_f32(samples, spec.sample_rate, spec.channels);
                return Ok(());
            }

            return Err(AppError::Audio(
                "Audio output device not initialized (rodio sink is None)".into(),
            ));
        }
    }
}
