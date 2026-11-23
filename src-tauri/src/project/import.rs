use crate::db::{self, ASSET_COLUMNS};
use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::project::jobs::{self, JobContext, JobOutcome, JobRun};
use crate::project::transform;
use crate::project::Project;
use crate::util;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const MAX_PIXELS: u64 = 80_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntryInternal {
    pub path: String,
    pub root: String,
    pub rel_path: String,
    pub name: String,
    pub ext: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub bytes: i64,
    pub sidecar_path: Option<String>,
    pub sidecar_kind: Option<String>,
    pub sidecar_text: Option<String>,
    pub sidecar_conflicts: Vec<String>,
    pub status: String,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCache {
    pub id: String,
    pub project_id: String,
    pub roots: Vec<String>,
    pub entries: Vec<ScanEntryInternal>,
    pub skipped: Vec<ScanSkip>,
    pub options: ScanRequest,
    pub summary: ScanSummary,
    pub created_at: String,
}

fn is_hidden_system_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name.to_lowercase().as_str(),
        "$recycle.bin" | "system volume information" | "node_modules" | "__pycache__"
    )
}

fn known_unknown_image_ext(ext: &str) -> bool {
    matches!(
        ext,
        "gif" | "avif" | "heic" | "heif" | "jxl" | "psd" | "svg" | "ico" | "exr" | "hdr"
            | "cr2" | "nef" | "arw" | "dng" | "orf" | "rw2" | "webp2"
    )
}

struct SidecarIndex {
    by_dir_key: HashMap<(String, String), Vec<(PathBuf, String)>>,
    by_dir: HashMap<String, Vec<(PathBuf, String)>>,
}

fn sidecar_index(paths: &[PathBuf]) -> SidecarIndex {
    let mut dirs: HashSet<String> = HashSet::new();
    for path in paths {
        if let Some(parent) = path.parent() {
            dirs.insert(parent.to_string_lossy().to_string());
        }
    }
    let mut by_dir_key: HashMap<(String, String), Vec<(PathBuf, String)>> = HashMap::new();
    let mut by_dir: HashMap<String, Vec<(PathBuf, String)>> = HashMap::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = util::ext_lower(&path);
            if ext != "txt" && ext != "caption" {
                continue;
            }
            let stem = util::stem_lower(&path);
            by_dir_key
                .entry((dir.clone(), stem))
                .or_default()
                .push((path.clone(), ext.clone()));
            by_dir.entry(dir.clone()).or_default().push((path, ext));
        }
    }
    SidecarIndex { by_dir_key, by_dir }
}

fn choose_sidecar(
    index: &SidecarIndex,
    image: &Path,
    priority: &str,
) -> (Option<PathBuf>, Option<String>, Vec<String>) {
    let Some(parent) = image.parent() else {
        return (None, None, Vec::new());
    };
    let dir = parent.to_string_lossy().to_string();
    let stem = util::stem_lower(image);
    let mut candidates = index
        .by_dir_key
        .get(&(dir, stem))
        .cloned()
        .unwrap_or_default();
    let mut conflicts: Vec<String> = Vec::new();
    if candidates.len() > 1 {
        conflicts = candidates
            .iter()
            .map(|(path, _)| path.to_string_lossy().to_string())
            .collect();
    }
    if candidates.is_empty() {
        return (None, None, conflicts);
    }
    let preferred = if priority == "caption" { "caption" } else { "txt" };
    candidates.sort_by_key(|(_, ext)| if ext == preferred { 0 } else { 1 });
    let (chosen, ext) = candidates.remove(0);
    (Some(chosen), Some(ext), conflicts)
}

pub fn scan(project: &Project, request: &ScanRequest) -> AppResult<ScanCache> {
    if request.paths.is_empty() {
        return Err(AppError::new("EMPTY_SCOPE", "请选择图片或文件夹"));
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut image_paths: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut skipped: Vec<ScanSkip> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for raw in &request.paths {
        let path = PathBuf::from(util::expand_user_home(raw));
        let canonical = path
            .canonicalize()
            .map_err(|e| AppError::new("SOURCE_MISSING", format!("路径不可访问：{}（{e}）", path.display())))?;
        if canonical.is_dir() {
            let root = canonical.clone();
            if roots.iter().all(|existing| existing != &root) {
                roots.push(root.clone());
            }
            let walker = WalkDir::new(&root)
                .follow_links(false)
                .max_depth(if request.recursive { 64 } else { 1 })
                .into_iter()
                .filter_entry(|entry| {
                    if entry.depth() == 0 {
                        return true;
                    }
                    if entry.file_type().is_symlink() {
                        return false;
                    }
                    if entry.file_type().is_dir() {
                        return !is_hidden_system_dir(&entry.file_name().to_string_lossy());
                    }
                    true
                });
            for entry in walker {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        skipped.push(ScanSkip {
                            path: error.path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                            reason: format!("遍历失败：{error}"),
                        });
                        continue;
                    }
                };
                if !entry.file_type().is_file() {
                    continue;
                }
                if entry.file_type().is_symlink() {
                    skipped.push(ScanSkip {
                        path: entry.path().to_string_lossy().to_string(),
                        reason: "跳过链接或重解析点".into(),
                    });
                    continue;
                }
                let ext = util::ext_lower(entry.path());
                if util::is_supported_image(entry.path()) || known_unknown_image_ext(&ext) {
                    let key = entry.path().to_string_lossy().to_lowercase();
                    if seen.insert(key) {
                        image_paths.push((entry.path().to_path_buf(), root.clone()));
                    }
                }
            }
        } else {
            let root = canonical.parent().unwrap_or(Path::new(".")).to_path_buf();
            if roots.iter().all(|existing| existing != &root) {
                roots.push(root.clone());
            }
            let ext = util::ext_lower(&canonical);
            let key = canonical.to_string_lossy().to_lowercase();
            if (util::is_supported_image(&canonical) || known_unknown_image_ext(&ext)) && seen.insert(key) {
                image_paths.push((canonical, root));
            }
        }
    }

    image_paths.sort_by(|a, b| a.0.to_string_lossy().cmp(&b.0.to_string_lossy()));
    let all_paths: Vec<PathBuf> = image_paths.iter().map(|(path, _)| path.clone()).collect();
    let index = sidecar_index(&all_paths);
    let mut entries: Vec<ScanEntryInternal> = Vec::new();
    let mut summary = ScanSummary::default();
    let mut matched_sidecars: HashSet<String> = HashSet::new();
    let mut stem_usage: HashMap<(String, String), usize> = HashMap::new();
    for (path, _) in &image_paths {
        let dir = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let stem = util::stem_lower(path);
        *stem_usage.entry((dir, stem)).or_insert(0) += 1;
    }

    for (path, root) in &image_paths {
        let ext = util::ext_lower(path);
        let rel_path = util::relative_to(root, path);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let metadata = std::fs::metadata(path).ok();
        let bytes = metadata.as_ref().map(|m| m.len() as i64).unwrap_or(0);
        let (sidecar_path, sidecar_kind, mut sidecar_conflicts) = choose_sidecar(&index, path, &request.sidecar_priority);
        let mut problems: Vec<String> = Vec::new();
        if let Some(sidecar) = &sidecar_path {
            matched_sidecars.insert(sidecar.to_string_lossy().to_string());
        }
        let dir = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let stem = util::stem_lower(path);
        if stem_usage.get(&(dir, stem)).copied().unwrap_or(0) > 1 {
            sidecar_conflicts.push("同一目录下多个文件共用同一个标注名".into());
        }
        let sidecar_text = match &sidecar_path {
            Some(sidecar) => match util::read_optional_text(sidecar) {
                Some(text) => Some(text),
                None => {
                    problems.push("标注文件不是有效的 UTF-8 文本".into());
                    None
                }
            },
            None => None,
        };
        if !sidecar_conflicts.is_empty() {
            summary.conflicts += 1;
        }
        let mut status = "ok".to_string();
        let mut format = util::format_name(&ext);
        let mut width = 0;
        let mut height = 0;
        if !util::is_supported_image(path) {
            status = "unsupported".into();
            problems.push("不支持的图片格式".into());
            summary.unsupported += 1;
        } else {
            match util::sniff_image(path) {
                Ok(info) => {
                    width = info.width;
                    height = info.height;
                    format = info.format.clone();
                    if info.animated || info.pages > 1 {
                        status = "animated".into();
                        problems.push("多帧图片：v1 只支持静态图片".into());
                        summary.animated += 1;
                    } else if (info.width as u64) * (info.height as u64) > MAX_PIXELS {
                        status = "oversized".into();
                        problems.push(format!(
                            "像素超过上限 80 MP（当前 {}×{}）",
                            info.width, info.height
                        ));
                        summary.oversized += 1;
                    }
                }
                Err(error) => {
                    status = "error".into();
                    problems.push(error.message.clone());
                    summary.errors += 1;
                }
            }
        }
        if status == "ok" {
            summary.candidates += 1;
            if sidecar_text.is_some() {
                summary.with_sidecar += 1;
            }
        }
        entries.push(ScanEntryInternal {
            path: path.to_string_lossy().to_string(),
            root: root.to_string_lossy().to_string(),
            rel_path,
            name,
            ext,
            format,
            width,
            height,
            bytes,
            sidecar_path: sidecar_path.map(|p| p.to_string_lossy().to_string()),
            sidecar_kind,
            sidecar_text,
            sidecar_conflicts,
            status,
            problems,
        });
    }

    // 孤立标注
    let all_sidecars: HashSet<String> = index
        .by_dir
        .values()
        .flat_map(|items| items.iter().map(|(path, _)| path.to_string_lossy().to_string()))
        .collect();
    summary.isolated_sidecars = all_sidecars
        .iter()
        .filter(|path| !matched_sidecars.contains(*path))
        .count() as i64;

    let id = util::new_id();
    let cache = ScanCache {
        id: id.clone(),
        project_id: project.id.clone(),
        roots: roots.iter().map(|p| p.to_string_lossy().to_string()).collect(),
        entries,
        skipped: skipped.into_iter().take(60).collect(),
        options: request.clone(),
        summary: summary.clone(),
        created_at: util::now_iso(),
    };
    // 持久化扫描结果，供应用重启后恢复/重试
    let staging = project.staging_dir().join(format!("import-{id}.json"));
    let _ = util::write_atomic(&staging, serde_json::to_string(&cache)?.as_bytes());
    Ok(cache)
}

pub fn load_scan(project: &Project, scan_id: &str) -> AppResult<ScanCache> {
    let staging = project.staging_dir().join(format!("import-{scan_id}.json"));
    let text = std::fs::read_to_string(&staging)
        .map_err(|_| AppError::new("SCAN_EXPIRED", "扫描结果已过期，请重新扫描"))?;
    serde_json::from_str(&text)
        .map_err(|_| AppError::new("SCAN_EXPIRED", "扫描结果无法读取，请重新扫描"))
}

pub fn preview_of(cache: &ScanCache) -> ScanPreview {
    let limit = 300usize;
    let entries: Vec<ScanEntry> = cache
        .entries
        .iter()
        .take(limit)
        .map(|entry| ScanEntry {
            path: entry.path.clone(),
            root: entry.root.clone(),
            rel_path: entry.rel_path.clone(),
            name: entry.name.clone(),
            ext: entry.ext.clone(),
            format: entry.format.clone(),
            width: entry.width,
            height: entry.height,
            bytes: entry.bytes,
            sidecar_path: entry.sidecar_path.clone(),
            sidecar_kind: entry.sidecar_kind.clone(),
            sidecar_text: entry
                .sidecar_text
                .as_ref()
                .map(|text| text.chars().take(500).collect()),
            sidecar_conflicts: entry.sidecar_conflicts.clone(),
            status: entry.status.clone(),
            problems: entry.problems.clone(),
        })
        .collect();
    let mut summary = cache.summary.clone();
    summary.truncated = (cache.entries.len().saturating_sub(limit)) as i64;
    ScanPreview {
        id: cache.id.clone(),
        roots: cache.roots.clone(),
        entries,
        summary,
        skipped: cache.skipped.clone(),
        options: cache.options.clone(),
    }
}

fn mtime_ms(metadata: &std::fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_default()
}

fn project_id(project: &Project) -> String {
    project.id.clone()
}

fn ensure_source_root(conn: &rusqlite::Connection, path: &str, mode: &str) -> AppResult<String> {
    if let Some((id, existing_mode)) = conn
        .query_row(
            "SELECT id, mode FROM source_roots WHERE path = ?1",
            params![path],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    {
        if existing_mode != mode {
            // 同一根目录以首次登记的方式访问，保证已有素材路径一致
            return Ok(id);
        }
        return Ok(id);
    }
    let id = util::new_id();
    conn.execute(
        "INSERT INTO source_roots(id, path, mode, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![id, path, mode, util::now_iso()],
    )?;
    Ok(id)
}

pub fn start_import(
    app: AppHandle,
    project: std::sync::Arc<Project>,
    cache: ScanCache,
) -> AppResult<String> {
    let total = cache
        .entries
        .iter()
        .filter(|entry| entry.status == "ok")
        .count() as i64;
    let input = serde_json::json!({
        "scanId": cache.id,
        "projectId": cache.project_id,
        "roots": cache.roots,
        "mode": cache.options.mode,
        "recursive": cache.options.recursive,
        "duplicatePolicy": cache.options.duplicate_policy,
        "scanSummary": cache.summary,
    });
    let job_id = jobs::insert_job(
        &project,
        "import",
        &format!("导入图片（{} 张）", total),
        &input,
        total,
    )?;
    let job_for_thread = job_id.clone();
    jobs::run(app, project, job_id.clone(), move |ctx| {
        run_import(ctx, cache, total)
    });
    Ok(job_for_thread)
}

pub fn run_import(mut ctx: JobContext, cache: ScanCache, total: i64) -> AppResult<JobOutcome> {
    let project = ctx.project.clone();
    let options = cache.options.clone();
    let default_mode = {
        let conn = project.conn();
        conn.query_row(
            "SELECT default_caption_mode FROM project LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "tags".into())
    };
    let mut plan = {
        let conn = project.conn();
        let settings = crate::project::project_settings(&conn);
        settings
            .get("processing")
            .and_then(|value| serde_json::from_value::<crate::model::TransformPlan>(value.clone()).ok())
            .unwrap_or_default()
            .sanitized()
    };
    plan.format = "png".into();
    plan.crop = crate::model::CropRect::default();
    let plan_json = serde_json::to_string(&plan)?;
    let max_sort_index: i64 = {
        let conn = project.conn();
        conn.query_row("SELECT COALESCE(MAX(sort_index), 0) FROM assets", [], |row| row.get(0))?
    };
    // 预先登记来源根目录，避免并行线程重复插入同一路径。
    let root_ids: HashMap<String, String> = {
        let conn = project.conn();
        let mut map = HashMap::new();
        for root in &cache.roots {
            map.insert(root.clone(), ensure_source_root(&conn, root, &options.mode)?);
        }
        map
    };

    // 质检标记与项目更新时间只写一次；批量导入时逐张写入会成为主要瓶颈。
    {
        let conn = project.conn();
        let _ = db::meta_set(&conn, "quality_stale", "1");
        let _ = db::meta_set(
            &conn,
            "orphan_captions",
            &cache.summary.isolated_sidecars.to_string(),
        );
        let _ = conn.execute(
            "UPDATE project SET updated_at = ?1 WHERE id = ?2",
            params![util::now_iso(), project_id(&project)],
        );
    }

    let entries: Vec<&ScanEntryInternal> = cache
        .entries
        .iter()
        .filter(|entry| entry.status == "ok")
        .collect();
    let seen: std::sync::Mutex<HashSet<String>> = std::sync::Mutex::new(HashSet::new());
    let worker_slots = {
        let state = ctx.app.state::<crate::state::AppState>();
        state.worker.worker_count()
    };
    let parallelism = worker_slots.clamp(1, 4).min(entries.len().max(1));
    let chunk_size = (parallelism * 4).max(8);

    let mut success = 0i64;
    let mut skipped = 0i64;
    let mut failed = 0i64;
    let mut duplicate_paths: Vec<String> = Vec::new();
    let mut conflicts: Vec<String> = Vec::new();
    let mut errors: Vec<JobItemError> = Vec::new();
    let mut done = 0i64;
    let mut index = 0usize;

    while index < entries.len() {
        let end = (index + chunk_size).min(entries.len());
        let chunk = &entries[index..end];
        let cursor = std::sync::atomic::AtomicUsize::new(0);
        let outcomes: std::sync::Mutex<Vec<(usize, &ScanEntryInternal, AppResult<ImportOneOutcome>)>> =
            std::sync::Mutex::new(Vec::with_capacity(chunk.len()));
        std::thread::scope(|scope| {
            for _ in 0..parallelism {
                scope.spawn(|| loop {
                    let offset = cursor.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if offset >= chunk.len() {
                        break;
                    }
                    let entry = chunk[offset];
                    let sort_index = max_sort_index + 1 + (index + offset) as i64;
                    let result = import_one(
                        &project,
                        &ctx.app,
                        entry,
                        &options,
                        &default_mode,
                        &plan,
                        &plan_json,
                        sort_index,
                        &seen,
                        &root_ids,
                    );
                    outcomes
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push((offset, entry, result));
                });
            }
        });
        let mut results = outcomes
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        results.sort_by_key(|(offset, _, _)| *offset);
        for (_, entry, result) in results {
            done += 1;
            match result {
                Ok(outcome) => {
                    if outcome.success {
                        success += 1;
                    }
                    if outcome.skipped {
                        skipped += 1;
                    }
                    if let Some(duplicate) = outcome.duplicate {
                        duplicate_paths.push(duplicate);
                    }
                    conflicts.extend(outcome.conflicts);
                }
                Err(error) => {
                    failed += 1;
                    if errors.len() < 200 {
                        errors.push(JobItemError {
                            item_id: entry.rel_path.clone(),
                            path: entry.path.clone(),
                            message: error.message,
                            code: error.code,
                        });
                    }
                }
            }
        }
        if let JobRun::Cancelled = ctx.checkpoint(done, failed, total, "导入图片", false)? {
            let result = serde_json::json!({
                "success": success, "skipped": skipped, "failed": failed,
                "cancelled": true, "errors": errors,
                "duplicates": duplicate_paths, "conflicts": conflicts,
                "scanSkipped": cache.summary,
                "scanId": cache.id
            });
            cleanup_scan_file(&project, &cache.id);
            return Ok(JobOutcome { status: "cancelled".into(), result });
        }
        index = end;
    }

    ctx.checkpoint(done, failed, total, "收尾", true)?;
    if failed == 0 {
        cleanup_scan_file(&project, &cache.id);
    }
    {
        let conn = project.conn();
        let _ = conn.execute(
            "UPDATE project SET updated_at = ?1 WHERE id = ?2",
            params![util::now_iso(), project_id(&project)],
        );
    }
    {
        let state = ctx.app.state::<crate::state::AppState>();
        crate::state::sync_recent_for_project(&state, &project);
    }
    let result = serde_json::json!({
        "success": success,
        "skipped": skipped,
        "failed": failed,
        "errors": errors,
        "duplicates": duplicate_paths,
        "conflicts": conflicts,
        "scanSkipped": cache.summary,
        "scanId": cache.id,
        "roots": cache.roots,
    });
    let status = if failed > 0 { "completed_with_errors" } else { "completed" };
    Ok(JobOutcome { status: status.into(), result })
}

fn cleanup_scan_file(project: &Project, scan_id: &str) {
    let _ = std::fs::remove_file(project.staging_dir().join(format!("import-{scan_id}.json")));
}

struct ImportOneOutcome {
    success: bool,
    skipped: bool,
    duplicate: Option<String>,
    conflicts: Vec<String>,
}

/// 同一批导入内的哈希占位；失败时自动释放，成功导入后保留。
struct HashClaim<'a> {
    seen: &'a std::sync::Mutex<HashSet<String>>,
    hash: String,
    committed: bool,
}

impl Drop for HashClaim<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if let Ok(mut set) = self.seen.lock() {
            set.remove(&self.hash);
        }
    }
}

fn skipped_outcome(duplicate: Option<String>) -> ImportOneOutcome {
    ImportOneOutcome {
        success: false,
        skipped: true,
        duplicate,
        conflicts: vec![],
    }
}

#[allow(clippy::too_many_arguments)]
fn import_one(
    project: &Project,
    app: &AppHandle,
    entry: &ScanEntryInternal,
    options: &ScanRequest,
    default_mode: &str,
    plan: &crate::model::TransformPlan,
    plan_json: &str,
    sort_index: i64,
    seen: &std::sync::Mutex<HashSet<String>>,
    root_ids: &HashMap<String, String>,
) -> AppResult<ImportOneOutcome> {
    let source_path = PathBuf::from(&entry.path);
    let metadata_before = std::fs::metadata(&source_path)
        .map_err(|e| AppError::new("SOURCE_MISSING", format!("源文件不可读取：{e}")))?;
    let size_before = metadata_before.len();
    let mtime_before = mtime_ms(&metadata_before);

    let source_root_path = entry.root.clone();
    let source_root_id = {
        let conn = project.conn();
        let root_id = root_ids.get(&source_root_path).cloned().ok_or_else(|| {
            AppError::new("SOURCE_ROOT", "扫描根目录未登记，请重新扫描后再导入")
        })?;
        // 已导入过同一来源路径则跳过，不再读取与解码图片。
        if db::find_asset_by_source(&conn, &root_id, &entry.rel_path)?.is_some() {
            return Ok(skipped_outcome(None));
        }
        root_id
    };

    let (hash, hashed_size) = util::sha256_file(&source_path)
        .map_err(|e| AppError::io("读取源文件失败", e))?;
    let metadata_after = std::fs::metadata(&source_path)
        .map_err(|e| AppError::new("SOURCE_CHANGED", format!("读取过程中源文件消失：{e}")))?;
    if metadata_after.len() != size_before || mtime_ms(&metadata_after) != mtime_before || hashed_size != size_before {
        return Err(AppError::new(
            "SOURCE_CHANGED",
            "读取过程中源文件发生变化，请重试",
        ));
    }

    {
        let conn = project.conn();
        if let Some(existing) = db::find_asset_by_hash(&conn, &hash)? {
            if options.duplicate_policy != "keep" {
                return Ok(skipped_outcome(Some(format!(
                    "{}（与 {} 内容相同）",
                    entry.rel_path, existing.original_name
                ))));
            }
        }
    }

    // 先占位再分析：完全相同的图片在并行批次中只解码一次。
    let mut claim: Option<HashClaim> = None;
    if options.duplicate_policy != "keep" {
        let inserted = seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(hash.clone());
        if !inserted {
            return Ok(skipped_outcome(Some(format!(
                "{}（与本次导入中的另一张内容相同）",
                entry.rel_path
            ))));
        }
        claim = Some(HashClaim {
            seen,
            hash: hash.clone(),
            committed: false,
        });
    }

    // 规范化尺寸与哈希分析
    let analysis = {
        let state = app.state::<crate::state::AppState>();
        state.worker.analyze(&source_path)?
    };
    if analysis.frames > 1 {
        return Err(AppError::new("UNSUPPORTED_FORMAT", "多帧图片不支持导入"));
    }
    if (analysis.width as u64) * (analysis.height as u64) > MAX_PIXELS {
        return Err(AppError::new("TOO_LARGE", "图片像素超过 80 MP 上限"));
    }

    let content_hash = hash.clone();
    let ext = entry.ext.clone();
    let originals_dir = project.originals_dir();
    let managed_path = originals_dir.join(format!("{content_hash}.{ext}"));

    if options.mode == "copy" {
        if managed_path.exists() {
            let (existing_hash, _) = util::sha256_file(&managed_path)
                .map_err(|e| AppError::io("校验受管理原件失败", e))?;
            if existing_hash != content_hash {
                return Err(AppError::new(
                    "CONTENT_CONFLICT",
                    "项目原件缓存中的同名文件内容不一致",
                ));
            }
        } else {
            // 一次读取同时写入并计算哈希，避免复制后再完整读一遍校验。
            match util::copy_atomic_hash(&source_path, &managed_path) {
                Ok((copied_hash, copied_size)) => {
                    if copied_hash != content_hash || copied_size != size_before {
                        let _ = std::fs::remove_file(&managed_path);
                        return Err(AppError::new(
                            "COPY_VERIFY_FAILED",
                            "复制后的文件校验失败，已清理临时原件",
                        ));
                    }
                }
                Err(error) => {
                    // 并行导入相同内容且保留重复项时，另一线程可能已先完成同名原件。
                    if managed_path.exists() {
                        let (existing_hash, _) = util::sha256_file(&managed_path)
                            .map_err(|e| AppError::io("校验受管理原件失败", e))?;
                        if existing_hash != content_hash {
                            return Err(error);
                        }
                    } else {
                        return Err(error);
                    }
                }
            }
        }
    }

    let geometry = transform::compute_geometry(plan, analysis.width, analysis.height);
    let asset_id = util::new_id();
    let transform_revision_id = util::new_id();
    let caption_revision_id = util::new_id();
    let thumb_version = format!("{}-{}", &content_hash[..10], transform_revision_id);
    let tags = crate::caption::normalize_tags(crate::caption::split_caption_text(
        entry.sidecar_text.as_deref().unwrap_or(""),
    ));
    let text = entry.sidecar_text.clone().unwrap_or_default().trim_end().to_string();
    let search = crate::caption::search_text(default_mode, &tags, &text);
    let now = util::now_iso();
    let plan_hash = util::sha256_text(&format!("{content_hash}:{plan_json}"));
    let analysis_json = serde_json::json!({
        "icc": analysis.icc,
        "iccDescription": analysis.icc_description,
        "frames": analysis.frames,
        "mode": analysis.mode,
        "orientation": analysis.orientation,
        "rawWidth": analysis.raw_width,
        "rawHeight": analysis.raw_height,
    });

    {
        let mut conn = project.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO assets(id, content_hash, source_root_id, rel_path, original_name, ext, format, bytes,
                orig_width, orig_height, norm_width, norm_height, out_width, out_height, has_alpha, phash,
                blur_score, dark_ratio, bright_ratio, analysis_json, review_status, favorite, imported_at,
                sort_index, revision, transform_revision_id, caption_revision_id, missing, source_size,
                source_mtime, thumb_version, crop_ratio, pad_ratio, scale_ratio)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                ?19, ?20, 'pending', 0, ?21, ?22, 1, ?23, ?24, 0, ?25, ?26, ?27, 0, 0, ?28)",
            params![
                asset_id,
                content_hash,
                source_root_id,
                entry.rel_path,
                entry.name,
                entry.ext,
                entry.format,
                entry.bytes,
                analysis.raw_width,
                analysis.raw_height,
                analysis.width,
                analysis.height,
                geometry.out_width,
                geometry.out_height,
                if analysis.has_alpha { 1 } else { 0 },
                analysis.phash,
                analysis.blur,
                analysis.dark_ratio,
                analysis.bright_ratio,
                serde_json::to_string(&analysis_json)?,
                now,
                sort_index,
                transform_revision_id,
                caption_revision_id,
                entry.bytes,
                mtime_before,
                thumb_version,
                geometry.scale_ratio
            ],
        )?;
        tx.execute(
            "INSERT INTO transform_revisions(id, asset_id, revision_no, kind, plan_json, plan_hash, source_hash,
                out_width, out_height, crop_ratio, pad_ratio, scale_ratio, created_at)
             VALUES(?1, ?2, 1, 'applied', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                transform_revision_id,
                asset_id,
                plan_json,
                plan_hash,
                content_hash,
                geometry.out_width,
                geometry.out_height,
                geometry.crop_ratio,
                geometry.pad_ratio,
                geometry.scale_ratio,
                now
            ],
        )?;
        tx.execute(
            "INSERT INTO caption_revisions(id, asset_id, revision_no, mode, tags_json, text, source, status,
                search_text, created_at)
             VALUES(?1, ?2, 1, ?3, ?4, ?5, 'import', 'active', ?6, ?7)",
            params![
                caption_revision_id,
                asset_id,
                default_mode,
                serde_json::to_string(&tags)?,
                text,
                search,
                now
            ],
        )?;
        if let Some(collection_id) = options.collection_id.as_deref().filter(|value| !value.trim().is_empty()) {
            tx.execute(
                "INSERT OR IGNORE INTO collection_assets(collection_id, asset_id) VALUES(?1, ?2)",
                params![collection_id, asset_id],
            )?;
        }
        tx.commit()?;
    }

    if let Some(claim) = claim.as_mut() {
        claim.committed = true;
    }

    let mut conflicts = Vec::new();
    if !entry.sidecar_conflicts.is_empty() {
        conflicts.push(format!(
            "{}：同一文件名存在多个标注候选（{}）",
            entry.rel_path,
            entry.sidecar_conflicts.join("；")
        ));
    }
    Ok(ImportOneOutcome {
        success: true,
        skipped: false,
        duplicate: None,
        conflicts,
    })
}

/// 重试导入任务：按任务记录中的扫描 id 重新载入。
pub fn retry_import(app: AppHandle, project: std::sync::Arc<Project>, job_id: &str, scan_id: &str) -> AppResult<String> {
    let cache = load_scan(&project, scan_id)?;
    let _ = job_id;
    start_import(app, project, cache)
}

pub fn asset_count(project: &Project) -> i64 {
    project
        .conn()
        .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
        .unwrap_or(0)
}

pub fn query_all(project: &Project) -> AppResult<Vec<db::AssetRow>> {
    let conn = project.conn();
    let mut statement = conn.prepare(&format!("SELECT {ASSET_COLUMNS} FROM assets ORDER BY sort_index ASC"))?;
    let rows = statement.query_map([], db::asset_row)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}
