use crate::db;
use crate::error::{AppError, AppResult};
use crate::project::jobs::{self, JobContext, JobOutcome, JobRun};
use crate::project::Project;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

const JOB_KIND: &str = "metrics";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsBackfillResult {
    pub job_id: String,
    pub total: i64,
}

/// 为旧项目补齐曝光、对比度、饱和度与颜色丰富度；新导入素材已在分析阶段写入。
pub fn start_backfill(app: AppHandle, project: Arc<Project>) -> AppResult<MetricsBackfillResult> {
    let ids: Vec<String> = {
        let conn = project.conn();
        let mut statement = conn.prepare(
            "SELECT id FROM assets
             WHERE json_extract(analysis_json, '$.colorfulness') IS NULL
             ORDER BY sort_index ASC",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.filter_map(|row| row.ok()).collect()
    };
    if ids.is_empty() {
        return Ok(MetricsBackfillResult { job_id: String::new(), total: 0 });
    }
    let total = ids.len() as i64;
    {
        let conn = project.conn();
        let running: Option<String> = conn
            .query_row(
                "SELECT id FROM jobs WHERE kind = ?1 AND status IN ('running','queued','paused') LIMIT 1",
                params![JOB_KIND],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(job_id) = running {
            return Ok(MetricsBackfillResult { job_id, total });
        }
    }
    let job_id = jobs::insert_job(
        &project,
        JOB_KIND,
        &format!("分析图片指标（{} 张）", total),
        &json!({}),
        total,
    )?;
    let job_for_thread = job_id.clone();
    jobs::run(app, project, job_id.clone(), move |ctx| run_backfill(ctx, ids, total));
    Ok(MetricsBackfillResult { job_id: job_for_thread, total })
}

fn run_backfill(mut ctx: JobContext, ids: Vec<String>, total: i64) -> AppResult<JobOutcome> {
    let project = ctx.project.clone();
    let worker_slots = {
        let state = ctx.app.state::<crate::state::AppState>();
        state.worker.worker_count()
    };
    let parallelism = worker_slots.clamp(1, 8).min(ids.len().max(1));
    let chunk_size = (parallelism * 4).max(8);
    let mut done = 0i64;
    let mut updated = 0i64;
    let mut failed = 0i64;
    let mut index = 0usize;

    while index < ids.len() {
        let end = (index + chunk_size).min(ids.len());
        let chunk = &ids[index..end];
        let cursor = std::sync::atomic::AtomicUsize::new(0);
        let outcomes: std::sync::Mutex<Vec<(usize, AppResult<bool>)>> = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..parallelism {
                scope.spawn(|| loop {
                    let offset = cursor.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if offset >= chunk.len() {
                        break;
                    }
                    let result = backfill_one(&project, &ctx.app, &chunk[offset]);
                    outcomes
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push((offset, result));
                });
            }
        });
        let mut results = outcomes
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        results.sort_by_key(|(offset, _)| *offset);
        for (_, result) in results {
            done += 1;
            match result {
                Ok(true) => updated += 1,
                Ok(false) => {}
                Err(_) => failed += 1,
            }
        }
        if let JobRun::Cancelled = ctx.checkpoint(done, failed, total, "分析图片指标", false)? {
            return Ok(JobOutcome {
                status: "cancelled".into(),
                result: json!({ "updated": updated, "failed": failed, "cancelled": true }),
            });
        }
        index = end;
    }
    ctx.checkpoint(done, failed, total, "收尾", true)?;
    Ok(JobOutcome {
        status: if failed > 0 { "completed_with_errors" } else { "completed" }.into(),
        result: json!({ "updated": updated, "failed": failed }),
    })
}

fn backfill_one(project: &Project, app: &AppHandle, id: &str) -> AppResult<bool> {
    let asset = {
        let conn = project.conn();
        db::get_asset(&conn, id)?
    };
    let source = project.source_path(&asset)?;
    if !source.exists() {
        return Err(AppError::new("SOURCE_MISSING", "源文件失联"));
    }
    let analysis = {
        let state = app.state::<crate::state::AppState>();
        state.worker.analyze(&source, None)?
    };
    let mut value: Value = serde_json::from_str(&asset.analysis_json).unwrap_or_else(|_| json!({}));
    value["exposure"] = json!(analysis.exposure);
    value["contrast"] = json!(analysis.contrast);
    value["saturation"] = json!(analysis.saturation);
    value["colorfulness"] = json!(analysis.colorfulness);
    let conn = project.conn();
    conn.execute(
        "UPDATE assets SET analysis_json = ?1 WHERE id = ?2",
        params![serde_json::to_string(&value)?, id],
    )?;
    Ok(true)
}
