use crate::db::{self, meta_get, meta_set};
use crate::error::{AppError, AppResult};
use crate::model::{AppSettings, ProjectCounts, ProjectInfo, StorageStats};
use crate::util;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub mod assets;
pub mod captions;
pub mod collections;
pub mod history;
pub mod import;
pub mod jobs;
pub mod prompt_library;
pub mod quality;
pub mod sample;
pub mod transform;

pub const PROJECT_FILE: &str = "project.json";
pub const LOCK_FILE: &str = ".yoyoku.lock";
pub const APP_MARKER: &str = "yoyoku-dataset-prep";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub schema_version: u32,
    pub app: String,
    pub id: String,
    pub name: String,
    pub model: String,
    pub created_at: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
    pub parent_dir: String,
    pub model: String,
    #[serde(default)]
    pub template: String,
    #[serde(default)]
    pub trigger_word: String,
    #[serde(default)]
    pub default_caption_mode: String,
}

pub struct Project {
    pub id: String,
    pub root: PathBuf,
    pub db: std::sync::Mutex<Connection>,
    lock_path: PathBuf,
    lock_token: String,
}

impl Drop for Project {
    fn drop(&mut self) {
        if let Ok(text) = std::fs::read_to_string(&self.lock_path) {
            if text.contains(&self.lock_token) {
                let _ = std::fs::remove_file(&self.lock_path);
            }
        }
    }
}

impl Project {
    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn originals_dir(&self) -> PathBuf {
        self.root.join("originals")
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }

    pub fn thumbs_dir(&self) -> PathBuf {
        self.cache_dir().join("thumbs")
    }

    pub fn displays_dir(&self) -> PathBuf {
        self.cache_dir().join("display")
    }

    pub fn previews_dir(&self) -> PathBuf {
        self.cache_dir().join("previews")
    }

    pub fn staging_dir(&self) -> PathBuf {
        self.root.join("staging")
    }

    pub fn exports_dir(&self) -> PathBuf {
        self.root.join("exports")
    }

    pub fn backups_dir(&self) -> PathBuf {
        self.root.join("backups")
    }

    pub fn info(&self) -> AppResult<ProjectInfo> {
        project_info(self)
    }

    pub fn source_path(&self, asset: &db::AssetRow) -> AppResult<PathBuf> {
        let conn = self.conn();
        let root: Option<(String, String)> = conn
            .query_row(
                "SELECT path, mode FROM source_roots WHERE id = ?1",
                params![asset.source_root_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        drop(conn);
        if let Some((root_path, mode)) = root {
            if mode == "copy" {
                return Ok(self
                    .originals_dir()
                    .join(format!("{}.{}", asset.content_hash, asset.ext)));
            }
            return util::safe_join(Path::new(&root_path), &asset.rel_path);
        }
        // 兜底：受管理原件
        Ok(self
            .originals_dir()
            .join(format!("{}.{}", asset.content_hash, asset.ext)))
    }

    pub fn thumb_path(&self, asset_id: &str, version: &str) -> PathBuf {
        self.thumbs_dir().join(asset_id).join(format!("{version}.jpg"))
    }

    pub fn display_path(&self, asset_id: &str, version: &str) -> PathBuf {
        self.displays_dir()
            .join(asset_id)
            .join(format!("{version}.png"))
    }

    pub fn ensure_layout(&self) -> AppResult<()> {
        for dir in [
            self.originals_dir(),
            self.thumbs_dir(),
            self.displays_dir(),
            self.previews_dir(),
            self.staging_dir(),
            self.exports_dir(),
            self.backups_dir(),
        ] {
            util::ensure_dir(&dir)?;
        }
        Ok(())
    }

    pub fn touch_updated(&self) -> AppResult<()> {
        self.conn().execute(
            "UPDATE project SET updated_at = ?1 WHERE id = ?2",
            params![util::now_iso(), self.id],
        )?;
        Ok(())
    }
}

pub fn default_project_settings(model: &str, template: &str, caption_mode: &str) -> serde_json::Value {
    let base = if model == "sd15" { 512 } else { 1024 };
    let template_mode = match template {
        "object" => "nl",
        "character" | "style" => "tags",
        _ => caption_mode,
    };
    serde_json::json!({
        "resolution": [base, base],
        "baseModel": model,
        "template": template,
        "captionMode": template_mode,
        "triggerMode": if template_mode == "nl" { "prefix" } else { "first" },
        "processing": {
            "version": 1,
            "rotation": 0,
            "flipH": false,
            "flipV": false,
            "crop": { "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0 },
            "scaleMode": "preserve",
            "width": null,
            "height": null,
            "longestEdge": base,
            "allowUpscale": false,
            "resample": "lanczos",
            "background": "#ffffff",
            "color": { "brightness": 1.0, "contrast": 1.0, "saturation": 1.0 },
            "format": "png",
            "quality": 95
        },
        "thresholds": {
            "lowResolutionRatio": 0.5,
            "extremeAspect": 3.0,
            "cropRatio": 0.3,
            "padRatio": 0.25,
            "duplicateDistance": 8,
            "duplicateWeight": 0.8,
            "exposureRatio": 0.4,
            "blurEnabled": false,
            "blurThreshold": 60.0,
            "maxCaptionChars": 320
        },
        "exportDefaults": {
            "target": "kohya",
            "package": "folder",
            "naming": "index",
            "imageFormat": "png",
            "quality": 95,
            "captionExtension": ".txt",
            "enableBucket": true,
            "bucketNoUpscale": true,
            "bucketSteps": 64,
            "batchSize": 1
        },
        "tagVocabulary": [],
        "sidecarPriority": "txt",
        "schema": 1
    })
}

fn write_project_file(project: &Project, name: &str, model: &str, created_at: &str) -> AppResult<()> {
    let file = ProjectFile {
        schema_version: 1,
        app: APP_MARKER.into(),
        id: project.id.clone(),
        name: name.into(),
        model: model.into(),
        created_at: created_at.into(),
        app_version: env!("CARGO_PKG_VERSION").into(),
    };
    util::write_atomic(
        &project.root.join(PROJECT_FILE),
        serde_json::to_string_pretty(&file)?.as_bytes(),
    )
}

pub fn create_project(req: &CreateProjectRequest) -> AppResult<Project> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::new("INVALID_NAME", "项目名称不能为空"));
    }
    if name.chars().count() > 120 {
        return Err(AppError::new("INVALID_NAME", "项目名称不能超过 120 个字符"));
    }
    let parent = PathBuf::from(util::expand_user_home(&req.parent_dir));
    if req.parent_dir.trim().is_empty() {
        return Err(AppError::new("INVALID_NAME", "请选择保存位置"));
    }
    util::ensure_dir(&parent).map_err(|e| AppError::new("TARGET_UNWRITABLE", e.message))?;

    let folder = util::sanitize_stem(name);
    let root = parent.join(&folder);
    if root.exists() {
        let empty = std::fs::read_dir(&root)
            .map(|mut it| it.next().is_none())
            .unwrap_or(false);
        if !empty {
            return Err(AppError::new(
                "PROJECT_EXISTS",
                format!("目标文件夹已存在且非空：{}", root.display()),
            ));
        }
    }
    util::ensure_dir(&root)?;

    // 可写性探测
    let probe = root.join(".yoyoku-write-test");
    std::fs::write(&probe, b"ok").map_err(|e| {
        AppError::new(
            "TARGET_UNWRITABLE",
            format!("保存位置不可写：{e}"),
        )
    })?;
    let _ = std::fs::remove_file(&probe);

    let id = util::new_id();
    let created_at = util::now_iso();
    let db_path = root.join("database.sqlite");
    let mut conn = db::open_connection(&db_path)?;
    db::migrate(&mut conn, &root.join("backups"))?;

    let template = if req.template.is_empty() { "character".to_string() } else { req.template.clone() };
    let default_mode = if req.default_caption_mode.is_empty() {
        match template.as_str() {
            "object" => "nl".to_string(),
            _ => "tags".to_string(),
        }
    } else {
        req.default_caption_mode.clone()
    };
    let settings = default_project_settings(&req.model, &template, &default_mode);
    let trigger_mode = settings["triggerMode"].as_str().unwrap_or("first").to_string();

    conn.execute(
        "INSERT INTO project(id, name, model, template, trigger_word, trigger_mode, default_caption_mode, settings_json, created_at, updated_at, schema_version)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)",
        params![
            id,
            name,
            req.model,
            template,
            req.trigger_word.trim(),
            trigger_mode,
            default_mode,
            serde_json::to_string(&settings)?,
            created_at,
            db::SCHEMA_VERSION as i64
        ],
    )?;
    meta_set(&conn, "quality_stale", "1")?;
    drop(conn);

    let lock_token = util::new_id();
    let lock_path = root.join(LOCK_FILE);
    std::fs::write(&lock_path, lock_payload(&lock_token))?;

    let project = Project {
        id: id.clone(),
        root: root.clone(),
        db: std::sync::Mutex::new(db::open_connection(&db_path)?),
        lock_path,
        lock_token,
    };
    project.ensure_layout()?;
    write_project_file(&project, name, &req.model, &created_at)?;
    Ok(project)
}

fn lock_payload(token: &str) -> String {
    format!(
        "pid={}\ntoken={}\ntime={}\n",
        std::process::id(),
        token,
        util::now_iso()
    )
}

fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let output = crate::util::hidden_command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output();
        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            return text.contains(&pid.to_string());
        }
        false
    }
    #[cfg(not(windows))]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
}

pub fn open_project(root: &Path) -> AppResult<Project> {
    let root = root.canonicalize().map_err(|e| {
        AppError::new("PROJECT_MISSING", format!("项目目录不可访问：{e}"))
    })?;
    let project_file_path = root.join(PROJECT_FILE);
    let text = std::fs::read_to_string(&project_file_path).map_err(|_| {
        AppError::new(
            "PROJECT_MISSING",
            format!("此文件夹不是 Yoyoku 项目：{}", root.display()),
        )
    })?;
    let file: ProjectFile = serde_json::from_str(&text)
        .map_err(|e| AppError::new("PROJECT_CORRUPT", format!("project.json 无法读取：{e}")))?;
    if file.app != APP_MARKER {
        return Err(AppError::new("PROJECT_CORRUPT", "项目标识不匹配"));
    }
    if file.schema_version > 1 {
        return Err(AppError::new(
            "PROJECT_VERSION_UNSUPPORTED",
            format!(
                "此项目由更新版本创建（项目结构 v{}）。请升级应用后再试。",
                file.schema_version
            ),
        ));
    }

    let lock_path = root.join(LOCK_FILE);
    let mut lock_token = util::new_id();
    if let Ok(existing) = std::fs::read_to_string(&lock_path) {
        let pid = existing
            .lines()
            .find_map(|line| line.strip_prefix("pid="))
            .and_then(|value| value.trim().parse::<u32>().ok());
        if let Some(pid) = pid {
            if pid != std::process::id() && process_alive(pid) {
                return Err(AppError::new(
                    "PROJECT_LOCKED",
                    "项目已在另一个窗口中打开。请先关闭另一个窗口，或复制项目后继续。",
                ));
            }
        }
        if let Some(token) = existing
            .lines()
            .find_map(|line| line.strip_prefix("token="))
        {
            lock_token = token.trim().to_string();
        }
    }
    if lock_token.is_empty() {
        lock_token = util::new_id();
    }
    std::fs::write(&lock_path, lock_payload(&lock_token))?;

    let db_path = root.join("database.sqlite");
    let mut conn = db::open_connection(&db_path)?;
    db::migrate(&mut conn, &root.join("backups"))?;
    let exists: Option<String> = conn
        .query_row("SELECT id FROM project LIMIT 1", [], |row| row.get(0))
        .optional()?;
    if exists.is_none() {
        // 修复：数据库为空时按 project.json 重建项目行
        let settings = default_project_settings(&file.model, "character", "tags");
        conn.execute(
            "INSERT INTO project(id, name, model, template, trigger_word, trigger_mode, default_caption_mode, settings_json, created_at, updated_at, schema_version)
             VALUES(?1, ?2, ?3, 'character', '', 'first', 'tags', ?4, ?5, ?5, 1)",
            params![file.id, file.name, file.model, serde_json::to_string(&settings)?, file.created_at],
        )?;
    }
    drop(conn);

    let project = Project {
        id: file.id,
        root: root.clone(),
        db: std::sync::Mutex::new(db::open_connection(&db_path)?),
        lock_path,
        lock_token,
    };
    project.ensure_layout()?;
    project.touch_updated()?;
    Ok(project)
}

pub fn project_counts(conn: &Connection) -> AppResult<ProjectCounts> {
    let counts = conn.query_row(
        "SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN review_status != 'excluded' THEN 1 ELSE 0 END), 0) AS valid,
           COALESCE(SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
           COALESCE(SUM(CASE WHEN review_status = 'review' THEN 1 ELSE 0 END), 0) AS review,
           COALESCE(SUM(CASE WHEN review_status = 'excluded' THEN 1 ELSE 0 END), 0) AS excluded,
           COALESCE(SUM(CASE WHEN split_lock = 'train' THEN 1 ELSE 0 END), 0) AS train,
           COALESCE(SUM(CASE WHEN split_lock = 'val' THEN 1 ELSE 0 END), 0) AS val
         FROM assets",
        [],
        |row| {
            Ok(ProjectCounts {
                total: row.get(0)?,
                valid: row.get(1)?,
                pending: row.get(2)?,
                approved: row.get(3)?,
                review: row.get(4)?,
                excluded: row.get(5)?,
                train: row.get(6)?,
                val: row.get(7)?,
                collections: 0,
                orphan_captions: 0,
            })
        },
    )?;
    let mut counts = counts;
    counts.collections = conn.query_row("SELECT COUNT(*) FROM collections", [], |row| row.get(0))?;
    counts.orphan_captions = meta_get(conn, "orphan_captions")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    Ok(counts)
}

pub fn project_info(project: &Project) -> AppResult<ProjectInfo> {
    let conn = project.conn();
    let row = conn
        .query_row(
            "SELECT id, name, model, template, trigger_word, trigger_mode, default_caption_mode,
                    settings_json, created_at, updated_at, schema_version
             FROM project LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, i64>(10)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::new("PROJECT_CORRUPT", "项目记录缺失"))?;
    let counts = project_counts(&conn)?;
    let stale = meta_get(&conn, "quality_stale").as_deref() != Some("0");
    let scanned_at = meta_get(&conn, "quality_scanned_at");
    Ok(ProjectInfo {
        id: row.0,
        name: row.1,
        model: row.2,
        template: row.3,
        trigger_word: row.4,
        trigger_mode: row.5,
        default_caption_mode: row.6,
        settings: serde_json::from_str(&row.7).unwrap_or_else(|_| serde_json::json!({})),
        root: project.root.to_string_lossy().to_string(),
        created_at: row.8,
        updated_at: row.9,
        schema_version: row.10 as u32,
        counts,
        quality_stale: stale,
        quality_scanned_at: scanned_at,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdate {
    pub name: Option<String>,
    pub model: Option<String>,
    pub trigger_word: Option<String>,
    pub trigger_mode: Option<String>,
    pub default_caption_mode: Option<String>,
    pub settings: Option<serde_json::Value>,
    pub recompute: Option<bool>,
}

pub fn update_project(project: &Project, update: &ProjectUpdate) -> AppResult<ProjectInfo> {
    let conn = project.conn();
    if let Some(name) = &update.name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(AppError::new("INVALID_NAME", "项目名称不能为空"));
        }
        conn.execute(
            "UPDATE project SET name = ?1, updated_at = ?2",
            params![trimmed, util::now_iso()],
        )?;
    }
    if let Some(model) = &update.model {
        if !matches!(model.as_str(), "sd15" | "sdxl" | "custom") {
            return Err(AppError::new("INVALID_MODEL", "未知的基础模型"));
        }
        conn.execute(
            "UPDATE project SET model = ?1, updated_at = ?2",
            params![model, util::now_iso()],
        )?;
    }
    if let Some(trigger) = &update.trigger_word {
        conn.execute(
            "UPDATE project SET trigger_word = ?1, updated_at = ?2",
            params![trigger.trim(), util::now_iso()],
        )?;
    }
    if let Some(mode) = &update.trigger_mode {
        conn.execute(
            "UPDATE project SET trigger_mode = ?1, updated_at = ?2",
            params![mode, util::now_iso()],
        )?;
    }
    if let Some(mode) = &update.default_caption_mode {
        if !matches!(mode.as_str(), "tags" | "nl") {
            return Err(AppError::new("INVALID_MODE", "未知的标注模式"));
        }
        conn.execute(
            "UPDATE project SET default_caption_mode = ?1, updated_at = ?2",
            params![mode, util::now_iso()],
        )?;
    }
    if let Some(settings) = &update.settings {
        let current: String = conn.query_row("SELECT settings_json FROM project LIMIT 1", [], |row| row.get(0))?;
        let mut merged: serde_json::Value = serde_json::from_str(&current).unwrap_or_else(|_| serde_json::json!({}));
        merge_json(&mut merged, settings);
        conn.execute(
            "UPDATE project SET settings_json = ?1, updated_at = ?2",
            params![serde_json::to_string(&merged)?, util::now_iso()],
        )?;
    }
    if update.recompute == Some(true) {
        db::mark_quality_stale(&conn)?;
    }
    let name: String = conn.query_row("SELECT name FROM project LIMIT 1", [], |row| row.get(0))?;
    let model: String = conn.query_row("SELECT model FROM project LIMIT 1", [], |row| row.get(0))?;
    let created_at: String = conn.query_row("SELECT created_at FROM project LIMIT 1", [], |row| row.get(0))?;
    drop(conn);
    let _ = write_project_file(project, &name, &model, &created_at);
    project_info(project)
}

pub fn merge_json(base: &mut serde_json::Value, patch: &serde_json::Value) {
    if let (Some(base_obj), Some(patch_obj)) = (base.as_object_mut(), patch.as_object()) {
        for (key, value) in patch_obj {
            if value.is_object() && base_obj.get(key).map(|v| v.is_object()).unwrap_or(false) {
                if let Some(slot) = base_obj.get_mut(key) {
                    merge_json(slot, value);
                }
            } else {
                base_obj.insert(key.clone(), value.clone());
            }
        }
    } else {
        *base = patch.clone();
    }
}

pub fn project_settings(conn: &Connection) -> serde_json::Value {
    conn.query_row("SELECT settings_json FROM project LIMIT 1", [], |row| row.get::<_, String>(0))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub fn model_base_resolution(conn: &Connection) -> u32 {
    let model: String = conn
        .query_row("SELECT model FROM project LIMIT 1", [], |row| row.get(0))
        .unwrap_or_else(|_| "sdxl".into());
    if model == "sd15" { 512 } else { 1024 }
}

pub fn storage_stats(project: &Project) -> AppResult<StorageStats> {
    let conn = project.conn();
    let assets: i64 = conn.query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))?;
    drop(conn);
    let thumb_bytes = util::dir_size(&project.thumbs_dir());
    let display_bytes = util::dir_size(&project.displays_dir());
    let preview_bytes = util::dir_size(&project.previews_dir());
    let cache_bytes = util::dir_size(&project.cache_dir());
    Ok(StorageStats {
        project_root: project.root.to_string_lossy().to_string(),
        originals_bytes: util::dir_size(&project.originals_dir()),
        cache_bytes,
        thumb_bytes,
        display_bytes,
        preview_bytes,
        staging_bytes: util::dir_size(&project.staging_dir()),
        exports_bytes: util::dir_size(&project.exports_dir()),
        database_bytes: std::fs::metadata(project.root.join("database.sqlite"))
            .map(|m| m.len())
            .unwrap_or(0),
        assets,
        cache_files: util::count_files(&project.cache_dir()),
    })
}

pub fn apply_app_defaults_to_project(conn: &Connection, settings: &AppSettings) -> AppResult<()> {
    // 基础模型/分辨率只由项目自身设置决定；这里保留接口用于未来同步应用级偏好。
    let _ = (conn, settings);
    Ok(())
}

pub type SharedProject = Arc<Project>;
