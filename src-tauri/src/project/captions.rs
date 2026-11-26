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
        if tag.is_empty() || tag.chars().count() > 2000 {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagTotalEntry {
    pub tag: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagTotalsResult {
    pub target_assets: i64,
    pub tagged_assets: i64,
    pub tags: Vec<TagTotalEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagBulkRequest {
    /// 空数组表示作用于项目内全部图片。
    #[serde(default)]
    pub asset_ids: Vec<String>,
    pub action: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagBulkResult {
    pub action: String,
    pub total_assets: i64,
    pub changed_assets: i64,
    pub skipped_assets: i64,
    pub history_seq: Option<i64>,
}

struct BulkTarget {
    asset: AssetRow,
    mode: String,
    tags: Vec<String>,
    text: String,
}

fn is_tag_mode(mode: &str) -> bool {
    matches!(mode, "tags" | "mixed")
}

fn append_unique(list: &mut Vec<String>, values: &[String]) -> usize {
    let mut seen: std::collections::HashSet<String> =
        list.iter().map(|tag| caption::normalize_key(tag)).collect();
    let mut added = 0;
    for value in values {
        let key = caption::normalize_key(value);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        list.push(value.clone());
        added += 1;
    }
    added
}

fn expand_underscores(tag: &str) -> Option<String> {
    let start = tag.len() - tag.trim_start_matches('_').len();
    let end = tag.trim_end_matches('_').len();
    let core = tag.get(start..end)?;
    if !core.contains('_') {
        return None;
    }
    let mut expanded = String::from(&tag[..start]);
    let mut previous_underscore = false;
    for ch in core.chars() {
        if ch != '_' {
            expanded.push(ch);
        } else if !previous_underscore {
            expanded.push(' ');
        }
        previous_underscore = ch == '_';
    }
    expanded.push_str(&tag[end..]);
    Some(expanded)
}

fn expand_tag_list(
    tags: &[String],
    variants: &std::collections::HashMap<String, String>,
    keep_original: bool,
) -> Vec<String> {
    let mut next = Vec::with_capacity(tags.len());
    for tag in tags {
        if let Some(variant) = variants.get(&caption::normalize_key(tag)) {
            if keep_original {
                next.push(tag.clone());
            }
            next.push(variant.clone());
        } else {
            next.push(tag.clone());
        }
    }
    caption::normalize_tags(next)
}

fn scope_ids_json(asset_ids: &[String]) -> (String, i64) {
    let scoped = !asset_ids.is_empty();
    let json = serde_json::to_string(asset_ids).unwrap_or_else(|_| "[]".into());
    (json, if scoped { 1 } else { 0 })
}

/// 统计范围内的提示词出现次数。只统计短语模式（tags / mixed），
/// 自然语言模式的 tags_json 不参与展示，避免统计到未写入标注的旧标签。
pub fn tag_totals(project: &Project, asset_ids: &[String]) -> AppResult<TagTotalsResult> {
    let conn = project.conn();
    let (ids_json, scoped) = scope_ids_json(asset_ids);
    let target_assets: i64 = conn.query_row(
        "SELECT COUNT(*) FROM assets WHERE (?2 = 0 OR id IN (SELECT value FROM json_each(?1)))",
        params![ids_json, scoped],
        |row| row.get(0),
    )?;
    let mut statement = conn.prepare(
        "SELECT c.mode, c.tags_json FROM assets a
         JOIN caption_revisions c ON c.id = a.caption_revision_id
         WHERE (?2 = 0 OR a.id IN (SELECT value FROM json_each(?1)))",
    )?;
    let rows = statement.query_map(params![ids_json, scoped], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    struct Acc {
        count: i64,
        displays: std::collections::HashMap<String, i64>,
    }
    let mut acc: std::collections::BTreeMap<String, Acc> = std::collections::BTreeMap::new();
    let mut tagged_assets = 0i64;
    for row in rows {
        let (mode, tags_json) = row?;
        if !is_tag_mode(&mode) {
            continue;
        }
        tagged_assets += 1;
        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        for raw in tags {
            let tag = raw.trim();
            let key = caption::normalize_key(tag);
            if key.is_empty() || !seen.insert(key.clone()) {
                continue;
            }
            let entry = acc.entry(key).or_insert_with(|| Acc {
                count: 0,
                displays: std::collections::HashMap::new(),
            });
            entry.count += 1;
            *entry.displays.entry(tag.to_string()).or_insert(0) += 1;
        }
    }
    let mut tags: Vec<TagTotalEntry> = acc
        .into_iter()
        .map(|(key, entry)| {
            let display = entry
                .displays
                .into_iter()
                .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
                .map(|(tag, _)| tag)
                .unwrap_or(key);
            TagTotalEntry { tag: display, count: entry.count }
        })
        .collect();
    tags.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.tag.to_lowercase().cmp(&b.tag.to_lowercase()))
            .then_with(|| a.tag.cmp(&b.tag))
    });
    let truncated = tags.len() > 5000;
    tags.truncate(5000);
    Ok(TagTotalsResult { target_assets, tagged_assets, tags, truncated })
}

/// 批量新增 / 重命名 / 删除短语。所有改动写入同一条历史记录，可一次撤销。
pub fn tag_bulk(project: &Project, request: &TagBulkRequest) -> AppResult<TagBulkResult> {
    let action = request.action.trim();
    let values = caption::normalize_tags(request.tags.iter().cloned());
    let from = request.from.trim().to_string();
    let to = request.to.trim().to_string();
    let from_key = caption::normalize_key(&from);
    let expand = matches!(action, "convertUnderscores" | "duplicateUnderscores");
    let keep_original = action == "duplicateUnderscores";
    match action {
        "add" | "remove" if values.is_empty() => {
            return Err(AppError::new("INVALID_TAGS", "请填写要处理的提示词"));
        }
        "rename" if from.is_empty() || to.is_empty() => {
            return Err(AppError::new("INVALID_TAGS", "请填写原提示词和新提示词"));
        }
        "convertUnderscores" | "duplicateUnderscores" if request.asset_ids.is_empty() => {
            return Err(AppError::new("EMPTY_SCOPE", "请先选择要处理的图片"));
        }
        "add" | "remove" | "rename" | "convertUnderscores" | "duplicateUnderscores" => {}
        _ => return Err(AppError::new("INVALID_ACTION", "未知的批量操作")),
    }
    if from.chars().count() > 2000 || to.chars().count() > 2000 {
        return Err(AppError::new("INVALID_TAGS", "提示词长度不能超过 2000 个字符"));
    }
    if values.len() > 500 {
        return Err(AppError::new("INVALID_TAGS", "单次最多处理 500 条提示词"));
    }

    let mut conn = project.conn();
    let (ids_json, scoped) = scope_ids_json(&request.asset_ids);
    let total_assets: i64 = conn.query_row(
        "SELECT COUNT(*) FROM assets WHERE (?2 = 0 OR id IN (SELECT value FROM json_each(?1)))",
        params![ids_json, scoped],
        |row| row.get(0),
    )?;
    if total_assets == 0 {
        return Ok(TagBulkResult {
            action: action.into(),
            total_assets: 0,
            changed_assets: 0,
            skipped_assets: 0,
            history_seq: None,
        });
    }

    let default_mode = project.default_caption_mode(&conn);
    let targets: Vec<BulkTarget> = {
        let sql = format!(
            "SELECT {columns}, c.mode, c.tags_json, c.text
             FROM assets a
             LEFT JOIN caption_revisions c ON c.id = a.caption_revision_id
             WHERE (?2 = 0 OR a.id IN (SELECT value FROM json_each(?1)))
             ORDER BY a.sort_index ASC, a.id ASC",
            columns = db::ASSET_COLUMNS
                .split(", ")
                .map(|column| format!("a.{column}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(params![ids_json, scoped], |row| {
            let asset = db::asset_row(row)?;
            let mode: Option<String> = row.get(42)?;
            let tags_json: Option<String> = row.get(43)?;
            let text: Option<String> = row.get(44)?;
            Ok(BulkTarget {
                asset,
                mode: mode.unwrap_or_else(|| default_mode.clone()),
                tags: tags_json
                    .and_then(|value| serde_json::from_str(&value).ok())
                    .unwrap_or_default(),
                text: text.unwrap_or_default(),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let now = util::now_iso();
    let tx = conn.transaction()?;
    let mut before_state = HistoryState::default();
    let mut after_state = HistoryState::default();
    let mut changed_ids: Vec<String> = Vec::new();
    let mut changed_assets = 0i64;
    let mut skipped_assets = 0i64;
    let value_keys: std::collections::HashSet<String> =
        values.iter().map(|value| caption::normalize_key(value)).collect();

    for target in &targets {
        let mut tags = target.tags.clone();
        let mode = target.mode.clone();
        if action != "add" && !is_tag_mode(&mode) {
            skipped_assets += 1;
            continue;
        }
        let mut variants = std::collections::HashMap::new();
        let mut dirty = false;
        match action {
            "add" => {
                if !is_tag_mode(&mode) {
                    // 自然语言模式的 tags_json 不参与输出；新增短语时必须转换模式，
                    // 即使旧 tags_json 里已经存在同名项也要让短语真正可见。
                    append_unique(&mut tags, &values);
                    dirty = true;
                } else if append_unique(&mut tags, &values) > 0 {
                    dirty = true;
                }
            }
            "remove" => {
                let before = tags.len();
                tags.retain(|tag| !value_keys.contains(&caption::normalize_key(tag)));
                dirty = tags.len() != before;
            }
            "rename" => {
                dirty = caption::replace_tag(&mut tags, &from_key, &to);
            }
            _ if expand => {
                for tag in &tags {
                    if let Some(variant) = expand_underscores(tag) {
                        variants.insert(caption::normalize_key(tag), variant);
                    }
                }
                if !variants.is_empty() {
                    let next = expand_tag_list(&tags, &variants, keep_original);
                    dirty = next != tags;
                    tags = next;
                }
            }
            _ => unreachable!(),
        }
        if !dirty {
            skipped_assets += 1;
            continue;
        }
        let mut next_mode = mode;
        if action == "add" && !is_tag_mode(&next_mode) {
            // 自然语言模式新增短语后转为混合模式，正文保持原样。
            next_mode = if target.text.trim().is_empty() { "tags".into() } else { "mixed".into() };
        }

        // 先记录改动前的完整状态（含分组顺序 / 停用项），供撤销恢复。
        before_state
            .assets
            .push(history::snapshot_row_with_tag_state(&tx, &target.asset)?);

        // 保持分组视图的完整顺序 / 停用列表与文件内容同步。
        let state: Option<(String, String)> = tx
            .query_row(
                "SELECT order_json, disabled_json FROM caption_tag_state WHERE asset_id = ?1",
                params![target.asset.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((order_json, disabled_json)) = state {
            let mut order: Vec<String> = serde_json::from_str(&order_json).unwrap_or_default();
            let mut disabled: Vec<String> = serde_json::from_str(&disabled_json).unwrap_or_default();
            let mut state_changed = false;
            match action {
                "add" => {
                    if append_unique(&mut order, &values) > 0 {
                        state_changed = true;
                    }
                    let before = disabled.len();
                    disabled.retain(|tag| !value_keys.contains(&caption::normalize_key(tag)));
                    state_changed |= disabled.len() != before;
                }
                "remove" => {
                    let before = order.len() + disabled.len();
                    order.retain(|tag| !value_keys.contains(&caption::normalize_key(tag)));
                    disabled.retain(|tag| !value_keys.contains(&caption::normalize_key(tag)));
                    state_changed = order.len() + disabled.len() != before;
                }
                "rename" => {
                    state_changed |= caption::replace_tag(&mut order, &from_key, &to);
                }
                _ if expand => {
                    let next_order = expand_tag_list(&order, &variants, keep_original);
                    state_changed = next_order != order;
                    order = next_order;
                }
                _ => {}
            }
            if expand || action == "rename" {
                let enabled: std::collections::HashSet<_> = tags.iter().map(|tag| caption::normalize_key(tag)).collect();
                let before = disabled.len();
                disabled.retain(|tag| !enabled.contains(&caption::normalize_key(tag)));
                state_changed |= disabled.len() != before;
            }
            if state_changed {
                tx.execute(
                    "UPDATE caption_tag_state SET order_json = ?1, disabled_json = ?2, updated_at = ?3
                     WHERE asset_id = ?4",
                    params![
                        serde_json::to_string(&order)?,
                        serde_json::to_string(&disabled)?,
                        now,
                        target.asset.id
                    ],
                )?;
            }
        }

        let revision_no: i64 = tx.query_row(
            "SELECT COALESCE(MAX(revision_no),0) + 1 FROM caption_revisions WHERE asset_id = ?1",
            params![target.asset.id],
            |row| row.get(0),
        )?;
        let revision_id = util::new_id();
        let search = caption::search_text(&next_mode, &tags, &target.text);
        tx.execute(
            "INSERT INTO caption_revisions(id, asset_id, revision_no, mode, tags_json, text, source, status,
                parent_id, model_json, search_text, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'bulk', 'active', ?7, '{}', ?8, ?9)",
            params![
                revision_id,
                target.asset.id,
                revision_no,
                next_mode,
                serde_json::to_string(&tags)?,
                target.text,
                target.asset.caption_revision_id,
                search,
                now
            ],
        )?;
        let (next_status, _) = history::review_reset_on_change(&target.asset.review_status);
        tx.execute(
            "UPDATE assets SET caption_revision_id = ?1, revision = revision + 1, last_human_at = ?2,
                review_status = CASE WHEN review_status = 'approved' THEN ?3 ELSE review_status END
             WHERE id = ?4",
            params![revision_id, now, next_status, target.asset.id],
        )?;
        let mut updated = target.asset.clone();
        updated.caption_revision_id = Some(revision_id);
        updated.revision += 1;
        updated.last_human_at = Some(now.clone());
        if !next_status.is_empty() {
            updated.review_status = next_status.to_string();
        }
        after_state
            .assets
            .push(history::snapshot_row_with_tag_state(&tx, &updated)?);
        changed_ids.push(target.asset.id.clone());
        changed_assets += 1;
    }

    let history_seq = if changed_assets > 0 {
        db::mark_quality_stale(&tx)?;
        let label = match action {
            "add" => format!("批量添加提示词（{changed_assets} 张）"),
            "remove" => format!("批量删除提示词（{changed_assets} 张）"),
            "convertUnderscores" => format!("下划线转为空格（{changed_assets} 张）"),
            "duplicateUnderscores" => format!("复制空格版本（{changed_assets} 张）"),
            _ => format!("批量重命名提示词（{changed_assets} 张）"),
        };
        Some(history::record(
            &tx,
            "caption.bulk",
            &label,
            &changed_ids,
            &before_state,
            &after_state,
            None,
        )?)
    } else {
        None
    };
    tx.commit()?;
    Ok(TagBulkResult {
        action: action.into(),
        total_assets,
        changed_assets,
        skipped_assets,
        history_seq,
    })
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
        if request.source.as_deref() == Some("suggestion") { None } else { Some(1100) },
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
