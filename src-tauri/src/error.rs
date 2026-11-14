use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Audio error: {0}")]
    Audio(String),
    #[error("Screen capture error: {0}")]
    Screen(String),
    #[error("Accessibility error: {0}")]
    A11y(String),
    #[error("AI provider error: {0}")]
    Ai(String),
    #[error("Tool execution error: {0}")]
    Tool(String),
    #[error("Storage error: {0}")]
    Storage(String),
    #[error("Config error: {0}")]
    Config(String),
    #[error("UI error: {0}")]
    Ui(String),
    #[error("Input simulation error: {0}")]
    Input(String),
    #[error("Network error: {0}")]
    Network(String),
    #[error("Drive watchdog aborted: {0}")]
    DriveAborted(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::Storage(err.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Internal(err.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        AppError::Ai(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::Internal(err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
