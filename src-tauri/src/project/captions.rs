use crate::caption::{self, CaptionStats};
use crate::db::{self, AssetRow};
use crate::error::{AppError, AppResult};
use crate::project::history::{self, snapshot_asset, HistoryState};
use crate::project::Project;
use crate::util;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSaveRequest {
    pub asset_id: String,
    pub mode: String,
    pub tags: Vec<String>,
    pub text: String,
    pub expected_revision: i64,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSaveResult {
    pub revision_id: Option<String>,
    pub asset_revision: i64,
    pub final_text: String,
    pub stats: CaptionStats,
    pub review_reset: bool,
    pub history_seq: Option<i64>,
    pub changed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionPreviewRequest {
    pub mode: String,
    pub tags: Vec<String>,
    pub text: String,
    #[serde(default)]
    pub trigger_disabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionPreviewResult {
    pub final_text: String,
    pub stats: CaptionStats,
    pub char_count: usize,
    pub tag_count: usize,
}

/// 打标页的分组视图状态：`order` 保存包含停用项在内的完整顺序，
/// `disabled` 中的短语不写入标注文件，但仍保留在编辑器里供随时启用。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagState {
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub disabled: Vec<String>,
}

fn clean_tag_state_values(values: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for value in values {
        let tag = value.trim();
        if tag.is_empty() || tag.chars().count() > 200 {
            continue;
        }
        if seen.insert(tag.to_string()) {
            result.push(tag.to_string());
        }
        if result.len() >= 2000 {
            break;
        }
    }
    result
}

pub fn tag_state_get(project: &Project, asset_id: &str) -> AppResult<TagState> {
    let conn = project.conn();
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT order_json, disabled_json FROM caption_tag_state WHERE asset_id = ?1",
            params![asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row
        .map(|(order, disabled)| TagState {
            order: serde_json::from_str(&order).unwrap_or_default(),
            disabled: serde_json::from_str(&disabled).unwrap_or_default(),
        })
        .unwrap_or_default())
}

pub fn tag_state_set(project: &Project, asset_id: &str, state: &TagState) -> AppResult<()> {
    let conn = project.conn();
    db::get_asset(&conn, asset_id)?;
    let order = clean_tag_state_values(&state.order);
    let disabled = clean_tag_state_values(&state.disabled);
    conn.execute(
        "INSERT INTO caption_tag_state(asset_id, order_json, disabled_json, updated_at)
         VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(asset_id) DO UPDATE SET
           order_json = excluded.order_json,
           disabled_json = excluded.disabled_json,
           updated_at = excluded.updated_at",
        params![
            asset_id,
            serde_json::to_string(&order)?,
            serde_json::to_string(&disabled)?,
            util::now_iso()
        ],
    )?;
    Ok(())
}

fn project_trigger(conn: &rusqlite::Connection) -> AppResult<(String, String)> {
    conn.query_row(
        "SELECT trigger_word, trigger_mode FROM project LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .map_err(AppError::from)
}

pub fn preview(project: &Project, request: &CaptionPreviewRequest) -> AppResult<CaptionPreviewResult> {
    let conn = project.conn();
    let (trigger_word, trigger_mode) = project_trigger(&conn)?;
    let tags = caption::normalize_tags(request.tags.iter().cloned());
    let text = request.text.trim().to_string();
    let final_text = caption::finalize_caption(
        &request.mode,
        &tags,
        &text,
        &trigger_word,
        &trigger_mode,
        request.trigger_disabled,
    );
    let stats = caption::caption_stats(&request.mode, &tags, &text);
    Ok(CaptionPreviewResult {
        final_text,
        char_count: stats.char_count,
        tag_count: stats.tag_count,
        stats,
    })
}

pub fn save(project: &Project, request: &CaptionSaveRequest) -> AppResult<CaptionSaveResult> {
    if !matches!(request.mode.as_str(), "tags" | "nl" | "mixed") {
        return Err(AppError::new("INVALID_MODE", "未知的标注模式"));
    }
    let mut conn = project.conn();
    let asset = db::get_asset(&conn, &request.asset_id)?;
    if asset.revision != request.expected_revision {
        return Err(AppError::revision_conflict(asset.revision));
    }
    let (trigger_word, trigger_mode) = project_trigger(&conn)?;
    let tags = if request.mode != "nl" {
        caption::normalize_tags(request.tags.iter().cloned())
    } else {
        request.tags.clone()
    };
    let text = request.text.trim_end().to_string();

    let current: Option<(String, String, String)> = asset
        .caption_revision_id
        .as_deref()
        .and_then(|id| {
            conn.query_row(
                "SELECT mode, tags_json, text FROM caption_revisions WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .ok()
            .flatten()
        });
    let same = current
        .as_ref()
        .map(|(mode, tags_json, text_value)| {
            *mode == request.mode
                && serde_json::from_str::<Vec<String>>(tags_json).ok().as_deref() == Some(tags.as_slice())
                && text_value == &text
        })
        .unwrap_or(false);
    let final_text = caption::finalize_caption(
        &request.mode,
        &tags,
        &text,
        &trigger_word,
        &trigger_mode,
        asset.trigger_disabled,
    );
    let stats = caption::caption_stats(&request.mode, &tags, &text);
    if same {
        return Ok(CaptionSaveResult {
            revision_id: asset.caption_revision_id.clone(),
            asset_revision: asset.revision,
            final_text,
            stats,
            review_reset: false,
            history_seq: None,
            changed: false,
        });
    }

    let (next_status, reset) = history::review_reset_on_change(&asset.review_status);
    let now = util::now_iso();
    let search = caption::search_text(&request.mode, &tags, &text);
    let revision_id = util::new_id();
    let before = snapshot_asset(&conn, &request.asset_id)?;
    let tx = conn.transaction()?;
    let revision_no: i64 = tx.query_row(
        "SELECT COALESCE(MAX(revision_no),0) + 1 FROM caption_revisions WHERE asset_id = ?1",
        params![request.asset_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO caption_revisions(id, asset_id, revision_no, mode, tags_json, text, source, status,
            parent_id, model_json, search_text, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, '{}', ?9, ?10)",
        params![
            revision_id,
            request.asset_id,
            revision_no,
            request.mode,
            serde_json::to_string(&tags)?,
            text,
            request.source.clone().unwrap_or_else(|| "manual".into()),
            asset.caption_revision_id,
            search,
            now
        ],
    )?;
    tx.execute(
        "UPDATE assets SET caption_revision_id = ?1, revision = revision + 1, last_human_at = ?2,
            review_status = CASE WHEN review_status = 'approved' THEN ?3 ELSE review_status END
         WHERE id = ?4",
        params![revision_id, now, next_status, request.asset_id],
    )?;
    tx.commit()?;
    let after = snapshot_asset(&conn, &request.asset_id)?;
    let label = if reset {
        "编辑标注（已通过 → 待审核）"
    } else {
        "编辑标注"
    };
    let seq = history::record(
        &conn,
        "caption.save",
        label,
        &[request.asset_id.clone()],
        &HistoryState { assets: vec![before], memberships: vec![] },
        &HistoryState { assets: vec![after], memberships: vec![] },
        Some(1100),
    )?;
    db::mark_quality_stale(&conn)?;
    let revision = db::get_asset(&conn, &request.asset_id)?.revision;
    Ok(CaptionSaveResult {
        revision_id: Some(revision_id),
        asset_revision: revision,
        final_text,
        stats,
        review_reset: reset,
        history_seq: Some(seq),
        changed: true,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertPreview {
    pub target_mode: String,
    pub tags: Vec<String>,
    pub text: String,
    pub note: String,
}

pub fn convert_preview(project: &Project, asset_id: &str, target_mode: &str) -> AppResult<ConvertPreview> {
    if !matches!(target_mode, "tags" | "nl") {
        return Err(AppError::new("INVALID_MODE", "未知的标注模式"));
    }
    let conn = project.conn();
    let asset = db::get_asset(&conn, asset_id)?;
    let (mode, tags_json, text): (String, String, String) = asset
        .caption_revision_id
        .as_deref()
        .and_then(|id| {
            conn.query_row(
                "SELECT mode, tags_json, text FROM caption_revisions WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .ok()
            .flatten()
        })
        .unwrap_or(("tags".into(), "[]".into(), String::new()));
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    if target_mode == mode {
        return Ok(ConvertPreview {
            target_mode: target_mode.into(),
            tags,
            text,
            note: "当前已是此模式".into(),
        });
    }
    if target_mode == "nl" {
        let joined = caption::tags_to_text(&tags);
        Ok(ConvertPreview {
            target_mode: "nl".into(),
            tags,
            text: joined,
            note: "标签将合并为一段以逗号分隔的文本，可继续手工修改。".into(),
        })
    } else {
        let parsed = caption::normalize_tags(caption::split_caption_text(&text));
        let joined = caption::tags_to_text(&parsed);
        Ok(ConvertPreview {
            target_mode: "tags".into(),
            tags: parsed,
            text: joined,
            note: "正文将按英文/中文逗号与换行拆分为标签。".into(),
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionInfo {
    pub revision_id: String,
    pub mode: String,
    pub tags: Vec<String>,
    pub text: String,
    pub source: String,
    pub model: String,
    pub model_version: String,
    pub threshold: Option<f64>,
    pub created_at: String,
    pub status: String,
}

pub fn list_suggestions(project: &Project, asset_id: &str) -> AppResult<Vec<SuggestionInfo>> {
    let conn = project.conn();
    let mut statement = conn.prepare(
        "SELECT id, mode, tags_json, text, source, model_json, created_at, status
         FROM caption_revisions WHERE asset_id = ?1 AND status = 'suggestion'
         ORDER BY created_at DESC LIMIT 20",
    )?;
    let rows = statement.query_map(params![asset_id], |row| {
        let model_json: String = row.get(5)?;
        let model: serde_json::Value = serde_json::from_str(&model_json).unwrap_or(serde_json::json!({}));
        Ok(SuggestionInfo {
            revision_id: row.get(0)?,
            mode: row.get(1)?,
            tags: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(2)?).unwrap_or_default(),
            text: row.get(3)?,
            source: row.get(4)?,
            model: model.get("model").and_then(|v| v.as_str()).unwrap_or("本地模型").into(),
            model_version: model.get("version").and_then(|v| v.as_str()).unwrap_or("").into(),
            threshold: model.get("threshold").and_then(|v| v.as_f64()),
            created_at: row.get(6)?,
            status: row.get(7)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn insert_suggestion(
    conn: &rusqlite::Connection,
    asset: &AssetRow,
    mode: &str,
    tags: &[String],
    text: &str,
    source: &str,
    model_json: &serde_json::Value,
) -> AppResult<String> {
    let id = util::new_id();
    let revision_no: i64 = conn.query_row(
        "SELECT COALESCE(MAX(revision_no),0) + 1 FROM caption_revisions WHERE asset_id = ?1",
        params![asset.id],
        |row| row.get(0),
    )?;
    let search = caption::search_text(mode, tags, text);
    conn.execute(
        "INSERT INTO caption_revisions(id, asset_id, revision_no, mode, tags_json, text, source, status,
            parent_id, model_json, search_text, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'suggestion', ?8, ?9, ?10, ?11)",
        params![
            id,
            asset.id,
            revision_no,
            mode,
            serde_json::to_string(tags)?,
            text,
            source,
            asset.caption_revision_id,
            serde_json::to_string(model_json)?,
            search,
            util::now_iso()
        ],
    )?;
    Ok(id)
}

pub fn apply_suggestion(project: &Project, revision_id: &str, expected_revision: i64) -> AppResult<CaptionSaveResult> {
    let conn = project.conn();
    let (asset_id, mode, tags_json, text): (String, String, String, String) = conn
        .query_row(
            "SELECT asset_id, mode, tags_json, text FROM caption_revisions WHERE id = ?1 AND status = 'suggestion'",
            params![revision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("标注建议"))?;
    drop(conn);
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    save(
        project,
        &CaptionSaveRequest {
            asset_id,
            mode,
            tags,
            text,
            expected_revision,
            source: Some("suggestion".into()),
        },
    )
}
