use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rodio::{buffer::SamplesBuffer, OutputStream, Sink};
use crate::audio::ring_buffer::AudioRingProducer;
use crate::error::{AppError, Result};

pub struct AudioInputHandle {
    pub stream: cpal::Stream,
    pub is_running: Arc<AtomicBool>,
    pub sample_rate: u32,
    pub channels: u16,
}

unsafe impl Send for AudioInputHandle {}
unsafe impl Sync for AudioInputHandle {}

#[derive(Clone)]
pub struct AudioOutputHandle {
    pub sink: Arc<Sink>,
}

impl AudioOutputHandle {
    /// Clears queued audio immediately WITHOUT permanently stopping the rodio Sink.
    /// (Calling `sink.stop()` in rodio 0.19 can silence subsequent `append()` calls.)
    pub fn stop(&self) {
        self.sink.clear();
        self.sink.play();
    }

    pub fn play_pcm_f32(&self, samples: Vec<f32>, sample_rate: u32, channels: u16) {
        let buf = SamplesBuffer::new(channels, sample_rate, samples);
        self.sink.append(buf);
        self.sink.play();
    }

    pub fn sleep_until_end(&self) {
        self.sink.sleep_until_end();
    }
}

fn push_resampled_mono(
    mono: &[f32],
    src_rate: u32,
    target_rate: u32,
    phase: &mut f64,
    producer: &mut AudioRingProducer,
) {
    if mono.is_empty() {
        return;
    }
    if src_rate == target_rate || src_rate == 0 {
        for &s in mono {
            let _ = producer.push(s);
        }
        return;
    }

    let step = src_rate as f64 / target_rate as f64;
    let len = mono.len() as f64;
    while *phase < len {
        let idx0 = phase.floor() as usize;
        let idx1 = (idx0 + 1).min(mono.len() - 1);
        let frac = (*phase - idx0 as f64) as f32;
        let sample = mono[idx0] * (1.0 - frac) + mono[idx1] * frac;
        let _ = producer.push(sample);
        *phase += step;
    }
    *phase -= len;
}

pub fn create_input_stream(mut producer: AudioRingProducer) -> Result<AudioInputHandle> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| AppError::Audio("No default audio input device found".to_string()))?;

    let supported_config = device
        .default_input_config()
        .map_err(|e| AppError::Audio(format!("Failed to get default input config: {e}")))?;

    let channels = supported_config.channels() as usize;
    let src_rate = supported_config.sample_rate().0;
    let target_rate = 16000u32;

    let is_running = Arc::new(AtomicBool::new(true));
    let running_flag = Arc::clone(&is_running);

    let err_fn = |err| eprintln!("[Audio Input Error]: {err}");
    let config: cpal::StreamConfig = supported_config.clone().into();
    let mut phase = 0.0f64;

    let stream = match supported_config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !running_flag.load(Ordering::Relaxed) || channels == 0 {
                    return;
                }
                let mut mono = Vec::with_capacity(data.len() / channels);
                for frame in data.chunks_exact(channels) {
                    let sum: f32 = frame.iter().copied().sum();
                    mono.push(sum / channels as f32);
                }
                push_resampled_mono(&mono, src_rate, target_rate, &mut phase, &mut producer);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                if !running_flag.load(Ordering::Relaxed) || channels == 0 {
                    return;
                }
                let mut mono = Vec::with_capacity(data.len() / channels);
                for frame in data.chunks_exact(channels) {
                    let sum: f32 = frame.iter().map(|&s| s as f32 / i16::MAX as f32).sum();
                    mono.push(sum / channels as f32);
                }
                push_resampled_mono(&mono, src_rate, target_rate, &mut phase, &mut producer);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream(
            &config,
            move |data: &[i32], _: &cpal::InputCallbackInfo| {
                if !running_flag.load(Ordering::Relaxed) || channels == 0 {
                    return;
                }
                let mut mono = Vec::with_capacity(data.len() / channels);
                for frame in data.chunks_exact(channels) {
                    let sum: f32 = frame.iter().map(|&s| s as f32 / i32::MAX as f32).sum();
                    mono.push(sum / channels as f32);
                }
                push_resampled_mono(&mono, src_rate, target_rate, &mut phase, &mut producer);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                if !running_flag.load(Ordering::Relaxed) || channels == 0 {
                    return;
                }
                let mut mono = Vec::with_capacity(data.len() / channels);
                for frame in data.chunks_exact(channels) {
                    let sum: f32 = frame
                        .iter()
                        .map(|&s| (s as f32 - 32768.0) / 32768.0)
                        .sum();
                    mono.push(sum / channels as f32);
                }
                push_resampled_mono(&mono, src_rate, target_rate, &mut phase, &mut producer);
            },
            err_fn,
            None,
        ),
        other => {
            return Err(AppError::Audio(format!(
                "Unsupported input sample format: {other:?}"
            )));
        }
    }
    .map_err(|e| AppError::Audio(format!("Failed to build input stream: {e}")))?;

    stream
        .play()
        .map_err(|e| AppError::Audio(format!("Failed to start input stream: {e}")))?;

    Ok(AudioInputHandle {
        stream,
        is_running,
        sample_rate: target_rate,
        channels: 1,
    })
}

pub fn create_output_stream() -> Result<AudioOutputHandle> {
    let (tx, rx) = std::sync::mpsc::channel();

    std::thread::Builder::new()
        .name("rodio-output-thread".into())
        .spawn(move || {
            let res = (|| -> std::result::Result<(OutputStream, Arc<Sink>), String> {
                let (_stream, stream_handle) = OutputStream::try_default()
                    .map_err(|e| format!("Failed to open default audio output: {e}"))?;
                let sink = Sink::try_new(&stream_handle)
                    .map_err(|e| format!("Failed to create audio sink: {e}"))?;
                Ok((_stream, Arc::new(sink)))
            })();

            match res {
                Ok((stream, sink)) => {
                    let _ = tx.send(Ok(AudioOutputHandle { sink }));
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        let _ = &stream;
                    }
                }
                Err(err) => {
                    let _ = tx.send(Err(AppError::Audio(err)));
                }
            }
        })
        .map_err(|e| AppError::Audio(format!("Failed to spawn rodio audio thread: {e}")))?;

    rx.recv().map_err(|e| {
        AppError::Audio(format!(
            "Rodio audio thread communication channel disconnected: {e}"
        ))
    })?
}
