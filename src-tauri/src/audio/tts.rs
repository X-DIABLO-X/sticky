use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use regex::Regex;
use serde::Deserialize;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, Mutex};

use crate::audio::io::AudioOutputHandle;
use crate::error::{AppError, Result};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(20);
const DAEMON_SYNTH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PCM_BYTES: usize = 64 * 1024 * 1024;

#[derive(Deserialize)]
struct DaemonResponse {
    ok: bool,
    #[serde(default)]
    sample_rate: u32,
    #[serde(default = "default_channels")]
    channels: u16,
    #[serde(default)]
    pcm_len: usize,
    #[serde(default)]
    engine: String,
    #[serde(default)]
    error: Option<String>,
}

fn default_channels() -> u16 {
    1
}

enum DaemonError {
    /// Child process exited, timed out, or lost framing — drop and respawn.
    Transport(String),
    /// Child process is still healthy and responded with `ok: false`.
    Synthesis(String),
}

pub struct SynthesizedPcm {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
    pub engine: String,
}

struct TtsDaemon {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    default_engine: String,
}

impl TtsDaemon {
    async fn spawn() -> Result<Self> {
        let script_path = crate::audio::stt::resolve_script_path("neural_tts.py");
        if !script_path.exists() {
            return Err(AppError::Audio(format!(
                "neural_tts.py not found (checked {:?})",
                script_path
            )));
        }

        let python_bin = crate::audio::stt::resolve_python_executable();
        let mut cmd = tokio::process::Command::new(&python_bin);
        cmd.arg(&script_path)
            .arg("--daemon")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let started = Instant::now();
        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::Audio(format!("Failed to launch neural_tts daemon: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Audio("Failed to capture TTS daemon stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Audio("Failed to capture TTS daemon stdout".into()))?;

        // Continuously drain stderr so the OS pipe buffer never fills up and stalls the child.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                while let Ok(n) = reader.read_line(&mut line).await {
                    if n == 0 {
                        break;
                    }
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        eprintln!("[TTS Daemon] {trimmed}");
                    }
                    line.clear();
                }
            });
        }

        let mut stdout_reader = BufReader::new(stdout);
        let ready_engine = tokio::time::timeout(DAEMON_READY_TIMEOUT, async {
            let mut line = String::new();
            for _ in 0..32 {
                line.clear();
                let n = stdout_reader
                    .read_line(&mut line)
                    .await
                    .map_err(|e| AppError::Audio(format!("TTS daemon stdout error during startup: {e}")))?;
                if n == 0 {
                    return Err(AppError::Audio(
                        "TTS daemon exited before signaling READY".into(),
                    ));
                }
                let trimmed = line.trim();
                if let Some(engine) = trimmed.strip_prefix("READY ") {
                    return Ok(engine.trim().to_string());
                }
                if trimmed == "READY" {
                    return Ok("unknown".to_string());
                }
            }
            Err(AppError::Audio(
                "TTS daemon emitted too many startup lines without READY".into(),
            ))
        })
        .await
        .map_err(|_| AppError::Audio("Timed out waiting for TTS daemon READY".into()))??;

        eprintln!(
            "[TTS] Persistent neural daemon ready (engine={ready_engine}) in {}ms",
            started.elapsed().as_millis()
        );

        Ok(Self {
            _child: child,
            stdin,
            stdout: stdout_reader,
            default_engine: ready_engine,
        })
    }

    async fn synthesize(&mut self, text: &str) -> std::result::Result<SynthesizedPcm, DaemonError> {
        let req = serde_json::json!({
            "text": text,
            "engine": "auto",
        });
        let mut payload = req.to_string();
        payload.push('\n');

        self.stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| DaemonError::Transport(format!("Failed writing to TTS daemon stdin: {e}")))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| DaemonError::Transport(format!("Failed flushing TTS daemon stdin: {e}")))?;

        let mut header_line = String::new();
        let n = tokio::time::timeout(DAEMON_SYNTH_TIMEOUT, self.stdout.read_line(&mut header_line))
            .await
            .map_err(|_| DaemonError::Transport("Timed out waiting for TTS daemon response".into()))?
            .map_err(|e| DaemonError::Transport(format!("Failed reading TTS daemon header: {e}")))?;

        if n == 0 {
            return Err(DaemonError::Transport(
                "TTS daemon closed stdout unexpectedly".into(),
            ));
        }

        let resp: DaemonResponse = serde_json::from_str(header_line.trim()).map_err(|e| {
            DaemonError::Transport(format!(
                "Invalid JSON header from TTS daemon ({e}): {:?}",
                header_line.trim()
            ))
        })?;

        if !resp.ok {
            return Err(DaemonError::Synthesis(
                resp.error
                    .unwrap_or_else(|| "TTS daemon returned ok=false".to_string()),
            ));
        }

        if resp.pcm_len == 0 {
            return Ok(SynthesizedPcm {
                samples: Vec::new(),
                sample_rate: if resp.sample_rate > 0 { resp.sample_rate } else { 22050 },
                channels: resp.channels.max(1),
                engine: if resp.engine.is_empty() {
                    self.default_engine.clone()
                } else {
                    resp.engine
                },
            });
        }

        if resp.pcm_len > MAX_PCM_BYTES || resp.pcm_len % 2 != 0 {
            return Err(DaemonError::Transport(format!(
                "Invalid PCM byte length from TTS daemon: {}",
                resp.pcm_len
            )));
        }

        let mut pcm_bytes = vec![0u8; resp.pcm_len];
        tokio::time::timeout(DAEMON_SYNTH_TIMEOUT, self.stdout.read_exact(&mut pcm_bytes))
            .await
            .map_err(|_| DaemonError::Transport("Timed out reading PCM payload from TTS daemon".into()))?
            .map_err(|e| DaemonError::Transport(format!("Failed reading PCM payload from TTS daemon: {e}")))?;

        let mut samples = Vec::with_capacity(pcm_bytes.len() / 2);
        for pair in pcm_bytes.chunks_exact(2) {
            let s16 = i16::from_le_bytes([pair[0], pair[1]]);
            samples.push(s16 as f32 / 32768.0);
        }

        let sample_rate = if resp.sample_rate > 0 {
            resp.sample_rate
        } else {
            22050
        };
        let channels = resp.channels.max(1);
        let engine = if resp.engine.is_empty() {
            self.default_engine.clone()
        } else {
            resp.engine
        };

        Ok(SynthesizedPcm {
            samples,
            sample_rate,
            channels,
            engine,
        })
    }
}

enum TtsQueueItem {
    Speak(u64, String),
    Cue(u64, usize, Option<String>),
}

pub struct KokoroTts {
    output_handle: Arc<Mutex<Option<AudioOutputHandle>>>,
    daemon: Arc<Mutex<Option<TtsDaemon>>>,
    app_handle: Arc<std::sync::Mutex<Option<tauri::AppHandle>>>,
    current_gen: Arc<AtomicU64>,
    queue_tx: mpsc::UnboundedSender<TtsQueueItem>,
    text_buffer: String,
}

impl KokoroTts {
    pub fn new(output_handle: Arc<Mutex<Option<AudioOutputHandle>>>) -> Self {
        let daemon: Arc<Mutex<Option<TtsDaemon>>> = Arc::new(Mutex::new(None));
        let app_handle: Arc<std::sync::Mutex<Option<tauri::AppHandle>>> =
            Arc::new(std::sync::Mutex::new(None));
        let current_gen = Arc::new(AtomicU64::new(0));
        let (queue_tx, queue_rx) = mpsc::unbounded_channel::<TtsQueueItem>();

        let worker_output = Arc::clone(&output_handle);
        let worker_daemon = Arc::clone(&daemon);
        let worker_app = Arc::clone(&app_handle);
        let worker_gen = Arc::clone(&current_gen);

        let worker_future = async move {
            Self::worker_loop(queue_rx, worker_output, worker_daemon, worker_app, worker_gen).await;
        };

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(worker_future);
        } else {
            tauri::async_runtime::spawn(worker_future);
        }

        Self {
            output_handle,
            daemon,
            app_handle,
            current_gen,
            queue_tx,
            text_buffer: String::new(),
        }
    }

    pub fn set_app_handle(&self, app: tauri::AppHandle) {
        if let Ok(mut guard) = self.app_handle.lock() {
            *guard = Some(app);
        }
    }

    async fn worker_loop(
        mut rx: mpsc::UnboundedReceiver<TtsQueueItem>,
        output_handle: Arc<Mutex<Option<AudioOutputHandle>>>,
        daemon: Arc<Mutex<Option<TtsDaemon>>>,
        app_handle: Arc<std::sync::Mutex<Option<tauri::AppHandle>>>,
        current_gen: Arc<AtomicU64>,
    ) {
        // Pre-warm the persistent Piper daemon in the background at startup so Turn 1 is <120ms.
        {
            let mut guard = daemon.lock().await;
            if guard.is_none() {
                match TtsDaemon::spawn().await {
                    Ok(d) => *guard = Some(d),
                    Err(e) => eprintln!("[TTS] Background daemon pre-warm warning: {e}"),
                }
            }
        }

        let mut audio_end_at: Option<Instant> = None;
        let mut active_gen: u64 = current_gen.load(Ordering::SeqCst);

        while let Some(item) = rx.recv().await {
            match item {
                TtsQueueItem::Speak(gen_id, raw_chunk) => {
                    if gen_id != current_gen.load(Ordering::SeqCst) {
                        continue;
                    }
                    if gen_id != active_gen {
                        audio_end_at = None;
                        active_gen = gen_id;
                    }

                    let clean_text = Self::sanitize_for_speech(&raw_chunk);
                    if clean_text.is_empty() {
                        continue;
                    }

                    match Self::synthesize_and_enqueue_audio(
                        &daemon,
                        &output_handle,
                        &clean_text,
                        Some((&current_gen, gen_id)),
                    )
                    .await
                    {
                        Ok(audio_dur) => {
                            if gen_id == current_gen.load(Ordering::SeqCst)
                                && !audio_dur.is_zero()
                            {
                                let now = Instant::now();
                                let base = audio_end_at.map(|t| t.max(now)).unwrap_or(now);
                                audio_end_at = Some(base + audio_dur);
                            }
                        }
                        Err(e) => {
                            eprintln!("[TTS] Worker synthesis error: {e}");
                        }
                    }
                }
                TtsQueueItem::Cue(gen_id, index, caption) => {
                    if gen_id != current_gen.load(Ordering::SeqCst) {
                        continue;
                    }
                    if gen_id != active_gen {
                        audio_end_at = None;
                        active_gen = gen_id;
                    }

                    if let Some(target_end) = audio_end_at {
                        while Instant::now() < target_end {
                            if gen_id != current_gen.load(Ordering::SeqCst) {
                                break;
                            }
                            let remaining = target_end.saturating_duration_since(Instant::now());
                            let sleep_dur = remaining.min(Duration::from_millis(40));
                            if sleep_dur.is_zero() {
                                break;
                            }
                            tokio::time::sleep(sleep_dur).await;
                        }
                    }

                    if gen_id != current_gen.load(Ordering::SeqCst) {
                        continue;
                    }

                    let maybe_app = app_handle.lock().ok().and_then(|g| g.clone());
                    if let Some(app) = maybe_app {
                        let _ = app.emit(
                            "overlay:viz_cue",
                            serde_json::json!({
                                "index": index,
                                "caption": caption,
                            }),
                        );
                    }
                }
            }
        }
    }

    /// Buffer streamed tokens and flush on natural clause/sentence boundaries into the
    /// non-blocking async queue (returns immediately in <0.1ms so LLM & overlay never stall).
    pub async fn push_token(&mut self, token: &str) -> Result<()> {
        self.text_buffer.push_str(token);

        while let Some(split_idx) = Self::find_flush_boundary(&self.text_buffer) {
            let remainder = self.text_buffer.split_off(split_idx);
            let chunk = std::mem::replace(&mut self.text_buffer, remainder);
            if !chunk.trim().is_empty() {
                let gen_id = self.current_gen.load(Ordering::SeqCst);
                let _ = self.queue_tx.send(TtsQueueItem::Speak(gen_id, chunk));
            }
        }

        Ok(())
    }

    /// Flush any preceding buffered speech, then queue a voice-synced animation beat cue.
    pub async fn push_cue(&mut self, index: usize, caption: Option<String>) {
        let gen_id = self.current_gen.load(Ordering::SeqCst);
        if !self.text_buffer.trim().is_empty() {
            let chunk = std::mem::take(&mut self.text_buffer);
            let _ = self.queue_tx.send(TtsQueueItem::Speak(gen_id, chunk));
        } else {
            self.text_buffer.clear();
        }
        let _ = self.queue_tx.send(TtsQueueItem::Cue(gen_id, index, caption));
    }

    pub async fn flush_remaining(&mut self) -> Result<()> {
        if !self.text_buffer.trim().is_empty() {
            let chunk = std::mem::take(&mut self.text_buffer);
            let gen_id = self.current_gen.load(Ordering::SeqCst);
            let _ = self.queue_tx.send(TtsQueueItem::Speak(gen_id, chunk));
        } else {
            self.text_buffer.clear();
        }
        Ok(())
    }

    pub async fn abort_playback(&mut self) {
        self.text_buffer.clear();
        self.current_gen.fetch_add(1, Ordering::SeqCst);
        let guard = self.output_handle.lock().await;
        if let Some(ref out) = *guard {
            out.stop();
        }
    }

    /// Directly synthesize via the warm daemon (or OS SAPI fallback) and return raw PCM.
    pub async fn synthesize_direct(&self, text: &str) -> Result<SynthesizedPcm> {
        let clean_text = Self::sanitize_for_speech(text);
        if clean_text.is_empty() {
            return Ok(SynthesizedPcm {
                samples: Vec::new(),
                sample_rate: 24000,
                channels: 1,
                engine: "none".into(),
            });
        }

        let mut daemon_guard = self.daemon.lock().await;
        if daemon_guard.is_none() {
            match TtsDaemon::spawn().await {
                Ok(d) => *daemon_guard = Some(d),
                Err(e) => {
                    eprintln!("[TTS] Failed to spawn daemon: {e}");
                    return Err(e);
                }
            }
        }

        if let Some(ref mut daemon) = *daemon_guard {
            match daemon.synthesize(&clean_text).await {
                Ok(pcm) => return Ok(pcm),
                Err(DaemonError::Synthesis(err)) => return Err(AppError::Audio(err)),
                Err(DaemonError::Transport(err)) => {
                    eprintln!("[TTS] Daemon transport error: {err}; restarting...");
                    daemon_guard.take();
                }
            }
        }

        Err(AppError::Audio("TTS synthesis unavailable".into()))
    }

    /// Directly synthesize via the warm daemon (or OS SAPI fallback) and play on `output_handle`.
    /// Useful for Settings "Test Speaker" with real synthesis timing and error reporting.
    pub async fn synthesize_and_play(&self, text: &str) -> Result<()> {
        let clean_text = Self::sanitize_for_speech(text);
        if clean_text.is_empty() {
            return Ok(());
        }

        Self::synthesize_and_enqueue_audio(&self.daemon, &self.output_handle, &clean_text, None)
            .await
            .map(|_| ())
    }

    /// Find the byte index right after a natural speech boundary:
    /// - `.`, `!`, `?`, `\n`, `:`, `;` after >= 10 chars
    /// - `,` after >= 28 chars
    /// - whitespace fallback if buffer grows past 140 chars without punctuation
    fn find_flush_boundary(buf: &str) -> Option<usize> {
        let mut char_count = 0usize;
        let mut chars = buf.char_indices().peekable();
        let mut prev_char: Option<char> = None;
        let mut last_ws_end: Option<usize> = None;

        while let Some((idx, ch)) = chars.next() {
            char_count += 1;
            let end_idx = idx + ch.len_utf8();
            let next_char = chars.peek().map(|&(_, c)| c);

            if ch.is_whitespace() {
                last_ws_end = Some(end_idx);
            }

            let is_decimal_dot = ch == '.'
                && prev_char.map(|p| p.is_ascii_digit()).unwrap_or(false)
                && next_char.map(|n| n.is_ascii_digit()).unwrap_or(false);

            let is_strong =
                matches!(ch, '.' | '!' | '?' | '\n' | ':' | ';') && !is_decimal_dot;

            if is_strong && char_count >= 10 {
                // Consume trailing closing quotes/brackets or consecutive punctuation (e.g. `..."`)
                let mut flush_end = end_idx;
                while let Some(&(nidx, nch)) = chars.peek() {
                    if matches!(nch, '.' | '!' | '?' | '"' | '\'' | ')' | ']') {
                        flush_end = nidx + nch.len_utf8();
                        chars.next();
                    } else {
                        break;
                    }
                }
                return Some(flush_end);
            }

            if ch == ',' && char_count >= 28 {
                return Some(end_idx);
            }

            prev_char = Some(ch);
        }

        if char_count >= 140 {
            if let Some(ws) = last_ws_end {
                if ws > 0 {
                    return Some(ws);
                }
            }
        }

        None
    }

    /// Strips Markdown, LaTeX delimiters, and formatting symbols so TTS & speech bubbles
    /// speak and display clean natural prose without reading asterisks or backticks.
    pub fn sanitize_for_speech(input: &str) -> String {
        static RE_IMAGE: OnceLock<Regex> = OnceLock::new();
        static RE_LINK: OnceLock<Regex> = OnceLock::new();
        static RE_FENCE_OPEN: OnceLock<Regex> = OnceLock::new();
        static RE_HEADING: OnceLock<Regex> = OnceLock::new();
        static RE_BLOCKQUOTE: OnceLock<Regex> = OnceLock::new();
        static RE_BULLET: OnceLock<Regex> = OnceLock::new();
        static RE_LATEX_INLINE: OnceLock<Regex> = OnceLock::new();
        static RE_LATEX_OPEN_SPLIT: OnceLock<Regex> = OnceLock::new();
        static RE_LATEX_CLOSE_SPLIT: OnceLock<Regex> = OnceLock::new();
        static RE_ITALIC_UNDER: OnceLock<Regex> = OnceLock::new();

        let re_image = RE_IMAGE.get_or_init(|| Regex::new(r"!\[([^\]]*)\]\([^)]*\)").unwrap());
        let re_link = RE_LINK.get_or_init(|| Regex::new(r"\[([^\]]+)\]\([^)]*\)").unwrap());
        let re_fence_open =
            RE_FENCE_OPEN.get_or_init(|| Regex::new(r"```[a-zA-Z0-9_-]*\s*\n").unwrap());
        let re_heading = RE_HEADING.get_or_init(|| Regex::new(r"(?m)^\s*#{1,6}\s*").unwrap());
        let re_blockquote = RE_BLOCKQUOTE.get_or_init(|| Regex::new(r"(?m)^\s*>\s*").unwrap());
        let re_bullet =
            RE_BULLET.get_or_init(|| Regex::new(r"(?m)^\s*(?:[-•▪]\s+)+").unwrap());
        let re_latex_inline = RE_LATEX_INLINE
            .get_or_init(|| Regex::new(r"\$([^\s$](?:[^$]*[^\s$])?)\$").unwrap());
        let re_latex_open_split =
            RE_LATEX_OPEN_SPLIT.get_or_init(|| Regex::new(r"\$([a-zA-Z\\])").unwrap());
        let re_latex_close_split =
            RE_LATEX_CLOSE_SPLIT.get_or_init(|| Regex::new(r"([a-zA-Z0-9}\)])\$").unwrap());
        let re_italic_under = RE_ITALIC_UNDER.get_or_init(|| {
            Regex::new(r#"(^|[\s"'(\[{])_+([^_\s](?:[^_]*?[^_\s])?)_+([\s"')\]},.!?;:]|$)"#)
                .unwrap()
        });

        // 1. Convert markdown images & links to their human-readable alt/label text
        let s = re_image.replace_all(input, "$1");
        let s = re_link.replace_all(&s, "$1");

        // 2. Strip fenced code block headers/markers and inline backticks
        let s = re_fence_open.replace_all(&s, " ");
        let s = s.replace("```", " ").replace('`', "");

        // 3. Turn arrow notations into natural spoken English
        let s = s
            .replace("->", " to ")
            .replace('→', " to ")
            .replace("=>", " to ");

        // 4. Strip line-leading markdown syntax before collapsing newlines
        let s = re_blockquote.replace_all(&s, "");
        let s = re_bullet.replace_all(&s, "");
        let s = re_heading.replace_all(&s, "");

        // 5. Strip strikethrough, asterisks, heading hashes, bullet glyphs, and double underscores
        let s = s
            .replace("~~", "")
            .replace('*', "")
            .replace('#', "")
            .replace('•', " ")
            .replace('▪', " ")
            .replace("__", "");

        // 6. Strip LaTeX $ delimiters (complete and chunk-split) while preserving currency like $50
        let s = s.replace("$$", "");
        let s = re_latex_inline.replace_all(&s, "$1");
        let s = re_latex_open_split.replace_all(&s, "$1");
        let s = re_latex_close_split.replace_all(&s, "$1");

        // 7. Strip italic _word_ / _phrase_ delimiters (2 passes handle adjacent "_a_ _b_")
        let s = re_italic_under.replace_all(&s, "$1$2$3");
        let s = re_italic_under.replace_all(&s, "$1$2$3");

        // 8. Collapse all whitespace cleanly
        s.replace('\r', " ")
            .replace('\n', " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn pcm_duration(sample_count: usize, sample_rate: u32, channels: u16) -> Duration {
        if sample_count == 0 || sample_rate == 0 {
            return Duration::ZERO;
        }
        let ch = channels.max(1) as f64;
        let secs = (sample_count as f64) / (sample_rate as f64 * ch);
        if secs.is_finite() && secs > 0.0 {
            Duration::from_secs_f64(secs)
        } else {
            Duration::ZERO
        }
    }

    async fn synthesize_via_daemon(
        daemon: &Arc<Mutex<Option<TtsDaemon>>>,
        clean_text: &str,
    ) -> Result<SynthesizedPcm> {
        let mut guard = daemon.lock().await;

        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(TtsDaemon::spawn().await?);
            }

            let t0 = Instant::now();
            let result = guard.as_mut().unwrap().synthesize(clean_text).await;
            match result {
                Ok(pcm) => {
                    eprintln!(
                        "[TTS] Synthesized {} chars via {} in {}ms ({} samples @ {}Hz)",
                        clean_text.len(),
                        pcm.engine,
                        t0.elapsed().as_millis(),
                        pcm.samples.len(),
                        pcm.sample_rate
                    );
                    return Ok(pcm);
                }
                Err(DaemonError::Synthesis(msg)) => {
                    return Err(AppError::Audio(format!("TTS daemon synthesis error: {msg}")));
                }
                Err(DaemonError::Transport(msg)) => {
                    eprintln!(
                        "[TTS] Daemon transport error (attempt {}): {msg}; respawning...",
                        attempt + 1
                    );
                    *guard = None;
                    if attempt == 1 {
                        return Err(AppError::Audio(format!(
                            "TTS daemon failed after respawn: {msg}"
                        )));
                    }
                }
            }
        }

        Err(AppError::Audio("TTS daemon unavailable".into()))
    }

    async fn synthesize_and_enqueue_audio(
        daemon: &Arc<Mutex<Option<TtsDaemon>>>,
        output_handle: &Arc<Mutex<Option<AudioOutputHandle>>>,
        clean_text: &str,
        gen_check: Option<(&Arc<AtomicU64>, u64)>,
    ) -> Result<Duration> {
        if let Some((atomic, expected)) = gen_check {
            if atomic.load(Ordering::SeqCst) != expected {
                return Ok(Duration::ZERO);
            }
        }

        // 1. Primary: Persistent warm neural TTS daemon (local Piper ONNX -> warm Edge-TTS)
        match Self::synthesize_via_daemon(daemon, clean_text).await {
            Ok(pcm) => {
                if pcm.samples.is_empty() {
                    return Ok(Duration::ZERO);
                }
                if let Some((atomic, expected)) = gen_check {
                    if atomic.load(Ordering::SeqCst) != expected {
                        return Ok(Duration::ZERO);
                    }
                }
                let dur = Self::pcm_duration(pcm.samples.len(), pcm.sample_rate, pcm.channels);
                Self::play_pcm(output_handle, pcm.samples, pcm.sample_rate, pcm.channels).await?;
                return Ok(dur);
            }
            Err(e) => {
                eprintln!("[TTS] Neural daemon unavailable, falling back to OS TTS: {e}");
            }
        }

        if let Some((atomic, expected)) = gen_check {
            if atomic.load(Ordering::SeqCst) != expected {
                return Ok(Duration::ZERO);
            }
        }

        // 2. Offline OS safety net (Windows SAPI / macOS say / Linux espeak-ng)
        Self::speak_os_fallback(output_handle, clean_text, gen_check).await
    }

    async fn play_pcm(
        output_handle: &Arc<Mutex<Option<AudioOutputHandle>>>,
        samples: Vec<f32>,
        sample_rate: u32,
        channels: u16,
    ) -> Result<()> {
        let guard = output_handle.lock().await;
        if let Some(ref out) = *guard {
            out.play_pcm_f32(samples, sample_rate, channels);
            return Ok(());
        }

        Err(AppError::Audio(
            "Audio output device not initialized (rodio sink is None)".into(),
        ))
    }

    fn decode_wav_bytes(wav_bytes: Vec<u8>) -> Result<(Vec<f32>, u32, u16)> {
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
        Ok((samples, spec.sample_rate, spec.channels))
    }

    async fn speak_os_fallback(
        output_handle: &Arc<Mutex<Option<AudioOutputHandle>>>,
        clean_text: &str,
        gen_check: Option<(&Arc<AtomicU64>, u64)>,
    ) -> Result<Duration> {
        #[cfg(target_os = "macos")]
        {
            let _ = (output_handle, gen_check);
            let status = tokio::process::Command::new("say")
                .arg(clean_text)
                .status()
                .await
                .map_err(|e| AppError::Audio(format!("macOS `say` TTS failed: {e}")))?;
            if !status.success() {
                return Err(AppError::Audio(
                    "macOS `say` exited with non-zero status".into(),
                ));
            }
            return Ok(Duration::ZERO);
        }

        #[cfg(target_os = "linux")]
        {
            let _ = (output_handle, gen_check);
            let ok = tokio::process::Command::new("espeak-ng")
                .arg(clean_text)
                .status()
                .await
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                tokio::process::Command::new("spd-say")
                    .arg("--wait")
                    .arg(clean_text)
                    .status()
                    .await
                    .map_err(|e| {
                        AppError::Audio(format!("Linux TTS (`espeak-ng`/`spd-say`) failed: {e}"))
                    })?;
            }
            return Ok(Duration::ZERO);
        }

        #[cfg(target_os = "windows")]
        {
            let b64_text =
                base64::engine::general_purpose::STANDARD.encode(clean_text.as_bytes());
            let script_path = crate::audio::stt::resolve_script_path("speak.ps1");
            let temp_wav =
                std::env::temp_dir().join(format!("sticky_tts_{}.wav", uuid::Uuid::new_v4()));

            let mut cmd = tokio::process::Command::new("powershell");
            cmd.creation_flags(CREATE_NO_WINDOW);

            if script_path.exists() {
                cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                    .arg(&script_path)
                    .args(["-TextBase64", &b64_text, "-OutFile"])
                    .arg(&temp_wav);
            } else {
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

            if let Some((atomic, expected)) = gen_check {
                if atomic.load(Ordering::SeqCst) != expected {
                    return Ok(Duration::ZERO);
                }
            }

            let (samples, sample_rate, channels) = Self::decode_wav_bytes(wav_bytes)?;
            let dur = Self::pcm_duration(samples.len(), sample_rate, channels);
            Self::play_pcm(output_handle, samples, sample_rate, channels).await?;
            Ok(dur)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_for_speech_strips_all_markdown_and_asterisks() {
        let raw = concat!(
            "## Heading\n",
            "> Quoted intro with *single*, **bold**, and split * asterisk.\n",
            "- bullet item with _italic_ and _two words_ and __strong__\n",
            "• another bullet and ▪ third bullet\n",
            "Check `code` and ```js\nlet x = 1;\n``` or ~~old~~ text.\n",
            "Visit [Click here](https://x.com) and ![Alt diagram](https://x.com/img.png).\n",
            "Flow: A -> B → C => D and math $x^2$ plus $$a + b$$."
        );

        let cleaned = KokoroTts::sanitize_for_speech(raw);

        assert!(!cleaned.contains('*'), "asterisks leaked: {cleaned}");
        assert!(!cleaned.contains('`'), "backticks leaked: {cleaned}");
        assert!(!cleaned.contains('#'), "headings leaked: {cleaned}");
        assert!(!cleaned.contains('~'), "strikethrough leaked: {cleaned}");
        assert!(!cleaned.contains('$'), "LaTeX $ leaked: {cleaned}");
        assert!(!cleaned.contains('_'), "italic underscores leaked: {cleaned}");
        assert!(!cleaned.contains("https://"), "link URL leaked: {cleaned}");
        assert!(!cleaned.contains("->"), "ASCII arrow leaked: {cleaned}");
        assert!(!cleaned.contains('→'), "unicode arrow leaked: {cleaned}");
        assert!(!cleaned.contains("=>"), "fat arrow leaked: {cleaned}");
        assert!(!cleaned.contains('•'), "bullet symbol leaked: {cleaned}");
        assert!(!cleaned.contains('▪'), "square bullet leaked: {cleaned}");
        assert!(!cleaned.contains('>'), "blockquote marker leaked: {cleaned}");

        assert!(cleaned.contains("Heading"), "{cleaned}");
        assert!(cleaned.contains("single, bold, and split asterisk."), "{cleaned}");
        assert!(cleaned.contains("bullet item with italic and two words and strong"), "{cleaned}");
        assert!(cleaned.contains("Check code and let x = 1; or old text."), "{cleaned}");
        assert!(cleaned.contains("Visit Click here and Alt diagram."), "{cleaned}");
        assert!(cleaned.contains("Flow: A to B to C to D"), "{cleaned}");
        assert!(cleaned.contains("math x^2 plus a + b."), "{cleaned}");

        // Normal snake_case identifiers and currency should remain intact
        let mixed = KokoroTts::sanitize_for_speech("Use snake_case_var for $50 and _emphasis_.");
        assert_eq!(mixed, "Use snake_case_var for $50 and emphasis.");
    }
}
