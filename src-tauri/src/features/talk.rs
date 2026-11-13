use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use crate::ai::prompts::Prompts;
use crate::ai::providers::ChatMessage;
use crate::ai::router::{ModelRouter, TaskType};
use crate::ai::tag_stream::{OverlayCommand, TagStreamParser};
use crate::audio::AudioEngine;
use crate::error::Result;
use crate::screen::ContextPrewarmer;

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
        }
    }

    pub async fn get_state(&self) -> TalkState {
        *self.current_state.lock().await
    }

    pub async fn start_talk(&self) -> Result<()> {
        let mut state = self.current_state.lock().await;
        if *state != TalkState::Idle {
            return Ok(());
        }

        self.cancel_flag.store(false, Ordering::SeqCst);
        *state = TalkState::Listening;
        let _ = self.app_handle.emit("talk:state", TalkState::Listening);

        let mut engine = self.audio_engine.lock().await;
        engine.start_mic()?;

        Ok(())
    }

    pub async fn stop_talk(&self) -> Result<()> {
        {
            let mut state = self.current_state.lock().await;
            if *state != TalkState::Listening {
                return Ok(());
            }
            *state = TalkState::Transcribing;
            let _ = self.app_handle.emit("talk:state", TalkState::Transcribing);
        }

        let mut engine = self.audio_engine.lock().await;
        engine.stop_mic();
        let raw_transcript = engine.transcribe_recorded().await?;
        drop(engine);

        let transcript = raw_transcript.trim().to_string();
        if transcript.is_empty() {
            let mut state = self.current_state.lock().await;
            *state = TalkState::Idle;
            let _ = self.app_handle.emit("talk:state", TalkState::Idle);
            return Ok(());
        }

        let _ = self.app_handle.emit("talk:transcript", &transcript);

        // Transition to Thinking
        {
            let mut state = self.current_state.lock().await;
            *state = TalkState::Thinking;
            let _ = self.app_handle.emit("talk:state", TalkState::Thinking);
        }

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

        let mut rx = self.router.route_and_stream(TaskType::FastTalk, &messages, &[]).await?;

        // Transition to Speaking
        {
            let mut state = self.current_state.lock().await;
            *state = TalkState::Speaking;
            let _ = self.app_handle.emit("talk:state", TalkState::Speaking);
        }

        let mut parser = TagStreamParser::new();
        let cancel = Arc::clone(&self.cancel_flag);
        let audio_engine = Arc::clone(&self.audio_engine);
        let app = self.app_handle.clone();

        while let Some(chunk_res) = rx.recv().await {
            if cancel.load(Ordering::Relaxed) {
                eprintln!("[Talk] Generation cancelled / barged in.");
                break;
            }

            match chunk_res {
                Ok(chunk) => {
                    if let Some(text) = chunk.delta_text {
                        let (clean_text, commands) = parser.feed_token(&text);

                        // Emit visual overlay commands
                        for cmd in commands {
                            broadcast_overlay_command(&app, &cmd);
                        }

                        // Stream clean speech to TTS
                        if !clean_text.is_empty() {
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
            let mut eng = audio_engine.lock().await;
            let _ = eng.push_tts_token(&final_clean).await;
        }

        let mut eng = audio_engine.lock().await;
        let _ = eng.flush_tts().await;
        drop(eng);

        let mut state = self.current_state.lock().await;
        *state = TalkState::Idle;
        let _ = self.app_handle.emit("talk:state", TalkState::Idle);

        Ok(())
    }

    pub async fn barge_in(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
        let mut engine = self.audio_engine.lock().await;
        engine.barge_in_flush().await;

        let mut state = self.current_state.lock().await;
        *state = TalkState::Idle;
        let _ = self.app_handle.emit("talk:state", TalkState::Idle);
    }
}
