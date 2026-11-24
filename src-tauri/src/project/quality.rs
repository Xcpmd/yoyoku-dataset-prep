use crate::caption;
use crate::db::{self, meta_get, meta_set, AssetRow};
use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::project::history::{self, snapshot_asset, HistoryState};
use crate::project::transform;
use crate::project::Project;
use crate::util;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const RULE_VERSION: &str = "q1";
const DUPLICATE_DISTANCE_DEFAULT: u32 = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Thresholds {
    pub low_resolution_ratio: f64,
    pub extreme_aspect: f64,
    pub crop_ratio: f64,
    pub pad_ratio: f64,
    pub duplicate_distance: u32,
    pub duplicate_weight: f64,
    pub exposure_ratio: f64,
    pub blur_enabled: bool,
    pub blur_threshold: f64,
    pub max_caption_chars: usize,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            low_resolution_ratio: 0.5,
            extreme_aspect: 3.0,
            crop_ratio: 0.3,
            pad_ratio: 0.25,
            duplicate_distance: DUPLICATE_DISTANCE_DEFAULT,
            duplicate_weight: 0.8,
            exposure_ratio: 0.4,
            blur_enabled: false,
            blur_threshold: 60.0,
            max_caption_chars: 320,
        }
    }
}

pub fn thresholds(conn: &rusqlite::Connection) -> Thresholds {
    let settings = crate::project::project_settings(conn);
    settings
        .get("thresholds")
        .and_then(|value| serde_json::from_value::<Thresholds>(value.clone()).ok())
        .unwrap_or_default()
}

pub fn config_hash(conn: &rusqlite::Connection) -> String {
    let th = thresholds(conn);
    let base = crate::project::model_base_resolution(conn);
    let text = serde_json::json!({
        "ruleVersion": RULE_VERSION,
        "base": base,
        "thresholds": th,
    });
    util::sha256_text(&text.to_string())
}

pub fn rule_meta(rule: &str) -> (&'static str, &'static str, &'static str) {
    match rule {
        "source_missing" => ("源文件失联", "blocking", "源文件无法读取，导出前必须重新定位或恢复。"),
        "caption_empty" => ("标注为空", "blocking", "最终导出文本为空，训练端无法读取语义。"),
        "output_blocked" => ("输出尺寸受阻", "blocking", "固定尺寸裁切需要放大，但当前配方禁止放大。"),
        "crop_empty" => ("裁剪无有效像素", "blocking", "裁剪矩形为空或小于 1 像素。"),
        "animated" => ("多帧图片", "blocking", "v1 只支持静态图片，请另存为单帧后重新导入。"),
        "low_resolution" => ("短边偏低", "suggestion", "图片短边低于预设短边的 50%，可能影响细节。"),
        "extreme_aspect" => ("超长比例", "suggestion", "长边/短边超过阈值，训练端分桶可能浪费像素。"),
        "heavy_crop" => ("裁剪面积较大", "suggestion", "裁掉的面积超过阈值，请确认主体完整。"),
        "heavy_pad" => ("补边面积较大", "suggestion", "补边占比超过阈值，可能产生无效背景。"),
        "upscale" => ("需要放大", "suggestion", "输出会放大原图，细节可能被插值。"),
        "transparent" => ("透明像素", "suggestion", "导出前会按指定背景合成为 RGB，请确认合成效果。"),
        "icc_anomaly" => ("嵌入色彩异常", "suggestion", "ICC 无法转换或配置异常，已按 sRGB 处理。"),
        "unreviewed" => ("未人工审核", "suggestion", "此图尚未人工确认。"),
        "trigger_missing" => ("触发词缺失", "suggestion", "项目触发词未出现在最终标注中。"),
        "trigger_duplicate" => ("触发词重复", "suggestion", "最终标注中触发词出现多次。"),
        "text_truncated" => ("文本偏长", "suggestion", "标注字符数超过阈值，训练端可能截断。"),
        "blur" => ("疑似模糊", "suggestion", "拉普拉斯方差低于校准阈值，建议人工确认。"),
        "exposure" => ("曝光异常", "suggestion", "过暗或过亮像素占比超过阈值。"),
        "exact_duplicate" => ("精确重复", "suggestion", "存在字节完全相同的图片。"),
        "near_duplicate" => ("感知近似重复", "suggestion", "pHash 距离低于阈值，可能重复。"),
        "duplicate_weight" => ("重复权重过高", "suggestion", "单一子集的重复后样本占比超过阈值。"),
        "sidecar_conflict" => ("标注候选冲突", "suggestion", "同一目录存在多个配套标注或共用标注名。"),
        _ => ("其他问题", "suggestion", "质量问题。"),
    }
}

fn all_rules() -> Vec<&'static str> {
    vec![
        "source_missing",
        "caption_empty",
        "output_blocked",
        "crop_empty",
        "animated",
        "low_resolution",
        "extreme_aspect",
        "heavy_crop",
        "heavy_pad",
        "upscale",
        "transparent",
        "icc_anomaly",
        "unreviewed",
        "trigger_missing",
        "trigger_duplicate",
        "text_truncated",
        "blur",
        "exposure",
        "exact_duplicate",
        "near_duplicate",
        "duplicate_weight",
    ]
}

fn insert_issue(
    conn: &rusqlite::Connection,
    asset_id: &str,
    rule: &str,
    level: &str,
    message: &str,
    evidence: &serde_json::Value,
    config_hash: &str,
) -> AppResult<()> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT id FROM issues WHERE asset_id = ?1 AND rule = ?2",
            params![asset_id, rule],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = exists {
        conn.execute(
            "UPDATE issues SET level = ?1, message = ?2, evidence_json = ?3, rule_version = ?4,
             config_hash = ?5 WHERE id = ?6",
            params![level, message, serde_json::to_string(evidence)?, RULE_VERSION, config_hash, id],
        )?;
    } else {
        conn.execute(
            "INSERT INTO issues(id, asset_id, rule, level, message, evidence_json, ignored, rule_version,
                config_hash, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)",
            params![
                util::new_id(),
                asset_id,
                rule,
                level,
                message,
                serde_json::to_string(evidence)?,
                RULE_VERSION,
                config_hash,
                util::now_iso()
            ],
        )?;
    }
    Ok(())
}

fn trigger_occurrences(text: &str, trigger: &str) -> usize {
    let text_lower = text.to_lowercase();
    let trigger_lower = trigger.to_lowercase();
    if trigger_lower.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut offset = 0;
    while let Some(found) = text_lower[offset..].find(&trigger_lower) {
        let start = offset + found;
        let end = start + trigger_lower.len();
        let before_ok = text_lower[..start].chars().next_back().map(|c| !c.is_alphanumeric() && c != '_').unwrap_or(true);
        let after_ok = text_lower[end..].chars().next().map(|c| !c.is_alphanumeric() && c != '_').unwrap_or(true);
        if before_ok && after_ok {
            count += 1;
        }
        offset = end;
        if offset >= text_lower.len() {
            break;
        }
    }
    count
}

fn load_caption(
    conn: &rusqlite::Connection,
    asset: &AssetRow,
    default_mode: &str,
) -> (String, Vec<String>, String) {
    if let Some(id) = asset.caption_revision_id.as_deref() {
        if let Ok(Some(row)) = conn
            .query_row(
                "SELECT mode, tags_json, text FROM caption_revisions WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()
        {
            return (row.0, serde_json::from_str(&row.1).unwrap_or_default(), row.2);
        }
    }
    (default_mode.to_string(), Vec::new(), String::new())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityRunResult {
    pub summary: QualitySummary,
    pub duplicate_groups: i64,
    pub scanned: i64,
    pub duration_ms: u64,
}

pub fn run(project: &Project) -> AppResult<QualityRunResult> {
    let start = std::time::Instant::now();
    let mut conn = project.conn();
    let hash = config_hash(&conn);
    let previous_hash = meta_get(&conn, "quality_config_hash");
    if previous_hash.as_deref() != Some(hash.as_str()) {
        // 阈值或规则版本变化：重新评估忽略项
        conn.execute("UPDATE issues SET ignored = 0, ignore_reason = NULL", [])?;
    }
    let th = thresholds(&conn);
    let base = crate::project::model_base_resolution(&conn) as f64;
    let (trigger_word, trigger_mode, default_mode): (String, String, String) = conn.query_row(
        "SELECT trigger_word, trigger_mode, default_caption_mode FROM project LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;

    let assets = {
        let mut statement = conn.prepare(&format!(
            "SELECT {} FROM assets ORDER BY sort_index ASC",
            db::ASSET_COLUMNS
        ))?;
        let rows = statement.query_map([], db::asset_row)?;
        rows.filter_map(|r| r.ok()).collect::<Vec<_>>()
    };

    // 记录每张图本次仍存在的问题，用于清理已解决项
    let mut present: HashMap<String, HashSet<String>> = HashMap::new();
    let mut source_missing = 0i64;
    let roots: HashMap<String, (String, String)> = {
        let mut statement = conn.prepare("SELECT id, path, mode FROM source_roots")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, (row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let tx = conn.transaction()?;
    for asset in &assets {
        let mut rules: HashSet<String> = HashSet::new();
        let source_path = if let Some((root, mode)) = asset
            .source_root_id
            .as_ref()
            .and_then(|id| roots.get(id))
        {
            if mode == "copy" {
                project.originals_dir().join(format!("{}.{}", asset.content_hash, asset.ext))
            } else {
                util::safe_join(std::path::Path::new(root), &asset.rel_path).unwrap_or_default()
            }
        } else {
            project.originals_dir().join(format!("{}.{}", asset.content_hash, asset.ext))
        };
        let missing = !source_path.exists();
        if missing {
            source_missing += 1;
            insert_issue(
                &tx,
                &asset.id,
                "source_missing",
                "blocking",
                "源文件已失联，请重新定位或从导出范围排除。",
                &serde_json::json!({ "path": asset.rel_path }),
                &hash,
            )?;
            rules.insert("source_missing".into());
            tx.execute("UPDATE assets SET missing = 1 WHERE id = ?1", params![asset.id])?;
        } else {
            tx.execute("UPDATE assets SET missing = 0 WHERE id = ?1", params![asset.id])?;
        }

        let plan = {
            let plan_json: Option<String> = asset
                .transform_revision_id
                .as_deref()
                .and_then(|id| {
                    tx.query_row(
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
                .sanitized()
        };
        let geometry = transform::compute_geometry(&plan, asset.norm_width, asset.norm_height);
        if geometry.crop_width == 0 || geometry.crop_height == 0 {
            insert_issue(&tx, &asset.id, "crop_empty", "blocking", "裁剪区域没有有效像素。", &serde_json::json!({}), &hash)?;
            rules.insert("crop_empty".into());
        }
        if geometry.blocked {
            insert_issue(
                &tx,
                &asset.id,
                "output_blocked",
                "blocking",
                geometry.blocked_reason.as_deref().unwrap_or("输出尺寸无法满足"),
                &serde_json::json!({ "outWidth": geometry.out_width, "outHeight": geometry.out_height }),
                &hash,
            )?;
            rules.insert("output_blocked".into());
        }

        let analysis: serde_json::Value = serde_json::from_str(&asset.analysis_json).unwrap_or(serde_json::json!({}));
        if analysis.get("frames").and_then(|v| v.as_u64()).unwrap_or(1) > 1 {
            insert_issue(&tx, &asset.id, "animated", "blocking", "多帧图片不能进入静态训练集。", &analysis, &hash)?;
            rules.insert("animated".into());
        }

        let (mode, tags, raw_text) = load_caption(&tx, asset, &default_mode);
        let final_text = caption::finalize_caption(
            &mode,
            &tags,
            &raw_text,
            &trigger_word,
            &trigger_mode,
            asset.trigger_disabled,
        );
        if final_text.trim().is_empty() {
            insert_issue(&tx, &asset.id, "caption_empty", "blocking", "最终标注为空，导出会被阻塞。", &serde_json::json!({}), &hash)?;
            rules.insert("caption_empty".into());
        }
        if asset.review_status == "pending" {
            insert_issue(&tx, &asset.id, "unreviewed", "suggestion", "尚未人工审核。", &serde_json::json!({ "status": asset.review_status }), &hash)?;
            rules.insert("unreviewed".into());
        }
        let short_edge = asset.norm_width.min(asset.norm_height) as f64;
        if short_edge < base * th.low_resolution_ratio {
            insert_issue(
                &tx,
                &asset.id,
                "low_resolution",
                "suggestion",
                &format!("短边 {} px，低于预设短边的 {:.0}%", short_edge as u32, th.low_resolution_ratio * 100.0),
                &serde_json::json!({ "shortEdge": short_edge as u32, "threshold": (base * th.low_resolution_ratio) as u32 }),
                &hash,
            )?;
            rules.insert("low_resolution".into());
        }
        let aspect = asset.norm_width.max(asset.norm_height) as f64 / short_edge.max(1.0);
        if aspect > th.extreme_aspect {
            insert_issue(
                &tx,
                &asset.id,
                "extreme_aspect",
                "suggestion",
                &format!("长边/短边 {:.2}，超过阈值 {:.1}", aspect, th.extreme_aspect),
                &serde_json::json!({ "aspect": aspect, "threshold": th.extreme_aspect }),
                &hash,
            )?;
            rules.insert("extreme_aspect".into());
        }
        if geometry.crop_ratio > th.crop_ratio {
            insert_issue(
                &tx,
                &asset.id,
                "heavy_crop",
                "suggestion",
                &format!("裁掉 {:.1}% 面积，超过 {:.0}% 阈值", geometry.crop_ratio * 100.0, th.crop_ratio * 100.0),
                &serde_json::json!({ "ratio": geometry.crop_ratio, "threshold": th.crop_ratio }),
                &hash,
            )?;
            rules.insert("heavy_crop".into());
        }
        if geometry.pad_ratio > th.pad_ratio {
            insert_issue(
                &tx,
                &asset.id,
                "heavy_pad",
                "suggestion",
                &format!("补边 {:.1}%，超过 {:.0}% 阈值", geometry.pad_ratio * 100.0, th.pad_ratio * 100.0),
                &serde_json::json!({ "ratio": geometry.pad_ratio, "threshold": th.pad_ratio }),
                &hash,
            )?;
            rules.insert("heavy_pad".into());
        }
        if geometry.scale_ratio > 1.001 {
            insert_issue(
                &tx,
                &asset.id,
                "upscale",
                "suggestion",
                &format!("输出放大约 {:.0}%", (geometry.scale_ratio - 1.0) * 100.0),
                &serde_json::json!({ "scale": geometry.scale_ratio }),
                &hash,
            )?;
            rules.insert("upscale".into());
        }
        if asset.has_alpha {
            insert_issue(
                &tx,
                &asset.id,
                "transparent",
                "suggestion",
                &format!("含透明像素，导出将合成到背景色 {}", plan.background),
                &serde_json::json!({ "background": plan.background }),
                &hash,
            )?;
            rules.insert("transparent".into());
        }
        if let Some(description) = analysis.get("iccDescription").and_then(|v| v.as_str()) {
            if description.contains("未转换") {
                insert_issue(&tx, &asset.id, "icc_anomaly", "suggestion", "ICC 配置异常，已按 sRGB 处理。", &analysis, &hash)?;
                rules.insert("icc_anomaly".into());
            }
        }
        if !trigger_word.trim().is_empty() && !asset.trigger_disabled {
            let occurrences = trigger_occurrences(&final_text, trigger_word.trim());
            if occurrences == 0 {
                insert_issue(
                    &tx,
                    &asset.id,
                    "trigger_missing",
                    "suggestion",
                    &format!("最终标注中未找到触发词「{}」", trigger_word.trim()),
                    &serde_json::json!({ "trigger": trigger_word, "finalText": final_text }),
                    &hash,
                )?;
                rules.insert("trigger_missing".into());
            } else if occurrences > 1 {
                insert_issue(
                    &tx,
                    &asset.id,
                    "trigger_duplicate",
                    "suggestion",
                    &format!("触发词出现 {occurrences} 次"),
                    &serde_json::json!({ "trigger": trigger_word, "count": occurrences }),
                    &hash,
                )?;
                rules.insert("trigger_duplicate".into());
            }
        }
        if final_text.chars().count() > th.max_caption_chars {
            insert_issue(
                &tx,
                &asset.id,
                "text_truncated",
                "suggestion",
                &format!("标注 {} 字符，超过 {} 字符阈值", final_text.chars().count(), th.max_caption_chars),
                &serde_json::json!({ "chars": final_text.chars().count(), "threshold": th.max_caption_chars }),
                &hash,
            )?;
            rules.insert("text_truncated".into());
        }
        if th.blur_enabled {
            if let Some(score) = asset.blur_score {
                if score < th.blur_threshold {
                    insert_issue(
                        &tx,
                        &asset.id,
                        "blur",
                        "suggestion",
                        &format!("拉普拉斯方差 {score:.1}，低于阈值 {:.1}", th.blur_threshold),
                        &serde_json::json!({ "score": score, "threshold": th.blur_threshold }),
                        &hash,
                    )?;
                    rules.insert("blur".into());
                }
            }
        }
        if asset.dark_ratio.unwrap_or(0.0) > th.exposure_ratio {
            insert_issue(
                &tx,
                &asset.id,
                "exposure",
                "suggestion",
                &format!("过暗像素占 {:.0}%", asset.dark_ratio.unwrap_or(0.0) * 100.0),
                &serde_json::json!({ "type": "dark", "ratio": asset.dark_ratio.unwrap_or(0.0), "threshold": th.exposure_ratio }),
                &hash,
            )?;
            rules.insert("exposure".into());
        }
        if asset.bright_ratio.unwrap_or(0.0) > th.exposure_ratio {
            insert_issue(
                &tx,
                &asset.id,
                "exposure",
                "suggestion",
                &format!("过亮像素占 {:.0}%", asset.bright_ratio.unwrap_or(0.0) * 100.0),
                &serde_json::json!({ "type": "bright", "ratio": asset.bright_ratio.unwrap_or(0.0), "threshold": th.exposure_ratio }),
                &hash,
            )?;
            rules.insert("exposure".into());
        }
        present.insert(asset.id.clone(), rules);
    }
    tx.commit()?;

    // 重复检测（精确 + pHash 分带）
    let duplicate_groups = detect_duplicates(&mut conn, &assets, &hash, th.duplicate_distance)?;
    // 重新载入重复规则归属
    for rule in ["exact_duplicate", "near_duplicate"] {
        let ids: Vec<String> = {
            let mut statement = conn.prepare("SELECT DISTINCT asset_id FROM issues WHERE rule = ?1")?;
            let rows = statement.query_map(params![rule], |row| row.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for id in ids {
            present.entry(id).or_default().insert(rule.into());
        }
    }

    // 清理已解决的普通问题
    {
        let tx = conn.transaction()?;
        for (asset_id, rules) in &present {
            let existing: Vec<String> = {
                let mut statement = tx.prepare("SELECT rule FROM issues WHERE asset_id = ?1")?;
                let rows = statement.query_map(params![asset_id], |row| row.get::<_, String>(0))?;
                rows.filter_map(|r| r.ok()).collect()
            };
            for rule in existing {
                if !rules.contains(&rule) {
                    tx.execute(
                        "DELETE FROM issues WHERE asset_id = ?1 AND rule = ?2",
                        params![asset_id, rule],
                    )?;
                }
            }
        }
        tx.commit()?;
    }

    // 刷新汇总
    let summary = summary(&conn)?;
    let payload = serde_json::json!({
        "blocking": summary.blocking,
        "suggestions": summary.suggestions,
        "ignored": summary.ignored_total,
        "sourceMissing": source_missing,
    });
    conn.execute(
        "INSERT INTO quality_runs(id, config_hash, summary_json, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![util::new_id(), hash, serde_json::to_string(&payload)?, util::now_iso()],
    )?;
    meta_set(&conn, "quality_config_hash", &hash)?;
    meta_set(&conn, "quality_stale", "0")?;
    meta_set(&conn, "quality_scanned_at", &util::now_iso())?;
    Ok(QualityRunResult {
        summary,
        duplicate_groups,
        scanned: assets.len() as i64,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

fn parse_hash(value: &str) -> Option<u64> {
    u64::from_str_radix(value.trim(), 16).ok()
}

fn detect_duplicates(
    conn: &mut rusqlite::Connection,
    assets: &[AssetRow],
    config_hash: &str,
    distance_threshold: u32,
) -> AppResult<i64> {
    let mut by_hash: HashMap<String, Vec<&AssetRow>> = HashMap::new();
    for asset in assets {
        by_hash.entry(asset.content_hash.clone()).or_default().push(asset);
    }
    let mut exact_groups: Vec<(String, Vec<String>)> = Vec::new();
    for (hash, members) in &by_hash {
        if members.len() > 1 {
            let ids: Vec<String> = members.iter().map(|a| a.id.clone()).collect();
            exact_groups.push((format!("exact-{}", &hash[..16]), ids));
        }
    }
    exact_groups.sort_by(|a, b| a.0.cmp(&b.0));

    // pHash 分带候选
    let threshold = distance_threshold.clamp(1, 16);
    let band_count = (threshold as usize + 1).min(16);
    let mut parent: HashMap<String, String> = HashMap::new();
    fn find(parent: &mut HashMap<String, String>, value: &str) -> String {
        let current = parent.get(value).cloned().unwrap_or_else(|| value.to_string());
        if current == value {
            return current;
        }
        let root = find(parent, &current);
        parent.insert(value.to_string(), root.clone());
        root
    }
    fn union(parent: &mut HashMap<String, String>, a: &str, b: &str) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent.insert(rb, ra);
        }
    }
    let mut hashes: Vec<(String, u64)> = Vec::new();
    for asset in assets {
        if let Some(value) = asset.phash.as_deref().and_then(parse_hash) {
            parent.entry(asset.id.clone()).or_insert_with(|| asset.id.clone());
            hashes.push((asset.id.clone(), value));
        }
    }
    let mut bands: HashMap<(usize, u64), Vec<usize>> = HashMap::new();
    for (index, (_, value)) in hashes.iter().enumerate() {
        let width = (64 + band_count - 1) / band_count;
        for band in 0..band_count {
            let shift = 64usize.saturating_sub((band + 1) * width);
            let mask = if width >= 64 { u64::MAX } else { ((1u64 << width) - 1) << shift };
            let key = (band, value & mask);
            let candidates = bands.entry(key).or_default();
            for &other in candidates.iter() {
                let (other_id, other_value) = &hashes[other];
                if (other_value ^ value).count_ones() <= threshold {
                    union(&mut parent, &hashes[index].0, other_id);
                }
            }
            candidates.push(index);
        }
    }

    let mut near_components: HashMap<String, Vec<String>> = HashMap::new();
    for (asset_id, _) in &hashes {
        let root = find(&mut parent, asset_id);
        near_components.entry(root).or_default().push(asset_id.clone());
    }
    let mut near_groups: Vec<(String, Vec<String>)> = Vec::new();
    for (_, mut members) in near_components {
        if members.len() < 2 {
            continue;
        }
        members.sort();
        let distinct_hashes: HashSet<String> = members
            .iter()
            .filter_map(|id| assets.iter().find(|a| &a.id == id))
            .map(|a| a.content_hash.clone())
            .collect();
        if distinct_hashes.len() < 2 {
            continue;
        }
        let joined = members.join("|");
        let id = format!("near-{}", &util::sha256_text(&joined)[..16]);
        near_groups.push((id, members));
    }
    near_groups.sort_by(|a, b| a.0.cmp(&b.0));

    let tx = conn.transaction()?;
    // 读取旧组保留确认状态
    let mut old: HashMap<String, (Option<String>, i64, i64)> = HashMap::new();
    {
        let mut statement = tx.prepare(
            "SELECT id, kept_asset_id, confirmed, dismissed FROM duplicate_groups WHERE kind IN ('exact','near')",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))
        })?;
        for row in rows.flatten() {
            old.insert(row.0, (row.1, row.2, row.3));
        }
    }
    let mut active_ids: Vec<String> = Vec::new();
    tx.execute("UPDATE assets SET duplicate_group_id = NULL", [])?;
    for (group_id, members) in exact_groups.iter().chain(near_groups.iter()) {
        let (old_kept, old_confirmed, old_dismissed) = old
            .get(group_id)
            .cloned()
            .unwrap_or((None, 0, 0));
        if old_dismissed != 0 {
            continue;
        }
        let mut keep = old_kept.filter(|id| members.contains(id));
        if keep.is_none() {
            let mut best: Option<&AssetRow> = None;
            for id in members {
                if let Some(asset) = assets.iter().find(|a| &a.id == id) {
                    let better = match best {
                        None => true,
                        Some(current) => {
                            let area = |a: &AssetRow| a.norm_width as u64 * a.norm_height as u64;
                            let reviewed = |a: &AssetRow| a.review_status == "approved" || a.review_status == "review";
                            if area(asset) != area(current) {
                                area(asset) > area(current)
                            } else if reviewed(asset) != reviewed(current) {
                                reviewed(asset)
                            } else {
                                asset.id < current.id
                            }
                        }
                    };
                    if better {
                        best = Some(asset);
                    }
                }
            }
            keep = best.map(|a| a.id.clone());
        }
        let kind = if group_id.starts_with("exact-") { "exact" } else { "near" };
        let confirmed = old_confirmed != 0;
        tx.execute(
            "INSERT INTO duplicate_groups(id, kind, members_json, kept_asset_id, confirmed, dismissed, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)
             ON CONFLICT(id) DO UPDATE SET members_json = excluded.members_json,
               kept_asset_id = excluded.kept_asset_id, confirmed = excluded.confirmed, updated_at = excluded.updated_at",
            params![
                group_id,
                kind,
                serde_json::to_string(members)?,
                keep,
                if confirmed { 1 } else { 0 },
                util::now_iso()
            ],
        )?;
        active_ids.push(group_id.clone());
        for member in members {
            tx.execute(
                "UPDATE assets SET duplicate_group_id = ?1 WHERE id = ?2",
                params![group_id, member],
            )?;
            if !confirmed {
                let rule = if kind == "exact" { "exact_duplicate" } else { "near_duplicate" };
                let message = if kind == "exact" {
                    format!("与另外 {} 张图片字节相同", members.len() - 1)
                } else {
                    format!("与另外 {} 张图片感知相近", members.len() - 1)
                };
                insert_issue(
                    &tx,
                    member,
                    rule,
                    "suggestion",
                    &message,
                    &serde_json::json!({ "groupId": group_id, "members": members.len() }),
                    config_hash,
                )?;
            }
        }
    }
    // 清理失效的未忽略组
    {
        let mut statement = tx.prepare("SELECT id FROM duplicate_groups WHERE dismissed = 0")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let stale: Vec<String> = rows
            .filter_map(|r| r.ok())
            .filter(|id| !active_ids.contains(id))
            .collect();
        drop(statement);
        for id in stale {
            tx.execute("DELETE FROM duplicate_groups WHERE id = ?1", params![id])?;
        }
    }
    tx.commit()?;
    Ok((exact_groups.len() + near_groups.len()) as i64)
}

pub fn summary(conn: &rusqlite::Connection) -> AppResult<QualitySummary> {
    let scanned_at = meta_get(conn, "quality_scanned_at");
    let stale = meta_get(conn, "quality_stale").as_deref() != Some("0");
    let hash = config_hash(conn);
    let mut rules: Vec<QualityRuleSummary> = Vec::new();
    let mut blocking = 0i64;
    let mut suggestions = 0i64;
    let mut ignored_total = 0i64;
    for rule in all_rules() {
        let (title, level, description) = rule_meta(rule);
        let (count, ignored): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(CASE WHEN ignored = 1 THEN 1 ELSE 0 END),0)
             FROM issues WHERE rule = ?1",
            params![rule],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if count == 0 {
            continue;
        }
        if level == "blocking" {
            blocking += count - ignored;
        } else {
            suggestions += count - ignored;
        }
        ignored_total += ignored;
        rules.push(QualityRuleSummary {
            rule: rule.into(),
            title: title.into(),
            level: level.into(),
            description: description.into(),
            count,
            ignored,
        });
    }
    Ok(QualitySummary {
        scanned_at,
        stale,
        config_hash: hash,
        blocking,
        suggestions,
        ignored_total,
        rules,
    })
}

pub fn issues_for_rule(
    project: &Project,
    rule: &str,
    include_ignored: bool,
    split: Option<&str>,
) -> AppResult<QualityIssues> {
    let conn = project.conn();
    let (title, level, description) = rule_meta(rule);
    let mut statement = conn.prepare(
        "SELECT i.id, i.asset_id, a.original_name, a.review_status, a.thumb_version, i.message,
                i.evidence_json, i.ignored, i.ignore_reason
         FROM issues i JOIN assets a ON a.id = i.asset_id
         WHERE i.rule = ?1 AND (?2 = 1 OR i.ignored = 0)
           AND (?3 IS NULL OR a.split_lock = ?3)
         ORDER BY a.sort_index ASC, a.id ASC",
    )?;
    let rows = statement.query_map(params![rule, if include_ignored { 1 } else { 0 }, split], |row| {
        let evidence: String = row.get(6)?;
        Ok(IssueRow {
            id: row.get(0)?,
            asset_id: row.get(1)?,
            asset_name: row.get(2)?,
            asset_status: row.get(3)?,
            thumb_version: row.get(4)?,
            message: row.get(5)?,
            evidence: serde_json::from_str(&evidence).unwrap_or(serde_json::json!({})),
            ignored: row.get::<_, i64>(7)? != 0,
            ignore_reason: row.get(8)?,
        })
    })?;
    Ok(QualityIssues {
        rule: rule.into(),
        title: title.into(),
        level: level.into(),
        description: description.into(),
        rows: rows.filter_map(|r| r.ok()).collect(),
    })
}

pub fn ignore(project: &Project, issue_id: &str, reason: &str) -> AppResult<()> {
    let conn = project.conn();
    let (level, asset_id): (String, String) = conn
        .query_row(
            "SELECT level, asset_id FROM issues WHERE id = ?1",
            params![issue_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("质检问题"))?;
    if level == "blocking" {
        return Err(AppError::new(
            "BLOCKING_NOT_IGNORABLE",
            "阻塞项不能忽略，请先解决或从导出范围排除该图片。",
        ));
    }
    conn.execute(
        "UPDATE issues SET ignored = 1, ignore_reason = ?1 WHERE id = ?2",
        params![reason.trim(), issue_id],
    )?;
    meta_set(&conn, "quality_stale", "0")?;
    let _ = asset_id;
    Ok(())
}

pub fn unignore(project: &Project, issue_id: &str) -> AppResult<()> {
    let conn = project.conn();
    conn.execute(
        "UPDATE issues SET ignored = 0, ignore_reason = NULL WHERE id = ?1",
        params![issue_id],
    )?;
    Ok(())
}

pub fn duplicate_groups(project: &Project) -> AppResult<Vec<DuplicateGroupView>> {
    let conn = project.conn();
    let mut groups = Vec::new();
    let rows: Vec<(String, String, String, Option<String>, i64)> = {
        let mut statement = conn.prepare(
            "SELECT id, kind, members_json, kept_asset_id, confirmed FROM duplicate_groups
             WHERE dismissed = 0 ORDER BY kind, id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for (id, kind, members_json, kept, confirmed) in rows {
        let member_ids: Vec<String> = serde_json::from_str(&members_json).unwrap_or_default();
        let mut members = Vec::new();
        let kept_hash: Option<u64> = kept
            .as_deref()
            .and_then(|kept_id| conn.query_row(
                "SELECT phash FROM assets WHERE id = ?1",
                params![kept_id],
                |row| row.get::<_, Option<String>>(0),
            ).optional().ok().flatten())
            .and_then(|value| value.as_deref().and_then(parse_hash));
        for member_id in &member_ids {
            if let Ok(asset) = db::get_asset(&conn, member_id) {
                let (mode, tags_json, text): (String, String, String) = asset
                    .caption_revision_id
                    .as_deref()
                    .and_then(|rev| {
                        conn.query_row(
                            "SELECT mode, tags_json, text FROM caption_revisions WHERE id = ?1",
                            params![rev],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                        )
                        .optional()
                        .ok()
                        .flatten()
                    })
                    .unwrap_or(("tags".into(), "[]".into(), String::new()));
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                let distance = if kind == "near" {
                    asset
                        .phash
                        .as_deref()
                        .and_then(parse_hash)
                        .and_then(|value| kept_hash.map(|kept| (value ^ kept).count_ones()))
                } else {
                    Some(0)
                };
                members.push(DuplicateMember {
                    asset_id: asset.id.clone(),
                    name: asset.original_name.clone(),
                    width: asset.norm_width,
                    height: asset.norm_height,
                    bytes: asset.bytes,
                    status: asset.review_status.clone(),
                    format: asset.format.clone(),
                    caption_preview: caption::caption_preview(&mode, &tags, &text, 80),
                    source_label: asset.rel_path.clone(),
                    thumb_version: asset.thumb_version.clone(),
                    split_lock: asset.split_lock.clone(),
                    keep_recommended: kept.as_deref() == Some(asset.id.as_str()),
                    distance,
                });
            }
        }
        if !members.is_empty() {
            groups.push(DuplicateGroupView {
                id,
                kind,
                confirmed: confirmed != 0,
                kept_asset_id: kept,
                members,
            });
        }
    }
    Ok(groups)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateAction {
    pub group_id: String,
    pub action: String,
    #[serde(default)]
    pub asset_ids: Vec<String>,
    #[serde(default)]
    pub kept_asset_id: Option<String>,
}

pub fn duplicate_action(project: &Project, request: &DuplicateAction) -> AppResult<i64> {
    let mut conn = project.conn();
    let (members_json, kept): (String, Option<String>) = conn
        .query_row(
            "SELECT members_json, kept_asset_id FROM duplicate_groups WHERE id = ?1",
            params![request.group_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("重复组"))?;
    let members: Vec<String> = serde_json::from_str(&members_json).unwrap_or_default();
    let mut targets: Vec<String> = if request.asset_ids.is_empty() {
        members.clone()
    } else {
        request.asset_ids.clone()
    };
    targets.retain(|id| members.contains(id));
    let now = util::now_iso();
    match request.action.as_str() {
        "keep" => {
            let kept_id = request
                .kept_asset_id
                .clone()
                .or(kept)
                .filter(|id| members.contains(id))
                .or_else(|| members.first().cloned())
                .ok_or_else(|| AppError::new("EMPTY_SCOPE", "重复组没有成员"))?;
            conn.execute(
                "UPDATE duplicate_groups SET kept_asset_id = ?1, confirmed = 1, updated_at = ?2 WHERE id = ?3",
                params![kept_id, now, request.group_id],
            )?;
        }
        "exclude_others" => {
            let kept_id = request
                .kept_asset_id
                .clone()
                .or(kept)
                .filter(|id| members.contains(id))
                .or_else(|| members.first().cloned())
                .ok_or_else(|| AppError::new("EMPTY_SCOPE", "重复组没有成员"))?;
            let mut snapshots = Vec::new();
            for member in &members {
                snapshots.push(snapshot_asset(&conn, member)?);
            }
            let tx = conn.transaction()?;
            for member in &members {
                if member == &kept_id {
                    continue;
                }
                tx.execute(
                    "UPDATE assets SET review_status = 'excluded', excluded_reason = '重复组保留所选图片',
                     revision = revision + 1, last_human_at = ?1 WHERE id = ?2",
                    params![now, member],
                )?;
            }
            tx.execute(
                "UPDATE duplicate_groups SET kept_asset_id = ?1, confirmed = 1, updated_at = ?2 WHERE id = ?3",
                params![kept_id, now, request.group_id],
            )?;
            tx.commit()?;
            let after = {
                let mut values = Vec::new();
                for member in &members {
                    values.push(snapshot_asset(&conn, member)?);
                }
                values
            };
            history::record(
                &conn,
                "quality.duplicate",
                "重复组：保留所选图片并排除其余",
                &members,
                &HistoryState { assets: snapshots, memberships: vec![] },
                &HistoryState { assets: after, memberships: vec![] },
                None,
            )?;
            db::mark_quality_stale(&conn)?;
        }
        "not_duplicate" => {
            let tx = conn.transaction()?;
            tx.execute(
                "UPDATE duplicate_groups SET dismissed = 1, confirmed = 0, updated_at = ?1 WHERE id = ?2",
                params![now, request.group_id],
            )?;
            for member in &members {
                tx.execute(
                    "UPDATE assets SET duplicate_group_id = NULL WHERE id = ?1",
                    params![member],
                )?;
                tx.execute(
                    "DELETE FROM issues WHERE asset_id = ?1 AND rule IN ('exact_duplicate','near_duplicate')",
                    params![member],
                )?;
            }
            tx.commit()?;
        }
        "exclude_selected" => {
            if targets.is_empty() {
                return Err(AppError::new("EMPTY_SCOPE", "请选择要排除的图片"));
            }
            let mut snapshots = Vec::new();
            for id in &targets {
                snapshots.push(snapshot_asset(&conn, id)?);
            }
            let tx = conn.transaction()?;
            for id in &targets {
                tx.execute(
                    "UPDATE assets SET review_status = 'excluded', excluded_reason = '重复组中排除',
                     revision = revision + 1, last_human_at = ?1 WHERE id = ?2",
                    params![now, id],
                )?;
            }
            tx.commit()?;
            let after = {
                let mut values = Vec::new();
                for id in &targets {
                    values.push(snapshot_asset(&conn, id)?);
                }
                values
            };
            history::record(
                &conn,
                "quality.duplicate",
                "排除重复图片",
                &targets,
                &HistoryState { assets: snapshots, memberships: vec![] },
                &HistoryState { assets: after, memberships: vec![] },
                None,
            )?;
            db::mark_quality_stale(&conn)?;
        }
        _ => {
            return Err(AppError::new("INVALID_ACTION", "未知的重复组操作"));
        }
    }
    Ok(targets.len() as i64)
}

// ---------------------------------------------------------------------------
// 数据概况
// ---------------------------------------------------------------------------

const BUCKET_SIZES: &[u32] = &[256, 512, 768, 1024, 1280, 1536, 2048, 4096];

fn size_bucket(short_edge: u32) -> String {
    let mut label = "≤256";
    for size in BUCKET_SIZES {
        if short_edge >= *size {
            label = match size {
                256 => "256",
                512 => "512",
                768 => "768",
                1024 => "1024",
                1280 => "1280",
                1536 => "1536",
                2048 => "2048",
                _ => ">2048",
            };
        }
    }
    if short_edge > 2048 {
        ">2048".into()
    } else {
        label.into()
    }
}

fn kohya_bucket(width: u32, height: u32, resolution: [u32; 2], steps: u32, no_upscale: bool) -> (u32, u32) {
    let steps = steps.max(8);
    let ar = width as f64 / height.max(1) as f64;
    if no_upscale && (width < resolution[0] || height < resolution[1]) {
        let bucket_w = ((width / steps) * steps).max(steps);
        let bucket_h = ((height / steps) * steps).max(steps);
        return (bucket_w, bucket_h);
    }
    let area = resolution[0] as f64 * resolution[1] as f64;
    let mut best = (resolution[0], resolution[1]);
    let mut best_score = f64::MAX;
    let max_side = 2048u32.max(resolution[0]).max(resolution[1]);
    let mut w = steps;
    while w <= max_side {
        let mut h = steps;
        while h <= max_side {
            let candidate_area = w as f64 * h as f64;
            if candidate_area >= area * 0.75 && candidate_area <= area * 1.3 {
                let candidate_ar = w as f64 / h as f64;
                let score = (candidate_ar.ln() - ar.ln()).abs() + (candidate_area / area - 1.0).abs() * 0.15;
                if score < best_score {
                    best_score = score;
                    best = (w, h);
                }
            }
            h += steps;
        }
        w += steps;
    }
    best
}

fn top_tags(conn: &rusqlite::Connection) -> Vec<OverviewTag> {
    let mut counts: HashMap<String, (String, i64)> = HashMap::new();
    if let Ok(mut statement) = conn.prepare(
        "SELECT c.mode, c.tags_json, c.text FROM assets a
         JOIN caption_revisions c ON c.id = a.caption_revision_id
         WHERE a.review_status != 'excluded'",
    ) {
        if let Ok(rows) = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        }) {
            for row in rows.flatten() {
                let tags: Vec<String> = if row.0 == "tags" {
                    serde_json::from_str(&row.1).unwrap_or_default()
                } else {
                    caption::split_caption_text(&row.2)
                };
                for tag in tags {
                    let key = caption::normalize_key(&tag);
                    if key.is_empty() {
                        continue;
                    }
                    let entry = counts.entry(key).or_insert((tag, 0));
                    entry.1 += 1;
                }
            }
        }
    }
    let mut values: Vec<OverviewTag> = counts
        .into_values()
        .map(|(tag, count)| OverviewTag { tag, count })
        .collect();
    values.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
    values.truncate(24);
    values
}

pub fn overview(project: &Project) -> AppResult<QualityOverview> {
    let conn = project.conn();
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))?;
    let valid: i64 = conn.query_row(
        "SELECT COUNT(*) FROM assets WHERE review_status != 'excluded'",
        [],
        |row| row.get(0),
    )?;
    let excluded = total - valid;
    let approved: i64 = conn.query_row(
        "SELECT COUNT(*) FROM assets WHERE review_status = 'approved'",
        [],
        |row| row.get(0),
    )?;
    let with_caption: i64 = conn.query_row(
        "SELECT COUNT(*) FROM assets a WHERE a.review_status != 'excluded'
           AND a.caption_revision_id IS NOT NULL",
        [],
        |row| row.get(0),
    )?;
    let duplicate_assets: i64 = conn.query_row(
        "SELECT COUNT(*) FROM assets WHERE duplicate_group_id IS NOT NULL",
        [],
        |row| row.get(0),
    )?;

    let mut size_counts: HashMap<String, i64> = HashMap::new();
    let mut orientation = HashMap::new();
    let mut bucket_counts: HashMap<String, i64> = HashMap::new();
    let mut split_counts: HashMap<String, i64> = HashMap::new();
    let settings = crate::project::project_settings(&conn);
    let resolution = settings
        .get("resolution")
        .and_then(|v| serde_json::from_value::<[u32; 2]>(v.clone()).ok())
        .unwrap_or([1024, 1024]);
    let records: Vec<(u32, u32, u32, u32, Option<String>)> = {
        let mut statement = conn.prepare(
            "SELECT norm_width, norm_height, out_width, out_height, split_lock FROM assets
             WHERE review_status != 'excluded'",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for (norm_w, norm_h, out_w, out_h, split) in records {
        let short = norm_w.min(norm_h);
        *size_counts.entry(size_bucket(short)).or_insert(0) += 1;
        let orient = if norm_w > norm_h {
            "横图"
        } else if norm_w < norm_h {
            "竖图"
        } else {
            "方图"
        };
        *orientation.entry(orient.to_string()).or_insert(0) += 1;
        let (bw, bh) = kohya_bucket(out_w.max(1), out_h.max(1), resolution, 64, true);
        *bucket_counts.entry(format!("{bw}×{bh}")).or_insert(0) += 1;
        *split_counts
            .entry(split.unwrap_or_else(|| "未分配".into()))
            .or_insert(0) += 1;
    }
    let mut size_buckets: Vec<OverviewBucket> = size_counts
        .into_iter()
        .map(|(label, count)| OverviewBucket { label, count })
        .collect();
    size_buckets.sort_by(|a, b| a.label.cmp(&b.label));
    let orientation_list: Vec<OverviewBucket> = ["横图", "竖图", "方图"]
        .iter()
        .map(|label| OverviewBucket {
            label: label.to_string(),
            count: orientation.get(*label).copied().unwrap_or(0),
        })
        .collect();
    let mut bucket_rows: Vec<OverviewBucket> = bucket_counts
        .into_iter()
        .map(|(label, count)| OverviewBucket { label, count })
        .collect();
    bucket_rows.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));
    bucket_rows.truncate(16);
    let sources: Vec<OverviewBucket> = {
        let mut statement = conn.prepare(
            "SELECT COALESCE(sr.path, '（未知来源）'), COUNT(a.id)
             FROM assets a LEFT JOIN source_roots sr ON sr.id = a.source_root_id
             GROUP BY sr.id ORDER BY COUNT(a.id) DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(OverviewBucket { label: row.get(0)?, count: row.get(1)? })
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let split_list: Vec<OverviewBucket> = ["train", "val", "未分配"]
        .iter()
        .map(|label| OverviewBucket {
            label: label.to_string(),
            count: split_counts.get(*label).copied().unwrap_or(0),
        })
        .collect();
    Ok(QualityOverview {
        total,
        valid,
        excluded,
        approved,
        with_caption,
        size_buckets,
        orientation: orientation_list,
        bucket_rows,
        top_tags: top_tags(&conn),
        sources,
        duplicate_assets,
        split_counts: split_list,
    })
}

// ---------------------------------------------------------------------------
// 导入页去重与回收区
// ---------------------------------------------------------------------------

/// 去重回收的排除原因。回收区只收纳由去重功能移入的图片，便于恢复。
pub const DEDUPE_REASON: &str = "去重回收";
/// 手动“移至回收区”的排除原因；与去重回收共用回收区。
pub const RECYCLE_REASON: &str = "回收区";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeMember {
    pub asset_id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub bytes: i64,
    pub status: String,
    pub thumb_version: String,
    pub display_version: String,
    /// 与建议保留图片的 pHash 汉明距离；完全相同时为 0。
    pub distance: Option<u32>,
    pub keep_recommended: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeGroup {
    pub id: String,
    pub kind: String,
    pub members: Vec<DedupeMember>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeScan {
    pub threshold: u32,
    pub scanned: i64,
    pub groups: Vec<DedupeGroup>,
    pub recycled: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeRecycled {
    pub asset_id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub bytes: i64,
    pub thumb_version: String,
    pub display_version: String,
    pub excluded_reason: Option<String>,
    pub recycled_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeActionResult {
    pub moved: i64,
    pub restored: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeSummary {
    pub threshold: u32,
    pub scanned: i64,
    pub groups: i64,
    pub duplicates: i64,
    pub recycled: i64,
}

fn recommend_keep<'a>(members: &[&'a AssetRow]) -> Option<&'a AssetRow> {
    let area = |asset: &AssetRow| asset.norm_width as u64 * asset.norm_height as u64;
    let reviewed = |asset: &AssetRow| matches!(asset.review_status.as_str(), "approved" | "review");
    let mut best: Option<&'a AssetRow> = None;
    for asset in members {
        let better = match best {
            None => true,
            Some(current) => {
                if area(asset) != area(current) {
                    area(asset) > area(current)
                } else if reviewed(asset) != reviewed(current) {
                    reviewed(asset)
                } else {
                    asset.id < current.id
                }
            }
        };
        if better {
            best = Some(asset);
        }
    }
    best
}

/// 去重候选的轻量快照；摘要只需 ID、内容哈希与感知哈希。
struct CandidateRow {
    id: String,
    content_hash: String,
    phash: Option<String>,
}

#[derive(Clone, Copy)]
struct Candidate<'a> {
    id: &'a str,
    content_hash: &'a str,
    phash: Option<&'a str>,
}

fn candidates_from_rows(rows: &[CandidateRow]) -> Vec<Candidate<'_>> {
    rows.iter()
        .map(|row| Candidate {
            id: &row.id,
            content_hash: &row.content_hash,
            phash: row.phash.as_deref(),
        })
        .collect()
}

fn candidates_from_assets(assets: &[AssetRow]) -> Vec<Candidate<'_>> {
    assets
        .iter()
        .map(|asset| Candidate {
            id: &asset.id,
            content_hash: &asset.content_hash,
            phash: asset.phash.as_deref(),
        })
        .collect()
}

/// 扫描未排除图片中的重复组。完全相同的图片按内容哈希归组，感知相近的图片按 pHash 距离归组。
/// 该扫描独立于质检的 duplicate_groups，不会改动质检结果。
pub fn dedupe_scan(project: &Project, threshold: Option<u32>) -> AppResult<DedupeScan> {
    // 只在数据库锁内读取候选快照与回收区数量，分组计算在锁外完成。
    let (threshold, assets, recycled) = {
        let conn = project.conn();
        let threshold = effective_threshold(&conn, threshold);
        let assets = load_candidates(&conn)?;
        let recycled = recycled_count(&conn)?;
        (threshold, assets, recycled)
    };
    let candidates = candidates_from_assets(&assets);
    let group_ids = build_group_ids(&candidates, threshold);
    let by_id: HashMap<&str, &AssetRow> = assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect();

    let mut groups: Vec<DedupeGroup> = Vec::new();
    for (kind, group_id, member_ids) in group_ids {
        let group_assets: Vec<&AssetRow> = member_ids
            .iter()
            .filter_map(|id| by_id.get(id.as_str()).copied())
            .collect();
        if group_assets.len() < 2 {
            continue;
        }
        let Some(keep) = recommend_keep(&group_assets) else {
            continue;
        };
        let keep_hash = keep.phash.as_deref().and_then(parse_hash);

        let mut members: Vec<DedupeMember> = group_assets
            .iter()
            .map(|asset| {
                let distance = if kind == "exact" {
                    Some(0)
                } else {
                    asset
                        .phash
                        .as_deref()
                        .and_then(parse_hash)
                        .and_then(|value| keep_hash.map(|kept| (value ^ kept).count_ones()))
                };
                DedupeMember {
                    asset_id: asset.id.clone(),
                    name: asset.original_name.clone(),
                    width: asset.norm_width,
                    height: asset.norm_height,
                    bytes: asset.bytes,
                    status: asset.review_status.clone(),
                    thumb_version: asset.thumb_version.clone(),
                    display_version: format!(
                        "src-{}",
                        &asset.content_hash[..asset.content_hash.len().min(10)]
                    ),
                    distance,
                    keep_recommended: asset.id == keep.id,
                }
            })
            .collect();
        members.sort_by(|a, b| {
            b.keep_recommended
                .cmp(&a.keep_recommended)
                .then_with(|| a.distance.unwrap_or(u32::MAX).cmp(&b.distance.unwrap_or(u32::MAX)))
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.asset_id.cmp(&b.asset_id))
        });
        groups.push(DedupeGroup {
            id: group_id,
            kind,
            members,
        });
    }
    groups.sort_by(|a, b| {
        b.members
            .len()
            .cmp(&a.members.len())
            .then_with(|| a.kind.cmp(&b.kind))
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(DedupeScan {
        threshold,
        scanned: assets.len() as i64,
        groups,
        recycled,
    })
}

/// 当前去重阈值：显式传入优先，否则读取项目设置并限制在 pHash 可分带范围内。
pub fn effective_threshold(conn: &rusqlite::Connection, threshold: Option<u32>) -> u32 {
    threshold
        .unwrap_or_else(|| thresholds(conn).duplicate_distance)
        .clamp(1, 16)
}

fn load_candidates(conn: &rusqlite::Connection) -> AppResult<Vec<AssetRow>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {} FROM assets WHERE review_status <> 'excluded' ORDER BY sort_index ASC, id ASC",
        db::ASSET_COLUMNS
    ))?;
    let rows = statement.query_map([], db::asset_row)?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

fn load_candidate_rows(conn: &rusqlite::Connection) -> AppResult<Vec<CandidateRow>> {
    let mut statement = conn.prepare(
        "SELECT id, content_hash, phash FROM assets
         WHERE review_status <> 'excluded' ORDER BY sort_index ASC, id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(CandidateRow {
            id: row.get(0)?,
            content_hash: row.get(1)?,
            phash: row.get::<_, Option<String>>(2)?,
        })
    })?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

fn recycled_count(conn: &rusqlite::Connection) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM assets WHERE review_status = 'excluded' AND excluded_reason IN (?1, ?2)",
        params![DEDUPE_REASON, RECYCLE_REASON],
        |row| row.get(0),
    )?)
}

/// 用于缓存去重摘要的轻量指纹：候选数量、修订量、排序上界与回收区数量。
/// 导入提交、状态修改、回收和恢复都会改变其中至少一项。
pub fn dedupe_fingerprint(conn: &rusqlite::Connection) -> AppResult<String> {
    let (count, revisions, max_sort, excluded) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(revision), 0), COALESCE(MAX(sort_index), 0),
                (SELECT COUNT(*) FROM assets WHERE review_status = 'excluded')
         FROM assets WHERE review_status <> 'excluded'",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    )?;
    Ok(format!("{count}:{revisions}:{max_sort}:{excluded}"))
}

/// 在候选快照上完成 pHash 分带与并查集，返回 (kind, groupId, memberIds)。
/// 不持有数据库连接，供摘要和完整扫描共用同一分组语义。
fn build_group_ids(candidates: &[Candidate<'_>], threshold: u32) -> Vec<(String, String, Vec<String>)> {
    fn find(parent: &mut HashMap<String, String>, value: &str) -> String {
        let mut current = value.to_string();
        loop {
            let next = parent.get(&current).cloned().unwrap_or_else(|| current.clone());
            if next == current {
                break;
            }
            current = next;
        }
        let root = current;
        let mut cursor = value.to_string();
        loop {
            let next = parent.get(&cursor).cloned().unwrap_or_else(|| cursor.clone());
            if next == root {
                break;
            }
            parent.insert(cursor.clone(), root.clone());
            cursor = next;
        }
        root
    }
    fn union(parent: &mut HashMap<String, String>, a: &str, b: &str) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent.insert(rb, ra);
        }
    }

    let mut parent: HashMap<String, String> = HashMap::new();
    let band_count = (threshold as usize + 1).min(16);
    // 完全相同的图片只保留一个代表参与 pHash 分带，其余成员并入代表；
    // 大量完全重复素材时避免重复比较，显著降低去重扫描成本。
    let mut representatives: HashMap<&str, String> = HashMap::new();
    let mut hashes: Vec<(String, u64)> = Vec::new();
    for candidate in candidates {
        if let Some(value) = candidate.phash.and_then(parse_hash) {
            parent
                .entry(candidate.id.to_string())
                .or_insert_with(|| candidate.id.to_string());
            let representative = representatives
                .entry(candidate.content_hash)
                .or_insert_with(|| candidate.id.to_string())
                .clone();
            if representative == candidate.id {
                hashes.push((candidate.id.to_string(), value));
            } else {
                union(&mut parent, candidate.id, &representative);
            }
        }
    }
    let mut bands: HashMap<(usize, u64), Vec<usize>> = HashMap::new();
    for (index, (_, value)) in hashes.iter().enumerate() {
        let width = (64 + band_count - 1) / band_count;
        for band in 0..band_count {
            let shift = 64usize.saturating_sub((band + 1) * width);
            let mask = if width >= 64 { u64::MAX } else { ((1u64 << width) - 1) << shift };
            let key = (band, value & mask);
            let candidates_in_band = bands.entry(key).or_default();
            for &other in candidates_in_band.iter() {
                let (other_id, other_value) = &hashes[other];
                if (other_value ^ value).count_ones() <= threshold {
                    union(&mut parent, &hashes[index].0, other_id);
                }
            }
            candidates_in_band.push(index);
        }
    }
    let mut components: HashMap<String, Vec<String>> = HashMap::new();
    for candidate in candidates {
        if candidate.phash.and_then(parse_hash).is_some() {
            let root = find(&mut parent, candidate.id);
            components.entry(root).or_default().push(candidate.id.to_string());
        }
    }
    let by_id: HashMap<&str, &Candidate<'_>> = candidates
        .iter()
        .map(|candidate| (candidate.id, candidate))
        .collect();

    let mut near_groups: Vec<(String, Vec<String>)> = Vec::new();
    for (_, mut members) in components {
        if members.len() < 2 {
            continue;
        }
        members.sort();
        let distinct_hashes: HashSet<String> = members
            .iter()
            .filter_map(|id| by_id.get(id.as_str()))
            .map(|candidate| candidate.content_hash.to_string())
            .collect();
        if distinct_hashes.len() < 2 {
            continue;
        }
        let id = format!("near-{}", &util::sha256_text(&members.join("|"))[..16]);
        near_groups.push((id, members));
    }
    near_groups.sort_by(|a, b| a.0.cmp(&b.0));
    let near_members: HashSet<String> = near_groups
        .iter()
        .flat_map(|(_, members)| members.iter().cloned())
        .collect();

    let mut by_hash: HashMap<&str, Vec<&Candidate<'_>>> = HashMap::new();
    for candidate in candidates {
        by_hash.entry(candidate.content_hash).or_default().push(candidate);
    }
    let mut exact_groups: Vec<(String, Vec<String>)> = Vec::new();
    for (hash, members) in &by_hash {
        if members.len() < 2 {
            continue;
        }
        if members.iter().all(|candidate| near_members.contains(candidate.id)) {
            continue;
        }
        let mut ids: Vec<String> = members.iter().map(|candidate| candidate.id.to_string()).collect();
        ids.sort();
        let key = &hash[..hash.len().min(16)];
        exact_groups.push((format!("exact-{key}"), ids));
    }
    exact_groups.sort_by(|a, b| a.0.cmp(&b.0));

    let mut groups: Vec<(String, String, Vec<String>)> = exact_groups
        .into_iter()
        .map(|(id, members)| ("exact".to_string(), id, members))
        .chain(
            near_groups
                .into_iter()
                .map(|(id, members)| ("near".to_string(), id, members)),
        )
        .filter(|(_, _, members)| members.len() >= 2)
        .collect();
    groups.sort_by(|a, b| {
        b.2.len()
            .cmp(&a.2.len())
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.cmp(&b.1))
    });
    groups
}

/// 只返回去重数量，供图库「去重」按钮角标使用；与完整扫描共用分组语义。
pub fn dedupe_summary(project: &Project, threshold: Option<u32>) -> AppResult<DedupeSummary> {
    // 摘要只需要轻量候选列，锁内读取后立即释放。
    let (threshold, rows, recycled) = {
        let conn = project.conn();
        let threshold = effective_threshold(&conn, threshold);
        let rows = load_candidate_rows(&conn)?;
        let recycled = recycled_count(&conn)?;
        (threshold, rows, recycled)
    };
    let candidates = candidates_from_rows(&rows);
    let groups = build_group_ids(&candidates, threshold);
    let duplicates = groups
        .iter()
        .map(|(_, _, members)| members.len().saturating_sub(1) as i64)
        .sum();
    Ok(DedupeSummary {
        threshold,
        scanned: rows.len() as i64,
        groups: groups.len() as i64,
        duplicates,
        recycled,
    })
}

pub fn dedupe_recycled(project: &Project) -> AppResult<Vec<DedupeRecycled>> {
    let conn = project.conn();
    let mut statement = conn.prepare(
        "SELECT id, original_name, norm_width, norm_height, bytes, thumb_version,
                'src-' || substr(content_hash, 1, 10), excluded_reason, last_human_at
         FROM assets
         WHERE review_status = 'excluded' AND excluded_reason IN (?1, ?2)
         ORDER BY last_human_at DESC, sort_index ASC
         LIMIT 2000",
    )?;
    let rows = statement.query_map(params![DEDUPE_REASON, RECYCLE_REASON], |row| {
        Ok(DedupeRecycled {
            asset_id: row.get(0)?,
            name: row.get(1)?,
            width: row.get(2)?,
            height: row.get(3)?,
            bytes: row.get(4)?,
            thumb_version: row.get(5)?,
            display_version: row.get(6)?,
            excluded_reason: row.get(7)?,
            recycled_at: row.get(8)?,
        })
    })?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

pub fn dedupe_recycle(project: &Project, asset_ids: &[String]) -> AppResult<DedupeActionResult> {
    recycle_move(project, asset_ids, true, DEDUPE_REASON)
}

/// 手动把选中图片移至回收区（不要求它们互为重复）。
pub fn assets_recycle(project: &Project, asset_ids: &[String]) -> AppResult<DedupeActionResult> {
    recycle_move(project, asset_ids, true, RECYCLE_REASON)
}

pub fn dedupe_restore(project: &Project, asset_ids: &[String]) -> AppResult<DedupeActionResult> {
    recycle_move(project, asset_ids, false, DEDUPE_REASON)
}

fn recycle_move(
    project: &Project,
    asset_ids: &[String],
    recycle: bool,
    reason: &str,
) -> AppResult<DedupeActionResult> {
    let mut conn = project.conn();
    let mut ids: Vec<String> = Vec::new();
    for id in asset_ids {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return Err(AppError::new(
            "EMPTY_SCOPE",
            if recycle { "请选择要移入回收区的图片" } else { "请选择要恢复的图片" },
        ));
    }
    let mut targets: Vec<String> = Vec::new();
    for id in &ids {
        let asset = db::get_asset(&conn, id)?;
        let recycled = asset.review_status == "excluded"
            && matches!(
                asset.excluded_reason.as_deref(),
                Some(DEDUPE_REASON) | Some(RECYCLE_REASON)
            );
        if recycle && !recycled && asset.review_status != "excluded" {
            targets.push(id.clone());
        } else if !recycle && recycled {
            targets.push(id.clone());
        }
    }
    if targets.is_empty() {
        return Ok(DedupeActionResult { moved: 0, restored: 0 });
    }
    let mut before = Vec::new();
    for id in &targets {
        before.push(snapshot_asset(&conn, id)?);
    }
    let now = util::now_iso();
    let tx = conn.transaction()?;
    for id in &targets {
        if recycle {
            tx.execute(
                "UPDATE assets SET review_status = 'excluded', excluded_reason = ?1,
                 revision = revision + 1, last_human_at = ?2 WHERE id = ?3",
                params![reason, now, id],
            )?;
        } else {
            tx.execute(
                "UPDATE assets SET review_status = 'pending', excluded_reason = NULL,
                 revision = revision + 1, last_human_at = ?1 WHERE id = ?2",
                params![now, id],
            )?;
        }
    }
    tx.commit()?;
    let mut after = Vec::new();
    for id in &targets {
        after.push(snapshot_asset(&conn, id)?);
    }
    history::record(
        &conn,
        if recycle { "assets.recycle" } else { "assets.restore" },
        if recycle { "移至回收区" } else { "从回收区恢复" },
        &targets,
        &HistoryState { assets: before, memberships: vec![] },
        &HistoryState { assets: after, memberships: vec![] },
        None,
    )?;
    let count = targets.len() as i64;
    Ok(DedupeActionResult {
        moved: if recycle { count } else { 0 },
        restored: if recycle { 0 } else { count },
    })
}
