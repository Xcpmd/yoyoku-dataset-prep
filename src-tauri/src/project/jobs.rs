use crate::error::{AppError, AppResult};
use crate::model::JobInfo;
use crate::project::Project;
use crate::state::JobControl;
use crate::util;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub struct JobContext {
    pub app: AppHandle,
    pub project: Arc<Project>,
    pub job_id: String,
    pub control: Arc<JobControl>,
    last_emit: Instant,
    last_status: String,
}

pub struct JobOutcome {
    pub status: String,
    pub result: Value,
}

#[derive(Debug, PartialEq)]
pub enum JobRun {
    Continue,
    Cancelled,
}

pub fn insert_job(
    project: &Project,
    kind: &str,
    title: &str,
    input: &Value,
    total: i64,
) -> AppResult<String> {
    let id = util::new_id();
    let now = util::now_iso();
    project.conn().execute(
        "INSERT INTO jobs(id, kind, title, status, input_json, total, done, failed, progress, checkpoint_json, created_at, updated_at)
         VALUES(?1, ?2, ?3, 'queued', ?4, ?5, 0, 0, 0, '{}', ?6, ?6)",
        params![id, kind, title, serde_json::to_string(input)?, total, now],
    )?;
    Ok(id)
}

pub fn run<F>(app: AppHandle, project: Arc<Project>, job_id: String, body: F)
where
    F: FnOnce(JobContext) -> AppResult<JobOutcome> + Send + 'static,
{
    let control = Arc::new(JobControl::default());
    {
        let state = app.state::<crate::state::AppState>();
        state
            .job_controls
            .lock()
            .insert(job_id.clone(), control.clone());
    }
    let thread_app = app.clone();
    let thread_project = project.clone();
    let thread_job = job_id.clone();
    std::thread::spawn(move || {
        set_status(&thread_project, &thread_job, "running", None, None);
        emit(&thread_app, &thread_project, &thread_job);
        let ctx = JobContext {
            app: thread_app.clone(),
            project: thread_project.clone(),
            job_id: thread_job.clone(),
            control,
            last_emit: Instant::now() - Duration::from_secs(10),
            last_status: "running".into(),
        };
        let outcome = body(ctx);
        match outcome {
            Ok(outcome) => {
                set_status(
                    &thread_project,
                    &thread_job,
                    &outcome.status,
                    None,
                    Some(outcome.result),
                );
            }
            Err(error) => {
                set_status(
                    &thread_project,
                    &thread_job,
                    "failed",
                    Some(error.to_json()),
                    None,
                );
            }
        }
        emit(&thread_app, &thread_project, &thread_job);
        let _ = thread_app.emit("assets:changed", serde_json::json!({ "jobId": thread_job }));
        let state = thread_app.state::<crate::state::AppState>();
        state.job_controls.lock().remove(&thread_job);
    });
}

impl JobContext {
    pub fn new(
        app: AppHandle,
        project: Arc<Project>,
        job_id: String,
        control: Arc<JobControl>,
    ) -> Self {
        Self {
            app,
            project,
            job_id,
            control,
            last_emit: Instant::now() - Duration::from_secs(10),
            last_status: "running".into(),
        }
    }

    pub fn checkpoint(
        &mut self,
        done: i64,
        failed: i64,
        total: i64,
        phase: &str,
        force: bool,
    ) -> AppResult<JobRun> {
        if self.control.cancel.load(Ordering::SeqCst) {
            self.set_cancelled(done, failed, total, phase);
            return Ok(JobRun::Cancelled);
        }
        if self.control.pause.load(Ordering::SeqCst) {
            update_progress(
                &self.project,
                &self.job_id,
                done,
                failed,
                total,
                phase,
                "paused",
            )?;
            self.emit();
            while self.control.pause.load(Ordering::SeqCst)
                && !self.control.cancel.load(Ordering::SeqCst)
            {
                std::thread::sleep(Duration::from_millis(120));
            }
            if self.control.cancel.load(Ordering::SeqCst) {
                self.set_cancelled(done, failed, total, phase);
                return Ok(JobRun::Cancelled);
            }
            set_status(&self.project, &self.job_id, "running", None, None);
            self.emit();
        }
        if force || self.last_emit.elapsed() >= Duration::from_millis(250) {
            update_progress(
                &self.project,
                &self.job_id,
                done,
                failed,
                total,
                phase,
                "running",
            )?;
            self.emit();
        }
        Ok(JobRun::Continue)
    }

    pub fn set_phase(&mut self, phase: &str) -> AppResult<()> {
        self.project.conn().execute(
            "UPDATE jobs SET phase = ?1, updated_at = ?2 WHERE id = ?3",
            params![phase, util::now_iso(), self.job_id],
        )?;
        Ok(())
    }

    fn set_cancelled(&mut self, done: i64, failed: i64, total: i64, phase: &str) {
        let _ = update_progress(
            &self.project,
            &self.job_id,
            done,
            failed,
            total,
            phase,
            "cancelled",
        );
        self.emit();
    }

    fn emit(&mut self) {
        emit(&self.app, &self.project, &self.job_id);
        self.last_emit = Instant::now();
    }
}

fn update_progress(
    project: &Project,
    job_id: &str,
    done: i64,
    failed: i64,
    total: i64,
    phase: &str,
    status: &str,
) -> AppResult<()> {
    let progress = if total > 0 {
        (done as f64 / total as f64).clamp(0.0, 1.0)
    } else {
        0.0
    };
    project.conn().execute(
        "UPDATE jobs SET done = ?1, failed = ?2, total = CASE WHEN ?3 > 0 THEN ?3 ELSE total END,
         progress = ?4, phase = ?5, status = ?6, updated_at = ?7 WHERE id = ?8",
        params![done, failed, total, progress, phase, status, util::now_iso(), job_id],
    )?;
    Ok(())
}

/// 同步执行任务体（用于示例项目等短任务）。
pub fn run_sync<F>(
    app: &AppHandle,
    project: Arc<Project>,
    job_id: String,
    body: F,
) -> AppResult<JobOutcome>
where
    F: FnOnce(JobContext) -> AppResult<JobOutcome>,
{
    set_status(&project, &job_id, "running", None, None);
    emit(app, &project, &job_id);
    let control = Arc::new(JobControl::default());
    let ctx = JobContext::new(app.clone(), project.clone(), job_id.clone(), control);
    let outcome = body(ctx);
    match &outcome {
        Ok(outcome) => set_status(
            &project,
            &job_id,
            &outcome.status,
            None,
            Some(outcome.result.clone()),
        ),
        Err(error) => set_status(&project, &job_id, "failed", Some(error.to_json()), None),
    }
    emit(app, &project, &job_id);
    let _ = app.emit("assets:changed", serde_json::json!({ "jobId": job_id }));
    outcome
}

pub fn set_status(
    project: &Project,
    job_id: &str,
    status: &str,
    error: Option<Value>,
    result: Option<Value>,
) {
    let conn = project.conn();
    let error_text = error.as_ref().map(|v| v.to_string());
    let result_text = result.as_ref().map(|v| v.to_string());
    let _ = conn.execute(
        "UPDATE jobs SET status = ?1, error_json = COALESCE(?2, error_json),
         result_json = COALESCE(?3, result_json), updated_at = ?4,
         progress = CASE WHEN ?1 = 'completed' OR ?1 = 'completed_with_errors' THEN 1.0 ELSE progress END
         WHERE id = ?5",
        params![status, error_text, result_text, util::now_iso(), job_id],
    );
}

pub fn emit(app: &AppHandle, project: &Project, job_id: &str) {
    if let Ok(info) = get_job(project, job_id) {
        let _ = app.emit("job:update", &info);
    }
}

pub fn get_job(project: &Project, job_id: &str) -> AppResult<JobInfo> {
    let conn = project.conn();
    conn.query_row(
        "SELECT id, kind, title, status, total, done, failed, progress, phase, error_json, result_json,
                created_at, updated_at, input_json, checkpoint_json
         FROM jobs WHERE id = ?1",
        params![job_id],
        |row| {
            let error: Option<String> = row.get(9)?;
            let result: Option<String> = row.get(10)?;
            let input: Option<String> = row.get(13)?;
            let checkpoint: Option<String> = row.get(14)?;
            Ok(JobInfo {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                status: row.get(3)?,
                total: row.get(4)?,
                done: row.get(5)?,
                failed: row.get(6)?,
                progress: row.get(7)?,
                phase: row.get(8)?,
                error: error.and_then(|t| serde_json::from_str(&t).ok()),
                result: result.and_then(|t| serde_json::from_str(&t).ok()),
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
                input: input
                    .and_then(|t| serde_json::from_str(&t).ok())
                    .unwrap_or(Value::Null),
                checkpoint: checkpoint
                    .and_then(|t| serde_json::from_str(&t).ok())
                    .unwrap_or(Value::Null),
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("任务"))
}

pub fn list_jobs(project: &Project) -> AppResult<Vec<JobInfo>> {
    let ids: Vec<String> = {
        let conn = project.conn();
        let mut statement = conn.prepare("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 100")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.filter_map(|row| row.ok()).collect()
    };
    let mut jobs = Vec::new();
    for id in ids {
        if let Ok(job) = get_job(project, &id) {
            jobs.push(job);
        }
    }
    Ok(jobs)
}

/// 应用重启后把未完成的任务标记为“待恢复”，由用户显式重试。
pub fn mark_interrupted(project: &Project) -> AppResult<()> {
    let conn = project.conn();
    let error = serde_json::json!({
        "code": "WORKER_INTERRUPTED",
        "message": "应用退出时任务被中断。可重试未完成的部分。",
        "retryable": true
    });
    conn.execute(
        "UPDATE jobs SET status = 'paused', error_json = ?1, phase = '已中断', updated_at = ?2
         WHERE status IN ('running', 'queued')",
        params![error.to_string(), util::now_iso()],
    )?;
    Ok(())
}

pub fn completed_count(project: &Project) -> i64 {
    project
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE status IN ('completed','completed_with_errors')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0)
}
