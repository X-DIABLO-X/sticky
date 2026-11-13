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
            let mut ctrl_space_press_start: Option<std::time::Instant> = None;

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

                // 2. Hardware-level Ctrl+Space keyboard detection (Push-To-Talk + Tap-To-Toggle)
                let ctrl_space = is_ctrl_space_pressed();

                // Key DOWN: User pressed Ctrl + Space
                if ctrl_space && !last_ctrl_space {
                    ctrl_space_press_start = Some(std::time::Instant::now());
                    eprintln!("[CursorTracker] Hardware Ctrl+Space DOWN detected!");

                    if ctrl_space_cooldown.elapsed() > Duration::from_millis(250) {
                        ctrl_space_cooldown = std::time::Instant::now();

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
                                    // If already listening and user taps again, toggle off
                                    let _ = tauri::Emitter::emit(&app_handle, "hotkey:talk_up", ());
                                    let _ = talk_ctrl.stop_talk().await;
                                }
                            });
                        }
                    }
                }

                // Key UP: User released Ctrl or Space
                if !ctrl_space && last_ctrl_space {
                    let held_ms = ctrl_space_press_start
                        .take()
                        .map(|t| t.elapsed().as_millis())
                        .unwrap_or(0);

                    eprintln!("[CursorTracker] Hardware Ctrl+Space UP detected! Held for {}ms", held_ms);

                    // Push-to-Talk: If user held Ctrl+Space for >= 180ms, releasing immediately stops recording & submits!
                    if held_ms >= 180 {
                        if let Some(app_state) = app.try_state::<AppState>() {
                            let talk_ctrl = Arc::clone(&app_state.talk_controller);
                            let app_handle = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let current = talk_ctrl.get_state().await;
                                if current == crate::features::talk::TalkState::Listening {
                                    eprintln!("[CursorTracker] Push-to-Talk release -> Stopping talk and submitting to LLM.");
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
