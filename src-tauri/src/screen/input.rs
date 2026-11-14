use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use crate::error::{AppError, Result};

pub struct InputSimulator {
    enigo: Enigo,
    pub commanded_pos: Arc<Mutex<(i32, i32)>>,
}

impl InputSimulator {
    pub fn new() -> Result<Self> {
        let enigo = Enigo::new(&Settings::default())
            .map_err(|e| AppError::Input(format!("Failed to init Enigo: {e}")))?;
        let initial = get_current_cursor_pos();
        Ok(Self {
            enigo,
            commanded_pos: Arc::new(Mutex::new(initial)),
        })
    }

    pub fn move_mouse(&mut self, x: i32, y: i32) -> Result<()> {
        if let Ok(mut guard) = self.commanded_pos.lock() {
            *guard = (x, y);
        }
        self.enigo
            .move_mouse(x, y, Coordinate::Abs)
            .map_err(|e| AppError::Input(format!("Mouse move failed: {e}")))
    }

    pub fn click(&mut self, x: i32, y: i32, button: &str) -> Result<()> {
        self.move_mouse(x, y)?;
        let btn = match button.to_lowercase().as_str() {
            "right" => Button::Right,
            "middle" => Button::Middle,
            _ => Button::Left,
        };

        if button == "double" {
            self.enigo
                .button(Button::Left, Direction::Click)
                .map_err(|e| AppError::Input(e.to_string()))?;
            std::thread::sleep(Duration::from_millis(40));
            self.enigo
                .button(Button::Left, Direction::Click)
                .map_err(|e| AppError::Input(e.to_string()))?;
        } else {
            self.enigo
                .button(btn, Direction::Click)
                .map_err(|e| AppError::Input(e.to_string()))?;
        }
        Ok(())
    }

    pub fn click_at(&mut self, x: i32, y: i32, button: &str) -> Result<()> {
        self.click(x, y, button)
    }

    pub fn type_text(&mut self, text: &str, press_enter: bool) -> Result<()> {
        self.enigo
            .text(text)
            .map_err(|e| AppError::Input(format!("Type text failed: {e}")))?;

        if press_enter {
            self.enigo
                .key(Key::Return, Direction::Click)
                .map_err(|e| AppError::Input(format!("Enter key failed: {e}")))?;
        }
        Ok(())
    }

    pub fn press_key(&mut self, key: Key) -> Result<()> {
        self.enigo
            .key(key, Direction::Click)
            .map_err(|e| AppError::Input(format!("Key press failed: {e}")))
    }

    pub fn press_hotkey(&mut self, keys: &[String]) -> Result<()> {
        let mut pressed = Vec::new();
        for k in keys {
            let key = match k.to_lowercase().as_str() {
                "ctrl" | "control" => Key::Control,
                "alt" => Key::Alt,
                "shift" => Key::Shift,
                "super" | "win" | "cmd" | "meta" => Key::Meta,
                "enter" | "return" => Key::Return,
                "esc" | "escape" => Key::Escape,
                "space" => Key::Space,
                "tab" => Key::Tab,
                "backspace" => Key::Backspace,
                other => {
                    if let Some(ch) = other.chars().next() {
                        Key::Unicode(ch)
                    } else {
                        continue;
                    }
                }
            };
            self.enigo
                .key(key, Direction::Press)
                .map_err(|e| AppError::Input(format!("Key press failed: {e}")))?;
            pressed.push(key);
        }

        std::thread::sleep(Duration::from_millis(20));

        for key in pressed.into_iter().rev() {
            let _ = self.enigo.key(key, Direction::Release);
        }

        Ok(())
    }

    pub fn scroll(&mut self, delta_x: i32, delta_y: i32) -> Result<()> {
        if delta_y != 0 {
            self.enigo
                .scroll(delta_y, enigo::Axis::Vertical)
                .map_err(|e| AppError::Input(format!("Scroll vertical failed: {e}")))?;
        }
        if delta_x != 0 {
            self.enigo
                .scroll(delta_x, enigo::Axis::Horizontal)
                .map_err(|e| AppError::Input(format!("Scroll horizontal failed: {e}")))?;
        }
        Ok(())
    }

    pub fn get_last_commanded_pos(&self) -> (i32, i32) {
        self.commanded_pos
            .lock()
            .map(|g| *g)
            .unwrap_or_else(|_| get_current_cursor_pos())
    }
}

/// 60Hz safety watchdog: dynamically reads `commanded_pos: Arc<Mutex<(i32, i32)>>` so synthetic
/// AI mouse movements never trip the 15px human-override abort threshold.
pub fn spawn_safety_watchdog(
    abort_flag: Arc<AtomicBool>,
    commanded_pos: Arc<Mutex<(i32, i32)>>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(16)); // ~60 Hz

        while !abort_flag.load(Ordering::Relaxed) {
            interval.tick().await;

            if is_esc_pressed() {
                abort_flag.store(true, Ordering::SeqCst);
                eprintln!("[Drive Watchdog] ESC key pressed - aborting execution!");
                break;
            }

            let (cx, cy) = commanded_pos
                .lock()
                .map(|g| *g)
                .unwrap_or_else(|_| get_current_cursor_pos());
            let (cur_x, cur_y) = get_current_cursor_pos();
            let dx = (cur_x - cx).abs();
            let dy = (cur_y - cy).abs();
            let dist = ((dx * dx + dy * dy) as f32).sqrt();

            if dist > 15.0 {
                abort_flag.store(true, Ordering::SeqCst);
                eprintln!(
                    "[Drive Watchdog] Physical mouse movement > 15px detected (dist: {:.1}) - aborting!",
                    dist
                );
                break;
            }
        }
    })
}

#[cfg(target_os = "windows")]
pub fn get_current_cursor_pos() -> (i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut pt).is_ok() {
            return (pt.x, pt.y);
        }
    }
    (0, 0)
}

#[cfg(not(target_os = "windows"))]
pub fn get_current_cursor_pos() -> (i32, i32) {
    (0, 0)
}

#[cfg(target_os = "windows")]
pub fn is_esc_pressed() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE};
    unsafe { (GetAsyncKeyState(VK_ESCAPE.0 as i32) as u16 & 0x8000) != 0 }
}

#[cfg(not(target_os = "windows"))]
pub fn is_esc_pressed() -> bool {
    false
}
