use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use crate::error::Result;
use crate::screen::input::get_current_cursor_pos;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalkthroughStep {
    pub instruction: String,
    pub bbox: [i32; 4], // [x1, y1, x2, y2]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalkthroughSession {
    pub steps: Vec<WalkthroughStep>,
    pub current_index: usize,
    pub is_active: bool,
}

pub struct WalkthroughController {
    app_handle: AppHandle,
    session: Arc<Mutex<Option<WalkthroughSession>>>,
    is_running: Arc<AtomicBool>,
}

impl WalkthroughController {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            session: Arc::new(Mutex::new(None)),
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn start_walkthrough(&self, steps: Vec<WalkthroughStep>) -> Result<()> {
        if steps.is_empty() {
            return Ok(());
        }

        let max_steps = steps.into_iter().take(15).collect::<Vec<_>>();
        let total = max_steps.len();

        let session = WalkthroughSession {
            steps: max_steps,
            current_index: 0,
            is_active: true,
        };

        {
            let mut s = self.session.lock().await;
            *s = Some(session);
        }

        self.is_running.store(true, Ordering::SeqCst);

        // Emit first step
        self.emit_current_step().await;

        // Spawn click monitor loop
        let is_running = Arc::clone(&self.is_running);
        let session_arc = Arc::clone(&self.session);
        let app = self.app_handle.clone();

        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(50));
            while is_running.load(Ordering::Relaxed) {
                interval.tick().await;

                let mut s_guard = session_arc.lock().await;
                if let Some(ref mut sess) = *s_guard {
                    if sess.current_index >= total {
                        sess.is_active = false;
                        let _ = app.emit("walkthrough:complete", ());
                        break;
                    }

                    let step = &sess.steps[sess.current_index];
                    let [x1, y1, x2, y2] = step.bbox;
                    let (cx, cy) = get_current_cursor_pos();

                    // Check if cursor is inside target bbox
                    let inside = cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;

                    // On Windows, check if left mouse button is pressed inside bbox
                    #[cfg(windows)]
                    {
                        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
                        let lbutton = unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 };
                        if inside && lbutton {
                            sess.current_index += 1;
                            let new_idx = sess.current_index;
                            drop(s_guard);

                            let _ = app.emit("walkthrough:step_advanced", serde_json::json!({
                                "index": new_idx,
                                "total": total
                            }));

                            // Debounce click
                            tokio::time::sleep(Duration::from_millis(300)).await;
                            continue;
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = inside;
                    }
                } else {
                    break;
                }
            }
        });

        Ok(())
    }

    pub async fn stop_walkthrough(&self) {
        self.is_running.store(false, Ordering::SeqCst);
        let mut s = self.session.lock().await;
        *s = None;
        let _ = self.app_handle.emit("walkthrough:stopped", ());
    }

    async fn emit_current_step(&self) {
        let guard = self.session.lock().await;
        if let Some(ref sess) = *guard {
            if let Some(step) = sess.steps.get(sess.current_index) {
                let _ = self.app_handle.emit("walkthrough:step", serde_json::json!({
                    "index": sess.current_index + 1,
                    "total": sess.steps.len(),
                    "instruction": step.instruction,
                    "bbox": step.bbox,
                }));
            }
        }
    }
}
