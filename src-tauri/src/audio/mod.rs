pub mod aec;
pub mod io;
pub mod ring_buffer;
pub mod stt;
pub mod tts;
pub mod vad;

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use crate::audio::aec::AecProcessor;
use crate::audio::io::{create_input_stream, create_output_stream, AudioInputHandle, AudioOutputHandle};
use crate::audio::ring_buffer::{create_audio_ring_buffer, AudioRingConsumer};
use crate::audio::stt::SttService;
use crate::audio::tts::KokoroTts;
use crate::audio::vad::{VadState, VoiceActivityDetector};
use crate::error::Result;

pub struct AudioEngine {
    ring_consumer: Option<AudioRingConsumer>,
    input_handle: Option<AudioInputHandle>,
    output_handle: Arc<Mutex<Option<AudioOutputHandle>>>,
    vad: VoiceActivityDetector,
    _aec: AecProcessor,
    stt: SttService,
    tts: KokoroTts,
    is_listening: bool,
    recorded_buffer: Vec<f32>,
    pub mic_sample_rate: u32,
}

impl AudioEngine {
    pub fn new(groq_api_key: Option<String>) -> Self {
        let output_handle = Arc::new(Mutex::new(None));
        let tts = KokoroTts::new(Arc::clone(&output_handle));
        let stt = SttService::new(groq_api_key);
        let vad = VoiceActivityDetector::default();
        let aec = AecProcessor::default();

        Self {
            ring_consumer: None,
            input_handle: None,
            output_handle,
            vad,
            _aec: aec,
            stt,
            tts,
            is_listening: false,
            recorded_buffer: Vec::with_capacity(48000 * 30), // 30 sec buffer
            mic_sample_rate: 44100,
        }
    }

    pub fn set_groq_api_key(&mut self, key: Option<String>) {
        self.stt.set_groq_api_key(key);
    }

    pub async fn init_output(&mut self) -> Result<()> {
        let out = create_output_stream()?;
        let mut guard = self.output_handle.lock().await;
        *guard = Some(out);
        Ok(())
    }

    pub fn start_mic(&mut self) -> Result<()> {
        if self.is_listening {
            return Ok(());
        }

        self.recorded_buffer.clear();
        self.vad.reset();

        // High capacity ring buffer for microphone streaming
        let (producer, consumer) = create_audio_ring_buffer(131072);
        self.ring_consumer = Some(consumer);

        let input_handle = create_input_stream(producer)?;
        self.mic_sample_rate = input_handle.sample_rate;
        self.input_handle = Some(input_handle);
        self.is_listening = true;

        Ok(())
    }

    pub fn stop_mic(&mut self) {
        if let Some(ref handle) = self.input_handle {
            handle.is_running.store(false, std::sync::atomic::Ordering::Relaxed);
        }
        self.input_handle = None;
        if let Some(ref mut consumer) = self.ring_consumer {
            let avail = consumer.slots_available();
            if avail > 0 {
                let mut buf = vec![0.0f32; avail];
                let read = consumer.pop_slice(&mut buf);
                self.recorded_buffer.extend_from_slice(&buf[..read]);
            }
        }
        self.ring_consumer = None;
        self.is_listening = false;
    }

    /// Read incoming PCM samples, compute RMS and run VAD across all available frames
    pub fn process_tick(&mut self) -> Option<(VadState, f32)> {
        let consumer = self.ring_consumer.as_mut()?;
        let mut last_state = None;
        let mut max_rms: f32 = 0.0;

        let sample_rate = if self.mic_sample_rate > 0 { self.mic_sample_rate } else { 44100 };
        let chunk_size = (sample_rate as usize * 30) / 1000; // 30ms chunk

        while consumer.slots_available() >= chunk_size {
            let mut chunk = vec![0.0f32; chunk_size];
            let read = consumer.pop_slice(&mut chunk);
            if read < chunk_size {
                break;
            }

            // Compute RMS energy directly from microphone signal
            let sum_sq: f32 = chunk.iter().map(|&s| s * s).sum();
            let rms = (sum_sq / chunk.len() as f32).sqrt();
            if rms > max_rms {
                max_rms = rms;
            }

            // Run VAD on frame
            let state = self.vad.process_frame(&chunk, Duration::from_millis(30));

            // Save clean mic audio to recorded buffer for Whisper transcription
            self.recorded_buffer.extend_from_slice(&chunk);

            if state == VadState::SpeechStarted || state == VadState::Speaking {
                last_state = Some(state);
            } else if last_state.is_none() || last_state == Some(VadState::Silence) {
                last_state = Some(state);
            }
        }

        last_state.map(|s| (s, max_rms))
    }

    pub async fn transcribe_recorded(&mut self) -> Result<String> {
        let samples = std::mem::take(&mut self.recorded_buffer);
        let sample_rate = if self.mic_sample_rate > 0 { self.mic_sample_rate } else { 44100 };
        self.stt.transcribe(&samples, sample_rate).await
    }

    pub async fn barge_in_flush(&mut self) {
        self.tts.abort_playback().await;
        if let Some(ref mut c) = self.ring_consumer {
            c.flush();
        }
    }

    pub async fn push_tts_token(&mut self, token: &str) -> Result<()> {
        self.tts.push_token(token).await
    }

    pub async fn flush_tts(&mut self) -> Result<()> {
        self.tts.flush_remaining().await
    }

    pub fn is_user_speaking(&self) -> bool {
        self.vad.is_currently_speaking()
    }

    pub fn sustained_speech_duration(&self) -> Duration {
        self.vad.sustained_speech_duration()
    }
}
