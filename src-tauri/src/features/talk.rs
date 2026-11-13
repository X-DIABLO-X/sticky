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
        {
            let state = self.current_state.lock().await;
            if *state == TalkState::Speaking {
                // Barge in on assistant if currently speaking
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
            let _ = self.app_handle.emit("talk:state", TalkState::Listening);
            let _ = self.app_handle.emit("transcript_chunk", serde_json::json!({
                "text": "Listening...",
                "speaker": "user",
                "audioActive": true
            }));
        }

        {
            let mut engine = self.audio_engine.lock().await;
            engine.start_mic()?;
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

            let initial_silence_timeout = Duration::from_millis(4500); // 4.5s without speech -> auto cancel
            let trailing_silence_timeout = Duration::from_millis(1200); // 1.2s silence after speech -> auto submit
            let max_utterance_timeout = Duration::from_millis(25000);   // 25s max listening cap

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
                    // Emit audio amplitude for live waveform visuals
                    let _ = app_handle_clone.emit("audio_amplitude", rms);

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

                // Check trailing silence timeout after user has spoken
                let trailing_silence_hit = if speech_detected {
                    silence_start.map(|s| s.elapsed() >= trailing_silence_timeout).unwrap_or(false)
                } else {
                    false
                };

                // Check initial silence timeout (user triggered talk but said nothing)
                let initial_silence_hit = !speech_detected && elapsed >= initial_silence_timeout;

                // Check max utterance duration cap
                let max_duration_hit = elapsed >= max_utterance_timeout;

                if trailing_silence_hit || initial_silence_hit || max_duration_hit {
                    if trailing_silence_hit {
                        eprintln!("[TalkController] Trailing silence ({}ms after speech) detected. Stopping and submitting.", trailing_silence_timeout.as_millis());
                    } else if initial_silence_hit {
                        eprintln!("[TalkController] Initial silence timeout ({}s) reached. Aborting talk.", initial_silence_timeout.as_secs());
                    } else if max_duration_hit {
                        eprintln!("[TalkController] Max utterance duration ({}s) reached. Stopping and submitting.", max_utterance_timeout.as_secs());
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
            let _ = WindowManager::hide(&self.app_handle, "bubble");
            return Ok(());
        }

        let _ = self.app_handle.emit("talk:transcript", &transcript);
        let _ = self.app_handle.emit("transcript_chunk", serde_json::json!({
            "text": transcript,
            "speaker": "user",
            "audioActive": false
        }));

        // Transition to Thinking
        {
            let mut state = self.current_state.lock().await;
            *state = TalkState::Thinking;
            let _ = self.app_handle.emit("talk:state", TalkState::Thinking);
            let _ = self.app_handle.emit("transcript_chunk", serde_json::json!({
                "text": "Thinking...",
                "speaker": "clicky",
                "audioActive": true
            }));
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

                        // Emit visual overlay commands
                        for cmd in commands {
                            broadcast_overlay_command(&app, &cmd);
                        }

                        // Stream clean speech to TTS and update bubble caption
                        if !clean_text.is_empty() {
                            full_assistant_response.push_str(&clean_text);
                            let _ = app.emit("transcript_chunk", serde_json::json!({
                                "text": full_assistant_response,
                                "speaker": "clicky",
                                "audioActive": true
                            }));
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
            let mut eng = audio_engine.lock().await;
            let _ = eng.push_tts_token(&final_clean).await;
        }

        let mut eng = audio_engine.lock().await;
        let _ = eng.flush_tts().await;
        drop(eng);

        let mut state = self.current_state.lock().await;
        *state = TalkState::Idle;
        let _ = self.app_handle.emit("talk:state", TalkState::Idle);
        let _ = WindowManager::hide(&self.app_handle, "bubble");

        Ok(())
    }

    pub async fn barge_in(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
        let mut engine = self.audio_engine.lock().await;
        engine.barge_in_flush().await;

        let mut state = self.current_state.lock().await;
        *state = TalkState::Idle;
        let _ = self.app_handle.emit("talk:state", TalkState::Idle);
        let _ = WindowManager::hide(&self.app_handle, "bubble");
    }
}
