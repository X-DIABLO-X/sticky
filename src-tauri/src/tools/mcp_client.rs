use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use crate::ai::providers::ToolDefinition;
use crate::error::{AppError, Result};
use crate::tools::{ToolFn, ToolRegistry};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum McpServerConfig {
    Stdio {
        command: String,
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    HttpSse {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpConfigFile {
    #[serde(rename = "mcpServers")]
    pub mcp_servers: HashMap<String, McpServerConfig>,
}

pub struct McpClient {
    client: Client,
}

impl Default for McpClient {
    fn default() -> Self {
        Self::new()
    }
}

impl McpClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }

    pub fn config_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".heyclicky")
            .join("mcp.json")
    }

    /// Load servers from ~/.heyclicky/mcp.json and register discovered tools
    pub async fn load_and_register_tools(&self, registry: &mut ToolRegistry) -> Result<()> {
        let path = Self::config_path();
        if !path.exists() {
            // Write default template if missing
            let default_cfg = json!({
                "mcpServers": {
                    "filesystem": {
                        "command": "npx",
                        "args": ["-y", "@modelcontextprotocol/server-filesystem", dirs::home_dir().unwrap_or_default().display().to_string()]
                    }
                }
            });
            let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
            let _ = std::fs::write(&path, serde_json::to_string_pretty(&default_cfg).unwrap_or_default());
            return Ok(());
        }

        let content = std::fs::read_to_string(&path)
            .map_err(|e| AppError::Tool(format!("Failed to read {}: {}", path.display(), e)))?;

        let parsed: McpConfigFile = match serde_json::from_str(&content) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[MCP] Warning: Failed to parse mcp.json: {}", e);
                return Ok(());
            }
        };

        for (server_name, config) in parsed.mcp_servers {
            match config {
                McpServerConfig::Stdio { command, args, env: _ } => {
                    self.register_stdio_tool_stubs(registry, &server_name, command, args);
                }
                McpServerConfig::HttpSse { url, headers: _ } => {
                    self.register_http_tool_stubs(registry, &server_name, url);
                }
            }
        }

        Ok(())
    }

    fn register_stdio_tool_stubs(
        &self,
        registry: &mut ToolRegistry,
        server_name: &str,
        command: String,
        args: Vec<String>,
    ) {
        let tool_name = format!("mcp_{}_exec", server_name);
        let s_name = server_name.to_string();
        let cmd_clone = command.clone();
        let args_clone = args.clone();

        let def = ToolDefinition {
            name: tool_name.clone(),
            description: format!("Execute tool on MCP stdio server '{}'", server_name),
            parameters: json!({
                "type": "object",
                "properties": {
                    "method": { "type": "string", "default": "tools/call" },
                    "params": { "type": "object" }
                }
            }),
        };

        let handler: ToolFn = Arc::new(move |call_args| {
            let s_cmd = cmd_clone.clone();
            let s_args = args_clone.clone();
            let _server = s_name.clone();

            Box::pin(async move {
                let req_payload = json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": call_args.get("method").and_then(|v| v.as_str()).unwrap_or("tools/call"),
                    "params": call_args.get("params").unwrap_or(&json!({}))
                });

                let mut child = Command::new(&s_cmd)
                    .args(&s_args)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| AppError::Tool(format!("Failed to spawn MCP process {}: {}", s_cmd, e)))?;

                if let Some(mut stdin) = child.stdin.take() {
                    let mut data = serde_json::to_vec(&req_payload).unwrap_or_default();
                    data.push(b'\n');
                    let _ = stdin.write_all(&data).await;
                }

                if let Some(stdout) = child.stdout.take() {
                    let mut reader = BufReader::new(stdout);
                    let mut line = String::new();
                    if let Ok(n) = reader.read_line(&mut line).await {
                        if n > 0 {
                            if let Ok(res_json) = serde_json::from_str::<serde_json::Value>(&line) {
                                return Ok(res_json);
                            }
                        }
                    }
                }

                Ok(json!({ "status": "executed", "server": _server }))
            })
        });

        registry.register(def, handler);
    }

    fn register_http_tool_stubs(
        &self,
        registry: &mut ToolRegistry,
        server_name: &str,
        url: String,
    ) {
        let tool_name = format!("mcp_{}_call", server_name);
        let s_url = url.clone();
        let client = self.client.clone();

        let def = ToolDefinition {
            name: tool_name.clone(),
            description: format!("Execute remote HTTP/SSE tool on MCP server '{}'", server_name),
            parameters: json!({
                "type": "object",
                "properties": {
                    "endpoint": { "type": "string" },
                    "payload": { "type": "object" }
                }
            }),
        };

        let handler: ToolFn = Arc::new(move |args| {
            let u = s_url.clone();
            let c = client.clone();
            Box::pin(async move {
                let res = c.post(&u)
                    .json(&args)
                    .send()
                    .await
                    .map_err(|e| AppError::Tool(format!("HTTP MCP request failed: {}", e)))?;

                let res_val: serde_json::Value = res.json().await
                    .map_err(|e| AppError::Tool(format!("HTTP MCP response parse error: {}", e)))?;

                Ok(res_val)
            })
        });

        registry.register(def, handler);
    }
}
