use crate::caption;
use crate::db::{self, meta_get, AssetRow};
use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::project::{transform, Project};
use crate::util;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub mod adapters;
pub mod runner;

pub const ADAPTER_VERSION: &str = "yoyoku-adapters/1.0";
pub const KOHYA_COMPAT: &str = "sd-scripts (DreamBooth 同名标注结构)";
pub const DIFFUSERS_COMPAT: &str = "diffusers text_to_image LoRA 示例脚本";
pub const LORA_SCRIPT_COMPAT: &str = "lora_script (单图训练次数_分组 目录结构)";

#[derive(Debug, Clone)]
pub struct ExportItem {
    pub asset_id: String,
    pub original_name: String,
    pub source_path: String,
    pub source_hash: String,
    pub source_size: i64,
    pub source_mtime: Option<String>,
    pub revision: i64,
    pub caption: String,
    pub caption_mode: String,
    pub plan: TransformPlan,
    pub split: String,
    pub subset: String,
    pub subset_label: String,
    pub repeats: u32,
    pub keep_tokens: u32,
    pub image_path: String,
    pub caption_path: String,
    pub width: u32,
    pub height: u32,
    pub estimated_bytes: u64,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct PendingExport {
    pub preview: ExportPreview,
    pub items: Vec<ExportItem>,
    pub config: ExportConfig,
    pub config_hash: String,
    pub created_at: String,
}

pub struct ExportRunOutcome {
    pub record_id: String,
    pub output_path: String,
    pub counts: serde_json::Value,
    pub validation: serde_json::Value,
    pub warnings: Vec<String>,
}

fn config_hash(config: &ExportConfig) -> String {
    util::sha256_text(&serde_json::to_string(config).unwrap_or_default())
}

fn root_map(conn: &rusqlite::Connection) -> AppResult<HashMap<String, (String, String)>> {
    let mut statement = conn.prepare("SELECT id, path, mode FROM source_roots")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, (row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn asset_source_path(
    project: &Project,
    roots: &HashMap<String, (String, String)>,
    asset: &AssetRow,
) -> PathBuf {
    if let Some((root, mode)) = asset.source_root_id.as_ref().and_then(|id| roots.get(id)) {
        if mode == "copy" {
            return project
                .originals_dir()
                .join(format!("{}.{}", asset.content_hash, asset.ext));
        }
        return util::safe_join(Path::new(root), &asset.rel_path).unwrap_or_default();
    }
    project
        .originals_dir()
        .join(format!("{}.{}", asset.content_hash, asset.ext))
}

fn caption_map(conn: &rusqlite::Connection) -> AppResult<HashMap<String, (String, Vec<String>, String)>> {
    let mut map = HashMap::new();
    let mut statement = conn.prepare("SELECT id, mode, tags_json, text FROM caption_revisions")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            (
                row.get::<_, String>(1)?,
                serde_json::from_str::<Vec<String>>(&row.get::<_, String>(2)?).unwrap_or_default(),
                row.get::<_, String>(3)?,
            ),
        ))
    })?;
    for row in rows.flatten() {
        map.insert(row.0, row.1);
    }
    Ok(map)
}

struct ProjectCaptionContext {
    trigger_word: String,
    trigger_mode: String,
    default_mode: String,
    base_resolution: u32,
}

fn caption_context(conn: &rusqlite::Connection) -> AppResult<ProjectCaptionContext> {
    let (trigger_word, trigger_mode, default_mode): (String, String, String) = conn.query_row(
        "SELECT trigger_word, trigger_mode, default_caption_mode FROM project LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let base_resolution = crate::project::model_base_resolution(conn);
    Ok(ProjectCaptionContext {
        trigger_word,
        trigger_mode,
        default_mode,
        base_resolution,
    })
}

fn scope_assets(conn: &rusqlite::Connection, scope: &ExportScope) -> AppResult<Vec<AssetRow>> {
    let mut assets: Vec<AssetRow> = Vec::new();
    match scope.mode.as_str() {
        "approved" => {
            let mut statement = conn.prepare(&format!(
                "SELECT {} FROM assets WHERE review_status = 'approved' ORDER BY sort_index ASC",
                db::ASSET_COLUMNS
            ))?;
            let rows = statement.query_map([], db::asset_row)?;
            assets.extend(rows.flatten());
        }
        "collection" => {
            let collection_id = scope
                .collection_id
                .as_deref()
                .ok_or_else(|| AppError::new("INVALID_SCOPE", "未选择集合"))?;
            let mut statement = conn.prepare(&format!(
                "SELECT {} FROM assets a JOIN collection_assets ca ON ca.asset_id = a.id
                 WHERE ca.collection_id = ?1 ORDER BY a.sort_index ASC",
                db::ASSET_COLUMNS
                    .split(", ")
                    .map(|c| format!("a.{c}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))?;
            let rows = statement.query_map(params![collection_id], db::asset_row)?;
            assets.extend(rows.flatten());
        }
        "selection" => {
            if scope.asset_ids.is_empty() {
                return Ok(assets);
            }
            for id in &scope.asset_ids {
                if let Ok(asset) = db::get_asset(conn, id) {
                    assets.push(asset);
                }
            }
            assets.sort_by_key(|a| a.sort_index);
        }
        _ => {
            let mut statement = conn.prepare(&format!(
                "SELECT {} FROM assets ORDER BY sort_index ASC",
                db::ASSET_COLUMNS
            ))?;
            let rows = statement.query_map([], db::asset_row)?;
            assets.extend(rows.flatten());
        }
    }
    if scope.restrict_approved && scope.mode != "approved" {
        assets.retain(|asset| asset.review_status == "approved");
    }
    Ok(assets)
}

fn effective_plan(
    asset_plan: &TransformPlan,
    config: &ExportConfig,
    base_resolution: u32,
) -> TransformPlan {
    let mut plan = asset_plan.clone().sanitized();
    plan.format = if config.image_format == "jpg" { "jpg".into() } else { "png".into() };
    plan.quality = config.quality.clamp(1, 100);
    plan.background = config.size.background.clone();
    plan.fill_transparent = config.size.fill_transparent;
    plan.resample = if config.size.resample == "bicubic" { "bicubic".into() } else { "lanczos".into() };
    match config.size.mode.as_str() {
        "preserve" => {
            plan.scale_mode = "preserve".into();
            plan.width = None;
            plan.height = None;
            plan.longest_edge = config
                .size
                .longest_edge
                .or(config.size.width)
                .or(config.size.height)
                .or(Some(base_resolution));
            plan.allow_upscale = config.size.allow_upscale;
        }
        "fitCrop" => {
            plan.scale_mode = "fitCrop".into();
            plan.width = Some(config.size.width.unwrap_or(base_resolution));
            plan.height = Some(config.size.height.unwrap_or(base_resolution));
            plan.longest_edge = None;
            plan.allow_upscale = config.size.allow_upscale;
        }
        "fitPad" => {
            plan.scale_mode = "fitPad".into();
            plan.width = Some(config.size.width.unwrap_or(base_resolution));
            plan.height = Some(config.size.height.unwrap_or(base_resolution));
            plan.longest_edge = None;
            plan.allow_upscale = config.size.allow_upscale;
        }
        _ => {
            // 沿用单图配方
        }
    }
    plan
}

fn sanitize_subset_dir(name: &str, index: usize) -> String {
    let cleaned = util::sanitize_stem(name);
    if cleaned.is_empty() {
        format!("subset-{:02}", index + 1)
    } else {
        format!("subset-{:02}", index + 1)
    }
}

#[derive(Default)]
struct SubsetPlan {
    assignments: HashMap<String, (String, String, u32, u32)>, // collectionId -> (dir,label,repeats,keep)
    overlaps: Vec<String>,
}

/// LoRA Script 的分组结构：分组目录为 `{单图训练次数}_{组名}`。
struct LoraSubsetPlan {
    order: Vec<String>,
    assignments: HashMap<String, (String, String, u32)>,
    ungrouped: (String, String, u32),
    members: HashMap<String, Vec<String>>,
}

fn unique_dir(base: String, used: &mut HashSet<String>) -> String {
    let mut candidate = base.clone();
    let mut counter = 2;
    while !used.insert(candidate.to_lowercase()) {
        candidate = format!("{base}-{counter}");
        counter += 1;
    }
    candidate
}

fn build_lora_subset_plan(
    conn: &rusqlite::Connection,
    config: &ExportConfig,
) -> AppResult<LoraSubsetPlan> {
    let mut untiled = conn.prepare(
        "SELECT id, name FROM collections WHERE kind <> 'query' ORDER BY lower(name), id",
    )?;
    let groups: Vec<(String, String)> = untiled
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .filter_map(|row| row.ok())
        .collect();
    let mut plan = LoraSubsetPlan {
        order: Vec::new(),
        assignments: HashMap::new(),
        ungrouped: (String::new(), "未分组".into(), 1),
        members: HashMap::new(),
    };
    let mut used: HashSet<String> = HashSet::new();
    for (index, (collection_id, name)) in groups.iter().enumerate() {
        let repeats = config
            .lora_script
            .repeats
            .get(collection_id)
            .copied()
            .unwrap_or(1)
            .clamp(1, 1000);
        let label = if name.trim().is_empty() {
            format!("分组{}", index + 1)
        } else {
            name.trim().to_string()
        };
        let safe = util::sanitize_stem(&label);
        let dir = unique_dir(format!("{repeats}_{safe}"), &mut used);
        plan.order.push(collection_id.clone());
        plan.assignments
            .insert(collection_id.clone(), (dir, label, repeats));
        let mut statement =
            conn.prepare("SELECT asset_id FROM collection_assets WHERE collection_id = ?1")?;
        let rows = statement.query_map(params![collection_id], |row| row.get::<_, String>(0))?;
        plan.members.insert(
            collection_id.clone(),
            rows.filter_map(|row| row.ok()).collect(),
        );
    }
    let ungrouped_repeats = config.lora_script.ungrouped_repeats.clamp(1, 1000);
    let ungrouped_dir = unique_dir(format!("{ungrouped_repeats}_未分组"), &mut used);
    plan.ungrouped = (ungrouped_dir, "未分组".into(), ungrouped_repeats);
    Ok(plan)
}

fn build_subset_plan(
    conn: &rusqlite::Connection,
    config: &ExportConfig,
) -> AppResult<(SubsetPlan, HashMap<String, Vec<String>>)> {
    let mut plan = SubsetPlan::default();
    // collectionId -> member ids
    let mut members: HashMap<String, Vec<String>> = HashMap::new();
    for (index, subset) in config.kohya.subsets.iter().enumerate() {
        if subset.collection_id.is_empty() {
            continue;
        }
        let dir = sanitize_subset_dir(&subset.name, index);
        let label = if subset.name.trim().is_empty() {
            dir.clone()
        } else {
            subset.name.trim().to_string()
        };
        plan.assignments.insert(
            subset.collection_id.clone(),
            (dir, label, subset.repeats.max(1), subset.keep_tokens),
        );
        let mut statement =
            conn.prepare("SELECT asset_id FROM collection_assets WHERE collection_id = ?1")?;
        let rows = statement.query_map(params![subset.collection_id], |row| row.get::<_, String>(0))?;
        members.insert(subset.collection_id.clone(), rows.filter_map(|r| r.ok()).collect());
    }
    Ok((plan, members))
}

fn subset_for_asset(
    members: &HashMap<String, Vec<String>>,
    asset_id: &str,
) -> Vec<String> {
    members
        .iter()
        .filter(|(_, ids)| ids.iter().any(|id| id == asset_id))
        .map(|(collection_id, _)| collection_id.clone())
        .collect()
}

#[derive(Default)]
struct UnionFind {
    parent: HashMap<String, String>,
}

impl UnionFind {
    fn find(&mut self, value: &str) -> String {
        let current = self
            .parent
            .get(value)
            .cloned()
            .unwrap_or_else(|| value.to_string());
        if current == value {
            return current;
        }
        let root = self.find(&current);
        self.parent.insert(value.to_string(), root.clone());
        root
    }
    fn union(&mut self, a: &str, b: &str) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.parent.insert(rb, ra);
        }
    }
}

fn assign_splits(
    conn: &rusqlite::Connection,
    assets: &[AssetRow],
    config: &ExportConfig,
) -> AppResult<(HashMap<String, String>, SplitSummary)> {
    let mut uf = UnionFind::default();
    for asset in assets {
        uf.parent.insert(asset.id.clone(), asset.id.clone());
    }
    let mut by_hash: HashMap<String, Vec<String>> = HashMap::new();
    for asset in assets {
        by_hash
            .entry(asset.content_hash.clone())
            .or_default()
            .push(asset.id.clone());
    }
    for ids in by_hash.values() {
        for pair in ids.windows(2) {
            uf.union(&pair[0], &pair[1]);
        }
    }
    let confirmed_groups: Vec<String> = {
        let mut statement =
            conn.prepare("SELECT members_json FROM duplicate_groups WHERE confirmed = 1 AND dismissed = 0")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for members_json in confirmed_groups {
        let members: Vec<String> = serde_json::from_str(&members_json).unwrap_or_default();
        let mut filtered: Vec<String> = members
            .into_iter()
            .filter(|id| assets.iter().any(|a| &a.id == id))
            .collect();
        if filtered.len() > 1 {
            let first = filtered.remove(0);
            for other in filtered {
                uf.union(&first, &other);
            }
        }
    }

    let mut components: HashMap<String, Vec<&AssetRow>> = HashMap::new();
    for asset in assets {
        let root = uf.find(&asset.id);
        components.entry(root).or_default().push(asset);
    }

    let mut assign: HashMap<String, String> = HashMap::new();
    let mut conflicts: Vec<String> = Vec::new();
    let mut locked_val = 0i64;
    let mut locked_train = 0i64;
    let mut unlocked: Vec<(String, Vec<&AssetRow>)> = Vec::new();
    let groups_count = components.len() as i64;

    for (root, members) in components {
        let mut locks: HashSet<String> = HashSet::new();
        for member in &members {
            if let Some(lock) = &member.split_lock {
                if lock == "train" || lock == "val" {
                    locks.insert(lock.clone());
                }
            }
        }
        let group_key = members
            .iter()
            .map(|a| a.id.clone())
            .min()
            .unwrap_or(root);
        if locks.len() > 1 {
            conflicts.push(format!(
                "重复组内同时锁定训练与验证：{}",
                members
                    .iter()
                    .map(|a| a.original_name.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            ));
            for member in members {
                assign.insert(member.id.clone(), "train".into());
                locked_train += 1;
            }
        } else if let Some(lock) = locks.iter().next() {
            let split = lock.clone();
            for member in &members {
                assign.insert(member.id.clone(), split.clone());
            }
            if split == "val" {
                locked_val += members.len() as i64;
            } else {
                locked_train += members.len() as i64;
            }
        } else {
            unlocked.push((group_key, members));
        }
    }

    let total = assets.len() as i64;
    let enabled = config.validation.enabled;
    let mut note = String::new();
    if enabled {
        if let Some(ratio) = Some(config.validation.ratio.clamp(0.01, 0.95)) {
            if config.validation.mode == "auto" {
                let target = ((total as f64) * ratio).round() as i64;
                let target = target.max(1).min(total.saturating_sub(1).max(1));
                // 稳定排序：SHA-256(seed + group)
                let mut ordered = unlocked;
                ordered.sort_by_key(|(key, _)| {
                    util::sha256_text(&format!("{}-{}", config.validation.seed, key))
                });
                let mut val = locked_val;
                let mut train = locked_train;
                for (_, members) in ordered {
                    let size = members.len() as i64;
                    let take = val < target && (train > 0 || val == 0) && (train - size) >= 0;
                    let split = if take { "val" } else { "train" };
                    if take {
                        val += size;
                    } else {
                        train += size;
                    }
                    for member in members {
                        assign.insert(member.id.clone(), split.into());
                    }
                }
                note = format!(
                    "自动划分：目标验证 {} 张，实际 {} 张（{}%）",
                    target,
                    val,
                    if total > 0 { (val as f64 / total as f64 * 100.0).round() } else { 0.0 }
                );
            } else {
                for (_, members) in unlocked {
                    for member in members {
                        assign.insert(member.id.clone(), "train".into());
                    }
                }
                note = "沿用手工分配；未锁定组进入训练集。".into();
            }
        }
    } else {
        for (_, members) in unlocked {
            for member in members {
                assign.insert(member.id.clone(), "train".into());
            }
        }
        note = "未启用验证集，全部进入训练集。".into();
    }
    // 未启用验证集时忽略手工验证锁定，全部进入训练集
    if !enabled {
        for asset in assets {
            assign.insert(asset.id.clone(), "train".into());
        }
        conflicts.clear();
    }
    // 兜底
    for asset in assets {
        assign.entry(asset.id.clone()).or_insert_with(|| "train".into());
    }
    let train = assign.values().filter(|v| *v == "train").count() as i64;
    let val = assign.values().filter(|v| *v == "val").count() as i64;
    let groups = groups_count;
    let summary = SplitSummary {
        enabled,
        mode: config.validation.mode.clone(),
        train,
        val,
        groups,
        target_ratio: if enabled { config.validation.ratio } else { 0.0 },
        actual_ratio: if total > 0 { val as f64 / total as f64 } else { 0.0 },
        conflicts,
        note,
    };
    Ok((assign, summary))
}

fn assign_names(items: &mut [ExportItem], config: &ExportConfig) -> HashSet<String> {
    let ext = if config.image_format == "jpg" { "jpg" } else { "png" };
    let mut used: HashSet<String> = HashSet::new();
    let mut warnings = HashSet::new();
    for (index, item) in items.iter_mut().enumerate() {
        let dir = &item.image_path[..item.image_path.rfind('/').unwrap_or(0)];
        let stem = if config.naming == "original" {
            util::sanitize_stem(
                Path::new(&item.original_name)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .as_deref()
                    .unwrap_or("image"),
            )
        } else {
            format!("{:06}", index + 1)
        };
        let mut candidate = stem.clone();
        let mut counter = 1;
        loop {
            let path = if dir.is_empty() {
                format!("{candidate}.{ext}")
            } else {
                format!("{dir}/{candidate}.{ext}")
            };
            let key = path.to_lowercase();
            if !used.contains(&key) {
                used.insert(key);
                item.image_path = path;
                break;
            }
            counter += 1;
            candidate = format!("{stem}_{counter:03}");
            if counter > 9999 {
                warnings.insert("文件名冲突过多，已使用稳定序号命名".to_string());
                break;
            }
        }
        if config.target == "kohya" || config.target == "lora_script" {
            let caption_name = Path::new(&item.image_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let caption_dir = item.image_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
            // lora_script 固定使用同名 .txt 标注。
            let caption_ext = if config.target == "lora_script" {
                ".txt"
            } else if config.caption_extension == ".caption" {
                ".caption"
            } else {
                ".txt"
            };
            item.caption_path = if caption_dir.is_empty() {
                format!("{caption_name}{caption_ext}")
            } else {
                format!("{caption_dir}/{caption_name}{caption_ext}")
            };
        }
    }
    warnings
}

fn estimate_bytes(width: u32, height: u32, format: &str) -> u64 {
    let pixels = width as u64 * height as u64;
    if format == "jpg" {
        pixels / 5 + 4096
    } else {
        pixels * 2 + 8192
    }
}

fn default_output_name(config: &ExportConfig) -> String {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let base = config
        .name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .map(|name| util::sanitize_stem(name.trim()))
        .unwrap_or_else(|| format!("yoyoku-{}-{stamp}", config.target));
    if config.package == "zip" {
        format!("{base}.zip")
    } else {
        base
    }
}

fn unique_path(parent: &Path, name: &str) -> PathBuf {
    let candidate = parent.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let ext = Path::new(name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for index in 2..10_000 {
        let candidate = parent.join(format!("{stem}-{index}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(name)
}

fn check_target_writable(parent: &Path) -> (bool, String) {
    let mut probe = parent.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(next) => probe = next.to_path_buf(),
            None => return (false, "目标路径没有可用的父目录".into()),
        }
    }
    let test = probe.join(format!(".yoyoku-write-{}", util::short_id(6)));
    match std::fs::write(&test, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&test);
            (true, String::new())
        }
        Err(error) => (false, format!("目标目录不可写：{error}")),
    }
}

pub fn preview(project: &Project, config: &ExportConfig) -> AppResult<PendingExport> {
    let conn = project.conn();
    let ctx = caption_context(&conn)?;
    let roots = root_map(&conn)?;
    let captions = caption_map(&conn)?;
    let scoped = scope_assets(&conn, &config.scope)?;
    let model: String = conn
        .query_row("SELECT model FROM project LIMIT 1", [], |row| row.get(0))?;

    let mut excluded_count = 0i64;
    let mut pending_count = 0i64;
    let mut approved_count = 0i64;
    let mut eligible_assets: Vec<&AssetRow> = Vec::new();
    for asset in &scoped {
        if asset.review_status == "excluded" {
            excluded_count += 1;
            continue;
        }
        if asset.review_status == "pending" {
            pending_count += 1;
        }
        if asset.review_status == "approved" {
            approved_count += 1;
        }
        eligible_assets.push(asset);
    }
    if eligible_assets.is_empty() {
        return Err(AppError::new("EMPTY_SCOPE", "当前导出范围内没有有效图片"));
    }

    let (subset_plan, subset_members) = build_subset_plan(&conn, config)?;
    let lora_plan = if config.target == "lora_script" {
        Some(build_lora_subset_plan(&conn, config)?)
    } else {
        None
    };
    // LoRA Script 结构只有分组训练目录，不生成验证集分割。
    let mut split_config = config.clone();
    if config.target == "lora_script" {
        split_config.validation.enabled = false;
    }
    let (split_assign, split_summary) = assign_splits(&conn, &eligible_assets.iter().map(|a| (*a).clone()).collect::<Vec<_>>(), &split_config)?;

    let mut issues: Vec<ExportIssue> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    if config.target == "lora_script" && config.validation.enabled {
        warnings.push("LoRA Script 结构不使用验证集，已全部按训练分组导出。".into());
    }
    let mut items: Vec<ExportItem> = Vec::new();
    let mut missing_ids: Vec<String> = Vec::new();
    let mut empty_caption_ids: Vec<String> = Vec::new();
    let mut changed_ids: Vec<String> = Vec::new();
    let mut blocked_ids: Vec<String> = Vec::new();
    let mut overlaps: Vec<String> = Vec::new();
    let mut estimated_bytes = 0u64;

    for asset in &eligible_assets {
        let source_path = asset_source_path(project, &roots, asset);
        let source = source_path.to_string_lossy().to_string();
        let metadata = std::fs::metadata(&source_path).ok();
        if metadata.is_none() {
            missing_ids.push(asset.id.clone());
        } else if let Some(meta) = &metadata {
            if meta.len() as i64 != asset.bytes {
                changed_ids.push(asset.id.clone());
            } else if let (Some(stored), Ok(modified)) = (
                asset.source_mtime.as_deref(),
                meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis().to_string())
                    .ok_or(()),
            ) {
                if stored != modified && asset
                    .source_root_id
                    .as_ref()
                    .and_then(|id| roots.get(id))
                    .map(|(_, mode)| mode.as_str() == "ref")
                    .unwrap_or(false)
                {
                    changed_ids.push(asset.id.clone());
                }
            }
        }
        let (mode, tags, text) = asset
            .caption_revision_id
            .as_deref()
            .and_then(|id| captions.get(id))
            .cloned()
            .unwrap_or_else(|| (ctx.default_mode.clone(), Vec::new(), String::new()));
        let final_text = caption::finalize_caption(
            &mode,
            &tags,
            &text,
            &ctx.trigger_word,
            &ctx.trigger_mode,
            asset.trigger_disabled,
        );
        if final_text.trim().is_empty() {
            empty_caption_ids.push(asset.id.clone());
        }
        let asset_plan = {
            let plan_json: Option<String> = asset
                .transform_revision_id
                .as_deref()
                .and_then(|id| {
                    conn.query_row(
                        "SELECT plan_json FROM transform_revisions WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                });
            plan_json
                .and_then(|json| serde_json::from_str::<TransformPlan>(&json).ok())
                .unwrap_or_default()
        };
        let plan = effective_plan(&asset_plan, config, ctx.base_resolution);
        let geometry = transform::compute_geometry(&plan, asset.norm_width, asset.norm_height);
        if geometry.blocked {
            blocked_ids.push(asset.id.clone());
        }
        let split = split_assign
            .get(&asset.id)
            .cloned()
            .unwrap_or_else(|| "train".into());

        // 子集归属
        let matching = subset_for_asset(&subset_members, &asset.id);
        let (subset, subset_label, repeats, keep_tokens) = if config.target == "kohya" {
            let mut distinct = matching.clone();
            distinct.sort();
            if distinct.len() > 1 {
                overlaps.push(format!(
                    "{} 同时属于 {} 个训练子集",
                    asset.original_name,
                    distinct.len()
                ));
            }
            if let Some(collection_id) = distinct.first() {
                subset_plan
                    .assignments
                    .get(collection_id)
                    .cloned()
                    .unwrap_or_else(|| (String::new(), "默认子集".into(), 1, 0))
            } else {
                (String::new(), "默认子集".into(), 1, config.kohya.keep_tokens)
            }
        } else if let Some(plan) = &lora_plan {
            // 按分组名称顺序选择第一个归属，避免同一图片写入多个子目录。
            let matches: Vec<&String> = plan
                .order
                .iter()
                .filter(|collection_id| {
                    plan.members
                        .get(*collection_id)
                        .map(|ids| ids.iter().any(|id| id == &asset.id))
                        .unwrap_or(false)
                })
                .collect();
            if matches.len() > 1 {
                overlaps.push(format!(
                    "{} 同时属于 {} 个分组，已使用「{}」",
                    asset.original_name,
                    matches.len(),
                    plan.assignments
                        .get(matches[0])
                        .map(|(_, label, _)| label.clone())
                        .unwrap_or_default()
                ));
            }
            let (dir, label, repeats) = if let Some(collection_id) = matches.first() {
                plan.assignments
                    .get(*collection_id)
                    .cloned()
                    .unwrap_or_else(|| plan.ungrouped.clone())
            } else {
                plan.ungrouped.clone()
            };
            (dir, label, repeats, 0)
        } else {
            (String::new(), "默认子集".into(), 1, 0)
        };

        let dir = if config.target == "lora_script" {
            subset.clone()
        } else if split == "val" {
            "validation".to_string()
        } else if config.target == "kohya" && !subset.is_empty() {
            format!("train/{subset}")
        } else {
            "train".to_string()
        };
        let caption_path = if config.target == "imagefolder" {
            format!("{dir}/metadata.jsonl")
        } else {
            String::new()
        };
        items.push(ExportItem {
            asset_id: asset.id.clone(),
            original_name: asset.original_name.clone(),
            source_path: source.clone(),
            source_hash: asset.content_hash.clone(),
            source_size: asset.bytes,
            source_mtime: asset.source_mtime.clone(),
            revision: asset.revision,
            caption: final_text,
            caption_mode: mode,
            plan,
            split,
            subset,
            subset_label,
            repeats,
            keep_tokens,
            image_path: format!("{dir}/placeholder.png"),
            caption_path,
            width: geometry.out_width,
            height: geometry.out_height,
            estimated_bytes: estimate_bytes(geometry.out_width, geometry.out_height, &config.image_format),
            status: asset.review_status.clone(),
        });
        estimated_bytes += estimate_bytes(geometry.out_width, geometry.out_height, &config.image_format);
    }

    items.sort_by_key(|item| {
        eligible_assets
            .iter()
            .position(|a| a.id == item.asset_id)
            .unwrap_or(usize::MAX)
    });
    let naming_warnings = assign_names(&mut items, config);
    warnings.extend(naming_warnings.into_iter());
    if config.target == "kohya" && config.kohya.subsets.iter().any(|subset| subset.collection_id.is_empty()) {
        warnings.push("有个训练子集未选择集合，已忽略。".into());
    }
    let train = items.iter().filter(|item| item.split == "train").count() as i64;
    let val = items.iter().filter(|item| item.split == "val").count() as i64;
    let mut split_summary = split_summary;
    split_summary.train = train;
    split_summary.val = val;
    split_summary.actual_ratio = if !items.is_empty() {
        val as f64 / items.len() as f64
    } else {
        0.0
    };
    if config.target == "kohya"
        && config.kohya.shuffle_caption
        && items.iter().any(|item| item.caption_mode != "tags")
    {
        warnings.push("存在自然语言标注，导出时已关闭 shuffle_caption。".into());
    }

    if !missing_ids.is_empty() {
        issues.push(ExportIssue {
            level: "blocking".into(),
            code: "SOURCE_MISSING".into(),
            message: format!("{} 张图片的源文件已失联，请在质检页重新定位或排除。", missing_ids.len()),
            asset_ids: missing_ids.iter().take(80).cloned().collect(),
            action: "relink".into(),
        });
    }
    if !changed_ids.is_empty() {
        issues.push(ExportIssue {
            level: "blocking".into(),
            code: "SOURCE_CHANGED".into(),
            message: format!("{} 张图片的源文件在导入后发生变化，请重新校验或重新导入。", changed_ids.len()),
            asset_ids: changed_ids.iter().take(80).cloned().collect(),
            action: "relink".into(),
        });
    }
    if !empty_caption_ids.is_empty() {
        issues.push(ExportIssue {
            level: "blocking".into(),
            code: "CAPTION_EMPTY".into(),
            message: format!("{} 张图片的最终标注为空。", empty_caption_ids.len()),
            asset_ids: empty_caption_ids.iter().take(80).cloned().collect(),
            action: "caption".into(),
        });
    }
    if !blocked_ids.is_empty() {
        issues.push(ExportIssue {
            level: "blocking".into(),
            code: "OUTPUT_BLOCKED".into(),
            message: format!("{} 张图片的固定尺寸策略需要放大，但当前禁止放大。", blocked_ids.len()),
            asset_ids: blocked_ids.iter().take(80).cloned().collect(),
            action: "plan".into(),
        });
    }
    if !overlaps.is_empty() {
        if config.target == "lora_script" {
            warnings.push(format!(
                "{} 张图片同时属于多个分组，已按分组名称顺序选择第一个：{}",
                overlaps.len(),
                overlaps.iter().take(3).cloned().collect::<Vec<_>>().join("；")
            ));
        } else {
            issues.push(ExportIssue {
                level: "blocking".into(),
                code: "SUBSET_OVERLAP".into(),
                message: format!("{} 张图片同时属于多个训练子集，请先调整集合归属。", overlaps.len()),
                asset_ids: Vec::new(),
                action: "collection".into(),
            });
        }
    }
    if !split_summary.conflicts.is_empty() {
        issues.push(ExportIssue {
            level: "blocking".into(),
            code: "SPLIT_CONFLICT".into(),
            message: split_summary.conflicts.join("；"),
            asset_ids: Vec::new(),
            action: "split".into(),
        });
    }
    if split_summary.enabled {
        if train == 0 {
            issues.push(ExportIssue {
                level: "blocking".into(),
                code: "TRAIN_EMPTY".into(),
                message: "训练集为空，无法导出。".into(),
                asset_ids: Vec::new(),
                action: "split".into(),
            });
        }
        if val == 0 {
            issues.push(ExportIssue {
                level: "blocking".into(),
                code: "VAL_EMPTY".into(),
                message: "已启用验证集，但验证集为空。请调整比例、锁定用途或关闭验证集。".into(),
                asset_ids: Vec::new(),
                action: "split".into(),
            });
        }
    }
    if pending_count > 0 {
        issues.push(ExportIssue {
            level: "suggestion".into(),
            code: "UNREVIEWED".into(),
            message: format!("{} 张图片尚未人工审核，仍会进入导出。", pending_count),
            asset_ids: Vec::new(),
            action: "review".into(),
        });
    }

    // 目标目录可写性
    let parent = config
        .dest_dir
        .as_deref()
        .map(util::expand_user_home)
        .map(PathBuf::from)
        .unwrap_or_else(|| project.exports_dir());
    let (writable, reason) = check_target_writable(&parent);
    if !writable {
        issues.push(ExportIssue {
            level: "blocking".into(),
            code: "TARGET_UNWRITABLE".into(),
            message: reason,
            asset_ids: Vec::new(),
            action: "path".into(),
        });
    }
    let output_path = if config.target == "lora_script"
        && config.name.as_deref().map(|name| name.trim().is_empty()).unwrap_or(true)
    {
        // LoRA Script 的根目录就是 LoRA 名称；未填写时使用项目名。
        let project_name: String = conn
            .query_row("SELECT name FROM project LIMIT 1", [], |row| row.get(0))
            .unwrap_or_else(|_| "lora".into());
        let base = util::sanitize_stem(&project_name);
        let name = if config.package == "zip" {
            format!("{base}.zip")
        } else {
            base
        };
        unique_path(&parent, &name)
    } else {
        unique_path(&parent, &default_output_name(config))
    };
    let adapter_version = match config.target.as_str() {
        "kohya" => KOHYA_COMPAT,
        "imagefolder" => DIFFUSERS_COMPAT,
        _ => LORA_SCRIPT_COMPAT,
    }
    .to_string();
    let mut preview = ExportPreview {
        id: util::new_id(),
        fingerprint: String::new(),
        target: config.target.clone(),
        package: config.package.clone(),
        output_path: output_path.to_string_lossy().to_string(),
        counts: ExportCounts {
            candidates: scoped.len() as i64,
            eligible: items.len() as i64,
            excluded: excluded_count,
            pending: pending_count,
            approved: approved_count,
            train,
            val,
            skipped: excluded_count,
        },
        issues,
        tree: Vec::new(),
        files: Vec::new(),
        samples: Vec::new(),
        estimated_bytes,
        split: split_summary,
        config: config.clone(),
        config_hash: config_hash(config),
        warnings,
        adapter_version,
    };
    let fingerprint = fingerprint(config, &items);
    preview.fingerprint = fingerprint.clone();
    adapters::fill_preview_files(&mut preview, &items, config, &model)?;
    let pending = PendingExport {
        preview,
        items,
        config: config.clone(),
        config_hash: config_hash(config),
        created_at: util::now_iso(),
    };
    // 记录快照（用于导出历史与预检指纹）
    conn.execute(
        "INSERT INTO export_snapshots(id, config_json, fingerprint, asset_count, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        params![
            pending.preview.id,
            serde_json::to_string(config)?,
            fingerprint,
            pending.items.len() as i64,
            util::now_iso()
        ],
    )?;
    Ok(pending)
}

fn fingerprint(config: &ExportConfig, items: &[ExportItem]) -> String {
    let parts: Vec<serde_json::Value> = items
        .iter()
        .map(|item| {
            serde_json::json!({
                "id": item.asset_id,
                "revision": item.revision,
                "hash": item.source_hash,
                "caption": item.caption,
                "plan": item.plan,
                "split": item.split,
                "subset": item.subset,
            })
        })
        .collect();
    util::sha256_text(&serde_json::json!({
        "config": config,
        "items": parts,
    }).to_string())
}

pub fn start(
    app: tauri::AppHandle,
    project: std::sync::Arc<Project>,
    pending: PendingExport,
) -> AppResult<String> {
    // 校验快照仍与当前数据一致
    let stale: Vec<String> = {
        let conn = project.conn();
        let mut stale = Vec::new();
        for item in &pending.items {
            match db::get_asset(&conn, &item.asset_id) {
                Ok(asset) => {
                    if asset.revision != item.revision
                        || asset.content_hash != item.source_hash
                        || asset.review_status == "excluded"
                    {
                        stale.push(item.asset_id.clone());
                    }
                }
                Err(_) => stale.push(item.asset_id.clone()),
            }
        }
        let snapshot_exists: Option<String> = conn
            .query_row(
                "SELECT id FROM export_snapshots WHERE id = ?1",
                params![pending.preview.id],
                |row| row.get(0),
            )
            .optional()?;
        if snapshot_exists.is_none() {
            stale.push("snapshot".into());
        }
        stale
    };
    if !stale.is_empty() {
        return Err(AppError::new(
            "PREVIEW_STALE",
            "数据在预检后发生了变化，请重新预检并确认差异后再导出。",
        )
        .items(stale));
    }
    let blocking: Vec<String> = pending
        .preview
        .issues
        .iter()
        .filter(|issue| issue.level == "blocking")
        .map(|issue| issue.message.clone())
        .collect();
    if !blocking.is_empty() {
        return Err(AppError::new(
            "EXPORT_BLOCKED",
            "导出预检仍存在阻塞项，请先处理。",
        )
        .details(serde_json::json!({ "blocking": blocking })));
    }
    let total = pending.items.len() as i64;
    let input = serde_json::json!({
        "previewId": pending.preview.id,
        "snapshotId": pending.preview.id,
        "fingerprint": pending.preview.fingerprint,
        "target": pending.config.target,
        "package": pending.config.package,
        "outputPath": pending.preview.output_path,
        "itemCount": total,
    });
    let job_id = crate::project::jobs::insert_job(
        &project,
        "export",
        &format!("导出数据集（{} 张）", total),
        &input,
        total,
    )?;
    let job_for_thread = job_id.clone();
    crate::project::jobs::run(app, project, job_id.clone(), move |ctx| {
        runner::run_export(ctx, pending)
    });
    Ok(job_for_thread)
}

pub fn list_records(project: &Project) -> AppResult<Vec<ExportRecordInfo>> {
    let conn = project.conn();
    let mut statement = conn.prepare(
        "SELECT id, snapshot_id, created_at, target, package, output_path, counts_json, validation_json, manifest_sha256
         FROM export_records ORDER BY created_at DESC LIMIT 50",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(ExportRecordInfo {
            id: row.get(0)?,
            snapshot_id: row.get(1)?,
            created_at: row.get(2)?,
            target: row.get(3)?,
            package: row.get(4)?,
            output_path: row.get(5)?,
            counts: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or(serde_json::json!({})),
            validation: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or(serde_json::json!({})),
            manifest_sha256: row.get(8)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn record_detail(project: &Project, record_id: &str) -> AppResult<ExportRecordInfo> {
    let conn = project.conn();
    conn.query_row(
        "SELECT id, snapshot_id, created_at, target, package, output_path, counts_json, validation_json, manifest_sha256
         FROM export_records WHERE id = ?1",
        params![record_id],
        |row| {
            Ok(ExportRecordInfo {
                id: row.get(0)?,
                snapshot_id: row.get(1)?,
                created_at: row.get(2)?,
                target: row.get(3)?,
                package: row.get(4)?,
                output_path: row.get(5)?,
                counts: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or(serde_json::json!({})),
                validation: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or(serde_json::json!({})),
                manifest_sha256: row.get(8)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("导出记录"))
}

/// 从导出历史生成当前路径的绝对版 TOML（搬移后也可使用）。
pub fn write_absolute_entry(project: &Project, record_id: &str) -> AppResult<(String, String)> {
    let record = record_detail(project, record_id)?;
    if record.target != "kohya" {
        return Err(AppError::new(
            "NOT_KOHYA",
            "只有 Kohya 目标支持生成绝对版 dataset.toml。",
        ));
    }
    let root = PathBuf::from(&record.output_path);
    if !root.is_dir() {
        return Err(AppError::new(
            "NOT_EXTRACTED",
            "导出包是 ZIP，请先解压后再生成绝对版 dataset.toml。",
        ));
    }
    let toml_path = root.join("dataset.toml");
    let text = std::fs::read_to_string(&toml_path)
        .map_err(|e| AppError::io("读取 dataset.toml 失败", e))?;
    let root_string = root.to_string_lossy().replace('\\', "/");
    let mut rewritten = text.clone();
    for line in text.lines() {
        if let Some(value) = line.trim().strip_prefix("image_dir") {
            if let Some(rest) = value.split('=').nth(1) {
                let dir = rest.trim().trim_matches('"');
                if !dir.is_empty() && !Path::new(dir).is_absolute() {
                    let absolute = format!("{root_string}/{dir}");
                    rewritten = rewritten.replace(line, &format!("image_dir = \"{}\"", absolute));
                }
            }
        }
    }
    let absolute_path = root.join("dataset.absolute.toml");
    util::write_atomic(&absolute_path, rewritten.as_bytes())?;
    let model: String = project
        .conn()
        .query_row("SELECT model FROM project LIMIT 1", [], |row| row.get(0))
        .unwrap_or_else(|_| "sdxl".into());
    let script = if model == "sd15" { "train_network.py" } else { "sdxl_train_network.py" };
    let command = format!(
        "accelerate launch --num_cpu_threads_per_process 1 {script} --dataset_config \"{}\"",
        absolute_path.to_string_lossy()
    );
    Ok((absolute_path.to_string_lossy().to_string(), command))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lora_config() -> ExportConfig {
        let mut config = ExportConfig::default();
        config.target = "lora_script".into();
        config.lora_script.ungrouped_repeats = 3;
        config
    }

    #[test]
    fn lora_subset_plan_uses_repeats_and_ignores_query_collections() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL);
             CREATE TABLE collection_assets (collection_id TEXT NOT NULL, asset_id TEXT NOT NULL);
             INSERT INTO collections VALUES ('c1', '人物', 'manual');
             INSERT INTO collections VALUES ('c2', '人物', 'manual');
             INSERT INTO collections VALUES ('c3', '人物', 'manual');
             INSERT INTO collections VALUES ('q1', '查询', 'query');
             INSERT INTO collection_assets VALUES ('c1', 'a1');
             INSERT INTO collection_assets VALUES ('c2', 'a2');
             INSERT INTO collection_assets VALUES ('c3', 'a3');",
        )
        .unwrap();
        let mut config = lora_config();
        config.lora_script.repeats.insert("c1".into(), 2);
        config.lora_script.repeats.insert("c2".into(), 5);
        config.lora_script.repeats.insert("c3".into(), 2);

        let plan = build_lora_subset_plan(&conn, &config).unwrap();

        assert_eq!(
            plan.order,
            vec!["c1".to_string(), "c2".to_string(), "c3".to_string()]
        );
        assert_eq!(plan.assignments.get("c1").unwrap().0, "2_人物");
        assert_eq!(plan.assignments.get("c2").unwrap().0, "5_人物");
        // 同名且同次数时通过序号目录区分，避免写入同一个文件夹。
        assert_eq!(plan.assignments.get("c3").unwrap().0, "2_人物-2");
        assert_eq!(plan.assignments.get("c1").unwrap().2, 2);
        assert_eq!(plan.assignments.get("c2").unwrap().2, 5);
        assert!(plan.assignments.get("q1").is_none());
        assert_eq!(plan.ungrouped, ("3_未分组".into(), "未分组".into(), 3));
    }
}
