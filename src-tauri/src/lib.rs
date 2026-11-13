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

pub fn run() {
    let config = AppConfig::load().unwrap_or_default();
    let hotkey_config = config.hotkeys.clone();

    let shortcut_builder = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            HotkeyManager::handle_shortcut_event(app, shortcut, event.state(), &hotkey_config);
        })
        .build();

    tauri::Builder::default()
        .plugin(shortcut_builder)
        .setup(|app| {
            let handle = app.handle().clone();
            let config = AppConfig::load().unwrap_or_default();

            // Initialize SQLite
            let db = Database::open(&config.db_path)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;

            let memory_repo = Arc::new(MemoryRepository::new(db.clone()));
            let agents_repo = Arc::new(AgentsRepository::new(db.clone()));

            // Initialize Audio Engine
            let mut audio_engine = AudioEngine::new(config.groq_api_key.clone());
            let _ = audio_engine.init_output();
            let audio_engine_arc = Arc::new(Mutex::new(audio_engine));

            // Initialize Prewarmer
            let prewarmer = ContextPrewarmer::new();
            prewarmer.start();

            // Initialize 60Hz OS Cursor Tracker for companion overlay
            let cursor_tracker = crate::screen::cursor::CursorTracker::new();
            cursor_tracker.start(handle.clone());

            // Initialize AI Router & Tools
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
            let toggle_dash = MenuItem::with_id(&handle, "toggle_dashboard", "Open Dashboard Window", true, None::<&str>)?;
            let toggle_item = MenuItem::with_id(&handle, "toggle_pill", "Show / Hide Pill", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(&handle, "quit", "Quit HeyClicky", true, None::<&str>)?;
            let tray_menu = Menu::with_items(&handle, &[&toggle_dash, &toggle_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "quit" => {
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
                })
                .build(&handle)?;

            // Setup Global Hotkeys
            let _ = HotkeyManager::setup_hotkeys(&handle, &config.hotkeys);

            // Ensure Dashboard Window is displayed on startup
            let _ = WindowManager::show(&handle, "dashboard");

            // Position Pill window top center and display
            let _ = WindowManager::position_pill_top_center(&handle);
            let _ = WindowManager::show(&handle, "pill");

            // Overlay window defaults to click-through and displayed
            let _ = WindowManager::set_ignore_cursor_events(&handle, "overlay", true);
            let _ = WindowManager::show(&handle, "overlay");

            // Store AppState
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_talk,
            commands::stop_talk,
            commands::start_dictation,
            commands::stop_dictation,
            commands::confirm_drive,
            commands::set_ignore_cursor_events,
            commands::get_agents,
            commands::create_agent,
            commands::get_cron_jobs,
            commands::add_cron_job,
            commands::get_memories,
            commands::save_memory,
            commands::get_app_config,
            commands::save_app_config,
            commands::get_config,
            commands::save_config,
            commands::toggle_talk,
            commands::toggle_dictation,
            commands::execute_prompt,
            commands::get_ollama_models,
            commands::check_ollama_status,
            commands::set_active_model,
            commands::open_dashboard,
            commands::toggle_dashboard,
        ])
        .run(tauri::generate_context!())
        .expect("error while running heyclicky application");
}
