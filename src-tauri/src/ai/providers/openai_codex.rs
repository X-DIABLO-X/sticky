use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{channel, Receiver};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::ai::providers::{
    ChatChunk, ChatMessage, ChatRole, LlmProvider, ToolCall, ToolDefinition,
};
use crate::error::{AppError, Result};

/// Default ultra-cheap multimodal Codex model requested by user.
pub const DEFAULT_CODEX_MODEL: &str = "gpt-6-luna";

const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_OAUTH_SCOPE: &str = "openid profile email offline_access";
const CODEX_ORIGINATOR: &str = "codex_cli_rs";

static REFRESH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn refresh_lock() -> &'static Mutex<()> {
    REFRESH_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexAuthStatus {
    pub authenticated: bool,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub expires_at: Option<i64>,
    pub auth_path: String,
    pub model: String,
    pub codex_only: bool,
}

pub struct OpenAiCodexProvider {
    client: Client,
    endpoint_url: String,
}

impl Default for OpenAiCodexProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAiCodexProvider {
    pub fn new() -> Self {
        Self::with_endpoint(CODEX_RESPONSES_URL.to_string())
    }

    pub fn with_endpoint(endpoint_url: String) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(12))
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            endpoint_url,
        }
    }

    /// Isolated Sticky token store (`~/.heyclicky/codex_auth.json`) to avoid refresh-token
    /// reuse collisions with external Codex CLI sessions.
    pub fn auth_file_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".heyclicky")
            .join("codex_auth.json")
    }

    pub fn load_tokens() -> Option<CodexTokens> {
        let path = Self::auth_file_path();
        let raw = std::fs::read_to_string(&path).ok()?;
        let tokens: CodexTokens = serde_json::from_str(&raw).ok()?;
        if tokens.access_token.trim().is_empty() {
            return None;
        }
        Some(tokens)
    }

    pub fn save_tokens(tokens: &CodexTokens) -> Result<()> {
        let path = Self::auth_file_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Config(format!("Failed to create auth dir: {e}")))?;
        }
        let json = serde_json::to_string_pretty(tokens)
            .map_err(|e| AppError::Config(format!("Failed to serialize Codex auth: {e}")))?;
        std::fs::write(&path, json)
            .map_err(|e| AppError::Config(format!("Failed to write {}: {e}", path.display())))?;
        Ok(())
    }

    pub fn is_authenticated() -> bool {
        Self::load_tokens().is_some()
    }

    pub fn get_status(model: &str, codex_only: bool) -> CodexAuthStatus {
        let path_str = Self::auth_file_path().to_string_lossy().to_string();
        let resolved_model = if model.trim().is_empty() {
            DEFAULT_CODEX_MODEL.to_string()
        } else {
            model.trim().to_string()
        };
        if let Some(tok) = Self::load_tokens() {
            CodexAuthStatus {
                authenticated: true,
                email: tok.email,
                account_id: tok.account_id,
                expires_at: tok.expires_at,
                auth_path: path_str,
                model: resolved_model,
                codex_only,
            }
        } else {
            CodexAuthStatus {
                authenticated: false,
                email: None,
                account_id: None,
                expires_at: None,
                auth_path: path_str,
                model: resolved_model,
                codex_only,
            }
        }
    }

    pub fn logout() -> Result<()> {
        let path = Self::auth_file_path();
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| AppError::Config(format!("Failed to remove Codex auth file: {e}")))?;
        }
        Ok(())
    }

    /// Imports an existing official OpenAI Codex CLI login (`~/.codex/auth.json`) into Sticky's
    /// local token store (`~/.heyclicky/codex_auth.json`).
    pub fn import_from_codex_cli(model: &str, codex_only: bool) -> Result<CodexAuthStatus> {
        let cli_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".codex")
            .join("auth.json");

        if !cli_path.exists() {
            return Err(AppError::Config(format!(
                "Codex CLI auth file not found at {}. Click 'Sign in with ChatGPT' instead.",
                cli_path.display()
            )));
        }

        let raw = std::fs::read_to_string(&cli_path)
            .map_err(|e| AppError::Config(format!("Failed to read {}: {e}", cli_path.display())))?;
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|e| AppError::Config(format!("Invalid JSON in {}: {e}", cli_path.display())))?;

        let tokens_obj = parsed.get("tokens").unwrap_or(&parsed);
        let access_token = tokens_obj
            .get("access_token")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AppError::Config("Codex CLI auth.json does not contain a valid access_token".into())
            })?
            .to_string();

        let refresh_token = tokens_obj
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let id_token = tokens_obj
            .get("id_token")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let explicit_account_id = tokens_obj
            .get("account_id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let claims = extract_jwt_metadata(id_token.as_deref(), &access_token);
        let now = chrono::Utc::now().timestamp();
        let tokens = CodexTokens {
            access_token,
            refresh_token,
            id_token,
            account_id: explicit_account_id.or(claims.account_id),
            email: claims.email,
            expires_at: claims.expires_at,
            updated_at: now,
        };

        Self::save_tokens(&tokens)?;
        Ok(Self::get_status(model, codex_only))
    }

    /// Runs the full browser OAuth 2.0 PKCE login flow (identical to Hermes Agent / Codex CLI):
    /// binds `http://localhost:1455/auth/callback`, opens the user's browser to ChatGPT sign-in,
    /// exchanges the authorization code for tokens, extracts `chatgpt_account_id` + `email`,
    /// persists to `~/.heyclicky/codex_auth.json`, and returns live `CodexAuthStatus`.
    pub async fn start_oauth_login(model: &str, codex_only: bool) -> Result<CodexAuthStatus> {
        let code_verifier = generate_pkce_verifier();
        let code_challenge = compute_pkce_challenge(&code_verifier);
        let state = generate_oauth_state();

        let listener = TcpListener::bind("127.0.0.1:1455").await.map_err(|e| {
            AppError::Ai(format!(
                "Could not bind OAuth callback listener on http://localhost:1455 ({e}). Close any other Codex login session using port 1455 and try again."
            ))
        })?;

        let auth_url = build_authorize_url(&code_challenge, &state);
        open_system_browser(&auth_url)?;

        let callback_code = wait_for_oauth_callback(listener, &state, Duration::from_secs(300)).await?;
        let tokens = exchange_authorization_code(&callback_code, &code_verifier).await?;
        Self::save_tokens(&tokens)?;

        Ok(Self::get_status(model, codex_only))
    }

    /// Returns a fresh valid `CodexTokens`, silently refreshing via `refresh_token` if expired
    /// or within 120 seconds of expiry. Serialized via `REFRESH_LOCK` to prevent token reuse errors.
    async fn ensure_valid_tokens(&self, force_refresh: bool) -> Result<CodexTokens> {
        let now = chrono::Utc::now().timestamp();
        if !force_refresh {
            if let Some(tok) = Self::load_tokens() {
                let is_fresh = tok
                    .expires_at
                    .map(|exp| exp > now + 120)
                    .unwrap_or(true);
                if is_fresh {
                    return Ok(tok);
                }
            } else {
                return Err(AppError::Ai(
                    "Not signed in to ChatGPT Codex. Open Settings -> ChatGPT Codex Auth and click 'Sign in with ChatGPT'.".into(),
                ));
            }
        }

        let _guard = refresh_lock().lock().await;
        let current = Self::load_tokens().ok_or_else(|| {
            AppError::Ai(
                "Not signed in to ChatGPT Codex. Open Settings -> ChatGPT Codex Auth and click 'Sign in with ChatGPT'.".into(),
            )
        })?;

        let now_locked = chrono::Utc::now().timestamp();
        if !force_refresh {
            if let Some(exp) = current.expires_at {
                if exp > now_locked + 120 {
                    return Ok(current);
                }
            }
        }

        let Some(ref refresh_tok) = current.refresh_token else {
            if !force_refresh {
                return Ok(current);
            }
            return Err(AppError::Ai(
                "ChatGPT Codex access token expired and no refresh_token is available. Please sign in again in Settings.".into(),
            ));
        };

        let refreshed = refresh_oauth_tokens(&self.client, refresh_tok, &current).await?;
        Self::save_tokens(&refreshed)?;
        Ok(refreshed)
    }

    /// Converts Sticky's `ChatMessage` slice into the Codex Responses API JSON payload
    /// (`instructions`, multimodal `input` with `input_text` + `input_image`, `store: false`, `stream: true`).
    pub fn build_responses_payload(
        model: &str,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Value {
        let mut system_parts: Vec<&str> = Vec::new();
        let mut input_items: Vec<Value> = Vec::new();

        for msg in messages {
            match msg.role {
                ChatRole::System => {
                    let trimmed = msg.content.trim();
                    if !trimmed.is_empty() {
                        system_parts.push(trimmed);
                    }
                }
                ChatRole::User => {
                    let mut content_blocks: Vec<Value> = Vec::new();
                    if !msg.content.is_empty() {
                        content_blocks.push(json!({
                            "type": "input_text",
                            "text": msg.content
                        }));
                    }
                    if let Some(ref imgs) = msg.images_base64 {
                        for b64 in imgs {
                            if b64.trim().is_empty() {
                                continue;
                            }
                            let url = if b64.starts_with("data:") {
                                b64.clone()
                            } else {
                                format!("data:image/jpeg;base64,{b64}")
                            };
                            content_blocks.push(json!({
                                "type": "input_image",
                                "image_url": url,
                                "detail": "high"
                            }));
                        }
                    }
                    if content_blocks.is_empty() {
                        content_blocks.push(json!({
                            "type": "input_text",
                            "text": ""
                        }));
                    }
                    input_items.push(json!({
                        "type": "message",
                        "role": "user",
                        "content": content_blocks
                    }));
                }
                ChatRole::Assistant => {
                    input_items.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{
                            "type": "output_text",
                            "text": msg.content
                        }]
                    }));
                }
                ChatRole::Tool => {
                    let call_id = msg
                        .tool_call_id
                        .clone()
                        .unwrap_or_else(|| format!("call_{}", Uuid::new_v4()));
                    input_items.push(json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": msg.content
                    }));
                }
            }
        }

        let instructions = if system_parts.is_empty() {
            "You are Sticky, a warm, concise, helpful desktop AI companion.".to_string()
        } else {
            system_parts.join("\n\n")
        };

        let mut payload = json!({
            "model": model,
            "instructions": instructions,
            "input": input_items,
            "store": false,
            "stream": true
        });

        if !tools.is_empty() {
            let tools_json: Vec<Value> = tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters
                    })
                })
                .collect();
            payload["tools"] = json!(tools_json);
        }

        payload
    }

    async fn send_responses_request(
        &self,
        tokens: &CodexTokens,
        payload: &Value,
    ) -> Result<reqwest::Response> {
        let mut req = self
            .client
            .post(&self.endpoint_url)
            .bearer_auth(&tokens.access_token)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .header("originator", CODEX_ORIGINATOR)
            .header("x-client-request-id", Uuid::new_v4().to_string());

        if let Some(ref acc_id) = tokens.account_id {
            if !acc_id.trim().is_empty() {
                req = req.header("chatgpt-account-id", acc_id.trim());
            }
        }

        req.json(payload)
            .send()
            .await
            .map_err(|e| AppError::Ai(format!("ChatGPT Codex request error: {e}")))
    }
}

#[async_trait]
impl LlmProvider for OpenAiCodexProvider {
    fn provider_name(&self) -> &str {
        "openai_codex"
    }

    async fn stream_chat(
        &self,
        model: &str,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<Receiver<Result<ChatChunk>>> {
        let resolved_model = if model.trim().is_empty() {
            DEFAULT_CODEX_MODEL
        } else {
            model.trim()
        };

        let mut tokens = self.ensure_valid_tokens(false).await?;
        let payload = Self::build_responses_payload(resolved_model, messages, tools);

        let mut response = self.send_responses_request(&tokens, &payload).await?;

        // If the backend returns 401 Unauthorized, refresh the OAuth token once and retry
        if response.status().as_u16() == 401 && tokens.refresh_token.is_some() {
            if let Ok(refreshed) = self.ensure_valid_tokens(true).await {
                tokens = refreshed;
                response = self.send_responses_request(&tokens, &payload).await?;
            }
        }

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let snippet: String = body.chars().take(400).collect();
            return Err(AppError::Ai(format!(
                "ChatGPT Codex HTTP {status} (model={resolved_model}): {snippet}"
            )));
        }

        let (tx, rx) = channel(128);
        let mut byte_stream = response.bytes_stream();

        let stream_future = async move {
            let mut buffer = String::new();
            let mut current_event = String::new();
            let mut emitted_any_delta = false;
            let mut sent_finish = false;

            while let Some(chunk_res) = byte_stream.next().await {
                match chunk_res {
                    Ok(bytes) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(idx) = buffer.find('\n') {
                            let line = buffer[..idx].trim_end_matches('\r').trim().to_string();
                            buffer = buffer[idx + 1..].to_string();

                            if line.is_empty() {
                                current_event.clear();
                                continue;
                            }
                            if let Some(ev) = line.strip_prefix("event:") {
                                current_event = ev.trim().to_string();
                                continue;
                            }
                            let Some(raw_data) = line.strip_prefix("data:") else {
                                continue;
                            };
                            let data = raw_data.trim();
                            if data.is_empty() {
                                continue;
                            }
                            if data == "[DONE]" {
                                if !sent_finish {
                                    let _ = tx
                                        .send(Ok(ChatChunk {
                                            delta_text: None,
                                            tool_calls: None,
                                            finish_reason: Some("stop".to_string()),
                                        }))
                                        .await;
                                }
                                return;
                            }

                            match parse_codex_sse_event(&current_event, data, emitted_any_delta) {
                                Ok(Some(parsed_evt)) => {
                                    if parsed_evt.is_text_delta {
                                        emitted_any_delta = true;
                                    }
                                    if parsed_evt.chunk.finish_reason.is_some() {
                                        sent_finish = true;
                                    }
                                    let is_done = parsed_evt.chunk.finish_reason.is_some();
                                    let _ = tx.send(Ok(parsed_evt.chunk)).await;
                                    if is_done {
                                        return;
                                    }
                                }
                                Ok(None) => {}
                                Err(err_msg) => {
                                    let _ = tx.send(Err(AppError::Ai(err_msg))).await;
                                    return;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx
                            .send(Err(AppError::Ai(format!("ChatGPT Codex stream error: {e}"))))
                            .await;
                        return;
                    }
                }
            }

            if !sent_finish {
                let _ = tx
                    .send(Ok(ChatChunk {
                        delta_text: None,
                        tool_calls: None,
                        finish_reason: Some("stop".to_string()),
                    }))
                    .await;
            }
        };

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(stream_future);
        } else {
            tauri::async_runtime::spawn(stream_future);
        }

        Ok(rx)
    }
}

struct ParsedSseChunk {
    chunk: ChatChunk,
    is_text_delta: bool,
}

/// Parses a single OpenAI Responses SSE `data:` JSON payload into a Sticky `ChatChunk`.
/// Resilient against Codex Responses models that stream via `response.output_text.delta`
/// while returning an empty `response.output` array on `response.completed`.
fn parse_codex_sse_event(
    event_name: &str,
    data: &str,
    emitted_any_delta: bool,
) -> std::result::Result<Option<ParsedSseChunk>, String> {
    let Ok(parsed) = serde_json::from_str::<Value>(data) else {
        return Ok(None);
    };

    let evt_type = parsed
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or(event_name);

    match evt_type {
        "response.output_text.delta" => {
            if let Some(delta) = parsed.get("delta").and_then(|d| d.as_str()) {
                if !delta.is_empty() {
                    return Ok(Some(ParsedSseChunk {
                        chunk: ChatChunk {
                            delta_text: Some(delta.to_string()),
                            tool_calls: None,
                            finish_reason: None,
                        },
                        is_text_delta: true,
                    }));
                }
            }
            Ok(None)
        }
        "response.output_text.done" => {
            // Only emit fallback full text if no incremental deltas were received
            if !emitted_any_delta {
                if let Some(text) = parsed.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        return Ok(Some(ParsedSseChunk {
                            chunk: ChatChunk {
                                delta_text: Some(text.to_string()),
                                tool_calls: None,
                                finish_reason: None,
                            },
                            is_text_delta: true,
                        }));
                    }
                }
            }
            Ok(None)
        }
        "response.output_item.done" => {
            if let Some(item) = parsed.get("item") {
                if item.get("type").and_then(|t| t.as_str()) == Some("function_call") {
                    let id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let name = item
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let arguments = item
                        .get("arguments")
                        .map(|v| {
                            if let Some(s) = v.as_str() {
                                s.to_string()
                            } else {
                                v.to_string()
                            }
                        })
                        .unwrap_or_default();
                    if !name.is_empty() {
                        return Ok(Some(ParsedSseChunk {
                            chunk: ChatChunk {
                                delta_text: None,
                                tool_calls: Some(vec![ToolCall {
                                    id,
                                    name,
                                    arguments,
                                }]),
                                finish_reason: None,
                            },
                            is_text_delta: false,
                        }));
                    }
                }
            }
            Ok(None)
        }
        "response.completed" | "response.done" => {
            // If deltas already streamed (even if response.output is empty []), finish cleanly!
            // If zero deltas arrived, check response.output text as last-resort fallback.
            let mut fallback_text = None;
            if !emitted_any_delta {
                if let Some(outputs) = parsed
                    .get("response")
                    .and_then(|r| r.get("output"))
                    .and_then(|o| o.as_array())
                {
                    let mut collected = String::new();
                    for item in outputs {
                        if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                            for block in content {
                                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                    collected.push_str(t);
                                }
                            }
                        }
                    }
                    if !collected.is_empty() {
                        fallback_text = Some(collected);
                    }
                }
            }
            Ok(Some(ParsedSseChunk {
                chunk: ChatChunk {
                    delta_text: fallback_text,
                    tool_calls: None,
                    finish_reason: Some("stop".to_string()),
                },
                is_text_delta: false,
            }))
        }
        "error" | "response.failed" => {
            let msg = parsed
                .get("error")
                .and_then(|e| e.get("message").or(Some(e)))
                .or_else(|| {
                    parsed
                        .get("response")
                        .and_then(|r| r.get("error"))
                        .and_then(|e| e.get("message").or(Some(e)))
                })
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| parsed.to_string());
            Err(format!("ChatGPT Codex stream error: {msg}"))
        }
        _ => Ok(None),
    }
}

// ============================================================================
// OAuth 2.0 PKCE Helpers, Loopback Callback Server & Token Exchange
// ============================================================================

fn generate_pkce_verifier() -> String {
    let mut bytes = Vec::with_capacity(48);
    for _ in 0..3 {
        bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes)
}

fn generate_oauth_state() -> String {
    let mut bytes = Vec::with_capacity(32);
    for _ in 0..2 {
        bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes)
}

pub fn compute_pkce_challenge(verifier: &str) -> String {
    let digest = sha256(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

pub fn build_authorize_url(code_challenge: &str, state: &str) -> String {
    format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator={}&state={}",
        CODEX_AUTH_URL,
        percent_encode(CODEX_CLIENT_ID),
        percent_encode(CODEX_REDIRECT_URI),
        percent_encode(CODEX_OAUTH_SCOPE),
        percent_encode(code_challenge),
        percent_encode(CODEX_ORIGINATOR),
        percent_encode(state),
    )
}

fn open_system_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Pass URL via explorer.exe so '&' query parameters are never interpreted by cmd.exe
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| AppError::Ai(format!("Failed to open browser for ChatGPT login: {e}")))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| AppError::Ai(format!("Failed to open browser for ChatGPT login: {e}")))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| AppError::Ai(format!("Failed to open browser for ChatGPT login: {e}")))?;
        Ok(())
    }
}

async fn wait_for_oauth_callback(
    listener: TcpListener,
    expected_state: &str,
    timeout: Duration,
) -> Result<String> {
    let deadline = Instant::now() + timeout;

    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(AppError::Ai(
                "ChatGPT OAuth sign-in timed out after 5 minutes. Please try signing in again.".into(),
            ));
        }
        let remaining = deadline - now;

        let (mut socket, _) = tokio::time::timeout(remaining, listener.accept())
            .await
            .map_err(|_| {
                AppError::Ai(
                    "ChatGPT OAuth sign-in timed out waiting for browser redirect.".into(),
                )
            })?
            .map_err(|e| AppError::Ai(format!("OAuth callback accept error: {e}")))?;

        let mut buf = vec![0u8; 8192];
        let n = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buf))
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or(0);
        if n == 0 {
            continue;
        }

        let req_str = String::from_utf8_lossy(&buf[..n]);
        let first_line = req_str.lines().next().unwrap_or("");
        let target_path = first_line.split_whitespace().nth(1).unwrap_or("");

        // Ignore favicon or unrelated probes
        if !target_path.starts_with("/auth/callback") {
            let _ = socket
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        }

        let query = target_path.split_once('?').map(|(_, q)| q).unwrap_or("");
        let params = parse_query_params(query);

        if let Some(err) = params.get("error") {
            let desc = params
                .get("error_description")
                .cloned()
                .unwrap_or_else(|| err.clone());
            let html = build_callback_html(false, &desc);
            let _ = write_http_html(&mut socket, 400, &html).await;
            return Err(AppError::Ai(format!("ChatGPT sign-in rejected: {desc}")));
        }

        let got_state = params.get("state").map(String::as_str).unwrap_or("");
        if got_state != expected_state {
            let html = build_callback_html(false, "OAuth state mismatch. Please retry sign-in from Sticky.");
            let _ = write_http_html(&mut socket, 400, &html).await;
            return Err(AppError::Ai("ChatGPT OAuth state mismatch".into()));
        }

        let Some(code) = params.get("code").filter(|c| !c.is_empty()) else {
            let html = build_callback_html(false, "Missing authorization code in callback.");
            let _ = write_http_html(&mut socket, 400, &html).await;
            return Err(AppError::Ai("Missing OAuth authorization code".into()));
        };

        let html = build_callback_html(
            true,
            "You are signed in to Sticky with ChatGPT Codex! You can close this tab and return to Sticky.",
        );
        let _ = write_http_html(&mut socket, 200, &html).await;
        return Ok(code.clone());
    }
}

async fn write_http_html(socket: &mut tokio::net::TcpStream, status: u16, html: &str) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    socket.write_all(resp.as_bytes()).await?;
    socket.flush().await
}

fn build_callback_html(ok: bool, message: &str) -> String {
    let accent = if ok { "#10b981" } else { "#ef4444" };
    let title = if ok {
        "Sticky Connected to ChatGPT"
    } else {
        "ChatGPT Sign-In Failed"
    };
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>{title}</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#f4f4f5;font-family:system-ui,-apple-system,sans-serif;">
<div style="max-width:440px;padding:32px;border-radius:18px;background:#18181b;border:1px solid {accent};box-shadow:0 20px 60px rgba(0,0,0,0.6);text-align:center;">
<div style="width:48px;height:48px;border-radius:999px;margin:0 auto 16px;background:{accent}22;border:2px solid {accent};display:flex;align-items:center;justify-content:center;font-size:22px;color:{accent};">{}</div>
<h2 style="margin:0 0 10px;font-size:18px;">{title}</h2>
<p style="margin:0;color:#a1a1aa;font-size:14px;line-height:1.5;">{message}</p>
</div></body></html>"#,
        if ok { "&#10003;" } else { "!" }
    )
}

async fn exchange_authorization_code(code: &str, code_verifier: &str) -> Result<CodexTokens> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| Client::new());

    let form_body = format!(
        "grant_type=authorization_code&client_id={}&code={}&code_verifier={}&redirect_uri={}",
        percent_encode(CODEX_CLIENT_ID),
        percent_encode(code),
        percent_encode(code_verifier),
        percent_encode(CODEX_REDIRECT_URI),
    );

    let resp = client
        .post(CODEX_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body)
        .send()
        .await
        .map_err(|e| AppError::Ai(format!("Failed contacting OpenAI OAuth token endpoint: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Ai(format!(
            "OpenAI OAuth token exchange failed (HTTP {status}): {body}"
        )));
    }

    let json: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Ai(format!("Invalid OAuth token response JSON: {e}")))?;

    parse_token_response(&json, None)
}

async fn refresh_oauth_tokens(
    client: &Client,
    refresh_token: &str,
    previous: &CodexTokens,
) -> Result<CodexTokens> {
    let form_body = format!(
        "grant_type=refresh_token&client_id={}&refresh_token={}",
        percent_encode(CODEX_CLIENT_ID),
        percent_encode(refresh_token),
    );

    let resp = client
        .post(CODEX_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body)
        .send()
        .await
        .map_err(|e| AppError::Ai(format!("ChatGPT token refresh network error: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Ai(format!(
            "ChatGPT token refresh failed (HTTP {status}). Please sign in again in Settings. Details: {body}"
        )));
    }

    let json: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Ai(format!("Invalid OAuth refresh response JSON: {e}")))?;

    parse_token_response(&json, Some(previous))
}

fn parse_token_response(json: &Value, previous: Option<&CodexTokens>) -> Result<CodexTokens> {
    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Ai("OAuth response missing access_token".into()))?
        .to_string();

    let refresh_token = json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| previous.and_then(|p| p.refresh_token.clone()));

    let id_token = json
        .get("id_token")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| previous.and_then(|p| p.id_token.clone()));

    let now = chrono::Utc::now().timestamp();
    let expires_in = json.get("expires_in").and_then(|v| v.as_i64());
    let claims = extract_jwt_metadata(id_token.as_deref(), &access_token);
    let expires_at = expires_in
        .map(|sec| now + sec)
        .or(claims.expires_at)
        .or_else(|| previous.and_then(|p| p.expires_at));

    Ok(CodexTokens {
        access_token,
        refresh_token,
        id_token,
        account_id: claims
            .account_id
            .or_else(|| previous.and_then(|p| p.account_id.clone())),
        email: claims
            .email
            .or_else(|| previous.and_then(|p| p.email.clone())),
        expires_at,
        updated_at: now,
    })
}

#[derive(Debug, Default)]
pub struct JwtMetadata {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub expires_at: Option<i64>,
}

/// Decodes unverified JWT payload claims (`chatgpt_account_id`, `email`, `exp`) from OpenAI
/// OAuth `id_token` / `access_token` so Sticky can send the exact `chatgpt-account-id` header.
pub fn extract_jwt_metadata(id_token: Option<&str>, access_token: &str) -> JwtMetadata {
    let mut meta = JwtMetadata::default();
    for candidate in [id_token, Some(access_token)].into_iter().flatten() {
        let Some(payload) = decode_jwt_payload(candidate) else {
            continue;
        };
        if meta.account_id.is_none() {
            meta.account_id = payload
                .get("https://api.openai.com/auth")
                .and_then(|auth| auth.get("chatgpt_account_id"))
                .and_then(|v| v.as_str())
                .or_else(|| payload.get("chatgpt_account_id").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
        }
        if meta.email.is_none() {
            meta.email = payload
                .get("email")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    payload
                        .get("https://api.openai.com/profile")
                        .and_then(|p| p.get("email"))
                        .and_then(|v| v.as_str())
                })
                .map(|s| s.to_string());
        }
        if meta.expires_at.is_none() {
            meta.expires_at = payload.get("exp").and_then(|v| v.as_i64());
        }
    }
    meta
}

fn decode_jwt_payload(jwt: &str) -> Option<Value> {
    let mut parts = jwt.split('.');
    let _header = parts.next()?;
    let payload_b64 = parts.next()?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload_b64))
        .ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3 / 2);
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_query_params(query: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(percent_decode(k), percent_decode(v));
    }
    map
}

/// Pure-Rust FIPS 180-4 SHA-256 for zero-dependency OAuth 2.0 PKCE S256 challenges.
fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(data.len() + 72);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_and_pkce_rfc7636_vector() {
        // RFC 7636 Appendix B official PKCE S256 test vector
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = compute_pkce_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn test_authorize_url_contains_required_codex_params() {
        let url = build_authorize_url("TEST_CHALLENGE", "TEST_STATE");
        assert!(url.starts_with("https://auth.openai.com/oauth/authorize?"));
        assert!(url.contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"));
        assert!(url.contains("code_challenge=TEST_CHALLENGE"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("codex_cli_simplified_flow=true"));
        assert!(url.contains("state=TEST_STATE"));
    }

    #[test]
    fn test_jwt_metadata_extraction() {
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"alg":"RS256","typ":"JWT"}"#);
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            r#"{"email":"user@example.com","exp":1893456000,"https://api.openai.com/auth":{"chatgpt_account_id":"acct_12345"}}"#,
        );
        let fake_jwt = format!("{header}.{payload}.sig");

        let meta = extract_jwt_metadata(Some(&fake_jwt), &fake_jwt);
        assert_eq!(meta.email.as_deref(), Some("user@example.com"));
        assert_eq!(meta.account_id.as_deref(), Some("acct_12345"));
        assert_eq!(meta.expires_at, Some(1893456000));
    }

    #[test]
    fn test_build_responses_payload_gpt6_luna_multimodal() {
        let messages = vec![
            ChatMessage::system("You are Sticky."),
            ChatMessage::user_with_image("How do I add a shortcut?", "AAAA".to_string()),
        ];
        let payload = OpenAiCodexProvider::build_responses_payload(DEFAULT_CODEX_MODEL, &messages, &[]);
        assert_eq!(payload["model"], "gpt-6-luna");
        assert_eq!(payload["instructions"], "You are Sticky.");
        assert_eq!(payload["store"], false);
        assert_eq!(payload["stream"], true);

        let input = payload["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["role"], "user");
        let blocks = input[0]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "input_text");
        assert_eq!(blocks[1]["type"], "input_image");
        assert_eq!(blocks[1]["image_url"], "data:image/jpeg;base64,AAAA");
    }

    #[test]
    fn test_parse_codex_sse_deltas_and_empty_completed_output() {
        let d1 = parse_codex_sse_event(
            "response.output_text.delta",
            r#"{"type":"response.output_text.delta","delta":"Click Add "}"#,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(d1.chunk.delta_text.as_deref(), Some("Click Add "));
        assert!(d1.is_text_delta);

        // Hermes-documented quirk: final response.completed has empty output: []
        let done = parse_codex_sse_event(
            "response.completed",
            r#"{"type":"response.completed","response":{"id":"resp_1","output":[]}}"#,
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(done.chunk.finish_reason.as_deref(), Some("stop"));
        assert_eq!(done.chunk.delta_text, None);
    }

    #[tokio::test]
    async fn test_codex_oauth_callback_loopback_end_to_end() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let state = "state_xyz_999";

        let server_task = tokio::spawn(async move {
            wait_for_oauth_callback(listener, state, Duration::from_secs(5)).await
        });

        let client = Client::new();
        let resp = client
            .get(format!("http://{addr}/auth/callback?code=auth_code_42&state={state}"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = resp.text().await.unwrap();
        assert!(body.contains("Sticky Connected to ChatGPT"));

        let got_code = server_task.await.unwrap().unwrap();
        assert_eq!(got_code, "auth_code_42");
    }

    #[tokio::test]
    async fn test_codex_stream_chat_end_to_end_mock_sse_gpt6_luna() {
        use crate::ai::tag_stream::{OverlayCommand, TagStreamParser};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut tmp = [0u8; 4096];
            loop {
                let n = socket.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&tmp[..n]);
                if let Some(hdr_end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&raw[..hdr_end]);
                    let content_len: usize = headers
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            if k.eq_ignore_ascii_case("content-length") {
                                v.trim().parse().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    if raw.len() >= hdr_end + 4 + content_len {
                        break;
                    }
                }
            }
            let req_text = String::from_utf8_lossy(&raw).to_string();

            // Verify headers & payload model/vision blocks
            assert!(req_text.contains("POST /codex/responses HTTP/1.1"));
            assert!(req_text.to_lowercase().contains("authorization: bearer tok_test_123"));
            assert!(req_text.to_lowercase().contains("chatgpt-account-id: acct_test_99"));
            assert!(req_text.contains("\"model\":\"gpt-6-luna\""));
            assert!(req_text.contains("\"type\":\"input_image\""));
            assert!(req_text.contains("\"store\":false"));
            assert!(req_text.contains("\"stream\":true"));

            let sse_body = concat!(
                "event: response.output_text.delta\r\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Click the Add shortcut button right in the center! \"}\r\n\r\n",
                "event: response.output_text.delta\r\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"[POINT:#41:Add shortcut] [DRAW:box:#41:#10b981] [GUIDE:continue]\"}\r\n\r\n",
                "event: response.completed\r\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_luna_1\",\"output\":[]}}\r\n\r\n"
            );

            let http_resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                sse_body.len(),
                sse_body
            );
            socket.write_all(http_resp.as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
        });

        // Drive send_responses_request directly against our mock loopback server using fake tokens
        let provider = OpenAiCodexProvider::with_endpoint(format!("http://{addr}/codex/responses"));
        let fake_tokens = CodexTokens {
            access_token: "tok_test_123".to_string(),
            refresh_token: None,
            id_token: None,
            account_id: Some("acct_test_99".to_string()),
            email: Some("tester@example.com".to_string()),
            expires_at: Some(chrono::Utc::now().timestamp() + 3600),
            updated_at: chrono::Utc::now().timestamp(),
        };
        let messages = vec![
            ChatMessage::system("You are Sticky."),
            ChatMessage::user_with_image(
                "How do I add a shortcut in Chrome?\n[Detected Screen Elements]: #41 \"Add shortcut\" (500,693)",
                "AAAA".to_string(),
            ),
        ];
        let payload = OpenAiCodexProvider::build_responses_payload(DEFAULT_CODEX_MODEL, &messages, &[]);
        let resp = provider
            .send_responses_request(&fake_tokens, &payload)
            .await
            .unwrap();
        assert!(resp.status().is_success());

        let raw_sse = resp.text().await.unwrap();
        let mut parser = TagStreamParser::new();
        let mut speech = String::new();
        let mut cmds = Vec::new();
        let mut emitted_delta = false;
        let mut finished = false;
        let mut cur_ev = String::new();

        for raw_line in raw_sse.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                cur_ev.clear();
                continue;
            }
            if let Some(ev) = line.strip_prefix("event:") {
                cur_ev = ev.trim().to_string();
                continue;
            }
            if let Some(d) = line.strip_prefix("data:") {
                if let Some(evt) = parse_codex_sse_event(&cur_ev, d.trim(), emitted_delta).unwrap() {
                    if evt.is_text_delta {
                        emitted_delta = true;
                    }
                    if let Some(text) = evt.chunk.delta_text {
                        let (c, k) = parser.feed_token(&text);
                        speech.push_str(&c);
                        cmds.extend(k);
                    }
                    if evt.chunk.finish_reason.as_deref() == Some("stop") {
                        finished = true;
                    }
                }
            }
        }
        let (fc, fk) = parser.flush();
        speech.push_str(&fc);
        cmds.extend(fk);

        server_task.await.unwrap();
        assert!(finished);
        assert_eq!(
            speech.trim(),
            "Click the Add shortcut button right in the center!"
        );
        assert!(cmds.iter().any(|c| matches!(
            c,
            OverlayCommand::PointRef { element_id: 41, .. }
        )));
        assert!(cmds.iter().any(|c| matches!(
            c,
            OverlayCommand::DrawRef { element_id: 41, shape, .. } if shape == "box"
        )));
        assert!(cmds
            .iter()
            .any(|c| matches!(c, OverlayCommand::Guide { active: true })));
    }
}
