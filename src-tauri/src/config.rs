use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HardwareProfile {
    CpuOnly,
    GpuLow,
    GpuHigh,
}

impl Default for HardwareProfile {
    fn default() -> Self {
        HardwareProfile::GpuLow
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyConfig {
    pub talk: String,
    pub dictation: String,
    pub pill: String,
    pub quick_input: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            talk: "Ctrl+Space".to_string(),
            dictation: "Alt+Shift+D".to_string(),
            pill: "Ctrl+Alt+A".to_string(),
            quick_input: "Ctrl+Alt+Q".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub hardware_profile: HardwareProfile,
    pub local_llama_url: String,
    pub local_model_name: Option<String>,
    pub groq_api_key: Option<String>,
    pub gemini_api_key: Option<String>,
    pub openrouter_api_key: Option<String>,
    pub hotkeys: HotkeyConfig,
    pub home_dir: PathBuf,
    pub models_dir: PathBuf,
    pub agents_dir: PathBuf,
    pub db_path: PathBuf,
}

impl Default for AppConfig {
    fn default() -> Self {
        let base_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".heyclicky");

        Self {
            hardware_profile: HardwareProfile::default(),
            local_llama_url: "http://127.0.0.1:11434".to_string(),
            local_model_name: Some("bonsai-2:9b".to_string()),
            groq_api_key: std::env::var("GROQ_API_KEY").ok(),
            gemini_api_key: std::env::var("GEMINI_API_KEY").ok(),
            openrouter_api_key: std::env::var("OPENROUTER_API_KEY").ok(),
            hotkeys: HotkeyConfig::default(),
            models_dir: base_dir.join("models"),
            agents_dir: base_dir.join("agents"),
            db_path: base_dir.join("data.db"),
            home_dir: base_dir,
        }
    }
}

impl AppConfig {
    pub fn config_file_path() -> PathBuf {
        let base_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".heyclicky");
        base_dir.join("config.toml")
    }

    pub fn load() -> Result<Self> {
        let path = Self::config_file_path();
        if !path.exists() {
            let default_cfg = Self::default();
            default_cfg.save()?;
            return Ok(default_cfg);
        }

        let content = std::fs::read_to_string(&path)
            .map_err(|e| AppError::Config(format!("Failed to read {}: {}", path.display(), e)))?;

        let mut config: AppConfig = toml::from_str(&content)
            .map_err(|e| AppError::Config(format!("Failed to parse TOML config: {}", e)))?;

        // Fall back to env vars if keys are not present in config
        if config.groq_api_key.is_none() {
            config.groq_api_key = std::env::var("GROQ_API_KEY").ok();
        }
        if config.gemini_api_key.is_none() {
            config.gemini_api_key = std::env::var("GEMINI_API_KEY").ok();
        }
        if config.openrouter_api_key.is_none() {
            config.openrouter_api_key = std::env::var("OPENROUTER_API_KEY").ok();
        }

        config.ensure_directories()?;
        Ok(config)
    }

    pub fn save(&self) -> Result<()> {
        self.ensure_directories()?;
        let path = Self::config_file_path();
        let toml_str = toml::to_string_pretty(self)
            .map_err(|e| AppError::Config(format!("Failed to serialize config: {}", e)))?;

        std::fs::write(&path, toml_str)
            .map_err(|e| AppError::Config(format!("Failed to write config {}: {}", path.display(), e)))?;

        Ok(())
    }

    pub fn ensure_directories(&self) -> Result<()> {
        std::fs::create_dir_all(&self.home_dir)
            .map_err(|e| AppError::Config(format!("Failed to create home dir: {}", e)))?;
        std::fs::create_dir_all(&self.models_dir)
            .map_err(|e| AppError::Config(format!("Failed to create models dir: {}", e)))?;
        std::fs::create_dir_all(&self.agents_dir)
            .map_err(|e| AppError::Config(format!("Failed to create agents dir: {}", e)))?;
        Ok(())
    }
}
