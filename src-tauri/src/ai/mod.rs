pub mod prompts;
pub mod providers;
pub mod router;
pub mod tag_stream;

use std::sync::Arc;
use tokio::sync::mpsc::Sender;
use crate::ai::prompts::Prompts;
use crate::ai::providers::{ChatMessage, ChatRole, ToolCall};
use crate::ai::router::{ModelRouter, TaskType};
use crate::error::Result;
use crate::tools::ToolRegistry;

pub struct AgentRuntime {
    router: Arc<ModelRouter>,
    tools: Arc<ToolRegistry>,
    messages: Vec<ChatMessage>,
}

impl AgentRuntime {
    pub fn new(router: Arc<ModelRouter>, tools: Arc<ToolRegistry>) -> Self {
        Self {
            router,
            tools,
            messages: vec![ChatMessage::system(Prompts::talk_mode_system_prompt())],
        }
    }

    pub fn with_system_prompt(router: Arc<ModelRouter>, tools: Arc<ToolRegistry>, system_prompt: &str) -> Self {
        Self {
            router,
            tools,
            messages: vec![ChatMessage::system(system_prompt)],
        }
    }

    pub fn reset_history(&mut self) {
        self.messages.retain(|m| m.role == ChatRole::System);
    }

    pub fn add_message(&mut self, message: ChatMessage) {
        self.messages.push(message);
    }

    /// Execute a conversation turn with autonomous tool calling loop
    pub async fn execute_turn(
        &mut self,
        user_prompt: &str,
        task_type: TaskType,
        stream_tx: Option<Sender<String>>,
    ) -> Result<String> {
        self.messages.push(ChatMessage::user(user_prompt));

        let max_tool_iterations = 5;
        let mut full_response = String::new();

        for _iteration in 0..max_tool_iterations {
            let tool_defs = self.tools.get_definitions();
            let mut rx = self.router.route_and_stream(task_type, &self.messages, &tool_defs).await?;

            let mut current_turn_text = String::new();
            let mut collected_tool_calls: Vec<ToolCall> = Vec::new();

            while let Some(chunk_res) = rx.recv().await {
                let chunk = chunk_res?;

                if let Some(ref text) = chunk.delta_text {
                    current_turn_text.push_str(text);
                    if let Some(ref tx) = stream_tx {
                        let _ = tx.send(text.clone()).await;
                    }
                }

                if let Some(tcs) = chunk.tool_calls {
                    collected_tool_calls.extend(tcs);
                }
            }

            full_response.push_str(&current_turn_text);

            if collected_tool_calls.is_empty() {
                // Completed turn without tool calls
                self.messages.push(ChatMessage::assistant(current_turn_text));
                break;
            }

            // Append assistant message with tool calls
            self.messages.push(ChatMessage {
                role: ChatRole::Assistant,
                content: current_turn_text,
                images_base64: None,
                tool_calls: Some(collected_tool_calls.clone()),
                tool_call_id: None,
            });

            // Execute each requested tool and append results
            for tc in collected_tool_calls {
                let tool_result_val = match self.tools.execute_tool(&tc.name, &tc.arguments).await {
                    Ok(val) => val.to_string(),
                    Err(e) => format!("{{\"error\": \"{}\"}}", e),
                };

                self.messages.push(ChatMessage::tool_result(tc.id, tool_result_val));
            }
        }

        Ok(full_response)
    }
}
