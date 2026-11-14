use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use crate::ai::prompts::Prompts;
use crate::ai::providers::ChatMessage;
use crate::ai::router::{ModelRouter, TaskType};
use crate::ai::tag_stream::{OverlayCommand, TagStreamParser};
use crate::audio::vad::VadState;
use crate::audio::AudioEngine;
use crate::error::Result;
use crate::screen::ContextPrewarmer;
use crate::ui::windows::WindowManager;
use crate::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TalkState {
    Idle,
    Listening,
    Transcribing,
    Thinking,
    Speaking,
}

pub struct TalkController {
    app_handle: AppHandle,
    audio_engine: Arc<Mutex<AudioEngine>>,
    prewarmer: ContextPrewarmer,
    router: Arc<ModelRouter>,
    current_state: Arc<Mutex<TalkState>>,
    cancel_flag: Arc<AtomicBool>,
    /// Serializes start_talk and stop_talk so rapid hotkey taps never race
    op_lock: Arc<Mutex<()>>,
}

fn broadcast_overlay_command(app: &AppHandle, cmd: &OverlayCommand) {
    let _ = app.emit("overlay:command", cmd);

    match cmd {
        OverlayCommand::Point { x, y, label, screen: _ } => {
            let _ = app.emit("overlay_point", serde_json::json!({
                "x": x,
                "y": y,
                "label": label,
                "screenIndex": 0,
                "durationMs": 1500
            }));
        }
        OverlayCommand::Draw { shape, coords, color, label: _ } => {
            let _ = app.emit("overlay_draw", serde_json::json!({
                "id": format!("draw_{}", uuid::Uuid::new_v4()),
                "shape": shape,
                "coords": coords,
                "color": color.as_deref().unwrap_or("#38bdf8")
            }));
        }
        OverlayCommand::Model3D { model, title } => {
            let _ = app.emit("overlay_3d", serde_json::json!({
                "id": format!("3d_{}", uuid::Uuid::new_v4()),
                "title": title,
                "geometryType": model,
                "visible": true
            }));
        }
        OverlayCommand::Step { index, total, bbox, instruction } => {
            let _ = app.emit("walkthrough_step", serde_json::json!({
                "step": {
                    "step": index,
                    "instruction": instruction,
                    "bbox": bbox
                },
                "current": index,
                "total": total
            }));
        }
        OverlayCommand::Raw(_) => {}
    }
}

impl TalkController {
    pub fn new(
        app_handle: AppHandle,
        audio_engine: Arc<Mutex<AudioEngine>>,
        prewarmer: ContextPrewarmer,
        router: Arc<ModelRouter>,
    ) -> Self {
        Self {
            app_handle,
            audio_engine,
            prewarmer,
            router,
            current_state: Arc::new(Mutex::new(TalkState::Idle)),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            op_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn get_state(&self) -> TalkState {
        *self.current_state.lock().await
    }

    fn emit_talk_state(app: &AppHandle, state: TalkState) {
        let str_state = match state {
            TalkState::Idle => "idle",
            TalkState::Listening => "listening",
            TalkState::Transcribing => "transcribing",
            TalkState::Thinking => "thinking",
            TalkState::Speaking => "speaking",
        };
        let _ = app.emit("talk:state", str_state);
        let _ = app.emit("talk_state", str_state);
        let _ = app.emit("talk_state_changed", str_state);
    }

    fn emit_transcript(app: &AppHandle, text: &str) {
        let _ = app.emit("talk:transcript", text);
        let _ = app.emit("talk_text", text);
        let _ = app.emit("transcript_chunk", serde_json::json!({
            "text": text,
            "speaker": "user",
            "audioActive": false
        }));
    }

    pub async fn start_talk(&self) -> Result<()> {
        let _guard = self.op_lock.lock().await;

        {
            let state = self.current_state.lock().await;
            if *state == TalkState::Speaking {
                drop(state);
                self.barge_in().await;
            } else if *state != TalkState::Idle {
                return Ok(());
            }

            let mut state = self.current_state.lock().await;
            if *state != TalkState::Idle {
                return Ok(());
            }

            self.cancel_flag.store(false, Ordering::SeqCst);
            *state = TalkState::Listening;
            Self::emit_talk_state(&self.app_handle, TalkState::Listening);
            let _ = self.app_handle.emit("cursor:ptt_start", ());
            let _ = self.app_handle.emit("hotkey:talk_down", ());
            let _ = self.app_handle.emit("transcript_chunk", serde_json::json!({
                "text": "Listening...",
                "speaker": "user",
                "audioActive": true
            }));
        }

        {
            let mut engine = self.audio_engine.lock().await;
            if let Err(e) = engine.start_mic() {
                eprintln!("[Talk] Failed to start microphone: {e}");
                let mut state = self.current_state.lock().await;
                *state = TalkState::Idle;
                Self::emit_talk_state(&self.app_handle, TalkState::Idle);
                return Err(e);
            }
        }

        // Spawn real-time audio polling, AEC processing, and VAD silence timeout loop
        let audio_engine_clone = Arc::clone(&self.audio_engine);
        let state_clone = Arc::clone(&self.current_state);
        let app_handle_clone = self.app_handle.clone();

        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(30));
            let mut speech_detected = false;
            let mut silence_start: Option<std::time::Instant> = None;
            let start_time = std::time::Instant::now();

            let initial_silence_timeout = Duration::from_millis(5000); // 5s without speech -> auto cancel
            let trailing_silence_timeout = Duration::from_millis(1400); // 1.4s silence after speech -> auto submit
            let max_utterance_timeout = Duration::from_millis(30000);   // 30s max cap

            loop {
                interval.tick().await;

                // Stop loop if no longer in Listening state
                {
                    let st = state_clone.lock().await;
                    if *st != TalkState::Listening {
                        break;
                    }
                }

                // Process audio tick (drains ring buffer, runs AEC and VAD)
                let tick_res = {
                    let mut engine = audio_engine_clone.lock().await;
                    engine.process_tick()
                };

                let elapsed = start_time.elapsed();

                if let Some((vad_state, rms)) = tick_res {
                    let _ = app_handle_clone.emit("audio_amplitude", rms);
                    let _ = app_handle_clone.emit("audio:rms", rms);

                    match vad_state {
                        VadState::SpeechStarted | VadState::Speaking => {
                            speech_detected = true;
                            silence_start = None;
                            let _ = app_handle_clone.emit("talk:vad", "speaking");
                        }
                        VadState::SpeechEnded => {
                            if silence_start.is_none() {
                                silence_start = Some(std::time::Instant::now());
                            }
                            let _ = app_handle_clone.emit("talk:vad", "speech_ended");
                        }
                        VadState::Silence => {
                            if speech_detected && silence_start.is_none() {
                                silence_start = Some(std::time::Instant::now());
                            }
                        }
                    }
                }

                let trailing_silence_hit = if speech_detected {
                    silence_start.map(|s| s.elapsed() >= trailing_silence_timeout).unwrap_or(false)
                } else {
                    false
                };

                let initial_silence_hit = !speech_detected && elapsed >= initial_silence_timeout;
                let max_duration_hit = elapsed >= max_utterance_timeout;

                if trailing_silence_hit || initial_silence_hit || max_duration_hit {
                    if trailing_silence_hit {
                        eprintln!("[TalkController] Trailing silence detected. Submitting speech...");
                    } else if initial_silence_hit {
                        eprintln!("[TalkController] Initial silence timeout. Aborting talk.");
                    } else if max_duration_hit {
                        eprintln!("[TalkController] Max utterance duration reached. Submitting speech...");
                    }

                    if let Some(app_state) = app_handle_clone.try_state::<AppState>() {
                        let talk_ctrl = Arc::clone(&app_state.talk_controller);
                        let _ = talk_ctrl.stop_talk().await;
                    }
                    break;
                }
            }
        });

        Ok(())
    }

    pub async fn stop_talk(&self) -> Result<()> {
        let _guard = self.op_lock.lock().await;

        {
            let mut state = self.current_state.lock().await;
            if *state != TalkState::Listening {
                return Ok(());
            }
            *state = TalkState::Transcribing;
            Self::emit_talk_state(&self.app_handle, TalkState::Transcribing);
            let _ = self.app_handle.emit("cursor:ptt_stop", ());
            let _ = self.app_handle.emit("hotkey:talk_up", ());
            let _ = self.app_handle.emit("transcript_chunk", serde_json::json!({
                "text": "Transcribing speech...",
                "speaker": "user",
                "audioActive": false
            }));
        }

        let raw_transcript = {
            let mut engine = self.audio_engine.lock().await;
            engine.stop_mic();
            match engine.transcribe_recorded().await {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[Talk] STT Transcription error: {e}");
                    String::new()
                }
            }
        };

        let transcript = raw_transcript.trim().to_string();
        if transcript.is_empty() {
            println!("\n[Speech Text]: (No speech detected in audio)");
            let mut state = self.current_state.lock().await;
            *state = TalkState::Idle;
            Self::emit_talk_state(&self.app_handle, TalkState::Idle);
            let _ = WindowManager::hide(&self.app_handle, "bubble");
            return Ok(());
        }

        println!("\n=======================================================");
        println!("[Speech Text]: \"{}\"", transcript);
        println!("=======================================================\n");

        Self::emit_transcript(&self.app_handle, &transcript);

        // Transition to Thinking
        {
            let mut state = self.current_state.lock().await;
            *state = TalkState::Thinking;
            Self::emit_talk_state(&self.app_handle, TalkState::Thinking);
            let _ = self.app_handle.emit("transcript_chunk", serde_json::json!({
                "text": "Thinking...",
                "speaker": "clicky",
                "audioActive": true
            }));
        }

        println!("[Talk] Querying Bonsai-2 9B model...");

        // Fetch pre-warmed context (A11y tree + screen capture)
        let (a11y, screen) = self.prewarmer.get_cached_context().await;
        let mut user_message_text = transcript.clone();

        if let Some(tree) = a11y {
            let mut interactive = Vec::new();
            tree.root.collect_interactive(&mut interactive);
            if !interactive.is_empty() {
                let json_tree = serde_json::to_string(&interactive).unwrap_or_default();
                user_message_text.push_str(&format!(
                    "\n\n[Active Window: \"{}\", UI Elements: {}]",
                    tree.window_title, json_tree
                ));
            }
        }

        let chat_message = if let Some(sc) = screen {
            ChatMessage::user_with_image(user_message_text, sc.base64_data)
        } else {
            ChatMessage::user(user_message_text)
        };

        let messages = vec![
            ChatMessage::system(Prompts::talk_mode_system_prompt()),
            chat_message,
        ];

        let rx_result = self.router.route_and_stream(TaskType::FastTalk, &messages, &[]).await;

        let mut rx = match rx_result {
            Ok(receiver) => receiver,
            Err(e) => {
                eprintln!("[Talk] LLM routing error: {e}");
                let mut state = self.current_state.lock().await;
                *state = TalkState::Idle;
                Self::emit_talk_state(&self.app_handle, TalkState::Idle);
                let _ = WindowManager::hide(&self.app_handle, "bubble");
                return Ok(());
            }
        };

        // Transition to Speaking
        {
            let mut state = self.current_state.lock().await;
            *state = TalkState::Speaking;
            Self::emit_talk_state(&self.app_handle, TalkState::Speaking);
        }

        let mut parser = TagStreamParser::new();
        let cancel = Arc::clone(&self.cancel_flag);
        let audio_engine = Arc::clone(&self.audio_engine);
        let app = self.app_handle.clone();
        let mut full_assistant_response = String::new();

        while let Some(chunk_res) = rx.recv().await {
            if cancel.load(Ordering::Relaxed) {
                eprintln!("[Talk] Generation cancelled / barged in.");
                break;
            }

            match chunk_res {
                Ok(chunk) => {
                    if let Some(text) = chunk.delta_text {
                        let (clean_text, commands) = parser.feed_token(&text);

                        for cmd in commands {
                            broadcast_overlay_command(&app, &cmd);
                        }

                        if !clean_text.is_empty() {
                            full_assistant_response.push_str(&clean_text);
                            let _ = app.emit("transcript_chunk", serde_json::json!({
                                "text": full_assistant_response,
                                "speaker": "clicky",
                                "audioActive": true
                            }));
                            let _ = app.emit("bubble_update", &full_assistant_response);
                            let mut eng = audio_engine.lock().await;
                            let _ = eng.push_tts_token(&clean_text).await;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[Talk] LLM stream error: {}", e);
                    break;
                }
            }
        }

        // Flush remaining tag buffer and TTS buffer
        let (final_clean, final_cmds) = parser.flush();
        for cmd in final_cmds {
            broadcast_overlay_command(&app, &cmd);
        }
        if !final_clean.is_empty() {
            full_assistant_response.push_str(&final_clean);
            let _ = app.emit("transcript_chunk", serde_json::json!({
                "text": full_assistant_response,
                "speaker": "clicky",
                "audioActive": false
            }));
            let _ = app.emit("bubble_update", &full_assistant_response);
            let mut eng = audio_engine.lock().await;
            let _ = eng.push_tts_token(&final_clean).await;
        }

        {
            let mut eng = audio_engine.lock().await;
            let _ = eng.flush_tts().await;
        }

        if !full_assistant_response.is_empty() {
            println!("\n[Clicky AI Response]: \"{}\"", full_assistant_response);
            println!("-------------------------------------------------------\n");
        }

        let mut state = self.current_state.lock().await;
        *state = TalkState::Idle;
        Self::emit_talk_state(&self.app_handle, TalkState::Idle);

        Ok(())
    }

    pub async fn barge_in(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
        let mut engine = self.audio_engine.lock().await;
        engine.barge_in_flush().await;

        let mut state = self.current_state.lock().await;
        *state = TalkState::Idle;
        Self::emit_talk_state(&self.app_handle, TalkState::Idle);
        let _ = WindowManager::hide(&self.app_handle, "bubble");
    }
}
