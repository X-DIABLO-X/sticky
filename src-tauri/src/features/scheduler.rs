use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio_cron_scheduler::{Job, JobScheduler};
use uuid::Uuid;
use crate::error::{AppError, Result};

pub struct SchedulerService {
    app_handle: AppHandle,
    scheduler: Arc<tokio::sync::Mutex<Option<JobScheduler>>>,
}

impl SchedulerService {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            scheduler: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    pub async fn start(&self) -> Result<()> {
        let sched = JobScheduler::new().await
            .map_err(|e| AppError::Internal(format!("Failed to init JobScheduler: {}", e)))?;

        sched.start().await
            .map_err(|e| AppError::Internal(format!("Failed to start JobScheduler: {}", e)))?;

        let mut guard = self.scheduler.lock().await;
        *guard = Some(sched);

        Ok(())
    }

    pub async fn add_cron_job(
        &self,
        cron_expr: &str,
        agent_id: &str,
        prompt: &str,
    ) -> Result<Uuid> {
        let guard = self.scheduler.lock().await;
        let sched = guard.as_ref()
            .ok_or_else(|| AppError::Internal("Scheduler not started".to_string()))?;

        let app = self.app_handle.clone();
        let a_id = agent_id.to_string();
        let pr = prompt.to_string();

        let job = Job::new_async(cron_expr, move |_uuid, _lock| {
            let app_clone = app.clone();
            let agent_clone = a_id.clone();
            let prompt_clone = pr.clone();

            Box::pin(async move {
                eprintln!("[Scheduler] Triggering recurring Clicky routine for agent: {}", agent_clone);
                let _ = app_clone.emit("scheduler:trigger", serde_json::json!({
                    "agent_id": agent_clone,
                    "prompt": prompt_clone
                }));
            })
        })
        .map_err(|e| AppError::Internal(format!("Invalid cron expression '{}': {}", cron_expr, e)))?;

        let job_id = sched.add(job).await
            .map_err(|e| AppError::Internal(format!("Failed to schedule cron job: {}", e)))?;

        Ok(job_id)
    }

    pub async fn remove_cron_job(&self, job_id: &Uuid) -> Result<()> {
        let guard = self.scheduler.lock().await;
        if let Some(ref sched) = *guard {
            sched.remove(job_id).await
                .map_err(|e| AppError::Internal(format!("Failed to remove job: {}", e)))?;
        }
        Ok(())
    }
}
