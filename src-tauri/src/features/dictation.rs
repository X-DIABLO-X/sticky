use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use crate::ai::prompts::Prompts;
use crate::ai::providers::ChatMessage;
use crate::ai::router::{ModelRouter, TaskType};
use crate::audio::AudioEngine;
use crate::error::Result;
use crate::screen::a11y::get_focused_window_tree;
use crate::screen::input::InputSimulator;

pub struct DictationController {
    app_handle: AppHandle,
    audio_engine: Arc<Mutex<AudioEngine>>,
    router: Arc<ModelRouter>,
    is_dictating: Arc<AtomicBool>,
}

impl DictationController {
    pub fn new(
        app_handle: AppHandle,
        audio_engine: Arc<Mutex<AudioEngine>>,
        router: Arc<ModelRouter>,
    ) -> Self {
        Self {
            app_handle,
            audio_engine,
            router,
            is_dictating: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_active(&self) -> bool {
        self.is_dictating.load(Ordering::Relaxed)
    }

    pub async fn start_dictation(&self) -> Result<()> {
        if self.is_dictating.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let _ = self.app_handle.emit("dictation:state", "recording");

        let mut engine = self.audio_engine.lock().await;
        engine.start_mic()?;

        Ok(())
    }

    pub async fn stop_dictation(&self, custom_hotwords: Vec<String>) -> Result<String> {
        if !self.is_dictating.swap(false, Ordering::SeqCst) {
            return Ok(String::new());
        }

        let _ = self.app_handle.emit("dictation:state", "processing");

        let mut engine = self.audio_engine.lock().await;
        engine.stop_mic();
        let raw_transcript = engine.transcribe_recorded().await?;
        drop(engine);

        let transcript = raw_transcript.trim().to_string();
        if transcript.is_empty() {
            let _ = self.app_handle.emit("dictation:state", "idle");
            return Ok(String::new());
        }

        // Capture focused screen context
        let window_title = tokio::task::spawn_blocking(|| {
            get_focused_window_tree(2).map(|t| t.window_title).unwrap_or_default()
        }).await.unwrap_or_default();

        let system_prompt = Prompts::dictation_cleanup_system_prompt(&custom_hotwords, Some(&window_title));
        let messages = vec![
            ChatMessage::system(system_prompt),
            ChatMessage::user(&transcript),
        ];

        let mut rx = self.router.route_and_stream(TaskType::DictationCleanup, &messages, &[]).await?;
        let mut cleaned_text = String::new();

        while let Some(chunk_res) = rx.recv().await {
            if let Ok(chunk) = chunk_res {
                if let Some(text) = chunk.delta_text {
                    cleaned_text.push_str(&text);
                }
            }
        }

        let final_text = cleaned_text.trim().to_string();
        if !final_text.is_empty() {
            paste_to_caret(&final_text).await?;

            // Spawn 20-second self-learning dictionary diff hook
            let inserted_clone = final_text.clone();
            let app = self.app_handle.clone();
            tauri::async_runtime::spawn(async move {
                self_learning_dictionary_hook(app, inserted_clone, window_title).await;
            });
        }

        let _ = self.app_handle.emit("dictation:state", "idle");
        Ok(final_text)
    }
}

/// Simulate typing / pasting text directly at active cursor caret
pub async fn paste_to_caret(text: &str) -> Result<()> {
    let t = text.to_string();
    tokio::task::spawn_blocking(move || {
        let mut sim = InputSimulator::new()?;
        sim.type_text(&t, false)?;
        Ok::<(), crate::error::AppError>(())
    }).await.unwrap_or(Err(crate::error::AppError::Internal("timeout".into())))?;
    Ok(())
}

/// Polls active element at t=5s, 10s, 20s to detect post-dictation user corrections
async fn self_learning_dictionary_hook(app: AppHandle, inserted: String, context_app: String) {
    let check_intervals = [5, 10, 20];
    for &sec in &check_intervals {
        tokio::time::sleep(Duration::from_secs(sec)).await;

        let tree = tokio::task::spawn_blocking(|| get_focused_window_tree(3)).await;
        if let Ok(Ok(t)) = tree {
            let mut interactive = Vec::new();
            t.root.collect_interactive(&mut interactive);

            // Check if any text field has a modified variation of what we inserted
            for node in interactive {
                if let Some(val) = node.value {
                    if val != inserted && val.len() > 2 && (val.contains(&inserted[..inserted.len().min(4)])) {
                        eprintln!(
                            "[Self-Learning Dict] Detected correction in {}: '{}' -> '{}'",
                            context_app, inserted, val
                        );
                        let _ = app.emit("dictionary:correction", serde_json::json!({
                            "original": inserted,
                            "corrected": val,
                            "app": context_app,
                        }));
                        return;
                    }
                }
            }
        }
    }
}
