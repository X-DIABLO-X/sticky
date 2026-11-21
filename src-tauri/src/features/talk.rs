use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, RwLock};

use crate::ai::prompts::Prompts;
use crate::ai::providers::ChatMessage;
use crate::ai::router::{ModelRouter, TaskType};
use crate::ai::tag_stream::{OverlayCommand, TagStreamParser};
use crate::audio::vad::VadState;
use crate::audio::AudioEngine;
use crate::config::AppConfig;
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
    config: Arc<RwLock<AppConfig>>,
    audio_engine: Arc<Mutex<AudioEngine>>,
    prewarmer: ContextPrewarmer,
    router: Arc<ModelRouter>,
    current_state: Arc<Mutex<TalkState>>,
    cancel_flag: Arc<AtomicBool>,
    op_lock: Arc<Mutex<()>>,
}

fn emit_activity_log(app: &AppHandle, category: &str, title: &str, message: &str) {
    let now = chrono::Local::now().format("%H:%M:%S%.3f").to_string();
    let _ = app.emit(
        "activity:log",
        serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "timestamp": now,
            "category": category,
            "title": title,
            "content": message
        }),
    );
}

fn emit_pipeline_error(app: &AppHandle, stage: &str, message: impl Into<String>) {
    let msg = message.into();
    eprintln!("[Pipeline Error][{stage}]: {msg}");
    emit_activity_log(app, "error", &format!("{} Error", stage.to_uppercase()), &msg);
    let _ = app.emit(
        "pipeline:error",
        serde_json::json!({
            "stage": stage,
            "message": msg
        }),
    );
}

fn broadcast_overlay_command(app: &AppHandle, cmd: &OverlayCommand) {
    let _ = app.emit("overlay:command", cmd);
    match cmd {
        OverlayCommand::Point { x, y, label, screen: _ } => {
            let _ = app.emit(
                "overlay_point",
                serde_json::json!({ "x": x, "y": y, "label": label, "screenIndex": 0, "durationMs": 1500 }),
            );
        }
        OverlayCommand::Draw { shape, coords, color, label: _ } => {
            let _ = app.emit(
                "overlay_draw",
                serde_json::json!({
                    "id": format!("draw_{}", uuid::Uuid::new_v4()),
                    "shape": shape,
                    "coords": coords,
                    "color": color.as_deref().unwrap_or("#3b82f6")
                }),
            );
        }
        OverlayCommand::Model3D { model, title } => {
            let _ = app.emit(
                "overlay_3d",
                serde_json::json!({
                    "id": format!("3d_{}", uuid::Uuid::new_v4()),
                    "title": title,
                    "geometryType": model,
                    "visible": true
                }),
            );
        }
        OverlayCommand::Step { index, total, bbox, instruction } => {
            let _ = app.emit(
                "walkthrough_step",
                serde_json::json!({
                    "step": { "step": index, "instruction": instruction, "bbox": bbox },
                    "current": index,
                    "total": total
                }),
            );
        }
        OverlayCommand::Raw(_) => {}
    }
}

impl TalkController {
    pub fn new(
        app_handle: AppHandle,
        config: Arc<RwLock<AppConfig>>,
        audio_engine: Arc<Mutex<AudioEngine>>,
        prewarmer: ContextPrewarmer,
        router: Arc<ModelRouter>,
    ) -> Self {
        Self {
            app_handle,
            config,
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

    pub async fn start_talk(&self) -> Result<()> {
        let _guard = self.op_lock.lock().await;

        let needs_barge_in = {
            let state = self.current_state.lock().await;
            if *state == TalkState::Speaking {
                true
            } else if *state != TalkState::Idle {
                return Ok(());
            } else {
                false
            }
        };

        if needs_barge_in {
            self.barge_in().await;
        }

        {
            let mut state = self.current_state.lock().await;
            if *state != TalkState::Idle {
                return Ok(());
            }
            self.cancel_flag.store(false, Ordering::SeqCst);
            *state = TalkState::Listening;
            Self::emit_talk_state(&self.app_handle, TalkState::Listening);
            emit_activity_log(
                &self.app_handle,
                "talk",
                "Microphone Active",
                "Listening for voice input via default microphone...",
            );
            let _ = self.app_handle.emit("cursor:ptt_start", ());
            let _ = self.app_handle.emit("hotkey:talk_down", ());
            let _ = self.app_handle.emit(
                "transcript_chunk",
                serde_json::json!({ "text": "Listening...", "speaker": "user", "audioActive": true }),
            );
        }

        // Sync latest Groq API key from live config before starting mic
        let latest_groq_key = self.config.read().await.groq_api_key.clone();
        {
            let mut engine = self.audio_engine.lock().await;
            engine.set_groq_api_key(latest_groq_key);
            if let Err(e) = engine.start_mic() {
                emit_pipeline_error(&self.app_handle, "mic", e.to_string());
                let mut state = self.current_state.lock().await;
                *state = TalkState::Idle;
                Self::emit_talk_state(&self.app_handle, TalkState::Idle);
                return Err(e);
            }
        }

        let audio_engine_clone = Arc::clone(&self.audio_engine);
        let state_clone = Arc::clone(&self.current_state);
        let app_handle_clone = self.app_handle.clone();

        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(30));
            let mut speech_detected = false;
            let mut silence_start: Option<std::time::Instant> = None;
            let start_time = std::time::Instant::now();

            loop {
                interval.tick().await;
                if *state_clone.lock().await != TalkState::Listening {
                    break;
                }

                let tick_res = {
                    let mut engine = audio_engine_clone.lock().await;
                    engine.process_tick()
                };

                if let Some((vad_state, rms)) = tick_res {
                    let _ = app_handle_clone.emit("audio_amplitude", rms);
                    let _ = app_handle_clone.emit("audio:rms", rms);
                    match vad_state {
                        VadState::SpeechStarted | VadState::Speaking => {
                            speech_detected = true;
                            silence_start = None;
                        }
                        VadState::SpeechEnded | VadState::Silence => {
                            if speech_detected && silence_start.is_none() {
                                silence_start = Some(std::time::Instant::now());
                            }
                        }
                    }
                }

                let elapsed = start_time.elapsed();
                let trailing_hit = speech_detected
                    && silence_start
                        .map(|s| s.elapsed() >= Duration::from_millis(1400))
                        .unwrap_or(false);
                let initial_hit = !speech_detected && elapsed >= Duration::from_millis(6000);
                let max_hit = elapsed >= Duration::from_millis(30000);

                if trailing_hit || initial_hit || max_hit {
                    if trailing_hit {
                        emit_activity_log(&app_handle_clone, "talk", "Speech Ended", "Silence detected after speech; transcribing audio...");
                    } else if initial_hit {
                        emit_activity_log(&app_handle_clone, "talk", "Silence Timeout", "No speech detected within 6 seconds.");
                    } else if max_hit {
                        emit_activity_log(&app_handle_clone, "talk", "Max Duration (30s)", "Audio buffer reached 30 second limit.");
                    }
                    if let Some(app_state) = app_handle_clone.try_state::<AppState>() {
                        let _ = app_state.talk_controller.stop_talk().await;
                    }
                    break;
                }
            }
        });

        Ok(())
    }

    pub async fn stop_talk(&self) -> Result<()> {
        // Hold op_lock ONLY for the atomic state transition out of Listening,
        // NOT across long-running STT / LLM / TTS calls (which would block barge-in).
        {
            let _guard = self.op_lock.lock().await;
            let mut state = self.current_state.lock().await;
            if *state != TalkState::Listening {
                return Ok(());
            }
            *state = TalkState::Transcribing;
            Self::emit_talk_state(&self.app_handle, TalkState::Transcribing);
            emit_activity_log(&self.app_handle, "talk", "Transcribing Audio", "Audio captured; running speech-to-text...");
            let _ = self.app_handle.emit("cursor:ptt_stop", ());
            let _ = self.app_handle.emit("hotkey:talk_up", ());
            let _ = self.app_handle.emit(
                "transcript_chunk",
                serde_json::json!({ "text": "Transcribing...", "speaker": "user", "audioActive": false }),
            );
        }

        let transcript = {
            let mut engine = self.audio_engine.lock().await;
            engine.stop_mic();
            match engine.transcribe_recorded().await {
                Ok(t) => t.trim().to_string(),
                Err(e) => {
                    emit_pipeline_error(&self.app_handle, "stt", e.to_string());
                    let mut state = self.current_state.lock().await;
                    *state = TalkState::Idle;
                    Self::emit_talk_state(&self.app_handle, TalkState::Idle);
                    let _ = WindowManager::hide(&self.app_handle, "bubble");
                    return Ok(());
                }
            }
        };

        if transcript.is_empty() {
            emit_activity_log(&self.app_handle, "stt", "Empty Transcription", "No audible speech recognized in audio buffer.");
            let mut state = self.current_state.lock().await;
            *state = TalkState::Idle;
            Self::emit_talk_state(&self.app_handle, TalkState::Idle);
            let _ = WindowManager::hide(&self.app_handle, "bubble");
            return Ok(());
        }

        emit_activity_log(&self.app_handle, "stt", "User Speech Transcribed", &transcript);
        let _ = self.app_handle.emit("talk:transcript", &transcript);
        let _ = self.app_handle.emit("talk_text", &transcript);

        {
            let mut state = self.current_state.lock().await;
            *state = TalkState::Thinking;
            Self::emit_talk_state(&self.app_handle, TalkState::Thinking);
            let _ = self.app_handle.emit(
                "transcript_chunk",
                serde_json::json!({ "text": format!("Thinking: {}", transcript), "speaker": "clicky", "audioActive": false }),
            );
            emit_activity_log(&self.app_handle, "llm", "Prompting AI Model", "Routing transcript with active screen & UI context...");
        }

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

        let mut rx = match self.router.route_and_stream(TaskType::FastTalk, &messages, &[]).await {
            Ok(receiver) => receiver,
            Err(e) => {
                emit_pipeline_error(&self.app_handle, "llm", e.to_string());
                let mut state = self.current_state.lock().await;
                *state = TalkState::Idle;
                Self::emit_talk_state(&self.app_handle, TalkState::Idle);
                let _ = WindowManager::hide(&self.app_handle, "bubble");
                return Ok(());
            }
        };

        {
            let mut state = self.current_state.lock().await;
            *state = TalkState::Speaking;
            Self::emit_talk_state(&self.app_handle, TalkState::Speaking);
        }

        let mut parser = TagStreamParser::new();
        let mut full_reply = String::new();

        while let Some(chunk_res) = rx.recv().await {
            if self.cancel_flag.load(Ordering::Relaxed) {
                break;
            }
            match chunk_res {
                Ok(chunk) => {
                    if let Some(text) = chunk.delta_text {
                        let (clean, cmds) = parser.feed_token(&text);
                        for cmd in cmds {
                            broadcast_overlay_command(&self.app_handle, &cmd);
                        }
                        if !clean.is_empty() {
                            full_reply.push_str(&clean);
                            let _ = self.app_handle.emit("bubble_update", &full_reply);
                            let mut eng = self.audio_engine.lock().await;
                            if let Err(e) = eng.push_tts_token(&clean).await {
                                emit_pipeline_error(&self.app_handle, "tts", e.to_string());
                            }
                        }
                    }
                }
                Err(e) => {
                    emit_pipeline_error(&self.app_handle, "llm", e.to_string());
                    break;
                }
            }
        }

        let (final_clean, final_cmds) = parser.flush();
        for cmd in final_cmds {
            broadcast_overlay_command(&self.app_handle, &cmd);
        }
        {
            let mut eng = self.audio_engine.lock().await;
            if !final_clean.is_empty() {
                full_reply.push_str(&final_clean);
                let _ = self.app_handle.emit("bubble_update", &full_reply);
                if let Err(e) = eng.push_tts_token(&final_clean).await {
                    emit_pipeline_error(&self.app_handle, "tts", e.to_string());
                }
            }
            if let Err(e) = eng.flush_tts().await {
                emit_pipeline_error(&self.app_handle, "tts", e.to_string());
            }
        }

        if !full_reply.is_empty() {
            emit_activity_log(&self.app_handle, "llm", "LLM Output Generated", &full_reply);
            emit_activity_log(&self.app_handle, "tts", "Voice Playback Complete", "TTS audio synthesis finished.");
        }

        let mut state = self.current_state.lock().await;
        *state = TalkState::Idle;
        Self::emit_talk_state(&self.app_handle, TalkState::Idle);
        emit_activity_log(&self.app_handle, "talk", "Ready (Idle)", "Voice pipeline returned to standby.");
        let app_hide = self.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1200)).await;
            if let Some(app_state) = app_hide.try_state::<AppState>() {
                if app_state.talk_controller.get_state().await == TalkState::Idle {
                    let _ = WindowManager::hide(&app_hide, "bubble");
                }
            }
        });
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
