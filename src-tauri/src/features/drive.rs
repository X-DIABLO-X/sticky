use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use crate::error::{AppError, Result};
use crate::screen::a11y::get_focused_window_tree;
use crate::screen::input::{get_current_cursor_pos, spawn_safety_watchdog, InputSimulator};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveAction {
    pub action_type: String, // "click", "type", "hotkey"
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub button: Option<String>,
    pub text: Option<String>,
    pub keys: Option<Vec<String>>,
}

pub struct DriveController {
    app_handle: AppHandle,
    is_driving: Arc<AtomicBool>,
    auto_confirmed: Arc<AtomicBool>,
}

impl DriveController {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            is_driving: Arc::new(AtomicBool::new(false)),
            auto_confirmed: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_confirmed(&self, confirmed: bool) {
        self.auto_confirmed.store(confirmed, Ordering::SeqCst);
    }

    pub async fn execute_action(&self, action: DriveAction) -> Result<serde_json::Value> {
        if !self.auto_confirmed.load(Ordering::Relaxed) {
            // Emit confirmation request to UI
            let _ = self.app_handle.emit("drive:confirm_required", &action);
            return Err(AppError::DriveAborted("User confirmation required to drive desktop".to_string()));
        }

        self.is_driving.store(true, Ordering::SeqCst);
        let _ = self.app_handle.emit("drive:active", true);

        // Pre-action cursor position
        let current_pos = get_current_cursor_pos();

        // Spawn safety watchdog (60Hz, 15px threshold / ESC key)
        let abort_flag = Arc::new(AtomicBool::new(false));
        let watchdog_handle = spawn_safety_watchdog(Arc::clone(&abort_flag), current_pos);

        let action_res = tokio::task::spawn_blocking(move || -> Result<()> {
            let mut sim = InputSimulator::new()?;
            match action.action_type.as_str() {
                "click" => {
                    let x = action.x.unwrap_or(0);
                    let y = action.y.unwrap_or(0);
                    let btn = action.button.as_deref().unwrap_or("left");
                    sim.click(x, y, btn)?;
                }
                "type" => {
                    if let Some(ref text) = action.text {
                        sim.type_text(text, false)?;
                    }
                }
                "hotkey" => {
                    if let Some(ref keys) = action.keys {
                        sim.press_hotkey(keys)?;
                    }
                }
                _ => return Err(AppError::Tool(format!("Unknown drive action: {}", action.action_type))),
            }
            Ok(())
        }).await.unwrap_or(Err(AppError::Internal("Task failed".into())));

        // Wait 150ms verification window
        tokio::time::sleep(Duration::from_millis(150)).await;

        let was_aborted = abort_flag.load(Ordering::SeqCst);
        abort_flag.store(true, Ordering::SeqCst);
        let _ = watchdog_handle.await;

        self.is_driving.store(false, Ordering::SeqCst);
        let _ = self.app_handle.emit("drive:active", false);

        if was_aborted {
            return Err(AppError::DriveAborted("Drive action interrupted by user mouse move or ESC key".to_string()));
        }

        action_res?;

        // Re-read A11y tree to verify UI state after action
        let new_tree = tokio::task::spawn_blocking(|| get_focused_window_tree(3))
            .await
            .unwrap_or(Err(AppError::A11y("Verification failed".into())))?;

        Ok(serde_json::json!({
            "status": "success",
            "verified_window": new_tree.window_title
        }))
    }
}
