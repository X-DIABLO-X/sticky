use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadState {
    Silence,
    SpeechStarted,
    Speaking,
    SpeechEnded,
}

pub struct VoiceActivityDetector {
    energy_threshold: f32,
    silence_duration: Duration,
    speech_duration: Duration,
    tail_endpoint_duration: Duration,
    last_speech_time: Option<Instant>,
    first_speech_time: Option<Instant>,
    is_speaking: bool,
    adaptive_floor: f32,
}

impl Default for VoiceActivityDetector {
    fn default() -> Self {
        Self::new(0.008, Duration::from_millis(300))
    }
}

impl VoiceActivityDetector {
    pub fn new(energy_threshold: f32, tail_endpoint_duration: Duration) -> Self {
        Self {
            energy_threshold,
            silence_duration: Duration::from_millis(0),
            speech_duration: Duration::from_millis(0),
            tail_endpoint_duration,
            last_speech_time: None,
            first_speech_time: None,
            is_speaking: false,
            adaptive_floor: 0.003,
        }
    }

    /// Process a frame of 16kHz audio samples (typically 30ms = 480 samples, or 10ms = 160 samples)
    pub fn process_frame(&mut self, samples: &[f32], frame_duration: Duration) -> VadState {
        if samples.is_empty() {
            return VadState::Silence;
        }

        // Calculate Root Mean Square (RMS) energy
        let sum_sq: f32 = samples.iter().map(|&s| s * s).sum();
        let rms = (sum_sq / samples.len() as f32).sqrt();

        // Dynamically track background noise floor
        if rms < self.adaptive_floor {
            self.adaptive_floor = 0.92 * self.adaptive_floor + 0.08 * rms;
        } else {
            self.adaptive_floor = 0.998 * self.adaptive_floor + 0.002 * rms;
        }

        let effective_threshold = (self.energy_threshold).max(self.adaptive_floor * 2.2);
        let has_speech = rms > effective_threshold;

        if has_speech {
            self.silence_duration = Duration::from_millis(0);
            self.speech_duration += frame_duration;
            self.last_speech_time = Some(Instant::now());

            if !self.is_speaking {
                self.is_speaking = true;
                self.first_speech_time = Some(Instant::now());
                return VadState::SpeechStarted;
            } else {
                return VadState::Speaking;
            }
        } else {
            // Silence frame
            if self.is_speaking {
                self.silence_duration += frame_duration;
                if self.silence_duration >= self.tail_endpoint_duration {
                    self.is_speaking = false;
                    self.speech_duration = Duration::from_millis(0);
                    self.first_speech_time = None;
                    return VadState::SpeechEnded;
                } else {
                    return VadState::Speaking;
                }
            } else {
                return VadState::Silence;
            }
        }
    }

    pub fn is_currently_speaking(&self) -> bool {
        self.is_speaking
    }

    /// Check if speech has been sustained for at least `duration` (useful for barge-in >= 120ms)
    pub fn sustained_speech_duration(&self) -> Duration {
        if self.is_speaking {
            self.speech_duration
        } else {
            Duration::from_millis(0)
        }
    }

    pub fn reset(&mut self) {
        self.is_speaking = false;
        self.silence_duration = Duration::from_millis(0);
        self.speech_duration = Duration::from_millis(0);
        self.last_speech_time = None;
        self.first_speech_time = None;
    }
}
