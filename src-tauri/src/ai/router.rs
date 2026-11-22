use std::sync::Arc;
use tokio::sync::mpsc::Receiver;
use tokio::sync::RwLock;

use crate::ai::providers::{
    gemini::GeminiProvider,
    groq::GroqProvider,
    local_llamacpp::LocalLlamaProvider,
    openai_codex::{OpenAiCodexProvider, DEFAULT_CODEX_MODEL},
    openrouter::OpenRouterProvider,
    ChatChunk, ChatMessage, LlmProvider, ToolDefinition,
};
use crate::config::AppConfig;
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskType {
    DictationCleanup,
    FastTalk,
    ScreenVision,
    GuiDriving,
}

pub struct ModelRouter {
    config: Arc<RwLock<AppConfig>>,
}

impl ModelRouter {
    pub fn new(config: Arc<RwLock<AppConfig>>) -> Self {
        Self { config }
    }

    /// Stream chat with live config resolution, Ollama model auto-discovery, and automatic failover.
    pub async fn route_and_stream(
        &self,
        task: TaskType,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<Receiver<Result<ChatChunk>>> {
        let cfg = self.config.read().await.clone();
        let execution_chain = self.build_execution_chain(&cfg, task).await;

        if execution_chain.is_empty() {
            return Err(AppError::Ai(
                "No AI provider available. Sign in with ChatGPT Codex in Settings, start Ollama locally, or add a free Groq/Gemini/OpenRouter API key in Settings.".into(),
            ));
        }

        let mut errors = Vec::new();
        for (provider, model) in execution_chain {
            eprintln!(
                "[ModelRouter] Attempting task={:?} provider={} model={}",
                task,
                provider.provider_name(),
                model
            );
            match provider.stream_chat(&model, messages, tools).await {
                Ok(rx) => return Ok(rx),
                Err(err) => {
                    eprintln!(
                        "[ModelRouter] Provider {} ({}) failed for task={:?}: {}",
                        provider.provider_name(),
                        model,
                        task,
                        err
                    );
                    errors.push(format!("{}({}): {}", provider.provider_name(), model, err));
                }
            }
        }

        Err(AppError::Ai(format!(
            "All AI providers failed: {}",
            errors.join(" | ")
        )))
    }

    async fn resolve_local_model(
        &self,
        local: &LocalLlamaProvider,
        configured: Option<&str>,
        task: TaskType,
    ) -> Option<String> {
        if !local.check_health().await {
            return None;
        }
        let installed = local.list_models().await.unwrap_or_default();
        if installed.is_empty() {
            return configured.map(|s| s.to_string());
        }
        if let Some(wanted) = configured.filter(|s| !s.trim().is_empty()) {
            if installed.iter().any(|m| m == wanted || m.starts_with(wanted)) {
                return Some(wanted.to_string());
            }
        }
        if matches!(task, TaskType::ScreenVision | TaskType::GuiDriving) {
            if let Some(vision_model) = installed.iter().find(|m| {
                let lower = m.to_ascii_lowercase();
                lower.contains("vision")
                    || lower.contains("-vl")
                    || lower.contains("vl:")
                    || lower.contains("llava")
                    || lower.contains("minicpm-v")
                    || lower.contains("moondream")
                    || lower.contains("gemma3")
                    || lower.contains("gemma4")
                    || lower.contains("bonsai")
                    || lower.contains("qwen2.5vl")
                    || lower.contains("qwen3-vl")
            }) {
                return Some(vision_model.clone());
            }
        }
        // Auto-pick the first installed Ollama model instead of failing with 404
        installed.into_iter().next()
    }

    async fn build_execution_chain(
        &self,
        cfg: &AppConfig,
        task: TaskType,
    ) -> Vec<(Arc<dyn LlmProvider>, String)> {
        let mut chain: Vec<(Arc<dyn LlmProvider>, String)> = Vec::new();

        if OpenAiCodexProvider::is_authenticated() {
            let codex_model = if cfg.codex_model_name.trim().is_empty() {
                DEFAULT_CODEX_MODEL.to_string()
            } else {
                cfg.codex_model_name.trim().to_string()
            };
            let codex: Arc<dyn LlmProvider> = Arc::new(OpenAiCodexProvider::new());
            chain.push((codex, codex_model));
            if cfg.use_chatgpt_codex_only {
                return chain;
            }
        }

        let local = Arc::new(LocalLlamaProvider::new(cfg.local_llama_url.clone()));
        let groq = cfg
            .groq_api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(|k| Arc::new(GroqProvider::new(k.to_string())));
        let gemini = cfg
            .gemini_api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(|k| Arc::new(GeminiProvider::new(k.to_string())));
        let openrouter = cfg
            .openrouter_api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(|k| Arc::new(OpenRouterProvider::new(k.to_string())));

        let local_model = self
            .resolve_local_model(&local, cfg.local_model_name.as_deref(), task)
            .await;

        match task {
            TaskType::DictationCleanup => {
                if let Some(ref g) = groq {
                    chain.push((g.clone(), "qwen/qwen3.8-27b".to_string()));
                    chain.push((g.clone(), "openai/gpt-oss-20b".to_string()));
                }
                if let Some(m) = local_model {
                    chain.push((local.clone(), m));
                }
                if let Some(ref o) = openrouter {
                    chain.push((o.clone(), "openrouter/free".to_string()));
                }
            }
            TaskType::FastTalk => {
                if let Some(ref g) = groq {
                    chain.push((g.clone(), "qwen/qwen3.8-27b".to_string()));
                    chain.push((g.clone(), "openai/gpt-oss-20b".to_string()));
                }
                if let Some(ref gem) = gemini {
                    chain.push((gem.clone(), "gemini-2.5-flash-lite".to_string()));
                }
                if let Some(m) = local_model {
                    chain.push((local.clone(), m));
                }
                if let Some(ref o) = openrouter {
                    chain.push((o.clone(), "google/gemma-4-31b-it:free".to_string()));
                    chain.push((o.clone(), "openrouter/free".to_string()));
                }
            }
            TaskType::ScreenVision | TaskType::GuiDriving => {
                if let Some(ref g) = groq {
                    chain.push((g.clone(), "qwen/qwen3.8-27b".to_string()));
                }
                if let Some(ref gem) = gemini {
                    chain.push((gem.clone(), "gemini-2.5-flash-lite".to_string()));
                    chain.push((gem.clone(), "gemini-2.5-flash".to_string()));
                }
                if let Some(m) = local_model {
                    chain.push((local.clone(), m));
                }
                if let Some(ref o) = openrouter {
                    chain.push((o.clone(), "google/gemma-4-31b-it:free".to_string()));
                }
                if let Some(ref g) = groq {
                    chain.push((g.clone(), "openai/gpt-oss-20b".to_string()));
                }
            }
        }

        chain
    }
}
