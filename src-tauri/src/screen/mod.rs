pub mod a11y;
pub mod capture;
pub mod cursor;
pub mod input;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use crate::screen::a11y::{get_focused_window_tree, A11yTree};
use crate::screen::capture::{CapturedScreen, ScreenCaptureService};

#[derive(Clone)]
pub struct ContextPrewarmer {
    cached_a11y: Arc<RwLock<Option<A11yTree>>>,
    cached_screenshot: Arc<RwLock<Option<CapturedScreen>>>,
    last_window_title: Arc<RwLock<String>>,
    is_running: Arc<AtomicBool>,
}

impl ContextPrewarmer {
    pub fn new() -> Self {
        Self {
            cached_a11y: Arc::new(RwLock::new(None)),
            cached_screenshot: Arc::new(RwLock::new(None)),
            last_window_title: Arc::new(RwLock::new(String::new())),
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start(&self) {
        if self.is_running.swap(true, Ordering::SeqCst) {
            return;
        }

        let is_running = Arc::clone(&self.is_running);
        let cached_a11y = Arc::clone(&self.cached_a11y);
        let cached_screenshot = Arc::clone(&self.cached_screenshot);
        let last_title = Arc::clone(&last_window_title_clone(&self.last_window_title));

        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(500));
            while is_running.load(Ordering::Relaxed) {
                interval.tick().await;

                // Query active window A11y tree (depth 4 for fast prewarm)
                if let Ok(tree) = tauri::async_runtime::spawn_blocking(|| get_focused_window_tree(4)).await.unwrap_or(Err(crate::error::AppError::A11y("timeout".into()))) {
                    let mut prev = last_title.write().await;
                    if *prev != tree.window_title {
                        *prev = tree.window_title.clone();
                        drop(prev);

                        // Window focus changed: prewarm a11y and screen capture
                        {
                            let mut a11y_guard = cached_a11y.write().await;
                            *a11y_guard = Some(tree);
                        }

                        if let Ok(screen) = tauri::async_runtime::spawn_blocking(|| ScreenCaptureService::capture(0, None, Some(1280))).await.unwrap_or(Err(crate::error::AppError::Screen("timeout".into()))) {
                            let mut screen_guard = cached_screenshot.write().await;
                            *screen_guard = Some(screen);
                        }
                    }
                }
            }
        });
    }

    pub fn stop(&self) {
        self.is_running.store(false, Ordering::Relaxed);
    }

    pub async fn get_cached_context(&self) -> (Option<A11yTree>, Option<CapturedScreen>) {
        let a11y = self.cached_a11y.read().await.clone();
        let screen = self.cached_screenshot.read().await.clone();
        (a11y, screen)
    }

    pub async fn update_now(&self) {
        if let Ok(tree) = tauri::async_runtime::spawn_blocking(|| get_focused_window_tree(6)).await.unwrap_or(Err(crate::error::AppError::A11y("err".into()))) {
            let mut a11y_guard = self.cached_a11y.write().await;
            *a11y_guard = Some(tree);
        }
        if let Ok(screen) = tauri::async_runtime::spawn_blocking(|| ScreenCaptureService::capture(0, None, Some(1280))).await.unwrap_or(Err(crate::error::AppError::Screen("err".into()))) {
            let mut screen_guard = self.cached_screenshot.write().await;
            *screen_guard = Some(screen);
        }
    }
}

fn last_window_title_clone(arc: &Arc<RwLock<String>>) -> Arc<RwLock<String>> {
    Arc::clone(arc)
}
