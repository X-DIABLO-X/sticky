use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, Result};
use crate::screen::input::{spawn_safety_watchdog, InputSimulator};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveAction {
    pub action_type: String, // "click" | "type" | "hotkey" | "move"
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub button: Option<String>,
    pub text: Option<String>,
    pub keys: Option<Vec<String>>,
}

/// RAII guard that guarantees `is_driving` is reset to `false` even if `execute_action` returns early or panics.
struct DrivingGuard {
    flag: Arc<AtomicBool>,
    app: AppHandle,
}

impl Drop for DrivingGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
        let _ = self.app.emit("drive:active", false);
    }
}

pub struct DriveController {
    pub app_handle: AppHandle,
    pub is_driving: Arc<AtomicBool>,
    pub abort_flag: Arc<AtomicBool>,
    pub auto_confirmed: Arc<AtomicBool>,
}

impl DriveController {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            is_driving: Arc::new(AtomicBool::new(false)),
            abort_flag: Arc::new(AtomicBool::new(false)),
            auto_confirmed: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_confirmed(&self, confirmed: bool) {
        self.auto_confirmed.store(confirmed, Ordering::SeqCst);
        if !confirmed {
            self.abort_flag.store(true, Ordering::SeqCst);
        }
    }

    pub fn stop_drive(&self) {
        self.abort_flag.store(true, Ordering::SeqCst);
        self.is_driving.store(false, Ordering::SeqCst);
        let _ = self.app_handle.emit("drive:active", false);
    }

    pub async fn execute_action(&self, action: DriveAction) -> Result<()> {
        if !self.auto_confirmed.load(Ordering::SeqCst) {
            let _ = self.app_handle.emit("drive:confirm_required", &action);
            return Err(AppError::Input(
                "Drive Mode action awaiting user confirmation".to_string(),
            ));
        }

        if self.is_driving.swap(true, Ordering::SeqCst) {
            return Err(AppError::Input("Drive action already in progress".to_string()));
        }

        let _guard = DrivingGuard {
            flag: self.is_driving.clone(),
            app: self.app_handle.clone(),
        };
        self.abort_flag.store(false, Ordering::SeqCst);
        let _ = self.app_handle.emit("drive:active", true);

        let abort_flag = self.abort_flag.clone();
        let join_res = tauri::async_runtime::spawn_blocking(move || -> Result<()> {
            let mut sim = InputSimulator::new()?;
            let watchdog = spawn_safety_watchdog(abort_flag.clone(), sim.commanded_pos.clone());

            let res = match action.action_type.as_str() {
                "move" => {
                    let (x, y) = (action.x.unwrap_or(0), action.y.unwrap_or(0));
                    sim.move_mouse(x, y)
                }
                "click" => {
                    let (x, y) = (action.x.unwrap_or(0), action.y.unwrap_or(0));
                    let btn = action.button.as_deref().unwrap_or("left");
                    sim.click_at(x, y, btn)
                }
                "type" => {
                    let text = action.text.as_deref().unwrap_or("");
                    sim.type_text(text, false)
                }
                "hotkey" => {
                    if let Some(ref keys) = action.keys {
                        sim.press_hotkey(keys)
                    } else {
                        Ok(())
                    }
                }
                _ => Ok(()),
            };

            abort_flag.store(true, Ordering::SeqCst);
            watchdog.abort();
            res
        })
        .await
        .map_err(|e| AppError::Input(format!("Drive task join error: {e}")))?;

        join_res
    }
}
