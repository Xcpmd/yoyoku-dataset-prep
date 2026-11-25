use crate::caption::finalize_caption;
use crate::db::{self, AssetRow};
use crate::error::{AppError, AppResult};
use crate::model::HistoryEntry;
use crate::project::Project;
use crate::util;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSnapshot {
    pub id: String,
    pub transform_revision_id: Option<String>,
    pub caption_revision_id: Option<String>,
    pub draft_transform_revision_id: Option<String>,
    pub out_width: u32,
    pub out_height: u32,
    pub crop_ratio: f64,
    pub pad_ratio: f64,
    pub scale_ratio: f64,
    pub thumb_version: String,
    pub review_status: String,
    pub favorite: bool,
    pub split_lock: Option<String>,
    pub note: String,
    pub excluded_reason: Option<String>,
    pub trigger_disabled: bool,
    pub last_human_at: Option<String>,
    pub review_note: Option<String>,
    /// 分组视图的完整顺序 / 停用项。旧历史记录没有该字段，撤销时保持现状。
    #[serde(default)]
    pub tag_order: Option<Vec<String>>,
    #[serde(default)]
    pub tag_disabled: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipChange {
    pub collection_id: String,
    pub asset_ids: Vec<String>,
    pub add: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryState {
    pub assets: Vec<AssetSnapshot>,
    #[serde(default)]
    pub memberships: Vec<MembershipChange>,
}

fn base_snapshot(row: &AssetRow) -> AssetSnapshot {
    AssetSnapshot {
        id: row.id.clone(),
        transform_revision_id: row.transform_revision_id.clone(),
        caption_revision_id: row.caption_revision_id.clone(),
        draft_transform_revision_id: row.draft_transform_revision_id.clone(),
        out_width: row.out_width,
        out_height: row.out_height,
        crop_ratio: row.crop_ratio,
        pad_ratio: row.pad_ratio,
        scale_ratio: row.scale_ratio,
        thumb_version: row.thumb_version.clone(),
        review_status: row.review_status.clone(),
        favorite: row.favorite,
        split_lock: row.split_lock.clone(),
        note: row.note.clone(),
        excluded_reason: row.excluded_reason.clone(),
        trigger_disabled: row.trigger_disabled,
        last_human_at: row.last_human_at.clone(),
        review_note: row.review_note.clone(),
        tag_order: None,
        tag_disabled: None,
    }
}

/// 普通资产操作不携带分组视图状态，避免撤销裁剪/质检等操作时覆盖之后的标签排序。
pub fn snapshot_from_row(row: &AssetRow) -> AssetSnapshot {
    base_snapshot(row)
}

/// 仅批量短语编辑使用：把完整排序 / 停用项一起写入历史，撤销时同步恢复。
pub fn snapshot_row_with_tag_state(
    conn: &rusqlite::Connection,
    row: &AssetRow,
) -> AppResult<AssetSnapshot> {
    let mut snapshot = base_snapshot(row);
    let state: Option<(String, String)> = conn
        .query_row(
            "SELECT order_json, disabled_json FROM caption_tag_state WHERE asset_id = ?1",
            params![row.id],
            |value| Ok((value.get(0)?, value.get(1)?)),
        )
        .optional()?;
    if let Some((order, disabled)) = state {
        snapshot.tag_order = Some(serde_json::from_str(&order).unwrap_or_default());
        snapshot.tag_disabled = Some(serde_json::from_str(&disabled).unwrap_or_default());
    }
    Ok(snapshot)
}

pub fn snapshot_asset(conn: &rusqlite::Connection, id: &str) -> AppResult<AssetSnapshot> {
    let row = db::get_asset(conn, id)?;
    Ok(snapshot_from_row(&row))
}

pub fn record(
    conn: &rusqlite::Connection,
    command_type: &str,
    label: &str,
    targets: &[String],
    before: &HistoryState,
    after: &HistoryState,
    merge_window_ms: Option<i64>,
) -> AppResult<i64> {
    db::push_history(
        conn,
        command_type,
        label,
        targets,
        &serde_json::to_value(before)?,
        &serde_json::to_value(after)?,
        merge_window_ms,
    )
}

fn apply_state(conn: &rusqlite::Connection, state: &HistoryState) -> AppResult<()> {
    for asset in &state.assets {
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM assets WHERE id = ?1",
                params![asset.id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            continue;
        }
        conn.execute(
            "UPDATE assets SET
               transform_revision_id = ?1, caption_revision_id = ?2, draft_transform_revision_id = ?3,
               out_width = ?4, out_height = ?5, crop_ratio = ?6, pad_ratio = ?7, scale_ratio = ?8,
               thumb_version = ?9, review_status = ?10, favorite = ?11, split_lock = ?12,
               note = ?13, excluded_reason = ?14, trigger_disabled = ?15, last_human_at = ?16,
               review_note = ?17, revision = revision + 1
             WHERE id = ?18",
            params![
                asset.transform_revision_id,
                asset.caption_revision_id,
                asset.draft_transform_revision_id,
                asset.out_width,
                asset.out_height,
                asset.crop_ratio,
                asset.pad_ratio,
                asset.scale_ratio,
                asset.thumb_version,
                asset.review_status,
                if asset.favorite { 1 } else { 0 },
                asset.split_lock,
                asset.note,
                asset.excluded_reason,
                if asset.trigger_disabled { 1 } else { 0 },
                asset.last_human_at,
                asset.review_note,
                asset.id
            ],
        )?;
        if asset.tag_order.is_some() || asset.tag_disabled.is_some() {
            let order = asset.tag_order.clone().unwrap_or_default();
            let disabled = asset.tag_disabled.clone().unwrap_or_default();
            conn.execute(
                "INSERT INTO caption_tag_state(asset_id, order_json, disabled_json, updated_at)
                 VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(asset_id) DO UPDATE SET
                   order_json = excluded.order_json,
                   disabled_json = excluded.disabled_json,
                   updated_at = excluded.updated_at",
                params![
                    asset.id,
                    serde_json::to_string(&order)?,
                    serde_json::to_string(&disabled)?,
                    util::now_iso()
                ],
            )?;
        }
    }
    for change in &state.memberships {
        for asset_id in &change.asset_ids {
            if change.add {
                conn.execute(
                    "INSERT OR IGNORE INTO collection_assets(collection_id, asset_id)
                     SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM collections WHERE id = ?1)
                       AND EXISTS (SELECT 1 FROM assets WHERE id = ?2)",
                    params![change.collection_id, asset_id],
                )?;
            } else {
                conn.execute(
                    "DELETE FROM collection_assets WHERE collection_id = ?1 AND asset_id = ?2",
                    params![change.collection_id, asset_id],
                )?;
            }
        }
    }
    db::mark_quality_stale(conn)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub label: String,
    pub seq: i64,
    pub command_type: String,
    pub redoable: bool,
    pub affected_ids: Vec<String>,
}

fn load_entry(conn: &rusqlite::Connection, seq: i64) -> AppResult<(String, String, HistoryState, HistoryState, Vec<String>)> {
    let (label, command, before, after, targets): (String, String, String, String, String) = conn
        .query_row(
            "SELECT label, command_type, before_json, after_json, target_json FROM history WHERE seq = ?1",
            params![seq],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )?;
    let before: HistoryState = serde_json::from_str(&before).unwrap_or_default();
    let after: HistoryState = serde_json::from_str(&after).unwrap_or_default();
    let targets: Vec<String> = serde_json::from_str(&targets).unwrap_or_default();
    Ok((label, command, before, after, targets))
}

pub fn undo_last(project: &Project, expected_seq: Option<i64>) -> AppResult<Option<UndoOutcome>> {
    let mut conn = project.conn();
    let seq: Option<i64> = conn
        .query_row(
            "SELECT seq FROM history WHERE undone = 0 ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if expected_seq.is_some() && seq != expected_seq {
        return Err(AppError::new("HISTORY_CHANGED", "操作历史已变化，请按历史顺序撤销"));
    }
    let Some(seq) = seq else {
        return Ok(None);
    };
    let (label, command, before, _after, targets) = load_entry(&conn, seq)?;
    let tx = conn.transaction()?;
    apply_state(&tx, &before)?;
    tx.execute("UPDATE history SET undone = 1 WHERE seq = ?1", params![seq])?;
    tx.commit()?;
    Ok(Some(UndoOutcome {
        label,
        seq,
        command_type: command,
        redoable: true,
        affected_ids: targets,
    }))
}

pub fn redo_last(project: &Project) -> AppResult<Option<UndoOutcome>> {
    let mut conn = project.conn();
    let seq: Option<i64> = conn
        .query_row(
            "SELECT seq FROM history WHERE undone = 1 ORDER BY seq ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(seq) = seq else {
        return Ok(None);
    };
    let (label, command, _before, after, targets) = load_entry(&conn, seq)?;
    let tx = conn.transaction()?;
    apply_state(&tx, &after)?;
    tx.execute("UPDATE history SET undone = 0 WHERE seq = ?1", params![seq])?;
    tx.commit()?;
    Ok(Some(UndoOutcome {
        label,
        seq,
        command_type: command,
        redoable: false,
        affected_ids: targets,
    }))
}

pub fn list_for_asset(project: &Project, asset_id: &str) -> AppResult<Vec<HistoryEntry>> {
    let conn = project.conn();
    let mut statement = conn.prepare(
        "SELECT seq, label, command_type, created_at, undone, target_json
         FROM history WHERE target_json LIKE ?1 ORDER BY seq DESC LIMIT 30",
    )?;
    let rows = statement.query_map(params![format!("%\"{asset_id}\"%")], |row| {
        Ok(HistoryEntry {
            seq: row.get(0)?,
            label: row.get(1)?,
            command_type: row.get(2)?,
            created_at: row.get(3)?,
            undone: row.get::<_, i64>(4)? != 0,
            target_ids: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn recent_history(project: &Project, limit: i64) -> AppResult<Vec<HistoryEntry>> {
    let conn = project.conn();
    let mut statement = conn.prepare(
        "SELECT seq, label, command_type, created_at, undone, target_json
         FROM history ORDER BY seq DESC LIMIT ?1",
    )?;
    let rows = statement.query_map(params![limit], |row| {
        Ok(HistoryEntry {
            seq: row.get(0)?,
            label: row.get(1)?,
            command_type: row.get(2)?,
            created_at: row.get(3)?,
            undone: row.get::<_, i64>(4)? != 0,
            target_ids: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 重置已通过状态并返回标签文本。
pub fn review_reset_on_change(status: &str) -> (&'static str, bool) {
    if status == "approved" {
        ("pending", true)
    } else {
        ("", false)
    }
}

pub fn final_caption_for(project: &Project, asset: &AssetRow) -> AppResult<String> {
    let conn = project.conn();
    let (mode, tags_json, text): (String, String, String) = match asset.caption_revision_id.as_deref() {
        Some(revision_id) => conn.query_row(
            "SELECT mode, tags_json, text FROM caption_revisions WHERE id = ?1",
            params![revision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?,
        None => (project.default_caption_mode(&conn), "[]".into(), "".into()),
    };
    let (trigger_word, trigger_mode): (String, String) = conn.query_row(
        "SELECT trigger_word, trigger_mode FROM project LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    drop(conn);
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    Ok(finalize_caption(
        &mode,
        &tags,
        &text,
        &trigger_word,
        &trigger_mode,
        asset.trigger_disabled,
    ))
}

impl Project {
    pub fn default_caption_mode(&self, conn: &rusqlite::Connection) -> String {
        conn.query_row(
            "SELECT default_caption_mode FROM project LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "tags".into())
    }

    pub fn now(&self) -> String {
        util::now_iso()
    }

    pub fn require_source(&self, asset: &AssetRow) -> AppResult<std::path::PathBuf> {
        let path = self.source_path(asset)?;
        if !path.exists() {
            return Err(AppError::new(
                "SOURCE_MISSING",
                format!("源文件已失联：{}", asset.original_name),
            ));
        }
        Ok(path)
    }
}
