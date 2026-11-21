use std::time::Duration;
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::json;
use tokio::sync::mpsc::{channel, Receiver};

use crate::ai::providers::{ChatChunk, ChatMessage, LlmProvider, ToolDefinition};
use crate::error::{AppError, Result};

pub struct OpenRouterProvider {
    pub api_key: String,
    client: Client,
}

impl OpenRouterProvider {
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
impl LlmProvider for OpenRouterProvider {
    fn provider_name(&self) -> &str {
        "openrouter"
    }

    async fn stream_chat(
        &self,
        model: &str,
        messages: &[ChatMessage],
        _tools: &[ToolDefinition],
    ) -> Result<Receiver<Result<ChatChunk>>> {
        let url = "https://openrouter.ai/api/v1/chat/completions";
        let selected_model = if model.trim().is_empty() {
            "google/gemma-4-31b-it:free"
        } else {
            model
        };

        let formatted_messages: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                if let Some(ref imgs) = m.images_base64 {
                    if !imgs.is_empty() {
                        let mut parts = vec![json!({ "type": "text", "text": m.content })];
                        for b64 in imgs {
                            parts.push(json!({
                                "type": "image_url",
                                "image_url": { "url": format!("data:image/jpeg;base64,{b64}") }
                            }));
                        }
                        return json!({ "role": m.role, "content": parts });
                    }
                }
                json!({ "role": m.role, "content": m.content })
            })
            .collect();

        let payload = json!({
            "model": selected_model,
            "messages": formatted_messages,
            "stream": true,
            "temperature": 0.3
        });

        let response = self
            .client
            .post(url)
            .bearer_auth(&self.api_key)
            .header("HTTP-Referer", "https://github.com/X-DIABLO-X/sticky")
            .header("X-Title", "Sticky Desktop AI")
            .json(&payload)
            .send()
            .await
            .map_err(|e| AppError::Ai(format!("OpenRouter request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Ai(format!("OpenRouter HTTP {status}: {body}")));
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
                                if data == "[DONE]" {
                                    let _ = tx
                                        .send(Ok(ChatChunk {
                                            delta_text: None,
                                            tool_calls: None,
                                            finish_reason: Some("stop".to_string()),
                                        }))
                                        .await;
                                    return;
                                }

                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                                    if let Some(content) = parsed
                                        .pointer("/choices/0/delta/content")
                                        .and_then(|c| c.as_str())
                                    {
                                        let _ = tx
                                            .send(Ok(ChatChunk {
                                                delta_text: Some(content.to_string()),
                                                tool_calls: None,
                                                finish_reason: None,
                                            }))
                                            .await;
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx
                            .send(Err(AppError::Ai(format!("OpenRouter stream error: {e}"))))
                            .await;
                        return;
                    }
                }
            }
        });

        Ok(rx)
    }
}
