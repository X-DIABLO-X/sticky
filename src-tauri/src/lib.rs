pub mod ai;
pub mod audio;
pub mod commands;
pub mod config;
pub mod error;
pub mod features;
pub mod screen;
pub mod storage;
pub mod tools;
pub mod ui;

use std::sync::Arc;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tokio::sync::{Mutex, RwLock};

use crate::ai::router::ModelRouter;
use crate::audio::AudioEngine;
use crate::config::AppConfig;
use crate::features::dictation::DictationController;
use crate::features::drive::DriveController;
use crate::features::scheduler::SchedulerService;
use crate::features::talk::TalkController;
use crate::features::walkthrough::WalkthroughController;
use crate::screen::ContextPrewarmer;
use crate::storage::agents_repo::AgentsRepository;
use crate::storage::memory::MemoryRepository;
use crate::storage::Database;
use crate::tools::browser_tools::register_browser_tools;
use crate::tools::mcp_client::McpClient;
use crate::tools::os_tools::register_os_tools;
use crate::tools::overlay_tools::register_overlay_tools;
use crate::tools::ToolRegistry;
use crate::ui::hotkeys::HotkeyManager;
use crate::ui::windows::WindowManager;

pub struct AppState {
    pub config: Arc<RwLock<AppConfig>>,
    pub db: Database,
    pub memory_repo: Arc<MemoryRepository>,
    pub agents_repo: Arc<AgentsRepository>,
    pub audio_engine: Arc<Mutex<AudioEngine>>,
    pub prewarmer: ContextPrewarmer,
    pub router: Arc<ModelRouter>,
    pub tools: Arc<Mutex<ToolRegistry>>,
    pub talk_controller: Arc<TalkController>,
    pub dictation_controller: Arc<DictationController>,
    pub drive_controller: Arc<DriveController>,
    pub walkthrough_controller: Arc<WalkthroughController>,
    pub scheduler_service: Arc<SchedulerService>,
}

static IS_QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn run() {
    // ── Single-instance guard ──────────────────────────────────────────────
    // WebView2 locks its user-data directory; if another HeyClicky is already
    // running, creating a second WebView will panic with HRESULT 0x800700AA
    // ("The requested resource is in use."). We detect this early via a named
    // mutex and exit gracefully instead of crashing.
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Threading::CreateMutexW;
        use windows::core::w;

        let _mutex: HANDLE = unsafe {
            CreateMutexW(None, false, w!("Global\\HeyClicky_SingleInstance_Guard"))
                .unwrap_or_default()
        };

        if _mutex.is_invalid() || unsafe { windows::Win32::Foundation::GetLastError() } == windows::Win32::Foundation::ERROR_ALREADY_EXISTS {
            let log_fn = || {
                let p = dirs::home_dir().unwrap_or_default().join(".heyclicky").join("app.log");
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                    use std::io::Write;
                    let _ = writeln!(f, "[{}] Another HeyClicky instance is already running. Exiting gracefully.", chrono::Local::now());
                }
            };
            log_fn();
            eprintln!("[HeyClicky] Another instance is already running. Exiting.");
            return;
        }

        // Keep the mutex handle alive for the process lifetime by storing it in a
        // static. Windows auto-releases the named mutex when the process exits.
        static INSTANCE_MUTEX: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
        INSTANCE_MUTEX.get_or_init(|| _mutex.0 as usize);
    }

    if let Some(h) = dirs::home_dir() {
        let dir = h.join(".heyclicky");
        let _ = std::fs::create_dir_all(&dir);
        let log_path = dir.join("app.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            use std::io::Write;
            let _ = writeln!(f, "\n[{}] Starting HeyClicky...", chrono::Local::now());
        }
    }

    std::panic::set_hook(Box::new(|info| {
        let crash_path = dirs::home_dir().unwrap_or_default().join(".heyclicky").join("crash.log");
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic".to_string()
        };
        let location = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_default();
        let msg = format!("[{}] CRASH PANIC: {}\nLocation: {}\n", chrono::Local::now(), payload, location);
        let _ = std::fs::write(&crash_path, &msg);
        eprintln!("{}", msg);
    }));

    let config = AppConfig::load().unwrap_or_default();
    let hotkey_config = config.hotkeys.clone();

    let shortcut_builder = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            HotkeyManager::handle_shortcut_event(app, shortcut, event.state(), &hotkey_config);
        })
        .build();

    let build_result = tauri::Builder::default()
        .plugin(shortcut_builder)
        .setup(|app| {
            let log = |m: &str| {
                let p = dirs::home_dir().unwrap_or_default().join(".heyclicky").join("app.log");
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                    use std::io::Write;
                    let _ = writeln!(f, "[{}] {}", chrono::Local::now(), m);
                }
            };

            log("Setup: loading config");
            let handle = app.handle().clone();
            let config = AppConfig::load().unwrap_or_default();

            // Initialize SQLite
            log("Setup: opening SQLite database");
            let db = Database::open(&config.db_path)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;

            let memory_repo = Arc::new(MemoryRepository::new(db.clone()));
            let agents_repo = Arc::new(AgentsRepository::new(db.clone()));

            // Initialize Audio Engine
            log("Setup: initializing audio engine");
            let mut audio_engine = AudioEngine::new(config.groq_api_key.clone());
            // init_output spawns a dedicated thread for rodio, safe to block_on here during setup
            let _ = tauri::async_runtime::block_on(audio_engine.init_output());
            let audio_engine_arc = Arc::new(Mutex::new(audio_engine));

            // Initialize Prewarmer
            log("Setup: starting prewarmer");
            let prewarmer = ContextPrewarmer::new();
            prewarmer.start();

            // Initialize 60Hz OS Cursor Tracker for companion overlay
            log("Setup: starting cursor tracker");
            let cursor_tracker = crate::screen::cursor::CursorTracker::new();
            cursor_tracker.start(handle.clone());

            // Initialize AI Router & Tools
            log("Setup: initializing router and tools");
            let router = Arc::new(ModelRouter::new(config.clone()));
            let mut tool_registry = ToolRegistry::new();
            register_os_tools(&mut tool_registry);
            register_overlay_tools(&mut tool_registry, handle.clone());
            register_browser_tools(&mut tool_registry);

            let mcp_client = McpClient::new();
            let registry_arc = Arc::new(Mutex::new(tool_registry));
            let reg_clone = Arc::clone(&registry_arc);
            tauri::async_runtime::spawn(async move {
                let mut guard = reg_clone.lock().await;
                let _ = mcp_client.load_and_register_tools(&mut guard).await;
            });

            // Initialize Feature Controllers
            log("Setup: initializing feature controllers");
            let talk_controller = Arc::new(TalkController::new(
                handle.clone(),
                Arc::clone(&audio_engine_arc),
                prewarmer.clone(),
                Arc::clone(&router),
            ));

            let dictation_controller = Arc::new(DictationController::new(
                handle.clone(),
                Arc::clone(&audio_engine_arc),
                Arc::clone(&router),
            ));

            let drive_controller = Arc::new(DriveController::new(handle.clone()));
            let walkthrough_controller = Arc::new(WalkthroughController::new(handle.clone()));

            let scheduler_service = Arc::new(SchedulerService::new(handle.clone()));
            let sched_clone = Arc::clone(&scheduler_service);
            tauri::async_runtime::spawn(async move {
                let _ = sched_clone.start().await;
            });

            // Set up System Tray
            log("Setup: setting up system tray");
            let toggle_dash = MenuItem::with_id(&handle, "toggle_dashboard", "Open Dashboard Window", true, None::<&str>)?;
            let toggle_item = MenuItem::with_id(&handle, "toggle_pill", "Show / Hide Pill", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(&handle, "quit", "Quit HeyClicky", true, None::<&str>)?;
            let tray_menu = Menu::with_items(&handle, &[&toggle_dash, &toggle_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "quit" => {
                            IS_QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
                            app.exit(0);
                        }
                        "toggle_dashboard" => {
                            let _ = WindowManager::toggle(app, "dashboard");
                        }
                        "toggle_pill" => {
                            let _ = WindowManager::toggle(app, "pill");
                        }
                        _ => {}
                    }
                });

            if let Some(icon) = handle.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }

            let _ = tray_builder.build(&handle);

            // Setup Global Hotkeys
            log("Setup: configuring hotkeys");
            let _ = HotkeyManager::setup_hotkeys(&handle, &config.hotkeys);

            // Overlay window defaults to click-through and displayed
            log("Setup: displaying overlay window");
            let _ = WindowManager::set_ignore_cursor_events(&handle, "overlay", true);
            let _ = WindowManager::show(&handle, "overlay");

            // Position Pill window top center and display
            log("Setup: positioning and displaying pill window");
            let _ = WindowManager::position_pill_top_center(&handle);
            let _ = WindowManager::show(&handle, "pill");

            // Ensure Dashboard Window is displayed on startup front and center
            log("Setup: displaying dashboard window");
            let _ = WindowManager::show(&handle, "dashboard");

            // Store AppState
            log("Setup: registering AppState");
            app.manage(AppState {
                config: Arc::new(RwLock::new(config)),
                db,
                memory_repo,
                agents_repo,
                audio_engine: audio_engine_arc,
                prewarmer,
                router,
                tools: registry_arc,
                talk_controller,
                dictation_controller,
                drive_controller,
                walkthrough_controller,
                scheduler_service,
            });

            log("Setup: complete!");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_talk,
            commands::stop_talk,
            commands::toggle_talk,
            commands::start_dictation,
            commands::stop_dictation,
            commands::toggle_dictation,
            commands::confirm_drive,
            commands::stop_drive,
            commands::set_ignore_cursor_events,
            commands::get_agents,
            commands::list_agents,
            commands::create_agent,
            commands::save_agent,
            commands::delete_agent,
            commands::toggle_agent,
            commands::execute_agent_task,
            commands::get_cron_jobs,
            commands::add_cron_job,
            commands::save_cron_job,
            commands::delete_cron_job,
            commands::toggle_cron_job,
            commands::get_memories,
            commands::save_memory,
            commands::clear_memory,
            commands::get_app_config,
            commands::save_app_config,
            commands::get_config,
            commands::save_config,
            commands::register_hotkey,
            commands::update_hotkeys,
            commands::get_mcp_servers,
            commands::save_mcp_server,
            commands::delete_mcp_server,
            commands::execute_prompt,
            commands::get_ollama_models,
            commands::check_ollama_status,
            commands::set_active_model,
            commands::open_dashboard,
            commands::toggle_dashboard,
            commands::hide_bubble,
            commands::hide_quick_input,
            commands::close_quick_input,
            commands::get_hardware_profile,
            commands::get_local_models,
            commands::download_local_model,
        ])
        .build(tauri::generate_context!());

    match build_result {
        Ok(app) => {
            app.run(|app_handle, event| {
                match event {
                    tauri::RunEvent::ExitRequested { api, .. } => {
                        if IS_QUITTING.load(std::sync::atomic::Ordering::SeqCst) {
                            let p = dirs::home_dir().unwrap_or_default().join(".heyclicky").join("app.log");
                            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                                use std::io::Write;
                                let _ = writeln!(f, "[{}] Quit confirmed. Releasing resources and shutting down.", chrono::Local::now());
                            }
                        } else {
                            let p = dirs::home_dir().unwrap_or_default().join(".heyclicky").join("app.log");
                            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                                use std::io::Write;
                                let _ = writeln!(f, "[{}] ExitRequested event received! Preventing exit to keep background pill & overlay running.", chrono::Local::now());
                            }
                            api.prevent_exit();
                        }
                    }
                    tauri::RunEvent::WindowEvent { label, event, .. } => {
                        match event {
                            tauri::WindowEvent::CloseRequested { api, .. } => {
                                let p = dirs::home_dir().unwrap_or_default().join(".heyclicky").join("app.log");
                                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                                    use std::io::Write;
                                    let _ = writeln!(f, "[{}] CloseRequested for '{}' - hiding window instead of destroying", chrono::Local::now(), label);
                                }
                                api.prevent_close();
                                if let Some(win) = app_handle.get_webview_window(&label) {
                                    let _ = win.hide();
                                }
                            }
                            tauri::WindowEvent::Destroyed => {
                                let p = dirs::home_dir().unwrap_or_default().join(".heyclicky").join("app.log");
                                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                                    use std::io::Write;
                                    let _ = writeln!(f, "[{}] Window '{}' was destroyed!", chrono::Local::now(), label);
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            });
        }
        Err(e) => {
            let crash_msg = format!("[{}] FATAL: Failed to build Tauri application: {}\n", chrono::Local::now(), e);
            let crash_path = dirs::home_dir().unwrap_or_default().join(".heyclicky").join("crash.log");
            let _ = std::fs::write(&crash_path, &crash_msg);
            let log_path = dirs::home_dir().unwrap_or_default().join(".heyclicky").join("app.log");
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
                use std::io::Write;
                let _ = write!(f, "{}", crash_msg);
            }
            eprintln!("{}", crash_msg);
        }
    }
}
