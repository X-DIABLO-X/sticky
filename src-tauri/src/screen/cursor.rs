use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use crate::screen::input::get_current_cursor_pos;
use crate::ui::windows::WindowManager;
use crate::AppState;

pub struct CursorTracker {
    is_running: Arc<AtomicBool>,
}

#[cfg(windows)]
fn is_mouse_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    unsafe {
        (GetAsyncKeyState(0x01) as u16 & 0x8000) != 0
    }
}

#[cfg(not(windows))]
fn is_mouse_down() -> bool {
    false
}

#[cfg(windows)]
fn is_ctrl_space_pressed() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_SPACE};
    unsafe {
        let ctrl = (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
        let space = (GetAsyncKeyState(VK_SPACE.0 as i32) as u16 & 0x8000) != 0;
        ctrl && space
    }
}

#[cfg(not(windows))]
fn is_ctrl_space_pressed() -> bool {
    false
}

impl CursorTracker {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start(&self, app: AppHandle) {
        if self.is_running.swap(true, Ordering::SeqCst) {
            return;
        }

        let is_running = Arc::clone(&self.is_running);

        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(16)); // ~60 FPS
            let mut last_pos = (-1, -1);
            let mut last_click = false;
            let mut last_ctrl_space = false;
            let mut ctrl_space_cooldown = std::time::Instant::now();

            while is_running.load(Ordering::Relaxed) {
                interval.tick().await;

                let (x, y) = get_current_cursor_pos();
                let clicking = is_mouse_down();

                // 1. Broadcast cursor position to all windows (overlay, dashboard, bubble)
                if (x, y) != last_pos || clicking != last_click {
                    last_pos = (x, y);
                    last_click = clicking;

                    let _ = app.emit("cursor_pos", serde_json::json!({
                        "x": x,
                        "y": y,
                        "clicking": clicking
                    }));
                }

                // 2. Hardware-level Ctrl+Space keyboard detection (bypasses Windows IME / hotkey conflicts)
                let ctrl_space = is_ctrl_space_pressed();
                if ctrl_space && !last_ctrl_space {
                    // Debounce hotkey toggle: at least 350ms between toggles
                    if ctrl_space_cooldown.elapsed() > Duration::from_millis(350) {
                        ctrl_space_cooldown = std::time::Instant::now();
                        eprintln!("[CursorTracker] Hardware Ctrl+Space detected! Toggling Talk Mode.");

                        if let Some(app_state) = app.try_state::<AppState>() {
                            let talk_ctrl = Arc::clone(&app_state.talk_controller);
                            let app_handle = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let current = talk_ctrl.get_state().await;
                                if current == crate::features::talk::TalkState::Idle {
                                    let _ = WindowManager::show(&app_handle, "bubble");
                                    let _ = WindowManager::position_bubble_at_cursor(&app_handle);
                                    let _ = tauri::Emitter::emit(&app_handle, "hotkey:talk_down", ());
                                    let _ = talk_ctrl.start_talk().await;
                                } else if current == crate::features::talk::TalkState::Listening {
                                    let _ = tauri::Emitter::emit(&app_handle, "hotkey:talk_up", ());
                                    let _ = talk_ctrl.stop_talk().await;
                                }
                            });
                        }
                    }
                }
                last_ctrl_space = ctrl_space;
            }
        });
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::Relaxed);
    }
}
