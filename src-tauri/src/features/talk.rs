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
use crate::screen::capture::{CapturedScreen, ScreenCaptureService};
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
    guide_active: Arc<AtomicBool>,
    guide_goal: Arc<Mutex<String>>,
    guide_step: Arc<Mutex<usize>>,
    guide_history: Arc<Mutex<Vec<ChatMessage>>>,
    guide_session_id: Arc<AtomicU64>,
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
    if !matches!(cmd, OverlayCommand::Guide { .. }) {
        let _ = app.emit("overlay:command", cmd);
    }
    match cmd {
        OverlayCommand::Point { x, y, label, screen: _ } => {
            let _ = app.emit(
                "overlay_point",
                serde_json::json!({ "x": x, "y": y, "label": label, "screenIndex": 0, "durationMs": 1500 }),
            );
        }
        OverlayCommand::Draw { shape, coords, color, label } => {
            let _ = app.emit(
                "overlay_draw",
                serde_json::json!({
                    "id": format!("draw_{}", uuid::Uuid::new_v4()),
                    "shape": shape,
                    "coords": coords,
                    "color": color.as_deref().unwrap_or("#10b981"),
                    "label": label
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
        OverlayCommand::ClearDrawings => {
            let _ = app.emit("overlay:clear_drawings", ());
        }
        OverlayCommand::Guide { .. } => {}
        OverlayCommand::Raw(_) => {}
    }
}

async fn capture_vlm_context() -> (String, Option<CapturedScreen>) {
    let a11y_fut = tauri::async_runtime::spawn_blocking(|| get_focused_window_tree(6));
    let screen_fut = tauri::async_runtime::spawn_blocking(|| {
        ScreenCaptureService::capture_for_vlm(0, Some(1280))
    });
    let (a11y_res, screen_res) = tokio::join!(a11y_fut, screen_fut);

    let a11y = a11y_res.ok().and_then(|r| r.ok());
    let screen = screen_res.ok().and_then(|r| r.ok());

    let (mon_x, mon_y, mon_w, mon_h) = ScreenCaptureService::monitor_bounds(0);
    let mut a11y_suffix = String::new();
    if let Some(tree) = a11y {
        let mut interactive = Vec::new();
        tree.root.collect_interactive(&mut interactive);
        if !interactive.is_empty() {
            let normalized_elements: Vec<serde_json::Value> = interactive
                .into_iter()
                .filter(|n| n.bbox[2] > 2 && n.bbox[3] > 2)
                .take(80)
                .map(|n| {
                    let (bbox_norm, center_norm) = ScreenCaptureService::physical_bbox_to_normalized(
                        n.bbox, mon_x, mon_y, mon_w, mon_h,
                    );
                    serde_json::json!({
                        "role": n.role,
                        "name": n.name,
                        "bbox": bbox_norm,
                        "center": center_norm
                    })
                })
                .collect();
            let json_tree = serde_json::to_string(&normalized_elements).unwrap_or_default();
            a11y_suffix = format!(
                "\n\n[Active Window: \"{}\" | Primary Monitor: {}x{} | All UI element bbox [x1,y1,x2,y2] & center [cx,cy] are ALREADY normalized 0-1000 — cross-check with the 0-1000 screenshot grid and copy them directly into [POINT:cx,cy:...], [DRAW:...], or [STEP:...]: {}]",
                tree.window_title, mon_w, mon_h, json_tree
            );
        }
    }

    (a11y_suffix, screen)
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
            guide_active: Arc::new(AtomicBool::new(false)),
            guide_goal: Arc::new(Mutex::new(String::new())),
            guide_step: Arc::new(Mutex::new(0)),
            guide_history: Arc::new(Mutex::new(Vec::new())),
            guide_session_id: Arc::new(AtomicU64::new(0)),
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

        // Cancel any active step-by-step guide loop when the user starts a new voice query
        self.guide_active.store(false, Ordering::SeqCst);
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

        // Capture fresh gridded VLM screenshot + normalized UI Automation context
        let (a11y_suffix, screen) = capture_vlm_context().await;
        let mut user_message_text = transcript.clone();
        user_message_text.push_str(&a11y_suffix);

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
                                broadcast_overlay_command(&self.app_handle, &cmd);
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
                broadcast_overlay_command(&self.app_handle, &cmd);
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
                history.push(ChatMessage::user(transcript));
                history.push(ChatMessage::assistant(full_reply));
            }
            self.guide_active.store(true, Ordering::SeqCst);
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

        let (a11y_suffix, screen) = capture_vlm_context().await;
        let mut verify_prompt =
            Prompts::guide_click_verification_prompt(&goal, step_num, click_x, click_y);
        verify_prompt.push_str(&a11y_suffix);

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
                                broadcast_overlay_command(&self.app_handle, &cmd);
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
                broadcast_overlay_command(&self.app_handle, &cmd);
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
            history.push(ChatMessage::assistant(full_reply));
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
            self.spawn_guide_click_watcher();
        } else {
            self.guide_active.store(false, Ordering::SeqCst);
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
