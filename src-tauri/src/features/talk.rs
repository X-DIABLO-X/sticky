use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
use crate::screen::a11y::get_focused_window_tree;
use crate::screen::capture::{CapturedScreen, DetectedElement, ScreenCaptureService};
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
    #[allow(dead_code)]
    prewarmer: ContextPrewarmer,
    router: Arc<ModelRouter>,
    current_state: Arc<Mutex<TalkState>>,
    cancel_flag: Arc<AtomicBool>,
    op_lock: Arc<Mutex<()>>,
    ptt_held: Arc<AtomicBool>,
    guide_active: Arc<AtomicBool>,
    guide_goal: Arc<Mutex<String>>,
    guide_step: Arc<Mutex<usize>>,
    guide_history: Arc<Mutex<Vec<ChatMessage>>>,
    guide_session_id: Arc<AtomicU64>,
}

fn emit_guide_state(app: &AppHandle, active: bool, step: usize, goal: &str, instruction: &str) {
    let _ = app.emit(
        "guide:state",
        serde_json::json!({
            "active": active,
            "step": step,
            "goal": goal,
            "instruction": instruction
        }),
    );
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

fn broadcast_overlay_command(
    app: &AppHandle,
    cmd: &OverlayCommand,
    element_map: &HashMap<u32, DetectedElement>,
) {
    match cmd {
        OverlayCommand::PointRef {
            element_id,
            label,
            screen,
        } => {
            if let Some(el) = element_map.get(element_id) {
                let resolved_label = if label.is_empty() {
                    el.label.clone()
                } else {
                    label.clone()
                };
                emit_activity_log(
                    app,
                    "overlay",
                    "Pinpoint Element Resolved",
                    &format!(
                        "Resolved #{} (\"{}\") -> ({}, {})",
                        element_id, el.label, el.center_norm[0], el.center_norm[1]
                    ),
                );
                let resolved = OverlayCommand::Point {
                    x: el.center_norm[0],
                    y: el.center_norm[1],
                    label: resolved_label,
                    screen: screen.clone(),
                };
                broadcast_overlay_command(app, &resolved, element_map);
            } else {
                emit_activity_log(
                    app,
                    "overlay",
                    "Unknown Element ID",
                    &format!(
                        "Element #{} not found in detected screen elements",
                        element_id
                    ),
                );
            }
            return;
        }
        OverlayCommand::DrawRef {
            shape,
            element_id,
            target_element_id,
            color,
            label,
        } => {
            let Some(el) = element_map.get(element_id) else {
                emit_activity_log(
                    app,
                    "overlay",
                    "Unknown Element ID",
                    &format!(
                        "Element #{} not found in detected screen elements",
                        element_id
                    ),
                );
                return;
            };

            let coords = match shape.as_str() {
                "box" => vec![
                    (el.bbox_norm[0] - 4).clamp(0, 1000),
                    (el.bbox_norm[1] - 4).clamp(0, 1000),
                    (el.bbox_norm[2] + 4).clamp(0, 1000),
                    (el.bbox_norm[3] + 4).clamp(0, 1000),
                ],
                "circle" => {
                    let w = (el.bbox_norm[2] - el.bbox_norm[0]).abs();
                    let h = (el.bbox_norm[3] - el.bbox_norm[1]).abs();
                    let r = (w.max(h) / 2 + 8).clamp(14, 120);
                    vec![el.center_norm[0], el.center_norm[1], r]
                }
                "text" => {
                    vec![el.center_norm[0], (el.bbox_norm[1] - 18).max(12)]
                }
                "arrow" | "line" => {
                    if let Some(target_id) = target_element_id {
                        let Some(el2) = element_map.get(target_id) else {
                            emit_activity_log(
                                app,
                                "overlay",
                                "Unknown Target Element ID",
                                &format!(
                                    "Target element #{} not found in detected screen elements",
                                    target_id
                                ),
                            );
                            return;
                        };
                        vec![
                            el.center_norm[0],
                            el.center_norm[1],
                            el2.center_norm[0],
                            el2.center_norm[1],
                        ]
                    } else {
                        vec![
                            (el.center_norm[0] - 60).max(0),
                            (el.center_norm[1] - 40).max(0),
                            el.center_norm[0],
                            el.center_norm[1],
                        ]
                    }
                }
                _ => el.bbox_norm.to_vec(),
            };

            emit_activity_log(
                app,
                "overlay",
                "Pinpoint Draw Resolved",
                &format!(
                    "Resolved DRAW {} #{} (\"{}\") -> {:?}",
                    shape, element_id, el.label, coords
                ),
            );

            let resolved = OverlayCommand::Draw {
                shape: shape.clone(),
                coords,
                color: color.clone(),
                label: label.clone(),
            };
            broadcast_overlay_command(app, &resolved, element_map);
            return;
        }
        _ => {}
    }

    // Transform monitor-local 0..1000 coords into virtual-desktop overlay 0..1000 coords (identity on 1 monitor)
    // and emit a SINGLE canonical `overlay:command` event (eliminates duplicate draws & double glide restarts).
    match cmd {
        OverlayCommand::Point { x, y, label, screen } => {
            let (ox, oy) = ScreenCaptureService::monitor_to_overlay_norm(*x, *y, 0);
            let mapped = OverlayCommand::Point {
                x: ox,
                y: oy,
                label: label.clone(),
                screen: screen.clone(),
            };
            let _ = app.emit("overlay:command", &mapped);
        }
        OverlayCommand::Draw { shape, coords, color, label } => {
            let mapped_coords = if shape == "circle" && coords.len() >= 3 {
                let (ox, oy) = ScreenCaptureService::monitor_to_overlay_norm(coords[0], coords[1], 0);
                vec![ox, oy, coords[2]]
            } else {
                let mut out = Vec::with_capacity(coords.len());
                let mut i = 0;
                while i + 1 < coords.len() {
                    let (ox, oy) = ScreenCaptureService::monitor_to_overlay_norm(coords[i], coords[i + 1], 0);
                    out.push(ox);
                    out.push(oy);
                    i += 2;
                }
                if i < coords.len() {
                    out.push(coords[i]);
                }
                out
            };
            let mapped = OverlayCommand::Draw {
                shape: shape.clone(),
                coords: mapped_coords,
                color: Some(color.clone().unwrap_or_else(|| "#10b981".to_string())),
                label: label.clone(),
            };
            let _ = app.emit("overlay:command", &mapped);
        }
        OverlayCommand::Step { index, total, bbox, instruction } => {
            let (ox1, oy1) = ScreenCaptureService::monitor_to_overlay_norm(bbox[0], bbox[1], 0);
            let (ox2, oy2) = ScreenCaptureService::monitor_to_overlay_norm(bbox[2], bbox[3], 0);
            let mapped = OverlayCommand::Step {
                index: *index,
                total: *total,
                bbox: [ox1, oy1, ox2, oy2],
                instruction: instruction.clone(),
            };
            let _ = app.emit("overlay:command", &mapped);
        }
        OverlayCommand::Model3D { .. } | OverlayCommand::ClearDrawings => {
            let _ = app.emit("overlay:command", cmd);
        }
        OverlayCommand::Guide { .. }
        | OverlayCommand::PointRef { .. }
        | OverlayCommand::DrawRef { .. }
        | OverlayCommand::Raw(_) => {}
    }
}

async fn capture_vlm_context() -> (Option<CapturedScreen>, Vec<DetectedElement>, String) {
    let a11y = tauri::async_runtime::spawn_blocking(|| get_focused_window_tree(5))
        .await
        .ok()
        .and_then(|r| r.ok());

    let (window_title, interactive) = if let Some(tree) = a11y {
        let mut nodes = Vec::new();
        tree.root.collect_interactive(&mut nodes);
        (tree.window_title, nodes)
    } else {
        (String::new(), Vec::new())
    };

    let grounded = tauri::async_runtime::spawn_blocking(move || {
        ScreenCaptureService::capture_grounded_for_vlm(0, Some(1280), &interactive)
    })
    .await
    .ok()
    .and_then(|r| r.ok());

    match grounded {
        Some(g) => (Some(g.screen), g.elements, window_title),
        None => (None, Vec::new(), window_title),
    }
}

fn format_detected_elements_context(window_title: &str, elements: &[DetectedElement]) -> String {
    if window_title.is_empty() && elements.is_empty() {
        return String::new();
    }
    let clean_title = window_title.replace('"', "'");
    if elements.is_empty() {
        return format!("\n\n[Active Window: \"{}\"]", clean_title);
    }
    let items: Vec<String> = elements
        .iter()
        .map(|el| {
            format!(
                "#{} \"{}\" [{},{},{},{}]",
                el.id,
                el.label.replace('"', "'"),
                el.bbox_norm[0],
                el.bbox_norm[1],
                el.bbox_norm[2],
                el.bbox_norm[3]
            )
        })
        .collect();
    format!(
        "\n\n[Active Window: \"{}\" | Detected Screen Elements (USE #ID FOR PINPOINT ACCURACY): {}]",
        clean_title,
        items.join(", ")
    )
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
            ptt_held: Arc::new(AtomicBool::new(false)),
            guide_active: Arc::new(AtomicBool::new(false)),
            guide_goal: Arc::new(Mutex::new(String::new())),
            guide_step: Arc::new(Mutex::new(0)),
            guide_history: Arc::new(Mutex::new(Vec::new())),
            guide_session_id: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn set_ptt_held(&self, held: bool) {
        self.ptt_held.store(held, Ordering::SeqCst);
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

        // Cancel any active step-by-step guide loop when the user starts a new voice query
        if self.guide_active.swap(false, Ordering::SeqCst) {
            emit_guide_state(&self.app_handle, false, 0, "", "");
        }
        self.guide_session_id.fetch_add(1, Ordering::SeqCst);

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
        let ptt_held_clone = Arc::clone(&self.ptt_held);
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
                let is_ptt_held = ptt_held_clone.load(Ordering::SeqCst);

                // While Ctrl+Space Push-to-Talk is actively held, NEVER auto-stop on thinking pauses!
                let trailing_hit = !is_ptt_held
                    && speech_detected
                    && silence_start
                        .map(|s| s.elapsed() >= Duration::from_millis(2200))
                        .unwrap_or(false);
                let initial_hit = !is_ptt_held && !speech_detected && elapsed >= Duration::from_millis(8000);
                let max_hit = elapsed >= Duration::from_millis(60000);

                if trailing_hit || initial_hit || max_hit {
                    if trailing_hit {
                        emit_activity_log(&app_handle_clone, "talk", "Speech Ended", "2.2s silence detected; transcribing audio...");
                    } else if initial_hit {
                        emit_activity_log(&app_handle_clone, "talk", "Silence Timeout", "No speech detected within 8 seconds.");
                    } else if max_hit {
                        emit_activity_log(&app_handle_clone, "talk", "Max Duration (60s)", "Audio buffer reached 60 second limit.");
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

        // Capture fresh grounded VLM screenshot + Set-of-Mark detected elements (OCR + A11y)
        let (screen, elements, window_title) = capture_vlm_context().await;
        let element_map: HashMap<u32, DetectedElement> =
            elements.iter().map(|e| (e.id, e.clone())).collect();
        let elements_suffix = format_detected_elements_context(&window_title, &elements);
        let mut user_message_text = transcript.clone();
        user_message_text.push_str(&elements_suffix);

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
        let mut guide_signal: Option<bool> = None;

        while let Some(chunk_res) = rx.recv().await {
            if self.cancel_flag.load(Ordering::Relaxed) {
                break;
            }
            match chunk_res {
                Ok(chunk) => {
                    if let Some(text) = chunk.delta_text {
                        let (clean, cmds) = parser.feed_token(&text);
                        for cmd in cmds {
                            if let OverlayCommand::Guide { active } = cmd {
                                guide_signal = Some(active);
                            } else {
                                broadcast_overlay_command(&self.app_handle, &cmd, &element_map);
                            }
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
            if let OverlayCommand::Guide { active } = cmd {
                guide_signal = Some(active);
            } else {
                broadcast_overlay_command(&self.app_handle, &cmd, &element_map);
            }
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

        {
            let mut state = self.current_state.lock().await;
            *state = TalkState::Idle;
            Self::emit_talk_state(&self.app_handle, TalkState::Idle);
        }

        if guide_signal == Some(true) && !self.cancel_flag.load(Ordering::Relaxed) {
            {
                let mut goal = self.guide_goal.lock().await;
                *goal = transcript.clone();
            }
            {
                let mut step = self.guide_step.lock().await;
                *step = 1;
            }
            {
                let mut history = self.guide_history.lock().await;
                history.clear();
                history.push(ChatMessage::user(transcript.clone()));
                history.push(ChatMessage::assistant(full_reply.clone()));
            }
            self.guide_active.store(true, Ordering::SeqCst);
            emit_guide_state(&self.app_handle, true, 1, &transcript, full_reply.trim());
            emit_activity_log(
                &self.app_handle,
                "talk",
                "Step-by-Step Guide Active",
                "Watching for your next click (press Esc anytime to exit guide).",
            );
            self.spawn_guide_click_watcher();
        } else {
            if guide_signal == Some(false) {
                self.guide_active.store(false, Ordering::SeqCst);
                emit_guide_state(&self.app_handle, false, 0, "", "");
                let _ = self.app_handle.emit("overlay:point_clear", ());
                let _ = self.app_handle.emit("overlay:clear_drawings", ());
            }
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
        }
        Ok(())
    }

    fn spawn_guide_click_watcher(&self) {
        let session_id = self.guide_session_id.fetch_add(1, Ordering::SeqCst) + 1;
        let guide_active = Arc::clone(&self.guide_active);
        let guide_session_id = Arc::clone(&self.guide_session_id);
        let app_handle = self.app_handle.clone();

        tauri::async_runtime::spawn(async move {
            // Wait ~600ms before arming so any click that triggered UI doesn't double-fire
            tokio::time::sleep(Duration::from_millis(600)).await;

            if !guide_active.load(Ordering::SeqCst)
                || guide_session_id.load(Ordering::SeqCst) != session_id
            {
                return;
            }

            #[cfg(windows)]
            {
                use windows::Win32::Foundation::POINT;
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON,
                };
                use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

                let mut prev_lbtn_down = unsafe {
                    (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0
                };
                let mut interval = tokio::time::interval(Duration::from_millis(30));

                loop {
                    interval.tick().await;
                    if !guide_active.load(Ordering::SeqCst)
                        || guide_session_id.load(Ordering::SeqCst) != session_id
                    {
                        break;
                    }

                    let esc_down = unsafe {
                        (GetAsyncKeyState(VK_ESCAPE.0 as i32) as u16 & 0x8000) != 0
                    };
                    if esc_down {
                        guide_active.store(false, Ordering::SeqCst);
                        emit_guide_state(&app_handle, false, 0, "", "");
                        let _ = app_handle.emit("overlay:point_clear", ());
                        let _ = app_handle.emit("overlay:clear_drawings", ());
                        emit_activity_log(
                            &app_handle,
                            "talk",
                            "Guide Cancelled",
                            "Exited step-by-step guide via Escape key.",
                        );
                        break;
                    }

                    let lbtn_down = unsafe {
                        (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0
                    };
                    let rising_edge = lbtn_down && !prev_lbtn_down;
                    prev_lbtn_down = lbtn_down;

                    if rising_edge {
                        let mut pt = POINT { x: 0, y: 0 };
                        let _ = unsafe { GetCursorPos(&mut pt) };
                        let (mx, my, mw, mh) = ScreenCaptureService::monitor_bounds(0);
                        let nx = (((pt.x - mx) as f64 / mw.max(1) as f64) * 1000.0)
                            .round()
                            .clamp(0.0, 1000.0) as i32;
                        let ny = (((pt.y - my) as f64 / mh.max(1) as f64) * 1000.0)
                            .round()
                            .clamp(0.0, 1000.0) as i32;

                        // Wait 450ms for the clicked menu/UI to open
                        tokio::time::sleep(Duration::from_millis(450)).await;

                        if !guide_active.load(Ordering::SeqCst)
                            || guide_session_id.load(Ordering::SeqCst) != session_id
                        {
                            break;
                        }

                        let _ = app_handle.emit("overlay:clear_drawings", ());
                        emit_activity_log(
                            &app_handle,
                            "talk",
                            "Click Detected",
                            &format!("Detected click at ({}, {}) — verifying step...", nx, ny),
                        );

                        if let Some(app_state) = app_handle.try_state::<AppState>() {
                            let _ = app_state.talk_controller.handle_guide_click(nx, ny).await;
                        }
                        break;
                    }
                }
            }
        });
    }

    pub async fn handle_guide_click(&self, click_x: i32, click_y: i32) -> Result<()> {
        if !self.guide_active.load(Ordering::SeqCst) {
            return Ok(());
        }

        {
            let _guard = self.op_lock.lock().await;
            let mut state = self.current_state.lock().await;
            if *state != TalkState::Idle {
                return Ok(());
            }
            self.cancel_flag.store(false, Ordering::SeqCst);
            *state = TalkState::Thinking;
            Self::emit_talk_state(&self.app_handle, TalkState::Thinking);
            let _ = self.app_handle.emit(
                "transcript_chunk",
                serde_json::json!({ "text": "Checking your click...", "speaker": "clicky", "audioActive": false }),
            );
        }

        let goal = self.guide_goal.lock().await.clone();
        let step_num = {
            let mut step = self.guide_step.lock().await;
            *step += 1;
            *step
        };

        let (screen, elements, window_title) = capture_vlm_context().await;
        let element_map: HashMap<u32, DetectedElement> =
            elements.iter().map(|e| (e.id, e.clone())).collect();
        let elements_suffix = format_detected_elements_context(&window_title, &elements);
        let mut verify_prompt =
            Prompts::guide_click_verification_prompt(&goal, step_num, click_x, click_y);
        verify_prompt.push_str(&elements_suffix);

        let current_msg = if let Some(sc) = screen {
            ChatMessage::user_with_image(verify_prompt, sc.base64_data)
        } else {
            ChatMessage::user(verify_prompt)
        };

        let mut messages = vec![ChatMessage::system(Prompts::talk_mode_system_prompt())];
        {
            let history = self.guide_history.lock().await;
            let start = history.len().saturating_sub(10);
            messages.extend(history[start..].iter().cloned());
        }
        messages.push(current_msg);

        let mut rx = match self.router.route_and_stream(TaskType::FastTalk, &messages, &[]).await {
            Ok(receiver) => receiver,
            Err(e) => {
                emit_pipeline_error(&self.app_handle, "llm", e.to_string());
                self.guide_active.store(false, Ordering::SeqCst);
                let _ = self.app_handle.emit("overlay:point_clear", ());
                let _ = self.app_handle.emit("overlay:clear_drawings", ());
                let mut state = self.current_state.lock().await;
                *state = TalkState::Idle;
                Self::emit_talk_state(&self.app_handle, TalkState::Idle);
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
        let mut guide_signal: Option<bool> = None;

        while let Some(chunk_res) = rx.recv().await {
            if self.cancel_flag.load(Ordering::Relaxed) || !self.guide_active.load(Ordering::SeqCst) {
                break;
            }
            match chunk_res {
                Ok(chunk) => {
                    if let Some(text) = chunk.delta_text {
                        let (clean, cmds) = parser.feed_token(&text);
                        for cmd in cmds {
                            if let OverlayCommand::Guide { active } = cmd {
                                guide_signal = Some(active);
                            } else {
                                broadcast_overlay_command(&self.app_handle, &cmd, &element_map);
                            }
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
            if let OverlayCommand::Guide { active } = cmd {
                guide_signal = Some(active);
            } else {
                broadcast_overlay_command(&self.app_handle, &cmd, &element_map);
            }
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
            emit_activity_log(
                &self.app_handle,
                "llm",
                &format!("Guide Step {} Reply", step_num),
                &full_reply,
            );
            let mut history = self.guide_history.lock().await;
            history.push(ChatMessage::user(format!(
                "I clicked at ({}, {}) for step {}.",
                click_x, click_y, step_num
            )));
            history.push(ChatMessage::assistant(full_reply.clone()));
        }

        {
            let mut state = self.current_state.lock().await;
            *state = TalkState::Idle;
            Self::emit_talk_state(&self.app_handle, TalkState::Idle);
        }

        if guide_signal == Some(true)
            && self.guide_active.load(Ordering::SeqCst)
            && !self.cancel_flag.load(Ordering::Relaxed)
        {
            emit_guide_state(&self.app_handle, true, step_num, &goal, full_reply.trim());
            self.spawn_guide_click_watcher();
        } else {
            self.guide_active.store(false, Ordering::SeqCst);
            emit_guide_state(&self.app_handle, false, 0, "", "");
            let _ = self.app_handle.emit("overlay:point_clear", ());
            let _ = self.app_handle.emit("overlay:clear_drawings", ());
            emit_activity_log(
                &self.app_handle,
                "talk",
                "Guide Complete",
                "Step-by-step guide finished; cursor returned to standby.",
            );
            let app_hide = self.app_handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1200)).await;
                if let Some(app_state) = app_hide.try_state::<AppState>() {
                    if app_state.talk_controller.get_state().await == TalkState::Idle {
                        let _ = WindowManager::hide(&app_hide, "bubble");
                    }
                }
            });
        }

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
