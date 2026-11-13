use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::json;
use tokio::sync::mpsc::{channel, Receiver};
use crate::ai::providers::{ChatChunk, ChatMessage, LlmProvider, ToolCall, ToolDefinition};
use crate::error::{AppError, Result};

pub struct LocalLlamaProvider {
    pub base_url: String,
    client: Client,
}

impl LocalLlamaProvider {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            client: Client::new(),
        }
    }

    pub async fn check_health(&self) -> bool {
        let url = format!("{}/api/version", self.base_url.trim_end_matches('/'));
        match self.client.get(&url).send().await {
            Ok(res) => res.status().is_success(),
            Err(_) => false,
        }
    }

    pub async fn list_models(&self) -> Result<Vec<String>> {
        let url = format!("{}/api/tags", self.base_url.trim_end_matches('/'));
        let res = self.client.get(&url).send().await
            .map_err(|e| AppError::Ai(format!("Failed to connect to Ollama at {}: {}", self.base_url, e)))?;

        if let Ok(json) = res.json::<serde_json::Value>().await {
            if let Some(models) = json.get("models").and_then(|m| m.as_array()) {
                let list = models.iter()
                    .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                    .collect();
                return Ok(list);
            }
        }
        Ok(vec![])
    }
}

#[async_trait]
impl LlmProvider for LocalLlamaProvider {
    fn provider_name(&self) -> &str {
        "local_llamacpp"
    }

    async fn stream_chat(
        &self,
        model: &str,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<Receiver<Result<ChatChunk>>> {
        let url = format!("{}/api/chat", self.base_url.trim_end_matches('/'));

        let formatted_messages: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                let mut map = serde_json::Map::new();
                map.insert("role".to_string(), json!(m.role));
                map.insert("content".to_string(), json!(m.content));
                if let Some(ref imgs) = m.images_base64 {
                    map.insert("images".to_string(), json!(imgs));
                }
                serde_json::Value::Object(map)
            })
            .collect();

        let mut payload = json!({
            "model": model,
            "messages": formatted_messages,
            "stream": true,
            "think": false,
            "options": {
                "temperature": 0.2
            }
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
            .post(&url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| AppError::Ai(format!("Local llama request error: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Ai(format!("Local llama HTTP {} error: {}", status, body)));
        }

        let (tx, rx) = channel(100);
        let mut byte_stream = response.bytes_stream();

        tokio::spawn(async move {
            let mut buffer = String::new();

            while let Some(chunk_res) = byte_stream.next().await {
                match chunk_res {
                    Ok(bytes) => {
                        let text = String::from_utf8_lossy(&bytes);
                        buffer.push_str(&text);

                        while let Some(idx) = buffer.find('\n') {
                            let line = buffer[..idx].trim().to_string();
                            buffer = buffer[idx + 1..].to_string();

                            if line.is_empty() {
                                continue;
                            }

                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                                if let Some(msg) = parsed.get("message") {
                                    let content = msg.get("content").and_then(|c| c.as_str());
                                    let mut tool_calls = None;

                                    if let Some(tc_arr) = msg.get("tool_calls").and_then(|t| t.as_array()) {
                                        let mut list = Vec::new();
                                        for tc in tc_arr {
                                            let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                                            let func = tc.get("function");
                                            let name = func.and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or_default().to_string();
                                            let args = func.and_then(|f| f.get("arguments")).map(|a| {
                                                if a.is_string() {
                                                    a.as_str().unwrap_or_default().to_string()
                                                } else {
                                                    a.to_string()
                                                }
                                            }).unwrap_or_default();
                                            list.push(ToolCall { id, name, arguments: args });
                                        }
                                        if !list.is_empty() {
                                            tool_calls = Some(list);
                                        }
                                    }

                                    let delta_text = content.filter(|s| !s.is_empty()).map(|s| s.to_string());
                                    if delta_text.is_some() || tool_calls.is_some() {
                                        let _ = tx.send(Ok(ChatChunk {
                                            delta_text,
                                            tool_calls,
                                            finish_reason: None,
                                        })).await;
                                    }
                                }

                                if parsed.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                                    let _ = tx.send(Ok(ChatChunk {
                                        delta_text: None,
                                        tool_calls: None,
                                        finish_reason: Some("stop".to_string()),
                                    })).await;
                                    return;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(AppError::Ai(format!("Stream error: {}", e)))).await;
                        return;
                    }
                }
            }
        });

        Ok(rx)
    }
}
