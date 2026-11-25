use crate::caption::{self, finalize_caption};
use crate::db::{self, AssetRow};
use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::project::asset_filter::{uses_scoped_text_search, FilterSql};
use crate::project::history::{self, snapshot_asset, AssetSnapshot, HistoryState, MembershipChange};
use crate::project::regex_tags::RegexTags;
use crate::project::{transform, Project};
use crate::util;
use rusqlite::{params, params_from_iter, OptionalExtension, ToSql};
use serde::Serialize;

struct CaptionConfig {
    trigger_word: String,
    trigger_mode: String,
    default_mode: String,
}

fn caption_config(conn: &rusqlite::Connection) -> AppResult<CaptionConfig> {
    let (trigger_word, trigger_mode, default_mode) = conn.query_row(
        "SELECT trigger_word, trigger_mode, default_caption_mode FROM project LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(CaptionConfig { trigger_word, trigger_mode, default_mode })
}

struct CaptionRaw {
    mode: String,
    tags: Vec<String>,
    text: String,
}

fn caption_raw(conn: &rusqlite::Connection, revision_id: Option<&str>, default_mode: &str) -> CaptionRaw {
    if let Some(revision_id) = revision_id {
        if let Ok(Some((mode, tags_json, text))) = conn
            .query_row(
                "SELECT mode, tags_json, text FROM caption_revisions WHERE id = ?1",
                params![revision_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()
        {
            return CaptionRaw {
                mode,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                text,
            };
        }
    }
    CaptionRaw {
        mode: default_mode.to_string(),
        tags: Vec::new(),
        text: String::new(),
    }
}

fn final_text(conn: &rusqlite::Connection, asset: &AssetRow, cfg: &CaptionConfig) -> AppResult<String> {
    let raw = caption_raw(conn, asset.caption_revision_id.as_deref(), &cfg.default_mode);
    Ok(finalize_caption(
        &raw.mode,
        &raw.tags,
        &raw.text,
        &cfg.trigger_word,
        &cfg.trigger_mode,
        asset.trigger_disabled,
    ))
}

fn summary_from_row(
    conn: &rusqlite::Connection,
    asset: &AssetRow,
    cfg: &CaptionConfig,
) -> AppResult<AssetSummary> {
    let raw = caption_raw(conn, asset.caption_revision_id.as_deref(), &cfg.default_mode);
    let final_text = finalize_caption(
        &raw.mode,
        &raw.tags,
        &raw.text,
        &cfg.trigger_word,
        &cfg.trigger_mode,
        asset.trigger_disabled,
    );
    let (blocking, suggestion): (i64, i64) = conn.query_row(
        "SELECT
           COALESCE(SUM(CASE WHEN level='blocking' AND ignored=0 THEN 1 ELSE 0 END),0),
           COALESCE(SUM(CASE WHEN level='suggestion' AND ignored=0 THEN 1 ELSE 0 END),0)
         FROM issues WHERE asset_id = ?1",
        params![asset.id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(AssetSummary {
        id: asset.id.clone(),
        name: asset.original_name.clone(),
        ext: asset.ext.clone(),
        format: asset.format.clone(),
        width: asset.norm_width,
        height: asset.norm_height,
        out_width: asset.out_width,
        out_height: asset.out_height,
        bytes: asset.bytes,
        status: asset.review_status.clone(),
        favorite: asset.favorite,
        caption_mode: raw.mode.clone(),
        caption_preview: caption::caption_preview(&raw.mode, &raw.tags, &raw.text, 96),
        caption_text: final_text.clone(),
        tags: raw.tags.clone(),
        issue_blocking: blocking,
        issue_suggestion: suggestion,
        duplicate_group_id: asset.duplicate_group_id.clone(),
        split_lock: asset.split_lock.clone(),
        thumb_version: asset.thumb_version.clone(),
        display_version: format!("src-{}", &asset.content_hash[..asset.content_hash.len().min(10)]),
        has_draft: asset.draft_transform_revision_id.is_some(),
        imported_at: asset.imported_at.clone(),
        last_human_at: asset.last_human_at.clone(),
        sort_index: asset.sort_index,
        revision: asset.revision,
        has_caption: !final_text.trim().is_empty(),
        crop_ratio: asset.crop_ratio,
        pad_ratio: asset.pad_ratio,
        scale_ratio: asset.scale_ratio,
        source_label: asset.rel_path.clone(),
        note: asset.note.clone(),
        missing: asset.missing,
        trigger_disabled: asset.trigger_disabled,
    })
}

fn escape_like(value: &str) -> String {
    value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

struct FilterParts {
    joins: String,
    where_sql: String,
    params: Vec<rusqlite::types::Value>,
}

fn build_filter(filter: &AssetFilter, advanced: FilterSql) -> FilterParts {
    use rusqlite::types::Value;
    let mut where_parts: Vec<String> = vec!["1=1".into()];
    let mut values: Vec<Value> = Vec::new();
    let join_caption = !advanced.clauses.is_empty() || !filter.query.trim().is_empty();

    if !filter.statuses.is_empty() {
        let placeholders: Vec<String> = filter
            .statuses
            .iter()
            .map(|_| "?".to_string())
            .collect();
        where_parts.push(format!("a.review_status IN ({})", placeholders.join(",")));
        for status in &filter.statuses {
            values.push(Value::Text(status.clone()));
        }
    }
    if filter.recycled_only {
        where_parts.push("a.review_status = 'excluded' AND a.excluded_reason IN (?, ?)".into());
        values.push(Value::Text(crate::project::quality::DEDUPE_REASON.into()));
        values.push(Value::Text(crate::project::quality::RECYCLE_REASON.into()));
    } else {
        // 回收区图片不属于图库视图；即使状态筛选包含“已排除”也只在回收区出现。
        where_parts.push("COALESCE(a.excluded_reason, '') NOT IN (?, ?)".into());
        values.push(Value::Text(crate::project::quality::DEDUPE_REASON.into()));
        values.push(Value::Text(crate::project::quality::RECYCLE_REASON.into()));
    }
    if !filter.orientations.is_empty() {
        let mut parts = Vec::new();
        for orientation in &filter.orientations {
            parts.push(match orientation.as_str() {
                "portrait" => "a.norm_height > a.norm_width".to_string(),
                "landscape" => "a.norm_width > a.norm_height".to_string(),
                "square" => "a.norm_width = a.norm_height".to_string(),
                _ => "1=0".to_string(),
            });
        }
        where_parts.push(format!("({})", parts.join(" OR ")));
    }
    if !filter.collection_ids.is_empty() {
        let placeholders: Vec<String> = filter
            .collection_ids
            .iter()
            .map(|_| "?".to_string())
            .collect();
        where_parts.push(format!(
            "EXISTS (SELECT 1 FROM collection_assets ca WHERE ca.asset_id = a.id AND ca.collection_id IN ({}))",
            placeholders.join(",")
        ));
        for id in &filter.collection_ids {
            values.push(Value::Text(id.clone()));
        }
    }
    if !filter.issue_rules.is_empty() {
        let placeholders: Vec<String> = filter.issue_rules.iter().map(|_| "?".to_string()).collect();
        where_parts.push(format!(
            "EXISTS (SELECT 1 FROM issues i WHERE i.asset_id = a.id AND i.rule IN ({}))",
            placeholders.join(",")
        ));
        for rule in &filter.issue_rules {
            values.push(Value::Text(rule.clone()));
        }
    }
    if !filter.issue_levels.is_empty() {
        for level in &filter.issue_levels {
            if level == "blocking" {
                where_parts.push(
                    "EXISTS (SELECT 1 FROM issues i WHERE i.asset_id = a.id AND i.level='blocking' AND i.ignored=0)".into(),
                );
            } else if level == "suggestion" {
                where_parts.push(
                    "EXISTS (SELECT 1 FROM issues i WHERE i.asset_id = a.id AND i.level='suggestion' AND i.ignored=0)".into(),
                );
            } else if level == "ignored" {
                where_parts.push(
                    "EXISTS (SELECT 1 FROM issues i WHERE i.asset_id = a.id AND i.ignored=1)".into(),
                );
            }
        }
    }
    if let Some(split) = &filter.split {
        if split == "unassigned" {
            where_parts.push("a.split_lock IS NULL".into());
        } else {
            where_parts.push("a.split_lock = ?".into());
            values.push(Value::Text(split.clone()));
        }
    }
    if filter.duplicate_only {
        where_parts.push("a.duplicate_group_id IS NOT NULL".into());
    }
    if filter.favorite_only {
        where_parts.push("a.favorite = 1".into());
    }
    if filter.has_draft {
        where_parts.push("a.draft_transform_revision_id IS NOT NULL".into());
    }
    if let Some(min) = filter.min_short_edge {
        where_parts.push("min(a.norm_width, a.norm_height) >= ?".into());
        values.push(Value::Integer(min as i64));
    }
    if let Some(max) = filter.max_short_edge {
        where_parts.push("min(a.norm_width, a.norm_height) <= ?".into());
        values.push(Value::Integer(max as i64));
    }
    let query = filter.query.trim();
    if !query.is_empty() && !uses_scoped_text_search(filter) {
        for term in query.split_whitespace() {
            if let Some(rest) = term.strip_prefix('-') {
                if rest.is_empty() {
                    continue;
                }
                let needle = format!("%{}%", escape_like(&rest.to_lowercase()));
                where_parts.push(
                    "(lower(a.original_name) NOT LIKE ? ESCAPE '\\' AND lower(a.rel_path) NOT LIKE ? ESCAPE '\\' \
                     AND lower(COALESCE(c.search_text,'')) NOT LIKE ? ESCAPE '\\')".into(),
                );
                values.push(Value::Text(needle.clone()));
                values.push(Value::Text(needle.clone()));
                values.push(Value::Text(needle));
            } else if let Some(tag) = term.strip_prefix("tag:") {
                let needle = format!("%{}%", escape_like(&tag.to_lowercase()));
                where_parts.push("lower(COALESCE(c.tags_json,'')) LIKE ? ESCAPE '\\'".into());
                values.push(Value::Text(needle));
            } else {
                let needle = format!("%{}%", escape_like(&term.to_lowercase()));
                where_parts.push(
                    "(lower(a.original_name) LIKE ? ESCAPE '\\' OR lower(a.rel_path) LIKE ? ESCAPE '\\' \
                     OR lower(COALESCE(a.note,'')) LIKE ? ESCAPE '\\' \
                     OR lower(COALESCE(c.search_text,'')) LIKE ? ESCAPE '\\')".into(),
                );
                values.push(Value::Text(needle.clone()));
                values.push(Value::Text(needle.clone()));
                values.push(Value::Text(needle.clone()));
                values.push(Value::Text(needle));
            }
        }
    }

    where_parts.extend(advanced.clauses);
    values.extend(advanced.values);
    FilterParts {
        joins: if join_caption { "LEFT JOIN caption_revisions c ON c.id = a.caption_revision_id".into() } else { String::new() },
        where_sql: where_parts.join(" AND "),
        params: values,
    }
}

fn order_parts(sort: &AssetSort) -> (String, bool) {
    let primary = match sort.field.as_str() {
        "name" => "lower(a.original_name)",
        "edge" => "max(a.norm_width, a.norm_height)",
        "status" => "CASE a.review_status WHEN 'pending' THEN 0 WHEN 'review' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END",
        "date" => "a.imported_at",
        "width" => "a.norm_width",
        "height" => "a.norm_height",
        "ratio" => "(CAST(a.norm_width AS REAL) / MAX(a.norm_height, 1))",
        "exposure" => "COALESCE(json_extract(a.analysis_json, '$.exposure'), 0.5 + 0.5 * (COALESCE(a.bright_ratio, 0.0) - COALESCE(a.dark_ratio, 0.0)))",
        "colorfulness" => "COALESCE(json_extract(a.analysis_json, '$.colorfulness'), 0.0)",
        "contrast" => "COALESCE(json_extract(a.analysis_json, '$.contrast'), MIN(1.0, COALESCE(a.blur_score, 0.0) / 1000.0))",
        "saturation" => "COALESCE(json_extract(a.analysis_json, '$.saturation'), 0.0)",
        _ => "a.sort_index",
    };
    (
        primary.to_string(),
        sort.direction.eq_ignore_ascii_case("desc"),
    )
}

fn order_sql(sort: &AssetSort) -> String {
    let (primary, descending) = order_parts(sort);
    format!(
        "{primary} {}, a.id ASC",
        if descending { "DESC" } else { "ASC" }
    )
}

pub fn query(
    project: &Project,
    filter: &AssetFilter,
    sort: &AssetSort,
    offset: i64,
    limit: i64,
    cursor: Option<&str>,
) -> AppResult<AssetsPage> {
    let conn = project.read_conn()?;
    FilterSql::compile(filter)?.run(&conn, |advanced| {
        query_page(&conn, build_filter(filter, advanced), sort, offset, limit, cursor)
    })
}

fn query_page(
    conn: &rusqlite::Connection,
    parts: FilterParts,
    sort: &AssetSort,
    offset: i64,
    limit: i64,
    cursor: Option<&str>,
) -> AppResult<AssetsPage> {
    let tx = conn.unchecked_transaction()?;
    let conn = &tx;
    let cfg = caption_config(conn)?;
    let total: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM assets a {} WHERE {}",
            parts.joins, parts.where_sql
        ),
        params_from_iter(parts.params.iter()),
        |row| row.get(0),
    )?;
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);
    let (primary, descending) = order_parts(sort);
    let cursor_id = cursor.filter(|value| !value.is_empty() && value.len() <= 160);
    // 稳定游标：用上一页最后一张的排序值与 ID 继续，避免深页 OFFSET 扫描；
    // 同值排序时以 `a.id ASC` 作为稳定次级键。
    let (where_sql, cursor_values) = if let Some(id) = cursor_id {
        let comparison = if descending { "<" } else { ">" };
        let cursor_expr = primary.replace("a.", "a2.");
        let sub = format!("(SELECT {cursor_expr} FROM assets a2 WHERE a2.id = ?)");
        (
            format!(
                "({}) AND ({primary} {comparison} {sub} OR ({primary} = {sub} AND a.id > ?))",
                parts.where_sql
            ),
            vec![id.to_string(), id.to_string(), id.to_string()],
        )
    } else {
        (parts.where_sql.clone(), Vec::new())
    };
    let sql = format!(
        "SELECT {columns} FROM assets a {joins} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?",
        columns = db::ASSET_COLUMNS
            .split(", ")
            .map(|column| format!("a.{column}"))
            .collect::<Vec<_>>()
            .join(", "),
        joins = parts.joins,
        where_sql = where_sql,
        order = order_sql(sort)
    );
    let mut values: Vec<Box<dyn ToSql>> = Vec::new();
    for value in &parts.params {
        values.push(Box::new(value.clone()));
    }
    for value in &cursor_values {
        values.push(Box::new(value.clone()));
    }
    values.push(Box::new(limit));
    values.push(Box::new(if cursor_id.is_some() { 0 } else { offset }));
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(values.iter().map(|v| v.as_ref())), db::asset_row)?;
    let mut items = Vec::new();
    for row in rows {
        let asset = row?;
        items.push(summary_from_row(conn, &asset, &cfg)?);
    }
    let next_offset = if cursor_id.is_some() {
        None
    } else if offset + (items.len() as i64) < total {
        Some(offset + items.len() as i64)
    } else {
        None
    };
    let next_cursor = if items.len() as i64 == limit {
        items.last().map(|item| item.id.clone())
    } else {
        None
    };
    Ok(AssetsPage {
        items,
        total,
        next_offset,
        next_cursor,
    })
}

pub fn resolve_ids(conn: &rusqlite::Connection, filter: &AssetFilter) -> AppResult<Vec<String>> {
    resolve_ids_within(conn, filter, None)
}

pub fn resolve_ids_within(
    conn: &rusqlite::Connection,
    filter: &AssetFilter,
    within_ids: Option<&[String]>,
) -> AppResult<Vec<String>> {
    FilterSql::compile(filter)?.run(conn, |advanced| {
        let mut parts = build_filter(filter, advanced);
        if let Some(ids) = within_ids {
            parts.where_sql.push_str(" AND a.id IN (SELECT value FROM json_each(?))");
            parts.params.push(rusqlite::types::Value::Text(serde_json::to_string(ids)?));
        }
        let sql = format!(
            "SELECT a.id FROM assets a {} WHERE {} ORDER BY a.sort_index ASC, a.id ASC",
            parts.joins, parts.where_sql
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(parts.params.iter()), |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

pub fn summaries(project: &Project, ids: &[String]) -> AppResult<Vec<AssetSummary>> {
    let conn = project.conn();
    let cfg = caption_config(&conn)?;
    let mut result = Vec::new();
    for id in ids.iter().take(5000) {
        if let Ok(asset) = db::get_asset(&conn, id) {
            if let Ok(summary) = summary_from_row(&conn, &asset, &cfg) {
                result.push(summary);
            }
        }
    }
    Ok(result)
}

pub fn detail(project: &Project, asset_id: &str) -> AppResult<AssetDetail> {
    let conn = project.conn();
    let cfg = caption_config(&conn)?;
    let asset = db::get_asset(&conn, asset_id)?;
    let summary = summary_from_row(&conn, &asset, &cfg)?;
    let raw = caption_raw(&conn, asset.caption_revision_id.as_deref(), &cfg.default_mode);
    let final_text = finalize_caption(
        &raw.mode,
        &raw.tags,
        &raw.text,
        &cfg.trigger_word,
        &cfg.trigger_mode,
        asset.trigger_disabled,
    );
    let stats = caption::caption_stats(&raw.mode, &raw.tags, &raw.text);
    let (caption_source, caption_created): (String, Option<String>) = asset
        .caption_revision_id
        .as_deref()
        .and_then(|id| {
            conn.query_row(
                "SELECT source, created_at FROM caption_revisions WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .ok()
            .flatten()
        })
        .unwrap_or(("none".into(), None));
    let issues = {
        let mut statement = conn.prepare(
            "SELECT id, asset_id, rule, level, message, evidence_json, ignored, ignore_reason
             FROM issues WHERE asset_id = ?1 ORDER BY CASE level WHEN 'blocking' THEN 0 ELSE 1 END, rule LIMIT 80",
        )?;
        let rows = statement.query_map(params![asset_id], |row| {
            let evidence: String = row.get(5)?;
            Ok(IssueInfo {
                id: row.get(0)?,
                asset_id: row.get(1)?,
                rule: row.get(2)?,
                level: row.get(3)?,
                message: row.get(4)?,
                evidence: serde_json::from_str(&evidence).unwrap_or(serde_json::json!({})),
                ignored: row.get::<_, i64>(6)? != 0,
                ignore_reason: row.get(7)?,
            })
        })?;
        rows.filter_map(|r| r.ok()).collect::<Vec<_>>()
    };
    let collections = {
        let mut statement = conn.prepare(
            "SELECT col.id, col.name, col.kind, col.created_at,
                    (SELECT COUNT(*) FROM collection_assets ca2 WHERE ca2.collection_id = col.id),
                    col.target_width, col.target_height
             FROM collections col
             JOIN collection_assets ca ON ca.collection_id = col.id
             WHERE ca.asset_id = ?1 ORDER BY col.name",
        )?;
        let rows = statement.query_map(params![asset_id], |row| {
            Ok(CollectionInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                count: row.get(4)?,
                created_at: row.get(3)?,
                query: None,
                sort: None,
                target_width: row.get(5)?,
                target_height: row.get(6)?,
            })
        })?;
        rows.filter_map(|r| r.ok()).collect::<Vec<_>>()
    };
    let source_root: Option<String> = asset
        .source_root_id
        .as_deref()
        .and_then(|root_id| {
            conn.query_row(
                "SELECT path FROM source_roots WHERE id = ?1",
                params![root_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
        });
    drop(conn);
    let transform_data = transform::transform_data(project, &asset)?;
    let history_entries = history::list_for_asset(project, asset_id)?;
    let source_path = project.source_path(&asset)?;
    let missing = !source_path.exists();
    let filesize = std::fs::metadata(&source_path).map(|m| m.len() as i64).unwrap_or(asset.bytes);
    let design = CaptionData {
        revision_id: asset.caption_revision_id.clone(),
        mode: raw.mode,
        tags: raw.tags,
        text: raw.text,
        final_text,
        source: caption_source,
        created_at: caption_created,
        char_count: stats.char_count,
        tag_count: stats.tag_count,
        token_estimate: stats.token_estimate,
        tokenizer_note: stats.tokenizer_note,
    };
    Ok(AssetDetail {
        summary,
        sha256: asset.content_hash,
        orig_width: asset.orig_width,
        orig_height: asset.orig_height,
        norm_width: asset.norm_width,
        norm_height: asset.norm_height,
        has_alpha: asset.has_alpha,
        phash: asset.phash,
        blur_score: asset.blur_score,
        dark_ratio: asset.dark_ratio,
        bright_ratio: asset.bright_ratio,
        source_root,
        rel_path: asset.rel_path,
        source_path: source_path.to_string_lossy().to_string(),
        source_size: asset.source_size,
        missing,
        excluded_reason: asset.excluded_reason,
        review_note: asset.review_note,
        issues,
        transform: transform_data,
        caption: design,
        collections,
        history: history_entries,
        imported_at: asset.imported_at,
        filesize,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUpdateResult {
    pub asset: AssetSummary,
    pub history_seq: i64,
    pub quality_stale: bool,
}

pub fn update(project: &Project, asset_id: &str, patch: &AssetPatch) -> AppResult<AssetUpdateResult> {
    let mut conn = project.conn();
    let cfg = caption_config(&conn)?;
    let asset = db::get_asset(&conn, asset_id)?;
    if let Some(status) = &patch.status {
        if !matches!(status.as_str(), "pending" | "approved" | "review" | "excluded") {
            return Err(AppError::new("INVALID_STATUS", "未知的审核状态"));
        }
    }
    if let Some(split) = &patch.split_lock {
        if !split.is_empty() && !matches!(split.as_str(), "train" | "val") {
            return Err(AppError::new("INVALID_SPLIT", "未知的用途"));
        }
    }
    let before = snapshot_asset(&conn, asset_id)?;
    let now = util::now_iso();
    let tx = conn.transaction()?;
    if let Some(status) = &patch.status {
        let reason = if status == "excluded" {
            patch.excluded_reason.clone().or(asset.excluded_reason.clone())
        } else {
            None
        };
        tx.execute(
            "UPDATE assets SET review_status = ?1, excluded_reason = ?2, last_human_at = ?3,
                revision = revision + 1 WHERE id = ?4",
            params![status, reason, now, asset_id],
        )?;
    }
    if let Some(favorite) = patch.favorite {
        tx.execute(
            "UPDATE assets SET favorite = ?1, revision = revision + 1 WHERE id = ?2",
            params![if favorite { 1 } else { 0 }, asset_id],
        )?;
    }
    if let Some(split) = &patch.split_lock {
        let value = if split.is_empty() { None } else { Some(split.clone()) };
        tx.execute(
            "UPDATE assets SET split_lock = ?1, revision = revision + 1 WHERE id = ?2",
            params![value, asset_id],
        )?;
    }
    if let Some(note) = &patch.note {
        tx.execute(
            "UPDATE assets SET note = ?1, revision = revision + 1 WHERE id = ?2",
            params![note, asset_id],
        )?;
    }
    if let Some(reason) = &patch.excluded_reason {
        tx.execute(
            "UPDATE assets SET excluded_reason = ?1, revision = revision + 1 WHERE id = ?2",
            params![reason, asset_id],
        )?;
    }
    if let Some(disabled) = patch.trigger_disabled {
        tx.execute(
            "UPDATE assets SET trigger_disabled = ?1, revision = revision + 1 WHERE id = ?2",
            params![if disabled { 1 } else { 0 }, asset_id],
        )?;
    }
    tx.commit()?;
    let after = snapshot_asset(&conn, asset_id)?;
    let label = if patch.status.is_some() {
        match patch.status.as_deref() {
            Some("approved") => "标记为已通过",
            Some("excluded") => "排除图片",
            Some("review") => "标记为需复核",
            _ => "重置为待审核",
        }
    } else if patch.favorite.is_some() {
        "更新收藏"
    } else if patch.split_lock.is_some() {
        "分配训练/验证用途"
    } else if patch.trigger_disabled.is_some() {
        "切换触发词"
    } else {
        "更新图片信息"
    };
    let seq = history::record(
        &conn,
        "asset.update",
        label,
        &[asset_id.to_string()],
        &HistoryState { assets: vec![before], memberships: vec![] },
        &HistoryState { assets: vec![after], memberships: vec![] },
        if patch.note.is_some() { Some(1200) } else { None },
    )?;
    db::mark_quality_stale(&conn)?;
    let asset = db::get_asset(&conn, asset_id)?;
    let summary = summary_from_row(&conn, &asset, &cfg)?;
    Ok(AssetUpdateResult { asset: summary, history_seq: seq, quality_stale: true })
}

// ---------------------------------------------------------------------------
// 批量操作
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PendingCaption {
    pub mode: String,
    pub tags: Vec<String>,
    pub text: String,
    pub tag_order: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct PendingAssetChange {
    pub asset_id: String,
    pub expected_revision: i64,
    pub before: AssetSnapshot,
    pub caption: Option<PendingCaption>,
    pub status: Option<String>,
    pub reason: Option<String>,
    pub split: Option<Option<String>>,
}

#[derive(Debug, Clone)]
pub struct PendingMembership {
    pub collection_id: String,
    pub asset_id: String,
    pub add: bool,
}

#[derive(Debug, Clone)]
pub struct PendingBatch {
    pub label: String,
    pub command_type: String,
    pub entries: Vec<PendingAssetChange>,
    pub memberships: Vec<PendingMembership>,
    pub project_root: std::path::PathBuf,
    pub skipped_count: usize,
    pub check_tag_state: bool,
}

fn is_member(conn: &rusqlite::Connection, collection_id: &str, asset_id: &str) -> AppResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM collection_assets WHERE collection_id = ?1 AND asset_id = ?2",
        params![collection_id, asset_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn transform_caption(
    op: &BatchOp,
    raw: &CaptionRaw,
    trigger_word: &str,
) -> (CaptionRaw, Option<String>) {
    if raw.mode == "tags" {
        let (tags, _text) = caption::apply_tag_transform(op, &raw.mode, &raw.tags, &raw.text, trigger_word);
        return (
            CaptionRaw { mode: "tags".into(), tags, text: raw.text.clone() },
            None,
        );
    }
    // 自然语言模式：对逗号分隔的段落做有限变换
    let mut terms = caption::split_caption_text(&raw.text);
    let mut warning = None;
    match op {
        BatchOp::AddTags { tags } => {
            for tag in tags {
                if !terms.iter().any(|t| caption::normalize_key(t) == caption::normalize_key(tag)) {
                    terms.push(tag.clone());
                }
            }
        }
        BatchOp::RemoveTags { tags } => {
            let keys: Vec<String> = tags.iter().map(|t| caption::normalize_key(t)).collect();
            terms.retain(|t| !keys.contains(&caption::normalize_key(t)));
        }
        BatchOp::ReplaceTag { from, to } => {
            let key = caption::normalize_key(from);
            for term in terms.iter_mut() {
                if caption::normalize_key(term) == key {
                    *term = to.clone();
                }
            }
        }
        BatchOp::MoveToFront { tag } => {
            let key = caption::normalize_key(tag);
            if let Some(index) = terms.iter().position(|t| caption::normalize_key(t) == key) {
                let value = terms.remove(index);
                terms.insert(0, value);
            }
        }
        BatchOp::Lowercase => {
            for term in terms.iter_mut() {
                *term = term.to_lowercase();
            }
        }
        BatchOp::Underscores => {
            warning = Some("自然语言模式不支持下划线规则，已跳过正文".into());
        }
        BatchOp::CleanShort { max_len } => {
            let trigger_key = caption::normalize_key(trigger_word);
            terms.retain(|t| {
                caption::normalize_key(t) == trigger_key || t.chars().count() > *max_len
            });
        }
        _ => {}
    }
    let text = terms.join(", ");
    (
        CaptionRaw { mode: "nl".into(), tags: raw.tags.clone(), text },
        warning,
    )
}

pub fn batch_preview(
    project: &Project,
    request: &BatchRequest,
    batch_id: &str,
) -> AppResult<(BatchPreview, PendingBatch)> {
    let regex_tags = RegexTags::compile(&request.op)?;
    let reader = project.read_conn()?;
    let conn = &reader.unchecked_transaction()?;
    let cfg = caption_config(conn)?;
    let resolved;
    let ids = if !request.asset_ids.is_empty() {
        &request.asset_ids
    } else if let Some(filter) = &request.filter {
        resolved = resolve_ids(conn, filter)?;
        &resolved
    } else {
        &request.asset_ids
    };
    let excluded: std::collections::HashSet<_> = request.exclude_ids.iter().collect();
    let mut seen = std::collections::HashSet::new();
    let mut ids = ids.iter().filter(|id| !excluded.contains(*id) && seen.insert(*id)).peekable();
    if ids.peek().is_none() {
        return Err(AppError::new("EMPTY_SCOPE", "没有可应用操作的图片"));
    }
    let mut entries = Vec::new();
    let mut memberships = Vec::new();
    let mut skipped = Vec::new();
    let mut diffs = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut skipped_count = 0;
    let mut skip = |item: BatchSkip| {
        skipped_count += 1;
        if skipped.len() < 8 {
            skipped.push(item);
        }
    };

    // 复制标注需要源内容
    let copy_source = if let BatchOp::CopyCaption { source } = &request.op {
        let source_asset = db::get_asset(&conn, source)?;
        Some(caption_raw(&conn, source_asset.caption_revision_id.as_deref(), &cfg.default_mode))
    } else {
        None
    };

    let mut operation_label = String::new();
    for id in ids {
        let asset = match db::get_asset(conn, id) {
            Ok(asset) => asset,
            Err(error) if error.code == "NOT_FOUND" => {
                skip(BatchSkip { asset_id: id.clone(), name: String::new(), reason: "图片已不存在".into() });
                continue;
            }
            Err(error) => return Err(error),
        };
        let raw = caption_raw(&conn, asset.caption_revision_id.as_deref(), &cfg.default_mode);
        let mut before_preview = caption::caption_preview(&raw.mode, &raw.tags, &raw.text, 80);
        let mut caption_change: Option<PendingCaption> = None;
        let mut status_change = None;
        let mut reason_change = None;
        let mut split_change = None;
        let mut after_preview = before_preview.clone();
        let mut tag_changes = None;
        let mut regex_snapshot = None;

        match &request.op {
            BatchOp::ExtractTags { .. } | BatchOp::RegexRemoveTags { .. } | BatchOp::RegexReplaceTags { .. } => {
                let rule = regex_tags.as_ref().expect("compiled regex batch operation");
                let snapshot = history::snapshot_row_with_tag_state(conn, &asset)?;
                let result = if raw.mode == "nl" && !rule.applies_to_prose() {
                    Err("只有自然语言标注".into())
                } else {
                    rule.apply(
                        &asset.original_name, &raw.tags, snapshot.tag_order.as_deref(),
                        snapshot.tag_disabled.as_deref().unwrap_or_default(), &cfg.trigger_word,
                        raw.mode == "nl",
                    )
                };
                let update = match result {
                    Ok(update) => update,
                    Err(reason) => {
                        skip(BatchSkip { asset_id: id.clone(), name: asset.original_name, reason });
                        continue;
                    }
                };
                let mode = if raw.mode != "nl" { raw.mode.as_str() } else if raw.text.trim().is_empty() { "tags" } else { "mixed" };
                if raw.mode == "nl" && mode == "mixed" && warnings.is_empty() {
                    warnings.push("含自然语言正文的图片会切换为混合标注，保留原正文。".into());
                }
                after_preview = caption::caption_preview(mode, &update.tags, &raw.text, 80);
                caption_change = Some(PendingCaption {
                    mode: mode.into(),
                    tags: update.tags,
                    text: raw.text,
                    tag_order: update.order,
                });
                tag_changes = Some(update.changes);
                regex_snapshot = Some(snapshot);
                operation_label = rule.label().into();
            }
            BatchOp::SetStatus { status, reason } => {
                let reason = reason.clone().unwrap_or_default();
                if asset.review_status == *status
                    && (status != "excluded" || asset.excluded_reason.clone().unwrap_or_default() == reason)
                {
                    skip(BatchSkip { asset_id: id.clone(), name: asset.original_name.clone(), reason: "状态未变化".into() });
                    continue;
                }
                status_change = Some(status.clone());
                reason_change = if status == "excluded" { Some(reason) } else { None };
                after_preview = format!("状态：{}", status_label(status));
                operation_label = "更改审核状态".into();
            }
            BatchOp::SetSplit { split } => {
                let target = split.clone().filter(|s| !s.is_empty());
                if asset.split_lock == target {
                    skip(BatchSkip { asset_id: id.clone(), name: asset.original_name.clone(), reason: "用途未变化".into() });
                    continue;
                }
                split_change = Some(target.clone());
                after_preview = format!("用途：{}", target.as_deref().unwrap_or("未分配"));
                operation_label = "分配用途".into();
            }
            BatchOp::AddToCollection { collection } | BatchOp::RemoveFromCollection { collection } => {
                let add = matches!(request.op, BatchOp::AddToCollection { .. });
                let collection_name: Option<String> = conn
                    .query_row(
                        "SELECT name FROM collections WHERE id = ?1",
                        params![collection],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(collection_name) = collection_name else {
                    return Err(AppError::not_found("集合"));
                };
                let member = is_member(&conn, collection, &id)?;
                if add == member {
                    skip(BatchSkip {
                        asset_id: id.clone(),
                        name: asset.original_name.clone(),
                        reason: if add { "已在集合中".into() } else { "不在集合中".into() },
                    });
                    continue;
                }
                memberships.push(PendingMembership { collection_id: collection.clone(), asset_id: id.clone(), add });
                before_preview = format!("集合：{}", if member { "已加入" } else { "未加入" });
                after_preview = format!(
                    "集合：{}「{}」",
                    if add { "已加入" } else { "已移出" },
                    collection_name
                );
                operation_label = if add { "加入集合".into() } else { "从集合移除".into() };
            }
            BatchOp::CopyCaption { .. } => {
                if let Some(source) = &copy_source {
                    if source.mode == raw.mode && source.tags == raw.tags && source.text == raw.text {
                        skip(BatchSkip { asset_id: id.clone(), name: asset.original_name.clone(), reason: "标注已相同".into() });
                        continue;
                    }
                    caption_change = Some(PendingCaption {
                        mode: source.mode.clone(),
                        tags: source.tags.clone(),
                        text: source.text.clone(),
                        tag_order: None,
                    });
                    after_preview = caption::caption_preview(&source.mode, &source.tags, &source.text, 80);
                    operation_label = "复制标注".into();
                }
            }
            op => {
                let (new_raw, warning) = transform_caption(op, &raw, &cfg.trigger_word);
                if let Some(warning) = warning {
                    if !warnings.contains(&warning) {
                        warnings.push(warning);
                    }
                }
                if new_raw.mode == raw.mode && new_raw.tags == raw.tags && new_raw.text == raw.text {
                    skip(BatchSkip { asset_id: id.clone(), name: asset.original_name.clone(), reason: "标注无变化".into() });
                    continue;
                }
                after_preview = caption::caption_preview(&new_raw.mode, &new_raw.tags, &new_raw.text, 80);
                caption_change = Some(PendingCaption {
                    mode: new_raw.mode,
                    tags: new_raw.tags,
                    text: new_raw.text,
                    tag_order: None,
                });
                operation_label = match op {
                    BatchOp::AddTags { .. } => "添加标签",
                    BatchOp::RemoveTags { .. } => "删除标签",
                    BatchOp::ReplaceTag { .. } => "替换标签",
                    BatchOp::MoveToFront { .. } => "移动标签到首位",
                    BatchOp::Lowercase => "统一大小写",
                    BatchOp::Underscores => "空格转下划线",
                    BatchOp::CleanShort { .. } => "清理短标签",
                    _ => "批量编辑标注",
                }
                .into();
            }
        }

        if diffs.len() < 8 {
            diffs.push(BatchDiff {
                asset_id: id.clone(),
                name: asset.original_name.clone(),
                before: before_preview,
                after: after_preview,
                changed: true,
                tag_changes,
            });
        }
        let before = regex_snapshot.unwrap_or_else(|| history::snapshot_from_row(&asset));
        entries.push(PendingAssetChange {
            asset_id: id.clone(),
            expected_revision: asset.revision,
            before,
            caption: caption_change,
            status: status_change,
            reason: reason_change,
            split: split_change,
        });
    }

    let changed = entries.len();
    let memberships_only = changed > 0 && entries.iter().all(|e| e.caption.is_none() && e.status.is_none() && e.split.is_none());
    let count = if memberships_only { memberships.len() as i64 } else { changed as i64 };
    let summary = if count == 0 {
        "没有需要变更的图片".to_string()
    } else if memberships_only {
        format!("将更新 {count} 张图片的集合归属，跳过 {skipped_count} 张")
    } else {
        format!("将修改 {count} 张图片，跳过 {skipped_count} 张")
    };
    let preview = BatchPreview {
        preview_id: batch_id.to_string(),
        count,
        skipped,
        skipped_count,
        diffs,
        summary,
        warnings,
        created_at: util::now_iso(),
    };
    let label = if operation_label.is_empty() { "批量操作".into() } else { format!("批量{operation_label}") };
    let command_type = match request.op {
        BatchOp::SetStatus { .. } => "batch.status",
        BatchOp::SetSplit { .. } => "batch.split",
        BatchOp::AddToCollection { .. } | BatchOp::RemoveFromCollection { .. } => "batch.collection",
        _ => "batch.caption",
    };
    let pending = PendingBatch {
        label,
        command_type: command_type.into(),
        entries,
        memberships,
        project_root: project.root.clone(),
        skipped_count,
        check_tag_state: regex_tags.is_some(),
    };
    Ok((preview, pending))
}

fn status_label(status: &str) -> &'static str {
    match status {
        "approved" => "已通过",
        "review" => "需复核",
        "excluded" => "已排除",
        _ => "待审核",
    }
}

pub fn apply_batch(project: &Project, pending: PendingBatch) -> AppResult<BatchResult> {
    if project.root != pending.project_root {
        return Err(AppError::new("PREVIEW_EXPIRED", "项目已切换，请重新预览"));
    }
    let mut conn = project.conn();
    let tx = conn.transaction()?;
    // 先校验全部修订号
    for entry in &pending.entries {
        let current = db::get_asset(&tx, &entry.asset_id)?;
        let tag_state_changed = if pending.check_tag_state {
            let snapshot = history::snapshot_row_with_tag_state(&tx, &current)?;
            snapshot.tag_order != entry.before.tag_order || snapshot.tag_disabled != entry.before.tag_disabled
        } else {
            false
        };
        if current.revision != entry.expected_revision || tag_state_changed {
            return Err(
                AppError::new("REVISION_CONFLICT", "部分图片已被修改，批量操作未执行。请重新预览。")
                    .items(vec![entry.asset_id.clone()]),
            );
        }
    }
    if pending.entries.is_empty() && pending.memberships.is_empty() {
        return Err(AppError::new("EMPTY_SCOPE", "没有需要变更的图片"));
    }
    let now = util::now_iso();
    for entry in &pending.entries {
        let mut changed = false;
        if let Some(caption) = &entry.caption {
            let revision_no: i64 = tx.query_row(
                "SELECT COALESCE(MAX(revision_no),0) + 1 FROM caption_revisions WHERE asset_id = ?1",
                params![entry.asset_id],
                |row| row.get(0),
            )?;
            let revision_id = util::new_id();
            let search = caption::search_text(&caption.mode, &caption.tags, &caption.text);
            tx.execute(
                "INSERT INTO caption_revisions(id, asset_id, revision_no, mode, tags_json, text, source, status, parent_id, search_text, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'batch', 'active', (SELECT caption_revision_id FROM assets WHERE id = ?2), ?7, ?8)",
                params![
                    revision_id,
                    entry.asset_id,
                    revision_no,
                    caption.mode,
                    serde_json::to_string(&caption.tags)?,
                    caption.text,
                    search,
                    now
                ],
            )?;
            tx.execute(
                "UPDATE assets SET caption_revision_id = ?1, revision = revision + 1,
                 last_human_at = ?2,
                 review_status = CASE WHEN review_status='approved' THEN 'pending' ELSE review_status END
                 WHERE id = ?3",
                params![revision_id, now, entry.asset_id],
            )?;
            if let Some(order) = &caption.tag_order {
                tx.execute(
                    "UPDATE caption_tag_state SET order_json = ?1, updated_at = ?2 WHERE asset_id = ?3",
                    params![serde_json::to_string(order)?, now, entry.asset_id],
                )?;
            }
            changed = true;
        }
        if let Some(status) = &entry.status {
            tx.execute(
                "UPDATE assets SET review_status = ?1, excluded_reason = ?2, last_human_at = ?3,
                 revision = revision + 1 WHERE id = ?4",
                params![status, entry.reason, now, entry.asset_id],
            )?;
            changed = true;
        }
        if let Some(split) = &entry.split {
            tx.execute(
                "UPDATE assets SET split_lock = ?1, revision = revision + 1 WHERE id = ?2",
                params![split, entry.asset_id],
            )?;
            changed = true;
        }
        if !changed {
            // 集合归属等由 memberships 处理
        }
    }
    for membership in &pending.memberships {
        if membership.add {
            tx.execute(
                "INSERT OR IGNORE INTO collection_assets(collection_id, asset_id) VALUES(?1, ?2)",
                params![membership.collection_id, membership.asset_id],
            )?;
        } else {
            tx.execute(
                "DELETE FROM collection_assets WHERE collection_id = ?1 AND asset_id = ?2",
                params![membership.collection_id, membership.asset_id],
            )?;
        }
    }
    let asset_ids: Vec<String> = pending
        .entries
        .iter()
        .map(|e| e.asset_id.clone())
        .chain(pending.memberships.iter().map(|m| m.asset_id.clone()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let after_assets = {
        let mut snapshots = Vec::new();
        for entry in &pending.entries {
            let snapshot = if pending.check_tag_state {
                let asset = db::get_asset(&tx, &entry.asset_id)?;
                history::snapshot_row_with_tag_state(&tx, &asset)?
            } else {
                snapshot_asset(&tx, &entry.asset_id)?
            };
            snapshots.push(snapshot);
        }
        snapshots
    };
    let before_assets = pending.entries.iter().map(|e| e.before.clone()).collect::<Vec<_>>();
    let membership_changes = {
        let mut map: std::collections::HashMap<(String, bool), Vec<String>> = std::collections::HashMap::new();
        for membership in &pending.memberships {
            map.entry((membership.collection_id.clone(), membership.add))
                .or_default()
                .push(membership.asset_id.clone());
        }
        map.into_iter()
            .map(|((collection_id, add), asset_ids)| MembershipChange { collection_id, asset_ids, add })
            .collect::<Vec<_>>()
    };
    // 历史状态的 memberships 表示“应用该状态时需要执行的变更”：
    // 撤销时执行反向变更，重做时重新执行原变更。
    let undo_memberships = membership_changes
        .iter()
        .map(|change| MembershipChange {
            collection_id: change.collection_id.clone(),
            asset_ids: change.asset_ids.clone(),
            add: !change.add,
        })
        .collect::<Vec<_>>();
    let seq = history::record(
        &tx,
        &pending.command_type,
        &pending.label,
        &asset_ids,
        &HistoryState { assets: before_assets, memberships: undo_memberships },
        &HistoryState { assets: after_assets, memberships: membership_changes },
        None,
    )?;
    db::mark_quality_stale(&tx)?;
    tx.commit()?;
    let applied = if pending.memberships.is_empty() {
        pending.entries.len() as i64
    } else {
        (pending.entries.len().max(pending.memberships.len())) as i64
    };
    Ok(BatchResult {
        applied,
        skipped: pending.skipped_count as i64,
        history_seq: seq,
        label: pending.label,
    })
}

#[cfg(test)]
mod query_tests {
    use super::*;
    use crate::project::CreateProjectRequest;
    use std::path::PathBuf;

    fn project_with_assets() -> (Project, PathBuf) {
        let parent = std::env::temp_dir().join(format!("yk-query-test-{}", util::short_id(8)));
        std::fs::create_dir_all(&parent).unwrap();
        let project = crate::project::create_project(&CreateProjectRequest {
            name: format!("query-test-{}", util::short_id(6)),
            parent_dir: parent.to_string_lossy().to_string(),
            model: "sdxl".into(),
            template: "character".into(),
            trigger_word: String::new(),
            default_caption_mode: "tags".into(),
        })
        .unwrap();
        {
            let conn = project.conn();
            let rows = [
                ("a", 250u32),
                ("b", 200),
                ("c", 150),
                ("d", 120),
                ("e", 100),
            ];
            for (index, (name, width)) in rows.iter().enumerate() {
                conn.execute(
                    "INSERT INTO assets(id, content_hash, source_root_id, rel_path, original_name,
                        ext, format, bytes, orig_width, orig_height, norm_width, norm_height,
                        out_width, out_height, imported_at, sort_index)
                     VALUES(?1, ?2, NULL, ?3, ?4, 'jpg', 'JPEG', 100, ?5, 100, ?5, 100, ?5, 100, ?6, ?7)",
                    params![
                        format!("asset-{index}"),
                        format!("hash-{index}"),
                        format!("{name}.jpg"),
                        name,
                        width,
                        util::now_iso(),
                        index as i64 + 1
                    ],
                )
                .unwrap();
            }
        }
        (project, parent)
    }

    #[test]
    fn cursor_pagination_matches_order_without_duplicates() {
        let (project, parent) = project_with_assets();
        let filter = AssetFilter::default();
        let sort = AssetSort {
            field: "width".into(),
            direction: "desc".into(),
        };
        let first = query(&project, &filter, &sort, 0, 2, None).unwrap();
        assert_eq!(
            first.items.iter().map(|asset| asset.width).collect::<Vec<_>>(),
            vec![250, 200]
        );
        assert_eq!(first.next_offset, Some(2));
        assert_eq!(
            first.next_cursor.as_deref(),
            Some(first.items[1].id.as_str())
        );

        let second = query(
            &project,
            &filter,
            &sort,
            0,
            2,
            first.next_cursor.as_deref(),
        )
        .unwrap();
        assert_eq!(
            second.items.iter().map(|asset| asset.width).collect::<Vec<_>>(),
            vec![150, 120]
        );
        assert_eq!(second.next_offset, None);

        let third = query(
            &project,
            &filter,
            &sort,
            0,
            2,
            second.next_cursor.as_deref(),
        )
        .unwrap();
        assert_eq!(
            third.items.iter().map(|asset| asset.width).collect::<Vec<_>>(),
            vec![100]
        );
        assert_eq!(third.next_cursor, None);

        // 指标值相同时按 ID 稳定前进；COALESCE 表达式不会让游标条件变成 NULL。
        let tied = AssetSort {
            field: "exposure".into(),
            direction: "asc".into(),
        };
        let page = query(&project, &filter, &tied, 0, 5, None).unwrap();
        assert_eq!(page.items.len(), 5);
        let mut seen = std::collections::HashSet::new();
        assert!(page.items.iter().all(|asset| seen.insert(asset.id.clone())));

        drop(project);
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn nested_filter_regex_and_pagination_use_the_same_scope() {
        let (project, parent) = project_with_assets();
        {
            let conn = project.conn();
            conn.execute("UPDATE assets SET favorite=1 WHERE id='asset-2'", []).unwrap();
            conn.execute("UPDATE assets SET split_lock='train' WHERE id='asset-1'", []).unwrap();
            conn.execute(
                "UPDATE assets SET review_status='excluded', excluded_reason=?1 WHERE id='asset-3'",
                params![crate::project::quality::RECYCLE_REASON],
            ).unwrap();
        }
        let mut filter: AssetFilter = serde_json::from_value(serde_json::json!({
            "regexSearch": {"pattern": "^[A-D]$", "target": "name"},
            "expression": {"kind": "group", "mode": "all", "negated": false, "children": [
                {"kind": "group", "mode": "any", "negated": false, "children": [
                    {"kind": "rule", "field": "width", "operator": "gte", "value": "200", "negated": false},
                    {"kind": "rule", "field": "favorite", "operator": "is", "value": "yes", "negated": false},
                    {"kind": "rule", "field": "name", "operator": "regex", "value": "^D$", "negated": false}
                ]},
                {"kind": "group", "mode": "any", "negated": true, "children": [
                    {"kind": "rule", "field": "split", "operator": "is", "value": "train", "negated": false},
                    {"kind": "rule", "field": "tag", "operator": "is", "value": "blocked", "negated": false}
                ]}
            ]}
        })).unwrap();
        let sort = AssetSort::default();
        let first = query(&project, &filter, &sort, 0, 1, None).unwrap();
        let second = query(&project, &filter, &sort, 0, 1, first.next_cursor.as_deref()).unwrap();
        assert_eq!(first.total, 2);
        assert_eq!(first.items[0].id, "asset-0");
        assert_eq!(second.items[0].id, "asset-2");
        let conn = project.read_conn().unwrap();
        assert_eq!(resolve_ids(&conn, &filter).unwrap(), ["asset-0", "asset-2"]);
        let ids = ["asset-1".into(), "asset-2".into()];
        assert_eq!(resolve_ids_within(&conn, &filter, Some(&ids)).unwrap(), ["asset-2"]);
        filter.search_case_sensitive = true;
        assert!(resolve_ids(&conn, &filter).unwrap().is_empty());
        filter.regex_search = None;
        filter.search_target = Some("path".into());
        filter.query = "A.JPG".into();
        assert!(resolve_ids(&conn, &filter).unwrap().is_empty());
        filter.search_case_sensitive = false;
        assert_eq!(resolve_ids(&conn, &filter).unwrap(), ["asset-0"]);
        drop(conn);
        drop(project);
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn extract_filename_tags_previews_preserves_state_and_undoes() {
        let (project, parent) = project_with_assets();
        {
            let conn = project.conn();
            conn.execute("UPDATE assets SET original_name='[青山] 0042.PNG' WHERE id='asset-0'", []).unwrap();
        }
        let tag_state = |order: &[&str]| crate::project::captions::TagState {
            order: order.iter().map(|tag| tag.to_string()).collect(),
            disabled: vec!["artist: 青山".into()],
        };
        crate::project::captions::tag_state_set(&project, "asset-0", &tag_state(&["artist: 青山"])).unwrap();
        let request = BatchRequest {
            asset_ids: vec!["asset-0".into(), "asset-1".into(), "asset-0".into()],
            filter: None,
            exclude_ids: Vec::new(),
            op: BatchOp::ExtractTags {
                syntax: ExtractSyntax::Template,
                pattern: "[{{artist: str}}] {{id: int}}.png".into(),
                templates: vec!["artist: {{artist}}".into(), "id: {{id}}".into()],
            },
        };
        let (preview, pending) = batch_preview(&project, &request, "preview").unwrap();
        assert_eq!(preview.count, 1);
        assert_eq!(preview.skipped_count, 1);
        assert_eq!(preview.diffs[0].tag_changes.as_ref().unwrap().added, ["id: 0042"]);
        let state = || crate::project::captions::tag_state_get(&project, "asset-0").unwrap();
        assert_eq!(state().order, ["artist: 青山"]);
        let result = apply_batch(&project, pending).unwrap();
        assert_eq!(result.applied, 1);
        assert_eq!(state().order, ["artist: 青山", "id: 0042"]);
        assert_eq!(state().disabled, ["artist: 青山"]);
        history::undo_last(&project, Some(result.history_seq)).unwrap();
        assert_eq!(state().order, ["artist: 青山"]);
        history::redo_last(&project).unwrap();
        assert_eq!(state().order, ["artist: 青山", "id: 0042"]);

        let mut replace = request;
        replace.op = BatchOp::RegexReplaceTags { pattern: "^id: ([0-9]+)$".into(), replacement: "image {{1}}".into() };
        let (preview, pending) = batch_preview(&project, &replace, "replace").unwrap();
        assert_eq!(preview.diffs[0].tag_changes.as_ref().unwrap().added, ["image 0042"]);
        crate::project::captions::tag_state_set(&project, "asset-0", &tag_state(&["id: 0042", "artist: 青山"])).unwrap();
        assert_eq!(apply_batch(&project, pending).unwrap_err().code, "REVISION_CONFLICT");
        drop(project);
        let _ = std::fs::remove_dir_all(&parent);
    }
}
