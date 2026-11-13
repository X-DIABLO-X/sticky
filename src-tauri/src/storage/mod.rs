pub mod agents_repo;
pub mod memory;

use std::path::Path;
use std::sync::{Arc, Mutex};
use rusqlite::Connection;
use crate::error::{AppError, Result};

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let conn = Connection::open(db_path)
            .map_err(|e| AppError::Storage(format!("Failed to open SQLite database: {}", e)))?;

        // Enable WAL mode for high concurrency
        let _ = conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };

        db.run_migrations()?;
        Ok(db)
    }

    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| AppError::Storage(format!("Failed to open in-memory SQLite: {}", e)))?;
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.run_migrations()?;
        Ok(db)
    }

    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("SQLite mutex poisoned")
    }

    fn run_migrations(&self) -> Result<()> {
        let conn = self.conn();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                system_prompt TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(scope, key)
            );

            CREATE TABLE IF NOT EXISTS dictionary_corrections (
                id TEXT PRIMARY KEY,
                wrong_phrase TEXT NOT NULL,
                right_phrase TEXT NOT NULL,
                app_context TEXT NOT NULL,
                frequency INTEGER DEFAULT 1,
                updated_at TEXT NOT NULL,
                UNIQUE(wrong_phrase, app_context)
            );

            CREATE TABLE IF NOT EXISTS cron_jobs (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                cron_expr TEXT NOT NULL,
                prompt TEXT NOT NULL,
                is_active INTEGER DEFAULT 1,
                created_at TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
            );
            "#,
        )
        .map_err(|e| AppError::Storage(format!("Failed to run database migrations: {}", e)))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::agents_repo::AgentsRepository;
    use super::memory::MemoryRepository;

    #[test]
    fn test_database_migrations_and_agent_crud() {
        let db = Database::in_memory().expect("in-memory db failed");
        let repo = AgentsRepository::new(db.clone());

        let agent = repo.create_agent("Clicky Pro", "Workflow Assistant", "You are Clicky", "C:/tmp/clicky")
            .expect("create agent failed");
        assert_eq!(agent.name, "Clicky Pro");

        let agents = repo.get_agents().expect("get agents failed");
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, agent.id);

        repo.save_message(&agent.id, "user", "Hello Clicky").expect("save message failed");
        repo.save_message(&agent.id, "assistant", "Hello! How can I help?").expect("save msg failed");

        let msgs = repo.get_messages(&agent.id).expect("get messages failed");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].content, "Hello! How can I help?");
    }

    #[test]
    fn test_memory_and_dictionary_corrections() {
        let db = Database::in_memory().expect("in-memory db failed");
        let repo = MemoryRepository::new(db);

        repo.save_memory("preference", "tone", "concise and friendly").expect("save memory failed");
        let memories = repo.get_memories(Some("preference")).expect("get memories failed");
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].key, "tone");
        assert_eq!(memories[0].value, "concise and friendly");

        // Self-learning dictionary hook
        repo.upsert_dictionary_correction("kube control", "kubectl", "terminal").expect("correction 1");
        repo.upsert_dictionary_correction("kube control", "kubectl", "terminal").expect("correction 2"); // increment frequency

        let hotwords = repo.get_dictionary_hotwords().expect("hotwords failed");
        assert!(hotwords.contains(&"kubectl".to_string()));
    }
}
