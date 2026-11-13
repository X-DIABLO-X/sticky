use std::sync::Arc;
use tokio::sync::mpsc::Receiver;
use crate::ai::providers::{
    gemini::GeminiProvider, groq::GroqProvider, local_llamacpp::LocalLlamaProvider,
    openrouter::OpenRouterProvider, ChatChunk, ChatMessage, LlmProvider, ToolDefinition,
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
    config: AppConfig,
    groq: Option<Arc<GroqProvider>>,
    gemini: Option<Arc<GeminiProvider>>,
    openrouter: Option<Arc<OpenRouterProvider>>,
    local_llama: Arc<LocalLlamaProvider>,
}

impl ModelRouter {
    pub fn new(config: AppConfig) -> Self {
        let groq = config.groq_api_key.as_ref().map(|k| Arc::new(GroqProvider::new(k.clone())));
        let gemini = config.gemini_api_key.as_ref().map(|k| Arc::new(GeminiProvider::new(k.clone())));
        let openrouter = config.openrouter_api_key.as_ref().map(|k| Arc::new(OpenRouterProvider::new(k.clone())));
        let local_llama = Arc::new(LocalLlamaProvider::new(config.local_llama_url.clone()));

        Self {
            config,
            groq,
            gemini,
            openrouter,
            local_llama,
        }
    }

    pub fn update_config(&mut self, config: AppConfig) {
        self.groq = config.groq_api_key.as_ref().map(|k| Arc::new(GroqProvider::new(k.clone())));
        self.gemini = config.gemini_api_key.as_ref().map(|k| Arc::new(GeminiProvider::new(k.clone())));
        self.openrouter = config.openrouter_api_key.as_ref().map(|k| Arc::new(OpenRouterProvider::new(k.clone())));
        self.local_llama = Arc::new(LocalLlamaProvider::new(config.local_llama_url.clone()));
        self.config = config;
    }

    /// Stream chat with automatic fallback failover (e.g. 429 rate limit or connection issue)
    pub async fn route_and_stream(
        &self,
        task: TaskType,
        messages: &[ChatMessage],
        tools: &[ToolDefinition],
    ) -> Result<Receiver<Result<ChatChunk>>> {
        let execution_chain = self.get_execution_chain(task);

        let mut last_err = None;
        for (provider, model) in execution_chain {
            eprintln!("[ModelRouter] Attempting provider {} with model {}", provider.provider_name(), model);
            match provider.stream_chat(&model, messages, tools).await {
                Ok(rx) => return Ok(rx),
                Err(err) => {
                    eprintln!("[ModelRouter] Provider {} failed ({}). Failing over to next...", provider.provider_name(), err);
                    last_err = Some(err);
                }
            }
        }

        Err(last_err.unwrap_or_else(|| AppError::Ai("All model providers in failover chain exhausted".into())))
    }

    fn get_execution_chain(&self, task: TaskType) -> Vec<(Arc<dyn LlmProvider>, String)> {
        let mut chain: Vec<(Arc<dyn LlmProvider>, String)> = Vec::new();
        let local_model = self.config.local_model_name.clone().unwrap_or_else(|| "bonsai-2:9b".to_string());

        match task {
            TaskType::DictationCleanup => {
                // If local Ollama is available, prefer local model for privacy and zero latency
                chain.push((self.local_llama.clone(), local_model.clone()));
                if let Some(ref g) = self.groq {
                    chain.push((g.clone(), "openai/gpt-oss-20b".to_string()));
                }
                if let Some(ref o) = self.openrouter {
                    chain.push((o.clone(), "google/gemma-2-9b-it:free".to_string()));
                }
            }
            TaskType::FastTalk => {
                chain.push((self.local_llama.clone(), local_model.clone()));
                if let Some(ref g) = self.groq {
                    chain.push((g.clone(), "qwen/qwen3.6-27b".to_string()));
                }
                if let Some(ref gem) = self.gemini {
                    chain.push((gem.clone(), "gemini-2.0-flash-exp".to_string()));
                }
                if let Some(ref o) = self.openrouter {
                    chain.push((o.clone(), "google/gemma-2-9b-it:free".to_string()));
                }
            }
            TaskType::ScreenVision => {
                // Bonsai-2 9B supports native vision capabilities!
                chain.push((self.local_llama.clone(), local_model.clone()));
                if let Some(ref gem) = self.gemini {
                    chain.push((gem.clone(), "gemini-2.0-flash-exp".to_string()));
                }
                if let Some(ref o) = self.openrouter {
                    chain.push((o.clone(), "meta-llama/llama-3.2-11b-vision-instruct:free".to_string()));
                }
            }
            TaskType::GuiDriving => {
                chain.push((self.local_llama.clone(), local_model.clone()));
                if let Some(ref gem) = self.gemini {
                    chain.push((gem.clone(), "gemini-2.0-flash-exp".to_string()));
                }
                if let Some(ref g) = self.groq {
                    chain.push((g.clone(), "qwen/qwen3.6-27b".to_string()));
                }
            }
        }

        chain
    }
}
