use std::time::Duration;
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::json;
use tokio::sync::mpsc::{channel, Receiver};

use crate::ai::providers::{ChatChunk, ChatMessage, ChatRole, LlmProvider, ToolDefinition};
use crate::error::{AppError, Result};

pub struct GeminiProvider {
    pub api_key: String,
    client: Client,
}

impl GeminiProvider {
    pub fn new(api_key: String) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self { api_key, client }
    }
}

#[async_trait]
impl LlmProvider for GeminiProvider {
    fn provider_name(&self) -> &str {
        "gemini"
    }

    async fn stream_chat(
        &self,
        model: &str,
        messages: &[ChatMessage],
        _tools: &[ToolDefinition],
    ) -> Result<Receiver<Result<ChatChunk>>> {
        let actual_model = if model.trim().is_empty() {
            "gemini-2.5-flash-lite"
        } else {
            model
        };
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
            actual_model, self.api_key
        );

        // Properly separate system prompts into `systemInstruction` instead of mapping them to `"user"`
        let mut system_parts = Vec::new();
        let mut contents = Vec::new();

        for m in messages {
            if m.role == ChatRole::System {
                if !m.content.trim().is_empty() {
                    system_parts.push(json!({ "text": m.content }));
                }
                continue;
            }

            let role = match m.role {
                ChatRole::Assistant => "model",
                _ => "user",
            };

            let mut parts = Vec::new();
            if !m.content.is_empty() {
                parts.push(json!({ "text": m.content }));
            }

            if let Some(ref imgs) = m.images_base64 {
                for b64 in imgs {
                    parts.push(json!({
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": b64
                        }
                    }));
                }
            }

            if !parts.is_empty() {
                contents.push(json!({
                    "role": role,
                    "parts": parts
                }));
            }
        }

        let mut payload = json!({
            "contents": contents,
            "generationConfig": {
                "temperature": 0.2
            }
        });

        if !system_parts.is_empty() {
            payload["systemInstruction"] = json!({ "parts": system_parts });
        }

        let response = self
            .client
            .post(&url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| AppError::Ai(format!("Gemini request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Ai(format!("Gemini HTTP {status}: {body}")));
        }

        let (tx, rx) = channel(100);
        let mut byte_stream = response.bytes_stream();

        tauri::async_runtime::spawn(async move {
            let mut buffer = String::new();

            while let Some(chunk_res) = byte_stream.next().await {
                match chunk_res {
                    Ok(bytes) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(idx) = buffer.find('\n') {
                            let line = buffer[..idx].trim().to_string();
                            buffer = buffer[idx + 1..].to_string();

                            if let Some(data) = line.strip_prefix("data: ") {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                                    if let Some(parts) = parsed
                                        .pointer("/candidates/0/content/parts")
                                        .and_then(|p| p.as_array())
                                    {
                                        for p in parts {
                                            if let Some(text) = p.get("text").and_then(|t| t.as_str()) {
                                                let _ = tx
                                                    .send(Ok(ChatChunk {
                                                        delta_text: Some(text.to_string()),
                                                        tool_calls: None,
                                                        finish_reason: None,
                                                    }))
                                                    .await;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(AppError::Ai(format!("Gemini stream error: {e}")))).await;
                        return;
                    }
                }
            }
        });

        Ok(rx)
    }
}
