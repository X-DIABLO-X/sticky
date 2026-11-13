pub mod browser_tools;
pub mod mcp_client;
pub mod os_tools;
pub mod overlay_tools;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use serde_json::Value;
use crate::ai::providers::ToolDefinition;
use crate::error::{AppError, Result};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type ToolFn = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value>> + Send + Sync>;

#[derive(Clone)]
pub struct ToolRegistry {
    tools: HashMap<String, (ToolDefinition, ToolFn)>,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    pub fn register(&mut self, definition: ToolDefinition, handler: ToolFn) {
        self.tools.insert(definition.name.clone(), (definition, handler));
    }

    pub fn get_definitions(&self) -> Vec<ToolDefinition> {
        self.tools.values().map(|(def, _)| def.clone()).collect()
    }

    pub async fn execute_tool(&self, name: &str, arguments_json: &str) -> Result<Value> {
        let (_, handler) = self.tools.get(name)
            .ok_or_else(|| AppError::Tool(format!("Tool '{}' not registered", name)))?;

        let args: Value = if arguments_json.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(arguments_json)
                .map_err(|e| AppError::Tool(format!("Invalid arguments JSON for '{}': {}", name, e)))?
        };

        handler(args).await
    }
}
