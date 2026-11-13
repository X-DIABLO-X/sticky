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
    aec: AecProcessor,
    stt: SttService,
    tts: KokoroTts,
    is_listening: bool,
    recorded_buffer: Vec<f32>,
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
            aec,
            stt,
            tts,
            is_listening: false,
            recorded_buffer: Vec::with_capacity(16000 * 30), // 30 sec buffer
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

        // 16kHz audio: create ring buffer for ~4 seconds
        let (producer, consumer) = create_audio_ring_buffer(65536);
        self.ring_consumer = Some(consumer);

        let input_handle = create_input_stream(producer)?;
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

    /// Read incoming PCM samples, run AEC and VAD
    pub fn process_tick(&mut self) -> Option<VadState> {
        let consumer = self.ring_consumer.as_mut()?;
        let available = consumer.slots_available();
        if available < 480 {
            // Need at least 30ms @ 16kHz (480 samples)
            return None;
        }

        let mut raw_chunk = vec![0.0f32; 480];
        let read = consumer.pop_slice(&mut raw_chunk);
        if read < 480 {
            return None;
        }

        // Process AEC
        let mut clean_chunk = vec![0.0f32; 480];
        let ref_zero = vec![0.0f32; 480];
        self.aec.process_frame(&raw_chunk, &ref_zero, &mut clean_chunk);

        // Run VAD
        let state = self.vad.process_frame(&clean_chunk, Duration::from_millis(30));

        // Save samples to buffer
        self.recorded_buffer.extend_from_slice(&clean_chunk);

        Some(state)
    }

    pub async fn transcribe_recorded(&mut self) -> Result<String> {
        let samples = std::mem::take(&mut self.recorded_buffer);
        self.stt.transcribe(&samples, 16000).await
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
