use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};
use crate::error::{AppError, Result};

static OVERLAY_CLICK_THROUGH: AtomicBool = AtomicBool::new(true);

pub struct WindowManager;

impl WindowManager {
    pub fn show(app: &AppHandle, label: &str) -> Result<()> {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.unminimize();
            win.show().map_err(|e| AppError::Config(e.to_string()))?;
            if label == "dashboard" || label == "quick_input" {
                let _ = win.set_focus();
            } else {
                Self::enforce_topmost_native(&win, label == "overlay");
            }
        }
        Ok(())
    }

    pub fn hide(app: &AppHandle, label: &str) -> Result<()> {
        if let Some(win) = app.get_webview_window(label) {
            win.hide().map_err(|e| AppError::Config(e.to_string()))?;
        }
        Ok(())
    }

    pub fn toggle(app: &AppHandle, label: &str) -> Result<bool> {
        if let Some(win) = app.get_webview_window(label) {
            let visible = win.is_visible().unwrap_or(false);
            if visible {
                win.hide().map_err(|e| AppError::Config(e.to_string()))?;
                return Ok(false);
            } else {
                let _ = win.unminimize();
                win.show().map_err(|e| AppError::Config(e.to_string()))?;
                if label == "dashboard" || label == "quick_input" {
                    let _ = win.set_focus();
                } else {
                    Self::enforce_topmost_native(&win, label == "overlay");
                }
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn set_ignore_cursor_events(app: &AppHandle, label: &str, ignore: bool) -> Result<()> {
        if label == "overlay" {
            OVERLAY_CLICK_THROUGH.store(ignore, Ordering::SeqCst);
        }
        if let Some(win) = app.get_webview_window(label) {
            win.set_ignore_cursor_events(ignore)
                .map_err(|e| AppError::Config(e.to_string()))?;
            Self::enforce_topmost_native(&win, ignore);
        }
        Ok(())
    }

    pub fn set_position(app: &AppHandle, label: &str, x: i32, y: i32) -> Result<()> {
        if let Some(win) = app.get_webview_window(label) {
            win.set_position(PhysicalPosition::new(x, y))
                .map_err(|e| AppError::Ui(format!("Failed to position window {}: {}", label, e)))?;
        }
        Ok(())
    }

    pub fn position_bubble_at_cursor(app: &AppHandle) -> Result<()> {
        let (cx, cy) = crate::screen::input::get_current_cursor_pos();
        Self::set_position(app, "bubble", cx + 24, cy + 24)
    }

    pub fn position_pill_top_center(app: &AppHandle) -> Result<()> {
        if let Some(win) = app.get_webview_window("pill") {
            if let Ok(Some(monitor)) = win.primary_monitor() {
                let size = monitor.size();
                let pos = monitor.position();
                let pill_w = 320i32;
                let x = pos.x + ((size.width as i32) - pill_w) / 2;
                let y = pos.y + 10;
                let _ = win.set_position(PhysicalPosition::new(x, y));
            }
            Self::enforce_topmost_native(&win, false);
        }
        Ok(())
    }

    /// Configures the transparent overlay to cover the full virtual desktop (all monitors)
    /// WITHOUT using `fullscreen: true` (which breaks Windows 11 DWM Z-order & Taskbar layering).
    pub fn configure_overlay_window(app: &AppHandle) -> Result<()> {
        if let Some(win) = app.get_webview_window("overlay") {
            #[cfg(windows)]
            {
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
                    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
                };
                unsafe {
                    let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
                    let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
                    let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
                    let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
                    if vw > 0 && vh > 0 {
                        let _ = win.set_position(PhysicalPosition::new(vx, vy));
                        let _ = win.set_size(PhysicalSize::new(vw as u32, vh as u32));
                    }
                }
            }

            #[cfg(not(windows))]
            {
                if let Ok(Some(monitor)) = win.primary_monitor() {
                    let _ = win.set_position(*monitor.position());
                    let _ = win.set_size(*monitor.size());
                }
            }

            let _ = win.set_ignore_cursor_events(true);
            let _ = win.set_visible_on_all_workspaces(true);
            Self::enforce_topmost_native(&win, true);
            let _ = win.show();
        }
        Ok(())
    }

    /// Directly applies Win32 `SetWindowPos(HWND_TOPMOST)` + `WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`
    /// bypassing tao's stale `WS_EX_TOPMOST` style-cache bug (tauri-apps/tao#1234), and excludes Sticky's
    /// HUD windows from screen capture via `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`.
    pub fn enforce_topmost_native(win: &tauri::WebviewWindow, click_through: bool) {
        let _ = win.set_always_on_top(true);

        #[cfg(windows)]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                GetWindowDisplayAffinity, GetWindowLongPtrW, SetWindowDisplayAffinity,
                SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE,
                SWP_NOMOVE, SWP_NOSIZE, WDA_EXCLUDEFROMCAPTURE, WS_EX_LAYERED, WS_EX_NOACTIVATE,
                WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
            };

            if let Ok(raw_hwnd) = win.hwnd() {
                let hwnd = HWND(raw_hwnd.0);
                unsafe {
                    let mut ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                    ex_style |= (WS_EX_TOPMOST.0 | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_LAYERED.0) as isize;
                    if click_through {
                        ex_style |= WS_EX_TRANSPARENT.0 as isize;
                    } else {
                        ex_style &= !(WS_EX_TRANSPARENT.0 as isize);
                    }
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style);

                    let _ = SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );

                    // Keep Sticky's own overlay/pill/bubble 100% visible to the user,
                    // but completely invisible to xcap / desktop capture & WinRT OCR.
                    let mut current_affinity: u32 = 0;
                    if GetWindowDisplayAffinity(hwnd, &mut current_affinity).is_err()
                        || current_affinity != WDA_EXCLUDEFROMCAPTURE.0
                    {
                        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
                    }
                }
            }
        }
    }

    /// Background Z-order keeper: re-asserts HWND_TOPMOST every 750ms without stealing focus,
    /// ensuring overlay/pill/bubble stay above Taskbar, VS Code, Chrome, and borderless apps.
    pub fn start_topmost_keeper(app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(750));
            loop {
                interval.tick().await;
                let overlay_ct = OVERLAY_CLICK_THROUGH.load(Ordering::SeqCst);
                for (label, click_through) in [("overlay", overlay_ct), ("pill", false), ("bubble", false)] {
                    if let Some(win) = app.get_webview_window(label) {
                        if win.is_visible().unwrap_or(false) {
                            Self::enforce_topmost_native(&win, click_through);
                        }
                    }
                }
            }
        });
    }
}
