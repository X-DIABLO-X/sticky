use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rodio::{buffer::SamplesBuffer, OutputStream, Sink};
use crate::audio::ring_buffer::AudioRingProducer;
use crate::error::{AppError, Result};

pub struct AudioInputHandle {
    pub stream: cpal::Stream,
    pub is_running: Arc<AtomicBool>,
}

unsafe impl Send for AudioInputHandle {}
unsafe impl Sync for AudioInputHandle {}

#[derive(Clone)]
pub struct AudioOutputHandle {
    pub sink: Arc<Sink>,
}

pub fn create_input_stream(
    mut producer: AudioRingProducer,
) -> Result<AudioInputHandle> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| AppError::Audio("No default audio input device found".to_string()))?;

    let supported_config = device
        .default_input_config()
        .map_err(|e| AppError::Audio(format!("Failed to get default input config: {}", e)))?;

    let channels = supported_config.channels();

    let is_running = Arc::new(AtomicBool::new(true));
    let running_flag = Arc::clone(&is_running);

    let err_fn = |err| eprintln!("Audio input error: {}", err);

    let stream = match supported_config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &supported_config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !running_flag.load(Ordering::Relaxed) {
                    return;
                }
                for chunk in data.chunks(channels as usize) {
                    let mono_sample = chunk.iter().sum::<f32>() / (channels as f32);
                    producer.push(mono_sample);
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &supported_config.into(),
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                if !running_flag.load(Ordering::Relaxed) {
                    return;
                }
                for chunk in data.chunks(channels as usize) {
                    let sum = chunk.iter().map(|&s| s as f32 / i16::MAX as f32).sum::<f32>();
                    let mono_sample = sum / (channels as f32);
                    producer.push(mono_sample);
                }
            },
            err_fn,
            None,
        ),
        _ => return Err(AppError::Audio("Unsupported input sample format".to_string())),
    }
    .map_err(|e| AppError::Audio(format!("Failed to build input stream: {}", e)))?;

    stream.play()
        .map_err(|e| AppError::Audio(format!("Failed to start input stream: {}", e)))?;

    Ok(AudioInputHandle {
        stream,
        is_running,
    })
}

pub fn create_output_stream() -> Result<AudioOutputHandle> {
    let (tx, rx) = std::sync::mpsc::channel();

    std::thread::Builder::new()
        .name("rodio-output-thread".into())
        .spawn(move || {
            let res = (|| -> std::result::Result<(OutputStream, Arc<Sink>), String> {
                let (_stream, stream_handle) = OutputStream::try_default()
                    .map_err(|e| format!("Failed to open default audio output: {}", e))?;
                let sink = Sink::try_new(&stream_handle)
                    .map_err(|e| format!("Failed to create audio sink: {}", e))?;
                Ok((_stream, Arc::new(sink)))
            })();

            match res {
                Ok((_stream, sink)) => {
                    let (term_tx, term_rx) = std::sync::mpsc::channel::<()>();
                    let _ = tx.send(Ok((sink, term_tx)));
                    // Keep stream alive until term signal or channel drop
                    let _ = term_rx.recv();
                }
                Err(err_msg) => {
                    let _ = tx.send(Err(err_msg));
                }
            }
        })
        .map_err(|e| AppError::Audio(format!("Failed to spawn audio output thread: {}", e)))?;

    let res = rx.recv().map_err(|e| AppError::Audio(format!("Audio thread died: {}", e)))?;
    match res {
        Ok((sink, _term_tx)) => Ok(AudioOutputHandle { sink }),
        Err(e) => Err(AppError::Audio(e)),
    }
}

impl AudioOutputHandle {
    pub fn play_pcm_f32(&self, samples: Vec<f32>, sample_rate: u32, channels: u16) {
        let buffer = SamplesBuffer::new(channels, sample_rate, samples);
        self.sink.append(buffer);
    }

    pub fn stop(&self) {
        self.sink.stop();
    }

    pub fn pause(&self) {
        self.sink.pause();
    }

    pub fn resume(&self) {
        self.sink.play();
    }

    pub fn is_empty(&self) -> bool {
        self.sink.empty()
    }
}
