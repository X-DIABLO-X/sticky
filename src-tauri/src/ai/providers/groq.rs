use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::json;
use tokio::sync::mpsc::{channel, Receiver};
use crate::ai::providers::{ChatChunk, ChatMessage, LlmProvider, ToolCall, ToolDefinition};
use crate::error::{AppError, Result};

pub struct GroqProvider {
    pub api_key: String,
    client: Client,
}

impl GroqProvider {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: Client::new(),
        }
    }
}

#[async_trait]
impl LlmProvider for GroqProvider {
    fn provider_name(&self) -> &str {
        "groq"
    }

    async fn stream_chat(
        &self,
        model: &str,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<Receiver<Result<ChatChunk>>> {
        let url = "https://api.groq.com/openai/v1/chat/completions";

        let formatted_messages: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                json!({
                    "role": m.role,
                    "content": m.content
                })
            })
            .collect();

        let mut payload = json!({
            "model": model,
            "messages": formatted_messages,
            "stream": true,
            "temperature": 0.3
        });

        if !tools.is_empty() {
            let tools_json: Vec<serde_json::Value> = tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters
                        }
                    })
                })
                .collect();
            payload["tools"] = json!(tools_json);
        }

        let response = self.client
            .post(url)
            .bearer_auth(&self.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| AppError::Ai(format!("Groq request failed: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Ai(format!("Groq error ({}): {}", status, body)));
        }

        let (tx, rx) = channel(100);
        let mut byte_stream = response.bytes_stream();

        tokio::spawn(async move {
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

                                            let mut tool_calls = None;
                                            if let Some(tc_arr) = delta.and_then(|d| d.get("tool_calls")).and_then(|t| t.as_array()) {
                                                let mut list = Vec::new();
                                                for tc in tc_arr {
                                                    let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                                                    let func = tc.get("function");
                                                    let name = func.and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or_default().to_string();
                                                    let args = func.and_then(|f| f.get("arguments")).and_then(|v| v.as_str()).unwrap_or_default().to_string();
                                                    list.push(ToolCall { id, name, arguments: args });
                                                }
                                                if !list.is_empty() {
                                                    tool_calls = Some(list);
                                                }
                                            }

                                            let finish_reason = first.get("finish_reason").and_then(|f| f.as_str()).map(|s| s.to_string());

                                            let _ = tx.send(Ok(ChatChunk {
                                                delta_text: content.map(|s| s.to_string()),
                                                tool_calls,
                                                finish_reason,
                                            })).await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(AppError::Ai(format!("Groq stream error: {}", e)))).await;
                        return;
                    }
                }
            }
        });

        Ok(rx)
    }
}
