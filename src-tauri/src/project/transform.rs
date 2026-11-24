use crate::db::{self, AssetRow};
use crate::error::{AppError, AppResult};
use crate::model::{Geometry, TransformData, TransformPlan};
use crate::project::history::{self, snapshot_asset};
use crate::project::Project;
use crate::util;
use crate::worker::WorkerPool;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

fn round_half_up(value: f64) -> u32 {
    value.max(0.0).round() as u32
}

/// 预览、质检、导出共用的几何计算。裁剪矩形位于旋转/翻转后的画面坐标。
pub fn compute_geometry(plan: &TransformPlan, norm_w: u32, norm_h: u32) -> Geometry {
    let plan = plan.clone().sanitized();
    let norm_w = norm_w.max(1) as f64;
    let norm_h = norm_h.max(1) as f64;
    let (mut width, mut height) = if matches!(plan.rotation, 90 | 270) {
        (norm_h, norm_w)
    } else {
        (norm_w, norm_h)
    };
    width = width.max(1.0);
    height = height.max(1.0);

    let crop = plan.crop;
    let x0 = (crop.x * width).floor().clamp(0.0, width - 1.0);
    let y0 = (crop.y * height).floor().clamp(0.0, height - 1.0);
    let x1 = ((crop.x + crop.w) * width)
        .ceil()
        .clamp(x0 + 1.0, width);
    let y1 = ((crop.y + crop.h) * height)
        .ceil()
        .clamp(y0 + 1.0, height);
    let crop_w = (x1 - x0).max(1.0);
    let crop_h = (y1 - y0).max(1.0);
    let crop_ratio = (1.0 - (crop_w * crop_h) / (width * height)).clamp(0.0, 1.0);

    let mut blocked = false;
    let mut blocked_reason: Option<String> = None;
    let mut pad_ratio = 0.0f64;
    let mut scale = 1.0f64;
    let (out_w, out_h, scaled_w, scaled_h) = match plan.scale_mode.as_str() {
        "fitCrop" => {
            let target_w = plan.width.unwrap_or(0).max(1) as f64;
            let target_h = plan.height.unwrap_or(0).max(1) as f64;
            let needed = (target_w / crop_w).max(target_h / crop_h);
            scale = needed;
            if needed > 1.0 && !plan.allow_upscale {
                blocked = true;
                blocked_reason = Some(format!(
                    "目标 {}×{} 需要放大（{:.0}%），当前设置禁止放大",
                    target_w as u32,
                    target_h as u32,
                    (needed - 1.0) * 100.0
                ));
            }
            (
                target_w as u32,
                target_h as u32,
                round_half_up(crop_w * needed).max(1),
                round_half_up(crop_h * needed).max(1),
            )
        }
        "fitPad" => {
            let target_w = plan.width.unwrap_or(0).max(1) as f64;
            let target_h = plan.height.unwrap_or(0).max(1) as f64;
            let mut needed = (target_w / crop_w).min(target_h / crop_h);
            if needed > 1.0 && !plan.allow_upscale {
                needed = 1.0;
            }
            scale = needed;
            let scaled_w = round_half_up(crop_w * needed).max(1);
            let scaled_h = round_half_up(crop_h * needed).max(1);
            pad_ratio = (1.0 - (scaled_w as f64 * scaled_h as f64) / (target_w * target_h))
                .clamp(0.0, 1.0);
            (target_w as u32, target_h as u32, scaled_w, scaled_h)
        }
        _ => {
            if let Some(edge) = plan.longest_edge.filter(|v| *v > 0) {
                let needed = edge as f64 / crop_w.max(crop_h);
                scale = if plan.allow_upscale {
                    needed
                } else {
                    needed.min(1.0)
                };
            }
            let scaled_w = round_half_up(crop_w * scale).max(1);
            let scaled_h = round_half_up(crop_h * scale).max(1);
            (scaled_w, scaled_h, scaled_w, scaled_h)
        }
    };

    Geometry {
        out_width: out_w,
        out_height: out_h,
        crop_width: crop_w as u32,
        crop_height: crop_h as u32,
        scaled_width: scaled_w,
        scaled_height: scaled_h,
        crop_ratio,
        pad_ratio,
        scale_ratio: scale,
        blocked,
        blocked_reason,
    }
}

fn plan_hash(plan: &TransformPlan, source_hash: &str) -> String {
    let text = serde_json::to_string(plan).unwrap_or_default();
    util::sha256_text(&format!("{source_hash}:{text}"))
}

fn revision_plan(conn: &rusqlite::Connection, revision_id: Option<&str>) -> AppResult<Option<(TransformPlan, String)>> {
    let Some(revision_id) = revision_id else {
        return Ok(None);
    };
    let result = conn
        .query_row(
            "SELECT plan_json, plan_hash FROM transform_revisions WHERE id = ?1",
            params![revision_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    Ok(result.and_then(|(json, hash)| {
        serde_json::from_str::<TransformPlan>(&json)
            .ok()
            .map(|plan| (plan, hash))
    }))
}

pub fn transform_data(project: &Project, asset: &AssetRow) -> AppResult<TransformData> {
    let conn = project.conn();
    let current = revision_plan(&conn, asset.transform_revision_id.as_deref())?;
    let draft = revision_plan(&conn, asset.draft_transform_revision_id.as_deref())?;
    let created_at: Option<String> = asset
        .transform_revision_id
        .as_deref()
        .map(|id| {
            conn.query_row(
                "SELECT created_at FROM transform_revisions WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten()
        })
        .unwrap_or(None);
    Ok(TransformData {
        revision_id: asset.transform_revision_id.clone(),
        plan: current.as_ref().map(|(p, _)| p.clone()).unwrap_or_default(),
        draft: draft.as_ref().map(|(p, _)| p.clone()),
        draft_revision_id: asset.draft_transform_revision_id.clone(),
        created_at,
        plan_hash: current.as_ref().map(|(_, h)| h.clone()),
        source_hash: Some(asset.content_hash.clone()),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformPreview {
    pub preview_url: String,
    pub geometry: Geometry,
    pub cached: bool,
    pub plan_hash: String,
}

pub fn preview(
    project: &Project,
    worker: &WorkerPool,
    asset_id: &str,
    plan: &TransformPlan,
    max_side: u32,
) -> AppResult<TransformPreview> {
    let plan = plan.clone().sanitized();
    let asset = {
        let conn = project.conn();
        db::get_asset(&conn, asset_id)?
    };
    let source = project.require_source(&asset)?;
    let geometry = compute_geometry(&plan, asset.norm_width, asset.norm_height);
    let hash = util::sha256_text(&format!(
        "{}:{}:{}",
        asset.content_hash,
        serde_json::to_string(&plan)?,
        max_side
    ));
    let out = project.previews_dir().join(format!("{hash}.jpg"));
    let cached = out.exists();
    if !cached {
        worker.render_interactive(
            &source,
            &plan,
            &out,
            Some(max_side.max(64)),
            Some("jpg"),
            180,
        )?;
    }
    Ok(TransformPreview {
        preview_url: format!("/preview/{hash}.jpg"),
        geometry,
        cached,
        plan_hash: hash,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformSaveResult {
    pub revision_id: String,
    pub plan_hash: String,
    pub geometry: Geometry,
    pub asset_revision: i64,
    pub thumb_version: String,
    pub review_reset: bool,
    pub warning: Option<String>,
    pub history_seq: i64,
}

/// 为变换生成并写入缩略图缓存；返回版本号。
pub fn regenerate_thumb(
    project: &Project,
    worker: &WorkerPool,
    asset: &AssetRow,
    plan: &TransformPlan,
    revision_id: &str,
) -> AppResult<String> {
    let source = project.require_source(asset)?;
    let version = format!("{}-{}", &asset.content_hash[..10], revision_id);
    let path = project.thumb_path(&asset.id, &version);
    worker.thumbnail(&source, Some(plan), &path, 640)?;
    Ok(version)
}

pub fn save(
    project: &Project,
    worker: &WorkerPool,
    asset_id: &str,
    plan: &TransformPlan,
    expected_revision: i64,
) -> AppResult<TransformSaveResult> {
    let plan = plan.clone().sanitized();
    let asset = {
        let conn = project.conn();
        db::get_asset(&conn, asset_id)?
    };
    if asset.revision != expected_revision {
        return Err(AppError::revision_conflict(asset.revision));
    }
    let source = project.require_source(&asset)?;
    let geometry = compute_geometry(&plan, asset.norm_width, asset.norm_height);
    let hash = plan_hash(&plan, &asset.content_hash);
    let revision_id = util::new_id();
    let now = util::now_iso();

    // 几何由共享计划函数计算，Python 工作进程使用同一公式渲染。
    let _ = &source;

    let (thumb_version, warning) = match regenerate_thumb(project, worker, &asset, &plan, &revision_id) {
        Ok(version) => (version, None),
        Err(error) => (
            asset.thumb_version.clone(),
            Some(format!("处理配方已保存，但缩略图生成失败：{}", error.message)),
        ),
    };

    let (next_status, reset) = history::review_reset_on_change(&asset.review_status);
    let mut conn = project.conn();
    let before = snapshot_asset(&conn, asset_id)?;
    let revision_no: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(revision_no), 0) + 1 FROM transform_revisions WHERE asset_id = ?1",
            params![asset_id],
            |row| row.get(0),
        )?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO transform_revisions(id, asset_id, revision_no, kind, plan_json, plan_hash, source_hash,
            out_width, out_height, crop_ratio, pad_ratio, scale_ratio, base_revision_id, created_at)
         VALUES(?1, ?2, ?3, 'applied', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            revision_id,
            asset_id,
            revision_no,
            serde_json::to_string(&plan)?,
            hash,
            asset.content_hash,
            geometry.out_width,
            geometry.out_height,
            geometry.crop_ratio,
            geometry.pad_ratio,
            geometry.scale_ratio,
            asset.transform_revision_id,
            now
        ],
    )?;
    if let Some(draft_id) = &asset.draft_transform_revision_id {
        tx.execute("DELETE FROM transform_revisions WHERE id = ?1", params![draft_id])?;
    }
    tx.execute(
        "UPDATE assets SET transform_revision_id = ?1, draft_transform_revision_id = NULL,
            out_width = ?2, out_height = ?3, crop_ratio = ?4, pad_ratio = ?5, scale_ratio = ?6,
            thumb_version = ?7, revision = revision + 1, last_human_at = ?8,
            review_status = CASE WHEN review_status = 'approved' THEN ?9 ELSE review_status END
         WHERE id = ?10",
        params![
            revision_id,
            geometry.out_width,
            geometry.out_height,
            geometry.crop_ratio,
            geometry.pad_ratio,
            geometry.scale_ratio,
            thumb_version,
            now,
            next_status,
            asset_id
        ],
    )?;
    tx.commit()?;
    let after = snapshot_asset(&conn, asset_id)?;
    let label = if reset {
        "提交处理配方（已通过 → 待审核）"
    } else {
        "提交处理配方"
    };
    let seq = history::record(
        &conn,
        "transform.save",
        label,
        &[asset_id.to_string()],
        &crate::project::history::HistoryState { assets: vec![before], memberships: vec![] },
        &crate::project::history::HistoryState { assets: vec![after], memberships: vec![] },
        None,
    )?;
    db::mark_quality_stale(&conn)?;
    let asset_revision = db::get_asset(&conn, asset_id)?.revision;
    Ok(TransformSaveResult {
        revision_id,
        plan_hash: hash,
        geometry,
        asset_revision,
        thumb_version,
        review_reset: reset,
        warning,
        history_seq: seq,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSaveResult {
    pub draft_revision_id: Option<String>,
    pub saved_at: Option<String>,
}

pub fn save_draft(
    project: &Project,
    asset_id: &str,
    plan: &TransformPlan,
) -> AppResult<DraftSaveResult> {
    let plan = plan.clone().sanitized();
    let mut conn = project.conn();
    let asset = db::get_asset(&conn, asset_id)?;
    let hash = plan_hash(&plan, &asset.content_hash);
    let now = util::now_iso();
    let tx = conn.transaction()?;
    let draft_id = if let Some(existing) = asset.draft_transform_revision_id.clone() {
        tx.execute(
            "UPDATE transform_revisions SET plan_json = ?1, plan_hash = ?2, out_width = NULL,
             out_height = NULL, created_at = ?3 WHERE id = ?4",
            params![serde_json::to_string(&plan)?, hash, now, existing],
        )?;
        existing
    } else {
        let revision_no: i64 = tx.query_row(
            "SELECT COALESCE(MAX(revision_no), 0) + 1 FROM transform_revisions WHERE asset_id = ?1",
            params![asset_id],
            |row| row.get(0),
        )?;
        let id = util::new_id();
        tx.execute(
            "INSERT INTO transform_revisions(id, asset_id, revision_no, kind, plan_json, plan_hash,
                source_hash, base_revision_id, created_at)
             VALUES(?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                asset_id,
                revision_no,
                serde_json::to_string(&plan)?,
                hash,
                asset.content_hash,
                asset.transform_revision_id,
                now
            ],
        )?;
        id
    };
    tx.execute(
        "UPDATE assets SET draft_transform_revision_id = ?1 WHERE id = ?2",
        params![draft_id, asset_id],
    )?;
    tx.commit()?;
    Ok(DraftSaveResult {
        draft_revision_id: Some(draft_id),
        saved_at: Some(now),
    })
}

pub fn clear_draft(project: &Project, asset_id: &str) -> AppResult<()> {
    let mut conn = project.conn();
    let asset = db::get_asset(&conn, asset_id)?;
    let tx = conn.transaction()?;
    if let Some(draft_id) = &asset.draft_transform_revision_id {
        tx.execute("DELETE FROM transform_revisions WHERE id = ?1", params![draft_id])?;
    }
    tx.execute(
        "UPDATE assets SET draft_transform_revision_id = NULL WHERE id = ?1",
        params![asset_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// 工作台画布使用的预览图（仅 EXIF/ICC 归正，保留透明通道）。
pub fn ensure_display(project: &Project, worker: &WorkerPool, asset: &AssetRow) -> AppResult<String> {
    let version = format!("src-{}", &asset.content_hash[..10]);
    let path = project.display_path(&asset.id, &version);
    if !path.exists() {
        let source = project.require_source(asset)?;
        worker.display(&source, &path, 1600)?;
    }
    Ok(format!("/display/{}/{}.webp", asset.id, version))
}

pub fn insert_initial_revision(
    conn: &rusqlite::Connection,
    asset_id: &str,
    source_hash: &str,
    plan: &TransformPlan,
) -> AppResult<String> {
    let id = util::new_id();
    let hash = plan_hash(plan, source_hash);
    conn.execute(
        "INSERT INTO transform_revisions(id, asset_id, revision_no, kind, plan_json, plan_hash, source_hash, created_at)
         VALUES(?1, ?2, 1, 'applied', ?3, ?4, ?5, ?6)",
        params![id, asset_id, serde_json::to_string(plan)?, hash, source_hash, util::now_iso()],
    )?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CropRect;

    #[test]
    fn preserve_longest_edge_downscales_without_upscale() {
        let mut plan = TransformPlan::default();
        plan.longest_edge = Some(512);
        let geometry = compute_geometry(&plan, 400, 300);
        assert_eq!((geometry.out_width, geometry.out_height), (400, 300));
        assert!(!geometry.blocked);
        let geometry = compute_geometry(&plan, 2048, 1024);
        assert_eq!((geometry.out_width, geometry.out_height), (512, 256));
    }

    #[test]
    fn fixed_crop_blocks_when_upscale_disabled() {
        let mut plan = TransformPlan::default();
        plan.scale_mode = "fitCrop".into();
        plan.width = Some(512);
        plan.height = Some(512);
        let geometry = compute_geometry(&plan, 400, 300);
        assert_eq!((geometry.out_width, geometry.out_height), (512, 512));
        assert!(geometry.blocked);
        assert!(geometry.blocked_reason.is_some());
    }

    #[test]
    fn fixed_pad_keeps_target_and_reports_padding() {
        let mut plan = TransformPlan::default();
        plan.scale_mode = "fitPad".into();
        plan.width = Some(512);
        plan.height = Some(512);
        let geometry = compute_geometry(&plan, 400, 300);
        assert_eq!((geometry.out_width, geometry.out_height), (512, 512));
        assert_eq!((geometry.scaled_width, geometry.scaled_height), (400, 300));
        assert!(!geometry.blocked);
        assert!(geometry.pad_ratio > 0.5);
    }

    #[test]
    fn crop_uses_floor_and_ceil() {
        let mut plan = TransformPlan::default();
        plan.crop = CropRect { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
        let geometry = compute_geometry(&plan, 1000, 500);
        assert_eq!((geometry.crop_width, geometry.crop_height), (800, 400));
        assert!(geometry.crop_ratio > 0.35 && geometry.crop_ratio < 0.37);
    }

    #[test]
    fn rotation_swaps_base_dimensions() {
        let mut plan = TransformPlan::default();
        plan.rotation = 90;
        let geometry = compute_geometry(&plan, 1000, 500);
        assert_eq!((geometry.out_width, geometry.out_height), (500, 1000));
    }
}
