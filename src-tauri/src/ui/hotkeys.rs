use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use crate::config::HotkeyConfig;
use crate::error::Result;
use crate::ui::windows::WindowManager;
use crate::AppState;

static TALK_PRESS_TIMESTAMP: AtomicI64 = AtomicI64::new(0);

pub struct HotkeyManager;

impl HotkeyManager {
    pub fn setup_hotkeys(app: &AppHandle, config: &HotkeyConfig) -> Result<()> {
        let global_shortcut = app.global_shortcut();

        // Register Pill hotkey
        if let Ok(shortcut) = config.pill.parse::<Shortcut>() {
            let res = global_shortcut.register(shortcut);
            eprintln!("[Hotkeys] Pill hotkey ('{}') registration: {:?}", config.pill, res.is_ok());
        }

        // Register Quick Input hotkey
        if let Ok(shortcut) = config.quick_input.parse::<Shortcut>() {
            let res = global_shortcut.register(shortcut);
            eprintln!("[Hotkeys] QuickInput hotkey ('{}') registration: {:?}", config.quick_input, res.is_ok());
        }

        // Register Talk hotkey (try configured string e.g. "Ctrl+Space")
        if let Ok(shortcut) = config.talk.parse::<Shortcut>() {
            let res = global_shortcut.register(shortcut);
            eprintln!("[Hotkeys] Primary Talk hotkey ('{}') registration: {:?}", config.talk, res.is_ok());
        }

        // Register secondary fallback for Talk: "Ctrl+Shift+Space"
        if let Ok(alt_talk) = "Ctrl+Shift+Space".parse::<Shortcut>() {
            let res = global_shortcut.register(alt_talk);
            eprintln!("[Hotkeys] Secondary Talk hotkey ('Ctrl+Shift+Space') registration: {:?}", res.is_ok());
        }

        // Register Dictation hotkey
        if let Ok(shortcut) = config.dictation.parse::<Shortcut>() {
            let res = global_shortcut.register(shortcut);
            eprintln!("[Hotkeys] Dictation hotkey ('{}') registration: {:?}", config.dictation, res.is_ok());
        }

        Ok(())
    }

    pub fn handle_shortcut_event(
        app: &AppHandle,
        shortcut: &Shortcut,
        state: ShortcutState,
        config: &HotkeyConfig,
    ) {
        let pill_sc = config.pill.parse::<Shortcut>().ok();
        let quick_sc = config.quick_input.parse::<Shortcut>().ok();
        let talk_sc = config.talk.parse::<Shortcut>().ok();
        let alt_talk_sc = "Ctrl+Shift+Space".parse::<Shortcut>().ok();
        let dict_sc = config.dictation.parse::<Shortcut>().ok();

        if pill_sc.as_ref() == Some(shortcut) {
            if state == ShortcutState::Pressed {
                let _ = WindowManager::toggle(app, "pill");
            }
        } else if quick_sc.as_ref() == Some(shortcut) {
            if state == ShortcutState::Pressed {
                let _ = WindowManager::toggle(app, "quick_input");
            }
        } else if talk_sc.as_ref() == Some(shortcut) || alt_talk_sc.as_ref() == Some(shortcut) {
            if state == ShortcutState::Pressed {
                let now = chrono::Utc::now().timestamp_millis();
                TALK_PRESS_TIMESTAMP.store(now, Ordering::SeqCst);

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
            } else if state == ShortcutState::Released {
                let now = chrono::Utc::now().timestamp_millis();
                let pressed_at = TALK_PRESS_TIMESTAMP.load(Ordering::SeqCst);
                let duration_ms = now - pressed_at;

                // Push-to-Talk behavior: If held down for > 450ms, release automatically submits
                if duration_ms > 450 {
                    let _ = tauri::Emitter::emit(app, "hotkey:talk_up", ());
                    if let Some(app_state) = app.try_state::<AppState>() {
                        let talk_ctrl = Arc::clone(&app_state.talk_controller);
                        tauri::async_runtime::spawn(async move {
                            let current = talk_ctrl.get_state().await;
                            if current == crate::features::talk::TalkState::Listening {
                                let _ = talk_ctrl.stop_talk().await;
                            }
                        });
                    }
                }
            }
        } else if dict_sc.as_ref() == Some(shortcut) {
            if state == ShortcutState::Pressed {
                let _ = WindowManager::show(app, "bubble");
                let _ = WindowManager::position_bubble_at_cursor(app);
                let _ = tauri::Emitter::emit(app, "hotkey:dictation_down", ());
                if let Some(app_state) = app.try_state::<AppState>() {
                    let dict_ctrl = Arc::clone(&app_state.dictation_controller);
                    tauri::async_runtime::spawn(async move {
                        let _ = dict_ctrl.start_dictation().await;
                    });
                }
            } else if state == ShortcutState::Released {
                let _ = tauri::Emitter::emit(app, "hotkey:dictation_up", ());
                if let Some(app_state) = app.try_state::<AppState>() {
                    let dict_ctrl = Arc::clone(&app_state.dictation_controller);
                    let memory_repo = Arc::clone(&app_state.memory_repo);
                    tauri::async_runtime::spawn(async move {
                        let hotwords = memory_repo.get_dictionary_hotwords().unwrap_or_default();
                        let _ = dict_ctrl.stop_dictation(hotwords).await;
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shortcut_formatting() {
        let s = "Ctrl+Space".parse::<Shortcut>().unwrap();
        let config_talk = "Ctrl+Space".parse::<Shortcut>().unwrap();
        assert_eq!(s, config_talk);

        let alt_talk = "Ctrl+Shift+Space".parse::<Shortcut>().unwrap();
        assert_ne!(s, alt_talk);

        let pill = "Ctrl+Alt+A".parse::<Shortcut>().unwrap();
        let config_pill = "Ctrl+Alt+A".parse::<Shortcut>().unwrap();
        assert_eq!(pill, config_pill);

        let dict = "Alt+Shift+D".parse::<Shortcut>().unwrap();
        let config_dict = "Alt+Shift+D".parse::<Shortcut>().unwrap();
        assert_eq!(dict, config_dict);
    }
}
