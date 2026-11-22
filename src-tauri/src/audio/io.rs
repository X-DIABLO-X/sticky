use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rodio::{buffer::SamplesBuffer, OutputStream, Sink};
use serde::{Deserialize, Serialize};
use crate::audio::ring_buffer::AudioRingProducer;
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub is_default: bool,
}

pub fn list_input_devices() -> Vec<AudioDeviceInfo> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let mut seen = HashSet::new();
    let mut devices = Vec::new();

    if let Ok(iter) = host.input_devices() {
        for dev in iter {
            if let Ok(name) = dev.name() {
                let trimmed = name.trim();
                if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
                    continue;
                }
                let is_default = default_name
                    .as_deref()
                    .map(|d| d.trim() == trimmed)
                    .unwrap_or(false);
                devices.push(AudioDeviceInfo {
                    name: trimmed.to_string(),
                    is_default,
                });
            }
        }
    }

    if let Some(def) = default_name {
        let trimmed = def.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
            devices.insert(
                0,
                AudioDeviceInfo {
                    name: trimmed.to_string(),
                    is_default: true,
                },
            );
        }
    }

    devices
}

pub fn list_output_devices() -> Vec<AudioDeviceInfo> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());
    let mut seen = HashSet::new();
    let mut devices = Vec::new();

    if let Ok(iter) = host.output_devices() {
        for dev in iter {
            if let Ok(name) = dev.name() {
                let trimmed = name.trim();
                if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
                    continue;
                }
                let is_default = default_name
                    .as_deref()
                    .map(|d| d.trim() == trimmed)
                    .unwrap_or(false);
                devices.push(AudioDeviceInfo {
                    name: trimmed.to_string(),
                    is_default,
                });
            }
        }
    }

    if let Some(def) = default_name {
        let trimmed = def.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
            devices.insert(
                0,
                AudioDeviceInfo {
                    name: trimmed.to_string(),
                    is_default: true,
                },
            );
        }
    }

    devices
}

fn pick_device<I>(devices: I, target: &str) -> Option<cpal::Device>
where
    I: Iterator<Item = cpal::Device>,
{
    let target_trimmed = target.trim();
    if target_trimmed.is_empty() {
        return None;
    }
    let target_lower = target_trimmed.to_lowercase();
    let mut partial_match: Option<cpal::Device> = None;

    for dev in devices {
        if let Ok(name) = dev.name() {
            let trimmed = name.trim();
            if trimmed == target_trimmed || trimmed.eq_ignore_ascii_case(target_trimmed) {
                return Some(dev);
            }
            if partial_match.is_none() && trimmed.to_lowercase().contains(&target_lower) {
                partial_match = Some(dev);
            }
        }
    }
    partial_match
}

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
    pub alive: Arc<AtomicBool>,
}

impl AudioOutputHandle {
    /// Clears queued audio immediately WITHOUT permanently stopping the rodio Sink.
    /// (Calling `sink.stop()` in rodio 0.19 can silence subsequent `append()` calls.)
    pub fn stop(&self) {
        self.sink.clear();
        self.sink.play();
    }

    pub fn shutdown(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.stop();
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

pub fn create_input_stream(
    mut producer: AudioRingProducer,
    device_name: Option<&str>,
) -> Result<AudioInputHandle> {
    let host = cpal::default_host();
    let device = if let Some(target) = device_name.map(str::trim).filter(|s| !s.is_empty()) {
        match host
            .input_devices()
            .ok()
            .and_then(|devs| pick_device(devs, target))
        {
            Some(dev) => {
                if dev.default_input_config().is_ok() {
                    dev
                } else {
                    eprintln!(
                        "[Audio] Selected input device '{target}' failed config probe; falling back to default."
                    );
                    host.default_input_device().ok_or_else(|| {
                        AppError::Audio("No default audio input device found".to_string())
                    })?
                }
            }
            None => {
                eprintln!(
                    "[Audio] Requested input device '{target}' not found; falling back to default."
                );
                host.default_input_device().ok_or_else(|| {
                    AppError::Audio("No default audio input device found".to_string())
                })?
            }
        }
    } else {
        host.default_input_device()
            .ok_or_else(|| AppError::Audio("No default audio input device found".to_string()))?
    };

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

pub fn create_output_stream(device_name: Option<&str>) -> Result<AudioOutputHandle> {
    let (tx, rx) = std::sync::mpsc::channel();
    let target_name = device_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    std::thread::Builder::new()
        .name("rodio-output-thread".into())
        .spawn(move || {
            let res = (|| -> std::result::Result<(OutputStream, Arc<Sink>), String> {
                let opened = if let Some(ref target) = target_name {
                    let host = cpal::default_host();
                    let matched = host
                        .output_devices()
                        .ok()
                        .and_then(|devs| pick_device(devs, target));
                    match matched {
                        Some(device) => match OutputStream::try_from_device(&device) {
                            Ok(pair) => Ok(pair),
                            Err(e) => {
                                eprintln!(
                                    "[Audio] Failed to open output device '{target}' ({e}); falling back to default."
                                );
                                OutputStream::try_default().map_err(|e2| {
                                    format!("Failed to open default audio output: {e2}")
                                })
                            }
                        },
                        None => {
                            eprintln!(
                                "[Audio] Requested output device '{target}' not found; falling back to default."
                            );
                            OutputStream::try_default().map_err(|e| {
                                format!("Failed to open default audio output: {e}")
                            })
                        }
                    }
                } else {
                    OutputStream::try_default()
                        .map_err(|e| format!("Failed to open default audio output: {e}"))
                };

                let (stream, stream_handle) = opened?;
                let sink = Sink::try_new(&stream_handle)
                    .map_err(|e| format!("Failed to create audio sink: {e}"))?;
                Ok((stream, Arc::new(sink)))
            })();

            match res {
                Ok((stream, sink)) => {
                    let alive = Arc::new(AtomicBool::new(true));
                    let handle = AudioOutputHandle {
                        sink,
                        alive: Arc::clone(&alive),
                    };
                    let _ = tx.send(Ok(handle));
                    while alive.load(Ordering::SeqCst) {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        let _ = &stream;
                    }
                    drop(stream);
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
