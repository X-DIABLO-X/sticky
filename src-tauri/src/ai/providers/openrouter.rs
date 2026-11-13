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
        Self {
            api_key,
            client: Client::new(),
        }
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
        let default_model = "google/gemma-2-9b-it:free";
        let selected_model = if model.is_empty() { default_model } else { model };

        let formatted_messages: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                json!({
                    "role": m.role,
                    "content": m.content
                })
            })
            .collect();

        let payload = json!({
            "model": selected_model,
            "messages": formatted_messages,
            "stream": true,
            "temperature": 0.3
        });

        let response = self.client
            .post(url)
            .bearer_auth(&self.api_key)
            .header("HTTP-Referer", "https://heyclicky.com")
            .header("X-Title", "HeyClicky Desktop")
            .json(&payload)
            .send()
            .await
            .map_err(|e| AppError::Ai(format!("OpenRouter request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Ai(format!("OpenRouter error ({}): {}", status, body)));
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

                            if line.starts_with("data: ") {
                                let data = &line["data: ".len()..];
                                if data == "[DONE]" {
                                    let _ = tx.send(Ok(ChatChunk {
                                        delta_text: None,
                                        tool_calls: None,
                                        finish_reason: Some("stop".to_string()),
                                    })).await;
                                    return;
                                }

                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                                    if let Some(choices) = parsed.get("choices").and_then(|c| c.as_array()) {
                                        if let Some(first) = choices.first() {
                                            let delta = first.get("delta");
                                            let content = delta.and_then(|d| d.get("content")).and_then(|c| c.as_str());

                                            let _ = tx.send(Ok(ChatChunk {
                                                delta_text: content.map(|s| s.to_string()),
                                                tool_calls: None,
                                                finish_reason: None,
                                            })).await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(AppError::Ai(format!("OpenRouter stream error: {}", e)))).await;
                        return;
                    }
                }
            }
        });

        Ok(rx)
    }
}
