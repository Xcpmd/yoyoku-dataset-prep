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
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

const MAX_PIXELS: u64 = 80_000_000;
/// 首批提交数量：让图库在导入开始后尽快出现第一批卡片。
const FIRST_BATCH: usize = 6;
/// 后续每批提交数量；配合事件节流限制数据库锁的持有时间。
const BATCH_MAX: usize = 24;
/// `assets:import-committed` 的节流间隔。
const COMMIT_EVENT_INTERVAL: Duration = Duration::from_millis(300);

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
    let _ = persist_scan(project, &cache);
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
        "collectionId": cache.options.collection_id,
        "scanSummary": cache.summary,
    });
    let job_id = jobs::insert_job(
        &project,
        "import",
        &format!("导入图片（{} 张）", total),
        &input,
        total,
    )?;
    // 重试会从磁盘重新读取扫描结果，因此把最终生效的分组随选项一起持久化。
    persist_scan(&project, &cache)?;
    let job_for_thread = job_id.clone();
    jobs::run(app, project, job_id.clone(), move |ctx| {
        run_import(ctx, cache, total)
    });
    Ok(job_for_thread)
}

fn persist_scan(project: &Project, cache: &ScanCache) -> AppResult<()> {
    let staging = project.staging_dir().join(format!("import-{}.json", cache.id));
    util::write_atomic(&staging, serde_json::to_string(cache)?.as_bytes())
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
    let seen: StdMutex<HashSet<String>> = StdMutex::new(HashSet::new());
    // 同一任务内已校验过的受管理原件，避免重复读取整份内容。
    let verified: StdMutex<HashSet<String>> = StdMutex::new(HashSet::new());
    let worker_slots = {
        let state = ctx.app.state::<crate::state::AppState>();
        state.worker.worker_count()
    };
    let parallelism = worker_slots.clamp(1, 8).min(entries.len().max(1));
    let staging_dir = project.staging_dir().join(format!("import-{}", cache.id));
    let _ = std::fs::remove_dir_all(&staging_dir);
    util::ensure_dir(&staging_dir)?;

    let mut success = 0i64;
    let mut skipped = 0i64;
    let mut failed = 0i64;
    let mut duplicate_paths: Vec<String> = Vec::new();
    let mut conflicts: Vec<String> = Vec::new();
    let mut errors: Vec<JobItemError> = Vec::new();
    let mut done = 0i64;
    let mut commit_seq = 0i64;
    let mut last_event = Instant::now() - COMMIT_EVENT_INTERVAL;
    let mut index = 0usize;
    let mut first_batch = true;

    while index < entries.len() {
        // 首批较小，尽快让图库出现第一张卡片；后续按固定批量提交。
        let batch_target = if first_batch { FIRST_BATCH } else { BATCH_MAX };
        first_batch = false;
        let end = (index + batch_target).min(entries.len());
        let chunk = &entries[index..end];
        let cursor = std::sync::atomic::AtomicUsize::new(0);
        let outcomes: StdMutex<Vec<(usize, PrepareOutcome)>> =
            StdMutex::new(Vec::with_capacity(chunk.len()));
        std::thread::scope(|scope| {
            for _ in 0..parallelism.min(chunk.len()) {
                scope.spawn(|| loop {
                    let offset = cursor.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if offset >= chunk.len() {
                        break;
                    }
                    let entry = chunk[offset];
                    let outcome = prepare_one(
                        &project,
                        &ctx.app,
                        entry,
                        &options,
                        &default_mode,
                        &plan,
                        &plan_json,
                        index + offset,
                        &seen,
                        &verified,
                        &root_ids,
                        &staging_dir,
                    );
                    outcomes
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push((offset, outcome));
                });
            }
        });
        let mut results = outcomes
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        results.sort_by_key(|(offset, _)| *offset);
        let mut ready: Vec<PreparedAsset> = Vec::with_capacity(results.len());
        for (_, outcome) in results {
            match outcome {
                PrepareOutcome::Ready(prepared) => ready.push(prepared),
                PrepareOutcome::Skipped { duplicate } => {
                    skipped += 1;
                    if let Some(duplicate) = duplicate {
                        duplicate_paths.push(duplicate);
                    }
                }
                PrepareOutcome::Failed { error, rel_path, path } => {
                    failed += 1;
                    if errors.len() < 200 {
                        errors.push(JobItemError {
                            item_id: rel_path,
                            path,
                            message: error.message,
                            code: error.code,
                        });
                    }
                }
            }
        }

        // 单一写入端把本批候选放入一个短事务，按扫描顺序追加。
        let commit = commit_prepared(&project, &options, &plan_json, ready, &seen)?;
        success += commit.committed as i64;
        skipped += commit.skipped as i64;
        duplicate_paths.extend(commit.duplicates);
        conflicts.extend(commit.conflicts);
        for failure in commit.failures {
            failed += 1;
            if errors.len() < 200 {
                errors.push(JobItemError {
                    item_id: failure.prepared.rel_path.clone(),
                    path: failure.prepared.path.clone(),
                    message: failure.error.message,
                    code: failure.error.code,
                });
            }
        }
        done += (end - index) as i64;
        commit_seq += 1;
        let is_last = end >= entries.len();
        if success > 0 && (commit_seq == 1 || is_last || last_event.elapsed() >= COMMIT_EVENT_INTERVAL) {
            // 只进入图库的增量刷新渠道；项目总计与集合仍由任务终态刷新。
            let _ = ctx.app.emit(
                "assets:import-committed",
                serde_json::json!({
                    "projectId": project.id,
                    "jobId": ctx.job_id,
                    "commitSeq": commit_seq,
                    "committed": success,
                    "total": total,
                }),
            );
            last_event = Instant::now();
        }

        if let JobRun::Cancelled = ctx.checkpoint(done, failed, total, "导入图片", false)? {
            let _ = std::fs::remove_dir_all(&staging_dir);
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

    let _ = std::fs::remove_dir_all(&staging_dir);
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

enum PrepareOutcome {
    Ready(PreparedAsset),
    Skipped {
        duplicate: Option<String>,
    },
    Failed {
        error: AppError,
        rel_path: String,
        path: String,
    },
}

/// 并行准备阶段的完整待提交记录；数据库写入延后到单写入端的分批事务。
struct PreparedAsset {
    path: String,
    rel_path: String,
    asset_id: String,
    transform_revision_id: String,
    caption_revision_id: String,
    content_hash: String,
    source_root_id: String,
    name: String,
    ext: String,
    format: String,
    bytes: i64,
    source_size: i64,
    source_mtime: String,
    caption_mode: String,
    claim_hash: Option<String>,
    created_object: bool,
    plan_hash: String,
    analysis_json: String,
    tags_json: String,
    caption_text: String,
    search_text: String,
    imported_at: String,
    analysis: crate::worker::AnalyzeInfo,
    geometry: crate::model::Geometry,
    conflicts: Vec<String>,
}

/// 同一批导入内的哈希占位；准备失败时自动释放，成功写入后保留。
struct ClaimGuard<'a> {
    seen: &'a StdMutex<HashSet<String>>,
    hash: String,
    keep: bool,
}

impl ClaimGuard<'_> {
    fn keep(mut self) {
        self.keep = true;
    }
}

impl Drop for ClaimGuard<'_> {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        if let Ok(mut set) = self.seen.lock() {
            set.remove(&self.hash);
        }
    }
}

/// 任务暂存文件；未发布或未显式保留时在离开作用域时删除。
struct StagedFile {
    path: Option<PathBuf>,
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 本张图片的缩略图目录；准备或写入失败时清理。
struct ThumbGuard {
    dir: PathBuf,
    keep: bool,
}

impl Drop for ThumbGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_one(
    project: &Project,
    app: &AppHandle,
    entry: &ScanEntryInternal,
    options: &ScanRequest,
    default_mode: &str,
    plan: &crate::model::TransformPlan,
    plan_json: &str,
    entry_index: usize,
    seen: &StdMutex<HashSet<String>>,
    verified: &StdMutex<HashSet<String>>,
    root_ids: &HashMap<String, String>,
    staging_dir: &Path,
) -> PrepareOutcome {
    match prepare_one_inner(
        project,
        app,
        entry,
        options,
        default_mode,
        plan,
        plan_json,
        entry_index,
        seen,
        verified,
        root_ids,
        staging_dir,
    ) {
        Ok(outcome) => outcome,
        Err(error) => PrepareOutcome::Failed {
            error,
            rel_path: entry.rel_path.clone(),
            path: entry.path.clone(),
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_one_inner(
    project: &Project,
    app: &AppHandle,
    entry: &ScanEntryInternal,
    options: &ScanRequest,
    default_mode: &str,
    plan: &crate::model::TransformPlan,
    plan_json: &str,
    entry_index: usize,
    seen: &StdMutex<HashSet<String>>,
    verified: &StdMutex<HashSet<String>>,
    root_ids: &HashMap<String, String>,
    staging_dir: &Path,
) -> AppResult<PrepareOutcome> {
    let source_path = PathBuf::from(&entry.path);
    let metadata_before = std::fs::metadata(&source_path)
        .map_err(|e| AppError::new("SOURCE_MISSING", format!("源文件不可读取：{e}")))?;
    let size_before = metadata_before.len();
    let mtime_before = mtime_ms(&metadata_before);

    let source_root_id = {
        let conn = project.conn();
        let root_id = root_ids
            .get(&entry.root)
            .cloned()
            .ok_or_else(|| AppError::new("SOURCE_ROOT", "扫描根目录未登记，请重新扫描后再导入"))?;
        // 已导入过同一来源路径则跳过，不再读取与解码图片。
        if db::find_asset_by_source(&conn, &root_id, &entry.rel_path)?.is_some() {
            return Ok(PrepareOutcome::Skipped { duplicate: None });
        }
        root_id
    };

    // 复制模式：一次读取同时写入任务暂存文件并计算 SHA-256，
    // 分析直接读取这份暂存字节，发布后即为受管理原件。
    let copy_mode = options.mode == "copy";
    let mut staged = StagedFile { path: None };
    let (hash, bytes) = if copy_mode {
        let stage_path = staging_dir.join(format!("{entry_index}.{}", entry.ext));
        let (hash, bytes) = util::copy_atomic_hash(&source_path, &stage_path)
            .map_err(|e| AppError::io("复制源文件失败", e))?;
        staged.path = Some(stage_path);
        let metadata_after = std::fs::metadata(&source_path)
            .map_err(|e| AppError::new("SOURCE_CHANGED", format!("复制过程中源文件消失：{e}")))?;
        if metadata_after.len() != size_before
            || mtime_ms(&metadata_after) != mtime_before
            || bytes != size_before
        {
            return Err(AppError::new(
                "SOURCE_CHANGED",
                "复制过程中源文件发生变化，请重试",
            ));
        }
        (hash, bytes)
    } else {
        let (hash, bytes) = util::sha256_file(&source_path)
            .map_err(|e| AppError::io("读取源文件失败", e))?;
        let metadata_after = std::fs::metadata(&source_path)
            .map_err(|e| AppError::new("SOURCE_CHANGED", format!("读取过程中源文件消失：{e}")))?;
        if metadata_after.len() != size_before
            || mtime_ms(&metadata_after) != mtime_before
            || bytes != size_before
        {
            return Err(AppError::new(
                "SOURCE_CHANGED",
                "读取过程中源文件发生变化，请重试",
            ));
        }
        (hash, bytes)
    };

    if options.duplicate_policy != "keep" {
        let duplicate = {
            let conn = project.conn();
            db::find_asset_by_hash(&conn, &hash)?.map(|asset| asset.original_name)
        };
        if let Some(name) = duplicate {
            return Ok(PrepareOutcome::Skipped {
                duplicate: Some(format!("{}（与 {} 内容相同）", entry.rel_path, name)),
            });
        }
    }

    // 先占位再分析：完全相同的图片在并行批次中只解码一次。
    let claim = if options.duplicate_policy != "keep" {
        let inserted = seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(hash.clone());
        if !inserted {
            return Ok(PrepareOutcome::Skipped {
                duplicate: Some(format!(
                    "{}（与本次导入中的另一张内容相同）",
                    entry.rel_path
                )),
            });
        }
        Some(ClaimGuard {
            seen,
            hash: hash.clone(),
            keep: false,
        })
    } else {
        None
    };

    let asset_id = util::new_id();
    let transform_revision_id = util::new_id();
    let caption_revision_id = util::new_id();
    let thumb_version = format!("{}-{}", &hash[..10], transform_revision_id);
    let display_version = format!("src-{}", &hash[..10]);
    // 分析时同步生成 256 px 原图缩略图，复用同一次解码；图库首屏不再逐张等待。
    let source_thumb_path = project
        .thumb_path(&asset_id, &format!("low-source-{display_version}"));
    let processed_thumb_path = project.thumb_path(&asset_id, &format!("low-{thumb_version}"));
    let thumb_guard = ThumbGuard {
        dir: project.thumbs_dir().join(&asset_id),
        keep: false,
    };

    let analysis_path = staged.path.as_deref().unwrap_or(&source_path);
    let analysis = {
        let state = app.state::<crate::state::AppState>();
        state.worker.analyze(analysis_path, Some((&source_thumb_path, 256)))?
    };
    if analysis.frames > 1 {
        return Err(AppError::new("UNSUPPORTED_FORMAT", "多帧图片不支持导入"));
    }
    if (analysis.width as u64) * (analysis.height as u64) > MAX_PIXELS {
        return Err(AppError::new("TOO_LARGE", "图片像素超过 80 MP 上限"));
    }
    if !copy_mode {
        // 引用模式直接依赖源文件，分析前后核对来源状态。
        let metadata_after = std::fs::metadata(&source_path)
            .map_err(|e| AppError::new("SOURCE_CHANGED", format!("分析过程中源文件消失：{e}")))?;
        if metadata_after.len() != size_before || mtime_ms(&metadata_after) != mtime_before {
            return Err(AppError::new(
                "SOURCE_CHANGED",
                "分析过程中源文件发生变化，请重试",
            ));
        }
    }
    let simple_plan = plan.rotation == 0
        && !plan.flip_h
        && !plan.flip_v
        && plan.scale_mode == "preserve"
        && (plan.color.brightness - 1.0).abs() < 1e-6
        && (plan.color.contrast - 1.0).abs() < 1e-6
        && (plan.color.saturation - 1.0).abs() < 1e-6;
    if simple_plan && source_thumb_path.exists() {
        if let Some(parent) = processed_thumb_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::copy(&source_thumb_path, &processed_thumb_path);
    }

    // 分析成功后把暂存内容不覆盖地发布为 originals/<hash>.<ext>。
    let created_object = if copy_mode {
        publish_managed(project, &hash, &entry.ext, &mut staged, verified)?
    } else {
        false
    };

    let geometry = transform::compute_geometry(plan, analysis.width, analysis.height);
    let tags = crate::caption::normalize_tags(crate::caption::split_caption_text(
        entry.sidecar_text.as_deref().unwrap_or(""),
    ));
    let text = entry.sidecar_text.clone().unwrap_or_default().trim_end().to_string();
    let search = crate::caption::search_text(default_mode, &tags, &text);
    let plan_hash = util::sha256_text(&format!("{hash}:{plan_json}"));
    let analysis_json = serde_json::json!({
        "icc": analysis.icc,
        "iccDescription": analysis.icc_description,
        "frames": analysis.frames,
        "mode": analysis.mode,
        "orientation": analysis.orientation,
        "rawWidth": analysis.raw_width,
        "rawHeight": analysis.raw_height,
        "exposure": analysis.exposure,
        "contrast": analysis.contrast,
        "saturation": analysis.saturation,
        "colorfulness": analysis.colorfulness,
    });
    let mut conflicts = Vec::new();
    if !entry.sidecar_conflicts.is_empty() {
        conflicts.push(format!(
            "{}：同一文件名存在多个标注候选（{}）",
            entry.rel_path,
            entry.sidecar_conflicts.join("；")
        ));
    }

    let claim_hash = claim.as_ref().map(|_| hash.clone());
    if let Some(claim) = claim {
        claim.keep();
    }
    let mut thumb_guard = thumb_guard;
    thumb_guard.keep = true;
    let bytes_final = bytes as i64;
    Ok(PrepareOutcome::Ready(PreparedAsset {
        path: entry.path.clone(),
        rel_path: entry.rel_path.clone(),
        asset_id,
        transform_revision_id,
        caption_revision_id,
        content_hash: hash,
        source_root_id,
        name: entry.name.clone(),
        ext: entry.ext.clone(),
        format: entry.format.clone(),
        bytes: bytes_final,
        source_size: size_before as i64,
        source_mtime: mtime_before,
        caption_mode: default_mode.to_string(),
        claim_hash,
        created_object,
        plan_hash,
        analysis_json: serde_json::to_string(&analysis_json)?,
        tags_json: serde_json::to_string(&tags)?,
        caption_text: text,
        search_text: search,
        imported_at: util::now_iso(),
        analysis,
        geometry,
        conflicts,
    }))
}

/// 把暂存文件不覆盖地发布为受管理原件；已有同名对象时按哈希确认可复用。
fn publish_managed(
    project: &Project,
    hash: &str,
    ext: &str,
    staged: &mut StagedFile,
    verified: &StdMutex<HashSet<String>>,
) -> AppResult<bool> {
    let managed = project.originals_dir().join(format!("{hash}.{ext}"));
    if managed.exists() {
        verify_managed(&managed, hash, verified)?;
        return Ok(false);
    }
    let Some(staged_path) = staged.path.take() else {
        return Ok(false);
    };
    util::ensure_dir(&project.originals_dir())?;
    match std::fs::rename(&staged_path, &managed) {
        Ok(()) => {
            if let Ok(mut set) = verified.lock() {
                set.insert(managed.to_string_lossy().to_string());
            }
            Ok(true)
        }
        Err(_) => {
            // 并行任务可能刚完成同名对象；此时复用并删除本次暂存。
            if managed.exists() {
                let _ = std::fs::remove_file(&staged_path);
                verify_managed(&managed, hash, verified)?;
                return Ok(false);
            }
            // 跨卷或目标目录不可重命名时回退为复制并校验。
            let copied = util::copy_atomic_hash(&staged_path, &managed);
            let _ = std::fs::remove_file(&staged_path);
            let (copied_hash, _) = copied?;
            if copied_hash != hash {
                let _ = std::fs::remove_file(&managed);
                return Err(AppError::new(
                    "COPY_VERIFY_FAILED",
                    "复制后的文件校验失败，已清理临时原件",
                ));
            }
            if let Ok(mut set) = verified.lock() {
                set.insert(managed.to_string_lossy().to_string());
            }
            Ok(true)
        }
    }
}

fn verify_managed(
    path: &Path,
    hash: &str,
    verified: &StdMutex<HashSet<String>>,
) -> AppResult<()> {
    let key = path.to_string_lossy().to_string();
    if verified
        .lock()
        .map(|set| set.contains(&key))
        .unwrap_or(false)
    {
        return Ok(());
    }
    let (existing_hash, _) =
        util::sha256_file(path).map_err(|e| AppError::io("校验受管理原件失败", e))?;
    if existing_hash != hash {
        return Err(AppError::new(
            "CONTENT_CONFLICT",
            "项目原件缓存中的同名文件内容不一致",
        ));
    }
    if let Ok(mut set) = verified.lock() {
        set.insert(key);
    }
    Ok(())
}

enum RowOutcome {
    Inserted,
    Skipped(Option<String>),
}

struct CommitFailure {
    prepared: PreparedAsset,
    error: AppError,
}

#[derive(Default)]
struct CommitOutcome {
    committed: usize,
    skipped: usize,
    duplicates: Vec<String>,
    conflicts: Vec<String>,
    failures: Vec<CommitFailure>,
}

/// 单一写入端：把一批已准备的记录放入一个短事务，按扫描顺序追加。
fn commit_prepared(
    project: &Project,
    options: &ScanRequest,
    plan_json: &str,
    items: Vec<PreparedAsset>,
    seen: &StdMutex<HashSet<String>>,
) -> AppResult<CommitOutcome> {
    let mut outcome = CommitOutcome::default();
    if items.is_empty() {
        return Ok(outcome);
    }
    let mut conn = project.conn();
    let mut tx = conn.transaction()?;
    let base: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sort_index), 0) FROM assets",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let mut rows: Vec<AppResult<RowOutcome>> = Vec::with_capacity(items.len());
    for (position, prepared) in items.iter().enumerate() {
        rows.push(insert_prepared(
            &mut tx,
            options,
            plan_json,
            prepared,
            base + 1 + position as i64,
        ));
    }
    let commit_error = tx.commit().err().map(|error| error.to_string());
    drop(conn);

    for (prepared, row) in items.into_iter().zip(rows) {
        match (commit_error.as_deref(), row) {
            (None, Ok(RowOutcome::Inserted)) => {
                outcome.committed += 1;
                outcome.conflicts.extend(prepared.conflicts.iter().cloned());
            }
            (None, Ok(RowOutcome::Skipped(duplicate))) => {
                release_claim(seen, &prepared);
                cleanup_prepared(project, &prepared);
                outcome.skipped += 1;
                if let Some(duplicate) = duplicate {
                    outcome.duplicates.push(duplicate);
                }
            }
            (None, Err(error)) => {
                release_claim(seen, &prepared);
                cleanup_prepared(project, &prepared);
                outcome.failures.push(CommitFailure { prepared, error });
            }
            (Some(message), _) => {
                release_claim(seen, &prepared);
                cleanup_prepared(project, &prepared);
                outcome.failures.push(CommitFailure {
                    prepared,
                    error: AppError::new(
                        "IMPORT_COMMIT_FAILED",
                        format!("提交导入批次失败：{message}"),
                    ),
                });
            }
        }
    }
    Ok(outcome)
}

fn insert_prepared(
    tx: &mut rusqlite::Transaction<'_>,
    options: &ScanRequest,
    plan_json: &str,
    prepared: &PreparedAsset,
    sort_index: i64,
) -> AppResult<RowOutcome> {
    // 锁内做最终复核：并发导入可能已写入同一来源路径或相同内容。
    if db::find_asset_by_source(tx, &prepared.source_root_id, &prepared.rel_path)?.is_some() {
        return Ok(RowOutcome::Skipped(None));
    }
    if options.duplicate_policy != "keep" {
        if let Some(existing) = db::find_asset_by_hash(tx, &prepared.content_hash)? {
            return Ok(RowOutcome::Skipped(Some(format!(
                "{}（与 {} 内容相同）",
                prepared.rel_path, existing.original_name
            ))));
        }
    }
    let savepoint = tx.savepoint()?;
    insert_rows(&savepoint, options, plan_json, prepared, sort_index)?;
    savepoint.commit()?;
    Ok(RowOutcome::Inserted)
}

fn insert_rows(
    conn: &rusqlite::Connection,
    options: &ScanRequest,
    plan_json: &str,
    item: &PreparedAsset,
    sort_index: i64,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO assets(id, content_hash, source_root_id, rel_path, original_name, ext, format, bytes,
            orig_width, orig_height, norm_width, norm_height, out_width, out_height, has_alpha, phash,
            blur_score, dark_ratio, bright_ratio, analysis_json, review_status, favorite, imported_at,
            sort_index, revision, transform_revision_id, caption_revision_id, missing, source_size,
            source_mtime, thumb_version, crop_ratio, pad_ratio, scale_ratio)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
            ?19, ?20, 'pending', 0, ?21, ?22, 1, ?23, ?24, 0, ?25, ?26, ?27, 0, 0, ?28)",
        params![
            item.asset_id,
            item.content_hash,
            item.source_root_id,
            item.rel_path,
            item.name,
            item.ext,
            item.format,
            item.bytes,
            item.analysis.raw_width,
            item.analysis.raw_height,
            item.analysis.width,
            item.analysis.height,
            item.geometry.out_width,
            item.geometry.out_height,
            if item.analysis.has_alpha { 1 } else { 0 },
            item.analysis.phash,
            item.analysis.blur,
            item.analysis.dark_ratio,
            item.analysis.bright_ratio,
            item.analysis_json,
            item.imported_at,
            sort_index,
            item.transform_revision_id,
            item.caption_revision_id,
            item.source_size,
            item.source_mtime,
            format!(
                "{}-{}",
                &item.content_hash[..item.content_hash.len().min(10)],
                item.transform_revision_id
            ),
            item.geometry.scale_ratio
        ],
    )?;
    conn.execute(
        "INSERT INTO transform_revisions(id, asset_id, revision_no, kind, plan_json, plan_hash, source_hash,
            out_width, out_height, crop_ratio, pad_ratio, scale_ratio, created_at)
         VALUES(?1, ?2, 1, 'applied', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            item.transform_revision_id,
            item.asset_id,
            plan_json,
            item.plan_hash,
            item.content_hash,
            item.geometry.out_width,
            item.geometry.out_height,
            item.geometry.crop_ratio,
            item.geometry.pad_ratio,
            item.geometry.scale_ratio,
            item.imported_at
        ],
    )?;
    conn.execute(
        "INSERT INTO caption_revisions(id, asset_id, revision_no, mode, tags_json, text, source, status,
            search_text, created_at)
         VALUES(?1, ?2, 1, ?3, ?4, ?5, 'import', 'active', ?6, ?7)",
        params![
            item.caption_revision_id,
            item.asset_id,
            item.caption_mode,
            item.tags_json,
            item.caption_text,
            item.search_text,
            item.imported_at
        ],
    )?;
    if let Some(collection_id) = options
        .collection_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        conn.execute(
            "INSERT OR IGNORE INTO collection_assets(collection_id, asset_id) VALUES(?1, ?2)",
            params![collection_id, item.asset_id],
        )?;
    }
    Ok(())
}

fn release_claim(seen: &StdMutex<HashSet<String>>, prepared: &PreparedAsset) {
    if let Some(hash) = &prepared.claim_hash {
        if let Ok(mut set) = seen.lock() {
            set.remove(hash);
        }
    }
}

fn cleanup_prepared(project: &Project, prepared: &PreparedAsset) {
    let _ = std::fs::remove_dir_all(project.thumbs_dir().join(&prepared.asset_id));
    if !prepared.created_object {
        return;
    }
    let managed = project
        .originals_dir()
        .join(format!("{}.{}", prepared.content_hash, prepared.ext));
    if !managed.exists() {
        return;
    }
    let referenced = project
        .conn()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE content_hash = ?1)",
            params![prepared.content_hash],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .unwrap_or(true);
    if !referenced {
        let _ = std::fs::remove_file(&managed);
    }
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

#[cfg(test)]
mod commit_tests {
    use super::*;
    use crate::model::Geometry;
    use crate::project::CreateProjectRequest;
    use crate::worker::AnalyzeInfo;

    fn analysis() -> AnalyzeInfo {
        AnalyzeInfo {
            width: 100,
            height: 80,
            raw_width: 100,
            raw_height: 80,
            format: "JPEG".into(),
            mode: "RGB".into(),
            frames: 1,
            has_alpha: false,
            icc: false,
            icc_description: None,
            orientation: 1,
            phash: "0000000000000000".into(),
            blur: 1.0,
            dark_ratio: 0.0,
            bright_ratio: 0.0,
            exposure: 0.5,
            contrast: 0.2,
            saturation: 0.1,
            colorfulness: 0.3,
        }
    }

    fn prepared(root_id: &str, hash: &str, rel: &str) -> PreparedAsset {
        PreparedAsset {
            path: format!("C:/source/{rel}"),
            rel_path: rel.into(),
            asset_id: util::new_id(),
            transform_revision_id: util::new_id(),
            caption_revision_id: util::new_id(),
            content_hash: hash.into(),
            source_root_id: root_id.into(),
            name: rel.into(),
            ext: "jpg".into(),
            format: "JPEG".into(),
            bytes: 1024,
            source_size: 1024,
            source_mtime: "1".into(),
            caption_mode: "tags".into(),
            claim_hash: None,
            created_object: false,
            plan_hash: util::sha256_text("plan"),
            analysis_json: "{}".into(),
            tags_json: "[]".into(),
            caption_text: String::new(),
            search_text: String::new(),
            imported_at: util::now_iso(),
            analysis: analysis(),
            geometry: Geometry {
                out_width: 100,
                out_height: 80,
                crop_width: 100,
                crop_height: 80,
                scaled_width: 100,
                scaled_height: 80,
                crop_ratio: 0.0,
                pad_ratio: 0.0,
                scale_ratio: 1.0,
                blocked: false,
                blocked_reason: None,
            },
            conflicts: vec![],
        }
    }

    #[test]
    fn commit_prepared_writes_batch_and_dedupes_in_transaction() {
        let parent = std::env::temp_dir().join(format!("yk-import-test-{}", util::short_id(8)));
        std::fs::create_dir_all(&parent).unwrap();
        let project = crate::project::create_project(&CreateProjectRequest {
            name: format!("import-test-{}", util::short_id(6)),
            parent_dir: parent.to_string_lossy().to_string(),
            model: "sdxl".into(),
            template: "character".into(),
            trigger_word: String::new(),
            default_caption_mode: "tags".into(),
        })
        .unwrap();
        let root_id = util::new_id();
        let collection_id = util::new_id();
        {
            let conn = project.conn();
            conn.execute(
                "INSERT INTO source_roots(id, path, mode, created_at) VALUES(?1, ?2, 'copy', ?3)",
                params![root_id, "C:/source", util::now_iso()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO collections(id, name, kind, query_json, created_at) VALUES(?1, ?2, 'manual', '{}', ?3)",
                params![collection_id, "测试分组", util::now_iso()],
            )
            .unwrap();
        }
        let options = ScanRequest {
            collection_id: Some(collection_id.clone()),
            ..Default::default()
        };
        let seen = StdMutex::new(HashSet::new());
        // 同一批内：不同路径同内容、以及同一来源路径都应被锁内复核拦下。
        let items = vec![
            prepared(&root_id, "hash-a", "a.jpg"),
            prepared(&root_id, "hash-a", "b.jpg"),
            prepared(&root_id, "hash-a", "a.jpg"),
        ];
        let outcome = commit_prepared(&project, &options, "{}", items, &seen).unwrap();
        assert_eq!(outcome.committed, 1);
        assert_eq!(outcome.skipped, 2);
        assert!(outcome.failures.is_empty());
        {
            let conn = project.conn();
            let assets: i64 = conn
                .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
                .unwrap();
            let members: i64 = conn
                .query_row("SELECT COUNT(*) FROM collection_assets", [], |row| row.get(0))
                .unwrap();
            let revisions: i64 = conn
                .query_row("SELECT COUNT(*) FROM transform_revisions", [], |row| row.get(0))
                .unwrap();
            let captions: i64 = conn
                .query_row("SELECT COUNT(*) FROM caption_revisions", [], |row| row.get(0))
                .unwrap();
            assert_eq!((assets, members, revisions, captions), (1, 1, 1, 1));
        }
        drop(project);
        let _ = std::fs::remove_dir_all(&parent);
    }
}
