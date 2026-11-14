use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::error::{AppError, Result};
use crate::storage::Database;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub scope: String,
    pub key: String,
    pub value: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictionaryCorrection {
    pub id: String,
    pub wrong_phrase: String,
    pub right_phrase: String,
    pub app_context: String,
    pub frequency: i64,
    pub updated_at: String,
}

pub struct MemoryRepository {
    db: Database,
}

impl MemoryRepository {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    pub fn save_memory(&self, scope: &str, key: &str, value: &str) -> Result<MemoryEntry> {
        let conn = self.db.conn();
        let now = Utc::now().to_rfc3339();
        let id = Uuid::new_v4().to_string();

        conn.execute(
            r#"
            INSERT INTO memories (id, scope, key, value, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(scope, key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            "#,
            params![id, scope, key, value, now, now],
        )
        .map_err(|e| AppError::Storage(format!("Failed to save memory: {}", e)))?;

        Ok(MemoryEntry {
            id,
            scope: scope.to_string(),
            key: key.to_string(),
            value: value.to_string(),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn get_memories(&self, scope: Option<&str>) -> Result<Vec<MemoryEntry>> {
        let conn = self.db.conn();
        let mut results = Vec::new();

        if let Some(s) = scope {
            let mut stmt = conn
                .prepare("SELECT id, scope, key, value, created_at, updated_at FROM memories WHERE scope = ?1 ORDER BY updated_at DESC")
                .map_err(|e| AppError::Storage(e.to_string()))?;

            let rows = stmt
                .query_map(params![s], |row| {
                    Ok(MemoryEntry {
                        id: row.get(0)?,
                        scope: row.get(1)?,
                        key: row.get(2)?,
                        value: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                })
                .map_err(|e| AppError::Storage(e.to_string()))?;

            for r in rows {
                results.push(r.map_err(|e| AppError::Storage(e.to_string()))?);
            }
        } else {
            let mut stmt = conn
                .prepare("SELECT id, scope, key, value, created_at, updated_at FROM memories ORDER BY updated_at DESC")
                .map_err(|e| AppError::Storage(e.to_string()))?;

            let rows = stmt
                .query_map([], |row| {
                    Ok(MemoryEntry {
                        id: row.get(0)?,
                        scope: row.get(1)?,
                        key: row.get(2)?,
                        value: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                })
                .map_err(|e| AppError::Storage(e.to_string()))?;

            for r in rows {
                results.push(r.map_err(|e| AppError::Storage(e.to_string()))?);
            }
        }

        Ok(results)
    }

    pub fn delete_memory(&self, id: &str) -> Result<()> {
        let conn = self.db.conn();
        conn.execute("DELETE FROM memories WHERE id = ?1", params![id])
            .map_err(|e| AppError::Storage(format!("Failed to delete memory: {}", e)))?;
        Ok(())
    }

    pub fn upsert_dictionary_correction(&self, wrong: &str, right: &str, app_context: &str) -> Result<()> {
        let conn = self.db.conn();
        let now = Utc::now().to_rfc3339();
        let id = Uuid::new_v4().to_string();

        conn.execute(
            r#"
            INSERT INTO dictionary_corrections (id, wrong_phrase, right_phrase, app_context, frequency, updated_at)
            VALUES (?1, ?2, ?3, ?4, 1, ?5)
            ON CONFLICT(wrong_phrase, app_context) DO UPDATE SET
                right_phrase = excluded.right_phrase,
                frequency = frequency + 1,
                updated_at = excluded.updated_at
            "#,
            params![id, wrong, right, app_context, now],
        )
        .map_err(|e| AppError::Storage(format!("Failed to record correction: {}", e)))?;

        Ok(())
    }

    pub fn get_dictionary_hotwords(&self) -> Result<Vec<String>> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare("SELECT right_phrase FROM dictionary_corrections ORDER BY frequency DESC LIMIT 50")
            .map_err(|e| AppError::Storage(e.to_string()))?;

        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| AppError::Storage(e.to_string()))?;

        let mut hotwords = Vec::new();
        for r in rows {
            hotwords.push(r.map_err(|e| AppError::Storage(e.to_string()))?);
        }

        Ok(hotwords)
    }

    pub fn list_memories(&self, scope: Option<&str>) -> Result<Vec<MemoryEntry>> {
        self.get_memories(scope)
    }

    pub fn upsert_memory(&self, scope: &str, key: &str, value: &str) -> Result<MemoryEntry> {
        self.save_memory(scope, key, value)
    }

    pub fn clear_all(&self) -> Result<()> {
        let conn = self.db.conn();
        conn.execute("DELETE FROM memories", [])
            .map_err(|e| AppError::Storage(format!("Failed to clear memories: {e}")))?;
        Ok(())
    }
}
