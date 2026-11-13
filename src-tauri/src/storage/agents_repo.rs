use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::error::{AppError, Result};
use crate::storage::Database;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentModel {
    pub id: String,
    pub name: String,
    pub role: String,
    pub system_prompt: String,
    pub workspace_path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageModel {
    pub id: String,
    pub agent_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronJobModel {
    pub id: String,
    pub agent_id: String,
    pub cron_expr: String,
    pub prompt: String,
    pub is_active: bool,
    pub created_at: String,
}

pub struct AgentsRepository {
    db: Database,
}

impl AgentsRepository {
    pub fn new(db: Database) -> Self {
        let repo = Self { db };
        let _ = repo.ensure_defaults();
        repo
    }

    fn ensure_defaults(&self) -> Result<()> {
        let conn = self.db.conn();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agents", [], |r| r.get(0))
            .unwrap_or(0);
        if count == 0 {
            let now = Utc::now().to_rfc3339();
            let _ = conn.execute(
                "INSERT INTO agents (id, name, role, system_prompt, workspace_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    "clicky-code",
                    "Coding Clicky",
                    "Fullstack Architecture & Code Automation",
                    "You are an elite autonomous coding agent with full local terminal and desktop access powered by bonsai-2:9b.",
                    "D:\\cliky",
                    now
                ],
            );
            let _ = conn.execute(
                "INSERT INTO agents (id, name, role, system_prompt, workspace_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    "clicky-research",
                    "Research Clicky",
                    "Deep Web Research & Synthesis",
                    "Synthesize complex documentation and inspect online resources with bonsai-2:9b.",
                    "D:\\cliky\\docs",
                    now
                ],
            );
        }
        Ok(())
    }

    pub fn create_agent(
        &self,
        name: &str,
        role: &str,
        system_prompt: &str,
        workspace_path: &str,
    ) -> Result<AgentModel> {
        let conn = self.db.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            r#"
            INSERT INTO agents (id, name, role, system_prompt, workspace_path, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![id, name, role, system_prompt, workspace_path, now],
        )
        .map_err(|e| AppError::Storage(format!("Failed to create agent: {}", e)))?;

        Ok(AgentModel {
            id,
            name: name.to_string(),
            role: role.to_string(),
            system_prompt: system_prompt.to_string(),
            workspace_path: workspace_path.to_string(),
            created_at: now,
        })
    }

    pub fn get_agents(&self) -> Result<Vec<AgentModel>> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare("SELECT id, name, role, system_prompt, workspace_path, created_at FROM agents ORDER BY created_at DESC")
            .map_err(|e| AppError::Storage(e.to_string()))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(AgentModel {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    role: row.get(2)?,
                    system_prompt: row.get(3)?,
                    workspace_path: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| AppError::Storage(e.to_string()))?;

        let mut agents = Vec::new();
        for r in rows {
            agents.push(r.map_err(|e| AppError::Storage(e.to_string()))?);
        }

        Ok(agents)
    }

    pub fn get_agent(&self, id: &str) -> Result<Option<AgentModel>> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare("SELECT id, name, role, system_prompt, workspace_path, created_at FROM agents WHERE id = ?1")
            .map_err(|e| AppError::Storage(e.to_string()))?;

        let mut rows = stmt
            .query_map(params![id], |row| {
                Ok(AgentModel {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    role: row.get(2)?,
                    system_prompt: row.get(3)?,
                    workspace_path: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| AppError::Storage(e.to_string()))?;

        if let Some(res) = rows.next() {
            Ok(Some(res.map_err(|e| AppError::Storage(e.to_string()))?))
        } else {
            Ok(None)
        }
    }

    pub fn save_message(&self, agent_id: &str, role: &str, content: &str) -> Result<MessageModel> {
        let conn = self.db.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            r#"
            INSERT INTO messages (id, agent_id, role, content, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![id, agent_id, role, content, now],
        )
        .map_err(|e| AppError::Storage(format!("Failed to save message: {}", e)))?;

        Ok(MessageModel {
            id,
            agent_id: agent_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            created_at: now,
        })
    }

    pub fn get_messages(&self, agent_id: &str) -> Result<Vec<MessageModel>> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare("SELECT id, agent_id, role, content, created_at FROM messages WHERE agent_id = ?1 ORDER BY created_at ASC")
            .map_err(|e| AppError::Storage(e.to_string()))?;

        let rows = stmt
            .query_map(params![agent_id], |row| {
                Ok(MessageModel {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| AppError::Storage(e.to_string()))?;

        let mut messages = Vec::new();
        for r in rows {
            messages.push(r.map_err(|e| AppError::Storage(e.to_string()))?);
        }

        Ok(messages)
    }

    pub fn add_cron_job(&self, agent_id: &str, cron_expr: &str, prompt: &str) -> Result<CronJobModel> {
        let conn = self.db.conn();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            r#"
            INSERT INTO cron_jobs (id, agent_id, cron_expr, prompt, is_active, created_at)
            VALUES (?1, ?2, ?3, ?4, 1, ?5)
            "#,
            params![id, agent_id, cron_expr, prompt, now],
        )
        .map_err(|e| AppError::Storage(format!("Failed to add cron job: {}", e)))?;

        Ok(CronJobModel {
            id,
            agent_id: agent_id.to_string(),
            cron_expr: cron_expr.to_string(),
            prompt: prompt.to_string(),
            is_active: true,
            created_at: now,
        })
    }

    pub fn get_cron_jobs(&self) -> Result<Vec<CronJobModel>> {
        let conn = self.db.conn();
        let mut stmt = conn
            .prepare("SELECT id, agent_id, cron_expr, prompt, is_active, created_at FROM cron_jobs ORDER BY created_at DESC")
            .map_err(|e| AppError::Storage(e.to_string()))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(CronJobModel {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    cron_expr: row.get(2)?,
                    prompt: row.get(3)?,
                    is_active: row.get::<_, i64>(4)? == 1,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| AppError::Storage(e.to_string()))?;

        let mut jobs = Vec::new();
        for r in rows {
            jobs.push(r.map_err(|e| AppError::Storage(e.to_string()))?);
        }

        Ok(jobs)
    }
}
