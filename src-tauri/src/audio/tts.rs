use std::sync::Arc;
use tokio::sync::Mutex;
use crate::audio::io::AudioOutputHandle;
use crate::error::Result;

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

    /// Add streamed text token, check for sentence boundary and flush to synthesizer
    pub async fn push_token(&mut self, token: &str) -> Result<()> {
        self.text_buffer.push_str(token);

        let should_flush = self.text_buffer.len() >= 20
            && self.text_buffer.chars().any(|c| c == '.' || c == '!' || c == '?' || c == '\n' || c == ':' || c == ';');

        if should_flush {
            let chunk = std::mem::take(&mut self.text_buffer);
            self.synthesize_and_play(&chunk).await?;
        }
        Ok(())
    }

    /// Flush any remaining buffered text
    pub async fn flush_remaining(&mut self) -> Result<()> {
        if !self.text_buffer.trim().is_empty() {
            let chunk = std::mem::take(&mut self.text_buffer);
            self.synthesize_and_play(&chunk).await?;
        }
        Ok(())
    }

    /// Immediate barge-in stop: stop rodio sink and clear text buffer
    pub async fn abort_playback(&mut self) {
        self.text_buffer.clear();
        let guard = self.output_handle.lock().await;
        if let Some(ref out) = *guard {
            out.stop();
        }
    }

    /// Synthesize text to real spoken voice audio and play via rodio or system speech
    pub async fn synthesize_and_play(&self, text: &str) -> Result<()> {
        let clean_text = text.trim();
        if clean_text.is_empty() {
            return Ok(());
        }

        let script_path = "D:\\cliky\\scripts\\speak.ps1";
        let temp_wav = std::env::temp_dir().join(format!("tts_{}.wav", uuid::Uuid::new_v4()));

        let status = tokio::process::Command::new("powershell")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(script_path)
            .arg("-Text")
            .arg(clean_text)
            .arg("-OutFile")
            .arg(temp_wav.to_string_lossy().to_string())
            .output()
            .await;

        if let Ok(output) = status {
            if output.status.success() && temp_wav.exists() {
                if let Ok(wav_bytes) = tokio::fs::read(&temp_wav).await {
                    let _ = tokio::fs::remove_file(&temp_wav).await;

                    if let Ok(mut reader) = hound::WavReader::new(std::io::Cursor::new(wav_bytes)) {
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
                    }
                }
            }
        }

        // Direct speak fallback if WAV capture is unavailable
        let _ = tokio::process::Command::new("powershell")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(script_path)
            .arg("-Text")
            .arg(clean_text)
            .spawn();

        Ok(())
    }
}
