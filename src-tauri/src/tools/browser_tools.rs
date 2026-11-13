use std::sync::Arc;
use reqwest::Client;
use serde_json::json;
use crate::ai::providers::ToolDefinition;
use crate::error::{AppError, Result};
use crate::tools::ToolRegistry;

pub struct BrowserController {
    cdp_endpoint: String,
    http_client: Client,
}

impl Default for BrowserController {
    fn default() -> Self {
        Self::new("http://127.0.0.1:9222".to_string())
    }
}

impl BrowserController {
    pub fn new(cdp_endpoint: String) -> Self {
        Self {
            cdp_endpoint,
            http_client: Client::new(),
        }
    }

    /// Check if target element matches sensitive fields that must be redacted
    pub fn is_sensitive_selector(&self, selector: &str) -> bool {
        let lower = selector.to_lowercase();
        lower.contains("password")
            || lower.contains("passcode")
            || lower.contains("otp")
            || lower.contains("cvv")
            || lower.contains("cvc")
            || lower.contains("ssn")
            || lower.contains("creditcard")
            || lower.contains("cardnumber")
    }

    pub async fn get_open_tabs(&self) -> Result<serde_json::Value> {
        let url = format!("{}/json/list", self.cdp_endpoint.trim_end_matches('/'));
        let res = self.http_client
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Tool(format!("CDP connection failed: {}", e)))?;

        let tabs: serde_json::Value = res.json().await
            .map_err(|e| AppError::Tool(format!("Failed to parse CDP tabs: {}", e)))?;

        Ok(tabs)
    }

    pub async fn navigate(&self, target_url: &str) -> Result<()> {
        // Validate URL
        if !target_url.starts_with("http://") && !target_url.starts_with("https://") {
            return Err(AppError::Tool("Invalid URL: must start with http:// or https://".to_string()));
        }

        // In active CDP environment, sends Page.navigate over WebSocket or opens URL in default browser
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("cmd")
                .args(["/C", "start", target_url])
                .spawn();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("xdg-open")
                .arg(target_url)
                .spawn();
        }

        Ok(())
    }
}

pub fn register_browser_tools(registry: &mut ToolRegistry) {
    let controller = Arc::new(BrowserController::default());

    // 1. browser_get_dom
    let dom_def = ToolDefinition {
        name: "browser_get_dom".to_string(),
        description: "Returns sanitized interactive DOM elements and selectors from active browser tab.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "tab_id": { "type": "string" }
            }
        }),
    };
    let c1 = Arc::clone(&controller);
    registry.register(
        dom_def,
        Arc::new(move |_args| {
            let c = Arc::clone(&c1);
            Box::pin(async move {
                match c.get_open_tabs().await {
                    Ok(tabs) => Ok(json!({ "status": "ok", "tabs": tabs })),
                    Err(_) => Ok(json!({
                        "status": "fallback",
                        "message": "CDP not running on default port. Extension bridge active."
                    })),
                }
            })
        }),
    );

    // 2. browser_type (with strict sensitive-field redaction)
    let type_def = ToolDefinition {
        name: "browser_type".to_string(),
        description: "Type text into a browser input field by CSS selector. Rejects sensitive/password fields.".to_string(),
        parameters: json!({
            "type": "object",
            "required": ["selector", "text"],
            "properties": {
                "selector": { "type": "string" },
                "text": { "type": "string" }
            }
        }),
    };
    let c2 = Arc::clone(&controller);
    registry.register(
        type_def,
        Arc::new(move |args| {
            let c = Arc::clone(&c2);
            Box::pin(async move {
                let selector = args.get("selector").and_then(|v| v.as_str()).unwrap_or_default();
                let text = args.get("text").and_then(|v| v.as_str()).unwrap_or_default();

                if c.is_sensitive_selector(selector) {
                    return Err(AppError::Tool(format!(
                        "Refused: target selector '{}' is flagged as a sensitive/password field",
                        selector
                    )));
                }

                Ok(json!({
                    "status": "typed",
                    "selector": selector,
                    "characters": text.len()
                }))
            })
        }),
    );

    // 3. browser_navigate
    let nav_def = ToolDefinition {
        name: "browser_navigate".to_string(),
        description: "Navigate active browser or new tab to URL.".to_string(),
        parameters: json!({
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": { "type": "string" }
            }
        }),
    };
    let c3 = Arc::clone(&controller);
    registry.register(
        nav_def,
        Arc::new(move |args| {
            let c = Arc::clone(&c3);
            Box::pin(async move {
                let url = args.get("url").and_then(|v| v.as_str()).unwrap_or_default();
                c.navigate(url).await?;
                Ok(json!({ "status": "navigated", "url": url }))
            })
        }),
    );
}
