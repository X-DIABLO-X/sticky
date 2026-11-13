use tauri::{AppHandle, Manager, PhysicalPosition, Position};
use crate::error::{AppError, Result};
use crate::screen::input::get_current_cursor_pos;

pub struct WindowManager;

impl WindowManager {
    pub fn show(app: &AppHandle, label: &str) -> Result<()> {
        let win = app.get_webview_window(label)
            .ok_or_else(|| AppError::Ui(format!("Window '{}' not found", label)))?;
        let _ = win.unminimize();
        win.show().map_err(|e| AppError::Ui(format!("Failed to show window {}: {}", label, e)))?;
        win.set_focus().map_err(|e| AppError::Ui(format!("Failed to focus window {}: {}", label, e)))?;
        Ok(())
    }

    pub fn hide(app: &AppHandle, label: &str) -> Result<()> {
        let win = app.get_webview_window(label)
            .ok_or_else(|| AppError::Ui(format!("Window '{}' not found", label)))?;
        win.hide().map_err(|e| AppError::Ui(format!("Failed to hide window {}: {}", label, e)))?;
        Ok(())
    }

    pub fn toggle(app: &AppHandle, label: &str) -> Result<bool> {
        let win = app.get_webview_window(label)
            .ok_or_else(|| AppError::Ui(format!("Window '{}' not found", label)))?;

        let is_visible = win.is_visible()
            .map_err(|e| AppError::Ui(format!("Failed to check visibility for {}: {}", label, e)))?;

        if is_visible {
            win.hide().map_err(|e| AppError::Ui(e.to_string()))?;
            Ok(false)
        } else {
            win.show().map_err(|e| AppError::Ui(e.to_string()))?;
            win.set_focus().map_err(|e| AppError::Ui(e.to_string()))?;
            Ok(true)
        }
    }

    pub fn set_position(app: &AppHandle, label: &str, x: i32, y: i32) -> Result<()> {
        let win = app.get_webview_window(label)
            .ok_or_else(|| AppError::Ui(format!("Window '{}' not found", label)))?;

        win.set_position(Position::Physical(PhysicalPosition { x, y }))
            .map_err(|e| AppError::Ui(format!("Failed to position window {}: {}", label, e)))?;

        Ok(())
    }

    pub fn set_ignore_cursor_events(app: &AppHandle, label: &str, ignore: bool) -> Result<()> {
        let win = app.get_webview_window(label)
            .ok_or_else(|| AppError::Ui(format!("Window '{}' not found", label)))?;

        win.set_ignore_cursor_events(ignore)
            .map_err(|e| AppError::Ui(format!("Failed to set ignore_cursor_events on {}: {}", label, e)))?;

        Ok(())
    }

    pub fn position_bubble_at_cursor(app: &AppHandle) -> Result<()> {
        let (cx, cy) = get_current_cursor_pos();
        // Place bubble 24px below-right of cursor
        Self::set_position(app, "bubble", cx + 24, cy + 24)
    }

    pub fn position_pill_top_center(app: &AppHandle) -> Result<()> {
        let win = app.get_webview_window("pill")
            .ok_or_else(|| AppError::Ui("Pill window not found".into()))?;

        let monitor = win.current_monitor().ok().flatten()
            .or_else(|| app.primary_monitor().ok().flatten());

        if let Some(mon) = monitor {
            let scale_factor = mon.scale_factor();
            let screen_width = mon.size().width as f64 / scale_factor;
            let pill_width = 320.0;
            let x = ((screen_width - pill_width) / 2.0 * scale_factor) as i32;
            let y = (8.0 * scale_factor) as i32;
            Self::set_position(app, "pill", x, y)?;
        }
        let _ = win.show();
        let _ = win.set_focus();
        Ok(())
    }
}
