use std::sync::Arc;
use tauri::{AppHandle, State};
use crate::ai::prompts::Prompts;
use crate::ai::router::TaskType;
use crate::ai::AgentRuntime;
use crate::config::AppConfig;
use crate::error::Result;
use crate::storage::agents_repo::{AgentModel, CronJobModel};
use crate::storage::memory::MemoryEntry;
use crate::ui::windows::WindowManager;
use crate::AppState;

#[tauri::command]
pub async fn start_talk(state: State<'_, AppState>) -> Result<()> {
    state.talk_controller.start_talk().await
}

#[tauri::command]
pub async fn stop_talk(state: State<'_, AppState>) -> Result<()> {
    state.talk_controller.stop_talk().await
}

#[tauri::command]
pub async fn start_dictation(state: State<'_, AppState>) -> Result<()> {
    state.dictation_controller.start_dictation().await
}

#[tauri::command]
pub async fn stop_dictation(state: State<'_, AppState>) -> Result<String> {
    let hotwords = state.memory_repo.get_dictionary_hotwords().unwrap_or_default();
    state.dictation_controller.stop_dictation(hotwords).await
}

#[tauri::command]
pub async fn confirm_drive(confirmed: bool, state: State<'_, AppState>) -> Result<()> {
    state.drive_controller.set_confirmed(confirmed);
    Ok(())
}

#[tauri::command]
pub async fn set_ignore_cursor_events(ignore: bool, app: AppHandle) -> Result<()> {
    WindowManager::set_ignore_cursor_events(&app, "overlay", ignore)
}

#[tauri::command]
pub async fn get_agents(state: State<'_, AppState>) -> Result<Vec<AgentModel>> {
    state.agents_repo.get_agents()
}

#[tauri::command]
pub async fn create_agent(
    name: String,
    role: String,
    system_prompt: Option<String>,
    workspace_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<AgentModel> {
    let cfg = state.config.read().await;
    let ws = workspace_path.unwrap_or_else(|| {
        cfg.agents_dir.join(&name).display().to_string()
    });
    let prompt = system_prompt.unwrap_or_else(|| Prompts::agent_routine_system_prompt(&name, &role));
    state.agents_repo.create_agent(&name, &role, &prompt, &ws)
}

#[tauri::command]
pub async fn get_cron_jobs(state: State<'_, AppState>) -> Result<Vec<CronJobModel>> {
    state.agents_repo.get_cron_jobs()
}

#[tauri::command]
pub async fn add_cron_job(
    agent_id: String,
    cron_expr: String,
    prompt: String,
    state: State<'_, AppState>,
) -> Result<CronJobModel> {
    let job = state.agents_repo.add_cron_job(&agent_id, &cron_expr, &prompt)?;
    state.scheduler_service.add_cron_job(&cron_expr, &agent_id, &prompt).await?;
    Ok(job)
}

#[tauri::command]
pub async fn get_memories(scope: Option<String>, state: State<'_, AppState>) -> Result<Vec<MemoryEntry>> {
    state.memory_repo.get_memories(scope.as_deref())
}

#[tauri::command]
pub async fn save_memory(
    scope: String,
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<MemoryEntry> {
    state.memory_repo.save_memory(&scope, &key, &value)
}

#[tauri::command]
pub async fn get_app_config(state: State<'_, AppState>) -> Result<AppConfig> {
    let cfg = state.config.read().await;
    Ok(cfg.clone())
}

#[tauri::command]
pub async fn save_app_config(new_config: AppConfig, state: State<'_, AppState>) -> Result<()> {
    new_config.save()?;
    let mut cfg = state.config.write().await;
    *cfg = new_config.clone();
    drop(cfg);

    let mut engine = state.audio_engine.lock().await;
    engine.set_groq_api_key(new_config.groq_api_key.clone());
    Ok(())
}

#[tauri::command]
pub async fn execute_prompt(
    prompt: String,
    agent_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    let system_prompt = if let Some(ref id) = agent_id {
        if let Ok(Some(agent)) = state.agents_repo.get_agent(id) {
            agent.system_prompt
        } else {
            Prompts::talk_mode_system_prompt().to_string()
        }
    } else {
        Prompts::talk_mode_system_prompt().to_string()
    };

    let tools_guard = state.tools.lock().await;
    let mut runtime = AgentRuntime::with_system_prompt(
        Arc::clone(&state.router),
        Arc::new(tools_guard.clone()),
        &system_prompt,
    );
    drop(tools_guard);

    let answer = runtime.execute_turn(&prompt, TaskType::FastTalk, None).await?;

    if let Some(ref id) = agent_id {
        let _ = state.agents_repo.save_message(id, "user", &prompt);
        let _ = state.agents_repo.save_message(id, "assistant", &answer);
    }

    Ok(answer)
}

#[tauri::command]
pub async fn get_ollama_models(state: State<'_, AppState>) -> Result<Vec<String>> {
    let cfg = state.config.read().await;
    let provider = crate::ai::providers::local_llamacpp::LocalLlamaProvider::new(cfg.local_llama_url.clone());
    provider.list_models().await
}

#[tauri::command]
pub async fn check_ollama_status(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let cfg = state.config.read().await;
    let provider = crate::ai::providers::local_llamacpp::LocalLlamaProvider::new(cfg.local_llama_url.clone());
    let running = provider.check_health().await;
    let models = if running {
        provider.list_models().await.unwrap_or_default()
    } else {
        vec![]
    };
    let current_model = cfg.local_model_name.clone().unwrap_or_else(|| "bonsai-2:9b".to_string());
    Ok(serde_json::json!({
        "running": running,
        "url": cfg.local_llama_url,
        "models": models,
        "current_model": current_model,
    }))
}

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<AppConfig> {
    get_app_config(state).await
}

#[tauri::command]
pub async fn save_config(config: AppConfig, state: State<'_, AppState>) -> Result<()> {
    save_app_config(config, state).await
}

#[tauri::command]
pub async fn toggle_talk(active: bool, state: State<'_, AppState>) -> Result<()> {
    if active {
        state.talk_controller.start_talk().await
    } else {
        state.talk_controller.stop_talk().await
    }
}

#[tauri::command]
pub async fn toggle_dictation(active: bool, state: State<'_, AppState>) -> Result<String> {
    if active {
        state.dictation_controller.start_dictation().await?;
        Ok(String::new())
    } else {
        let hotwords = state.memory_repo.get_dictionary_hotwords().unwrap_or_default();
        state.dictation_controller.stop_dictation(hotwords).await
    }
}

#[tauri::command]
pub async fn set_active_model(model_name: String, state: State<'_, AppState>) -> Result<()> {
    let mut cfg = state.config.write().await;
    cfg.local_model_name = Some(model_name);
    let _ = cfg.save();
    Ok(())
}

#[tauri::command]
pub async fn open_dashboard(app: AppHandle) -> Result<()> {
    WindowManager::show(&app, "dashboard")
}

#[tauri::command]
pub async fn toggle_dashboard(app: AppHandle) -> Result<bool> {
    WindowManager::toggle(&app, "dashboard")
}
