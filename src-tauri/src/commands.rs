use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

use crate::ai::local_runner::{HardwareProfileDto, LocalModelSpec};
use crate::ai::router::TaskType;
use crate::ai::AgentRuntime;
use crate::config::{AppConfig, McpServerDto};
use crate::error::{AppError, Result};
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
pub async fn toggle_talk(active: bool, state: State<'_, AppState>) -> Result<()> {
    if active {
        state.talk_controller.start_talk().await
    } else {
        state.talk_controller.stop_talk().await
    }
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
pub async fn confirm_drive(confirmed: bool, state: State<'_, AppState>) -> Result<()> {
    state.drive_controller.set_confirmed(confirmed);
    Ok(())
}

#[tauri::command]
pub async fn stop_drive(state: State<'_, AppState>) -> Result<()> {
    state.drive_controller.stop_drive();
    Ok(())
}

#[tauri::command]
pub async fn set_ignore_cursor_events(ignore: bool, app: AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window("overlay") {
        win.set_ignore_cursor_events(ignore)
            .map_err(|e| AppError::Config(e.to_string()))?;
    }
    Ok(())
}

// ── Agents CRUD ──

#[tauri::command]
pub async fn get_agents(state: State<'_, AppState>) -> Result<Vec<AgentModel>> {
    state.agents_repo.list_agents()
}

#[tauri::command]
pub async fn list_agents(state: State<'_, AppState>) -> Result<Vec<AgentModel>> {
    state.agents_repo.list_agents()
}

#[tauri::command]
pub async fn create_agent(
    name: String,
    role: String,
    #[allow(non_snake_case)] systemPrompt: Option<String>,
    system_prompt: Option<String>,
    #[allow(non_snake_case)] workspacePath: Option<String>,
    workspace_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<AgentModel> {
    let prompt = system_prompt.or(systemPrompt).unwrap_or_else(|| "You are a helpful desktop AI agent.".to_string());
    let path = workspace_path.or(workspacePath).unwrap_or_else(|| "D:\\cliky".to_string());
    state.agents_repo.create_agent(&name, &role, &prompt, &path)
}

#[tauri::command]
pub async fn save_agent(agent: AgentModel, state: State<'_, AppState>) -> Result<AgentModel> {
    state.agents_repo.upsert_agent(&agent)
}

#[tauri::command]
pub async fn delete_agent(
    #[allow(non_snake_case)] agentId: Option<String>,
    id: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    let target = id.or(agentId).unwrap_or_default();
    state.agents_repo.delete_agent(&target)
}

#[tauri::command]
pub async fn toggle_agent(
    #[allow(non_snake_case)] agentId: Option<String>,
    id: Option<String>,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let target = id.or(agentId).unwrap_or_default();
    state.agents_repo.set_agent_enabled(&target, enabled)
}

// ── Cron Jobs CRUD ──

#[tauri::command]
pub async fn get_cron_jobs(state: State<'_, AppState>) -> Result<Vec<CronJobModel>> {
    state.agents_repo.list_cron_jobs()
}

#[tauri::command]
pub async fn add_cron_job(
    #[allow(non_snake_case)] agentId: Option<String>,
    agent_id: Option<String>,
    #[allow(non_snake_case)] cronExpr: Option<String>,
    cron_expr: Option<String>,
    prompt: String,
    state: State<'_, AppState>,
) -> Result<CronJobModel> {
    let a_id = agent_id.or(agentId).unwrap_or_else(|| "default".to_string());
    let expr = cron_expr.or(cronExpr).unwrap_or_else(|| "0 9 * * *".to_string());
    state.agents_repo.create_cron_job(&a_id, &expr, &prompt)
}

#[tauri::command]
pub async fn save_cron_job(job: CronJobModel, state: State<'_, AppState>) -> Result<CronJobModel> {
    state.agents_repo.upsert_cron_job(&job)
}

#[tauri::command]
pub async fn delete_cron_job(
    #[allow(non_snake_case)] jobId: Option<String>,
    id: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    let target = id.or(jobId).unwrap_or_default();
    state.agents_repo.delete_cron_job(&target)
}

#[tauri::command]
pub async fn toggle_cron_job(
    #[allow(non_snake_case)] jobId: Option<String>,
    id: Option<String>,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let target = id.or(jobId).unwrap_or_default();
    state.agents_repo.set_cron_job_enabled(&target, enabled)
}

// ── Memory CRUD ──

#[tauri::command]
pub async fn get_memories(
    scope: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<MemoryEntry>> {
    state.memory_repo.list_memories(scope.as_deref())
}

#[tauri::command]
pub async fn save_memory(
    scope: String,
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<MemoryEntry> {
    state.memory_repo.upsert_memory(&scope, &key, &value)
}

#[tauri::command]
pub async fn clear_memory(state: State<'_, AppState>) -> Result<()> {
    state.memory_repo.clear_all()
}

// ── Config & Hotkeys ──

#[tauri::command]
pub async fn get_app_config(state: State<'_, AppState>) -> Result<AppConfig> {
    let cfg = state.config.read().await;
    Ok(cfg.clone())
}

#[tauri::command]
pub async fn save_app_config(new_config: AppConfig, state: State<'_, AppState>) -> Result<()> {
    let mut cfg = state.config.write().await;
    *cfg = new_config;
    cfg.save()
}

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<AppConfig> {
    let cfg = state.config.read().await;
    Ok(cfg.clone())
}

#[tauri::command]
pub async fn save_config(config: AppConfig, state: State<'_, AppState>) -> Result<()> {
    let mut cfg = state.config.write().await;
    *cfg = config;
    cfg.save()
}

#[tauri::command]
pub async fn register_hotkey(
    hotkey: String,
    action: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let mut cfg = state.config.write().await;
    cfg.set_hotkey(&action, &hotkey);
    cfg.save()
}

#[tauri::command]
pub async fn update_hotkeys(
    hotkeys: HashMap<String, String>,
    state: State<'_, AppState>,
) -> Result<()> {
    let mut cfg = state.config.write().await;
    for (action, key) in hotkeys {
        cfg.set_hotkey(&action, &key);
    }
    cfg.save()
}

// ── MCP Servers ──

#[tauri::command]
pub async fn get_mcp_servers(state: State<'_, AppState>) -> Result<Vec<McpServerDto>> {
    let cfg = state.config.read().await;
    Ok(cfg.list_mcp_servers())
}

#[tauri::command]
pub async fn save_mcp_server(server: McpServerDto, state: State<'_, AppState>) -> Result<()> {
    let mut cfg = state.config.write().await;
    cfg.upsert_mcp_server(server);
    cfg.save()
}

#[tauri::command]
pub async fn delete_mcp_server(id: String, state: State<'_, AppState>) -> Result<()> {
    let mut cfg = state.config.write().await;
    cfg.remove_mcp_server(&id);
    cfg.save()
}

// ── Prompt Execution & Ollama / Local Models ──

#[tauri::command]
pub async fn execute_prompt(
    prompt: String,
    #[allow(non_snake_case)] agentId: Option<String>,
    agent_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    let resolved_agent_id = agent_id.or(agentId);
    let system_prompt = if let Some(id) = resolved_agent_id {
        state
            .agents_repo
            .list_agents()?
            .into_iter()
            .find(|a| a.id == id)
            .map(|a| a.system_prompt)
            .unwrap_or_else(|| "You are Sticky, a helpful desktop AI assistant.".to_string())
    } else {
        "You are Sticky, a helpful desktop AI assistant.".to_string()
    };

    let tool_registry = {
        let guard = state.tools.lock().await;
        Arc::new(guard.clone())
    };

    let mut runtime = AgentRuntime::with_system_prompt(
        state.router.clone(),
        tool_registry,
        &system_prompt,
    );
    runtime.execute_turn(&prompt, TaskType::FastTalk, None).await
}

#[tauri::command]
pub async fn execute_agent_task(
    #[allow(non_snake_case)] agentId: Option<String>,
    agent_id: Option<String>,
    input: Option<String>,
    prompt: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    let p = input.or(prompt).unwrap_or_default();
    execute_prompt(p, agentId, agent_id, state).await
}

#[tauri::command]
pub async fn get_ollama_models(_state: State<'_, AppState>) -> Result<Vec<String>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| AppError::Network(e.to_string()))?;

    let resp = match client.get("http://127.0.0.1:11434/api/tags").send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(vec![]),
    };

    let json: serde_json::Value = resp.json().await.unwrap_or_default();
    let models = json["models"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["name"].as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

#[tauri::command]
pub async fn check_ollama_status(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let models = get_ollama_models(state).await.unwrap_or_default();
    Ok(serde_json::json!({
        "running": !models.is_empty(),
        "models": models,
    }))
}

#[tauri::command]
pub async fn set_active_model(
    #[allow(non_snake_case)] modelName: Option<String>,
    model_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    let chosen = model_name.or(modelName).unwrap_or_default();
    if chosen.is_empty() {
        return Err(AppError::Config("Model name cannot be empty".to_string()));
    }
    let mut cfg = state.config.write().await;
    cfg.set_active_model(&chosen);
    cfg.save()
}

// ── Window Management Helpers ──

#[tauri::command]
pub async fn open_dashboard(app: AppHandle) -> Result<()> {
    if WindowManager::show(&app, "dashboard").is_err() {
        let _ = WindowManager::show(&app, "main");
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_dashboard(app: AppHandle) -> Result<bool> {
    match WindowManager::toggle(&app, "dashboard") {
        Ok(res) => Ok(res),
        Err(_) => WindowManager::toggle(&app, "main"),
    }
}

#[tauri::command]
pub async fn hide_bubble(app: AppHandle) -> Result<()> {
    WindowManager::hide(&app, "bubble")
}

#[tauri::command]
pub async fn hide_quick_input(app: AppHandle) -> Result<()> {
    WindowManager::hide(&app, "quick_input")
}

#[tauri::command]
pub async fn close_quick_input(app: AppHandle) -> Result<()> {
    WindowManager::hide(&app, "quick_input")
}

// ── Local Hardware & Model Runner Commands ──

#[tauri::command]
pub async fn get_hardware_profile() -> Result<HardwareProfileDto> {
    Ok(crate::ai::local_runner::detect_hardware_profile())
}

#[tauri::command]
pub async fn get_local_models() -> Result<Vec<LocalModelSpec>> {
    Ok(crate::ai::local_runner::get_available_models())
}

#[tauri::command]
pub async fn download_local_model(
    #[allow(non_snake_case)] modelName: Option<String>,
    model_id: Option<String>,
    app_handle: AppHandle,
) -> Result<String> {
    let target = model_id
        .or(modelName)
        .ok_or_else(|| AppError::Config("Missing model identifier".to_string()))?;

    crate::ai::local_runner::download_model_weights(&target, &app_handle).await
}

// ── Audio Device Routing & Speaker Test ──

#[tauri::command]
pub async fn list_audio_devices(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let inputs = crate::audio::io::list_input_devices();
    let outputs = crate::audio::io::list_output_devices();
    let cfg = state.config.read().await;
    Ok(serde_json::json!({
        "inputs": inputs,
        "outputs": outputs,
        "selected_input": cfg.input_device_name,
        "selected_output": cfg.output_device_name,
    }))
}

#[tauri::command]
pub async fn set_audio_devices(
    input_device: Option<String>,
    output_device: Option<String>,
    #[allow(non_snake_case)] inputDevice: Option<String>,
    #[allow(non_snake_case)] outputDevice: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    let normalize = |raw: Option<String>| -> Option<String> {
        raw.and_then(|s| {
            let trimmed = s.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
    };

    let selected_input = normalize(input_device.or(inputDevice));
    let selected_output = normalize(output_device.or(outputDevice));

    {
        let mut cfg = state.config.write().await;
        cfg.input_device_name = selected_input.clone();
        cfg.output_device_name = selected_output.clone();
        cfg.save()?;
    }

    {
        let mut engine = state.audio_engine.lock().await;
        engine.set_input_device(selected_input);
        engine.set_output_device(selected_output).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn test_tts_output(
    text: Option<String>,
    state: State<'_, AppState>,
) -> Result<u64> {
    let phrase = text
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Audio output and realtime voice are synced and ready.".to_string());

    let started = std::time::Instant::now();
    {
        let mut engine = state.audio_engine.lock().await;
        engine.test_tts_direct(&phrase).await?;
    }
    Ok(started.elapsed().as_millis() as u64)
}
