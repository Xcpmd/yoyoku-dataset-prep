use crate::db;
use crate::error::{AppError, AppResult};
use crate::model::TransformPlan;
use crate::project::jobs::{self, JobContext, JobOutcome, JobRun};
use crate::project::{transform, Project};
use crate::state::AppState;
use rusqlite::params_from_iter;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub const JOB_KIND: &str = "crop";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropApplyRequest {
    pub asset_ids: Vec<String>,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub collection_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropApplyStart {
    pub job_id: String,
    pub total: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CropRunMarker {
    completed_at: String,
    width: u32,
    height: u32,
}

fn crop_marker_key(collection_id: &str) -> String {
    format!("crop.last-run.{collection_id}")
}

fn load_crop_marker(project: &Project, collection_id: &str) -> Option<CropRunMarker> {
    if let Some(marker) = db::meta_get(&project.conn(), &crop_marker_key(collection_id))
        .and_then(|value| serde_json::from_str(&value).ok())
    {
        return Some(marker);
    }

    // 兼容功能上线前已经完成的裁切任务，任务记录保留时可直接恢复增量基准。
    let conn = project.conn();
    let mut statement = conn
        .prepare(
            "SELECT input_json, updated_at FROM jobs
             WHERE kind = 'crop' AND status IN ('completed', 'completed_with_errors')
             ORDER BY updated_at DESC",
        )
        .ok()?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()?;
    for row in rows.flatten() {
        let (input_json, updated_at) = row;
        let Ok(input) = serde_json::from_str::<serde_json::Value>(&input_json) else {
            continue;
        };
        if input.get("collectionId").and_then(|value| value.as_str()) != Some(collection_id) {
            continue;
        }
        let Some(width) = input.get("width").and_then(|value| value.as_u64()) else {
            continue;
        };
        let Some(height) = input.get("height").and_then(|value| value.as_u64()) else {
            continue;
        };
        return Some(CropRunMarker {
            completed_at: updated_at,
            width: width as u32,
            height: height as u32,
        });
    }
    None
}

fn select_assets_for_run(
    project: &Project,
    asset_ids: &[String],
    collection_id: Option<&str>,
    width: u32,
    height: u32,
) -> AppResult<Vec<String>> {
    let Some(collection_id) = collection_id else {
        return Ok(asset_ids.to_vec());
    };
    let Some(marker) = load_crop_marker(project, collection_id) else {
        return Ok(asset_ids.to_vec());
    };

    // 修改目标尺寸后，原分组内的所有图片都需要重新生成。
    if marker.width != width || marker.height != height {
        return Ok(asset_ids.to_vec());
    }

    let conn = project.conn();
    let mut selected = Vec::new();
    for chunk in asset_ids.chunks(400) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT a.id, a.out_width, a.out_height, tr.created_at
             FROM assets a
             LEFT JOIN transform_revisions tr ON tr.id = a.transform_revision_id
             WHERE a.id IN ({placeholders})"
        );
        let mut statement = conn.prepare(&sql)?;
        let rows =
            statement.query_map(params_from_iter(chunk.iter().map(String::as_str)), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?;
        for row in rows {
            let (id, out_width, out_height, transform_at) = row?;
            let changed_after_last_run = transform_at
                .as_deref()
                .map(|created_at| created_at > marker.completed_at.as_str())
                .unwrap_or(false);
            if out_width != width as i64 || out_height != height as i64 || changed_after_last_run {
                selected.push(id);
            }
        }
    }
    Ok(selected)
}

fn record_crop_marker(
    project: &Project,
    collection_id: &str,
    width: u32,
    height: u32,
) -> AppResult<()> {
    let marker = CropRunMarker {
        completed_at: crate::util::now_iso(),
        width,
        height,
    };
    db::meta_set(
        &project.conn(),
        &crop_marker_key(collection_id),
        &serde_json::to_string(&marker)?,
    )
}

/// 启动分组批量裁切任务：逐张套用 fitCrop 目标尺寸，并在任务中心上报进度。
pub fn start(
    app: AppHandle,
    project: Arc<Project>,
    req: CropApplyRequest,
) -> AppResult<CropApplyStart> {
    let mut seen = std::collections::HashSet::new();
    let asset_ids: Vec<String> = req
        .asset_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty() && seen.insert(id.clone()))
        .collect();
    if asset_ids.is_empty() {
        return Err(AppError::new("EMPTY_SCOPE", "当前分组没有可裁切的图片"));
    }
    if !(64..=8192).contains(&req.width) || !(64..=8192).contains(&req.height) {
        return Err(AppError::new(
            "INVALID_CONFIG",
            "裁切目标尺寸需在 64–8192 之间",
        ));
    }

    let collection_id = req.collection_id;
    let asset_ids = select_assets_for_run(
        &project,
        &asset_ids,
        collection_id.as_deref(),
        req.width,
        req.height,
    )?;
    if asset_ids.is_empty() {
        return Err(AppError::new(
            "NO_CHANGED_IMAGES",
            "该分组没有检测到已保存的修改图片，无需重复裁切",
        ));
    }

    let total = asset_ids.len() as i64;
    let title = req
        .title
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| format!("裁切 {} 张图片", total));
    let job_id = jobs::insert_job(
        &project,
        JOB_KIND,
        &title,
        &json!({
            "collectionId": collection_id.clone(),
            "width": req.width,
            "height": req.height,
            "total": total,
        }),
        total,
    )?;
    let start = CropApplyStart {
        job_id: job_id.clone(),
        total,
    };
    let width = req.width;
    let height = req.height;
    jobs::run(app, project, job_id, move |ctx| {
        run_apply(ctx, asset_ids, width, height, collection_id)
    });
    Ok(start)
}

fn run_apply(
    mut ctx: JobContext,
    asset_ids: Vec<String>,
    width: u32,
    height: u32,
    collection_id: Option<String>,
) -> AppResult<JobOutcome> {
    let total = asset_ids.len() as i64;
    let project = ctx.project.clone();
    let app = ctx.app.clone();
    let mut done = 0i64;
    let mut success = 0i64;
    let mut failed = 0i64;
    let mut errors: Vec<serde_json::Value> = Vec::new();

    for asset_id in asset_ids {
        match apply_one(&project, &app, &asset_id, width, height) {
            Ok(()) => success += 1,
            Err(error) => {
                failed += 1;
                if errors.len() < 200 {
                    errors.push(json!({
                        "itemId": asset_id,
                        "path": asset_id,
                        "message": error.message,
                    }));
                }
            }
        }
        done += 1;
        if let JobRun::Cancelled = ctx.checkpoint(done, failed, total, "裁切中", false)? {
            return Ok(JobOutcome {
                status: "cancelled".into(),
                result: json!({
                    "success": success,
                    "failed": failed,
                    "cancelled": true,
                    "errors": errors,
                    "collectionId": collection_id,
                    "width": width,
                    "height": height,
                }),
            });
        }
    }

    ctx.checkpoint(done, failed, total, "收尾", true)?;
    let marker_warning = if failed == 0 {
        collection_id.as_deref().and_then(|collection_id| {
            record_crop_marker(&project, collection_id, width, height)
                .err()
                .map(|error| error.message)
        })
    } else {
        None
    };
    Ok(JobOutcome {
        status: if failed > 0 {
            "completed_with_errors"
        } else {
            "completed"
        }
        .into(),
        result: json!({
            "success": success,
            "failed": failed,
            "errors": errors,
            "collectionId": collection_id,
            "width": width,
            "height": height,
            "incrementalMarkerWarning": marker_warning,
        }),
    })
}

fn apply_one(
    project: &Project,
    app: &AppHandle,
    asset_id: &str,
    width: u32,
    height: u32,
) -> AppResult<()> {
    let (asset, plan) = load_asset_plan(project, asset_id)?;
    let plan = with_target(plan, width, height);
    let result = {
        let state = app.state::<AppState>();
        transform::save(project, &state.worker, asset_id, &plan, asset.revision)
    };
    match result {
        Ok(_) => Ok(()),
        Err(error) if error.code == "REVISION_CONFLICT" => {
            // 其他页面刚改过同一张图时，重新读取最新版本与配方后再试一次。
            let (asset, plan) = load_asset_plan(project, asset_id)?;
            let plan = with_target(plan, width, height);
            let state = app.state::<AppState>();
            transform::save(project, &state.worker, asset_id, &plan, asset.revision)?;
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn load_asset_plan(project: &Project, asset_id: &str) -> AppResult<(db::AssetRow, TransformPlan)> {
    let conn = project.conn();
    let asset = db::get_asset(&conn, asset_id)?;
    let plan = transform::applied_plan(&conn, &asset)?;
    Ok((asset, plan))
}

fn with_target(mut plan: TransformPlan, width: u32, height: u32) -> TransformPlan {
    plan.scale_mode = "fitCrop".into();
    plan.width = Some(width);
    plan.height = Some(height);
    plan.allow_upscale = true;
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_size_keeps_existing_crop_and_allows_upscale() {
        let mut plan = TransformPlan::default();
        plan.crop.x = 0.1;
        plan.crop.y = 0.2;
        plan.crop.w = 0.5;
        plan.crop.h = 0.6;
        plan.rotation = 90;
        plan.allow_upscale = false;
        let next = with_target(plan, 1024, 768);
        assert_eq!(next.scale_mode, "fitCrop");
        assert_eq!(next.width, Some(1024));
        assert_eq!(next.height, Some(768));
        assert!(next.allow_upscale);
        assert_eq!(next.rotation, 90);
        assert_eq!(next.crop.w, 0.5);
    }
}
