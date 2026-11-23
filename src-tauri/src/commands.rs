use crate::backup;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::exports;
use crate::model::*;
use crate::project::{self, assets, captions, collections, history, import, jobs, prompt_library, quality, sample, transform, Project};
use crate::state::{self, AppState};
use crate::tagging;
use crate::util;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tauri::State;

// ---------------------------------------------------------------------------
// 应用与对话框
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> AppResult<AppInfo> {
    let open = state.project.read().is_some();
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: state.data_dir.to_string_lossy().to_string(),
        worker_ready: state.worker.last_error().is_none(),
        worker_python: state.python.clone(),
        worker_script: state.worker_script.to_string_lossy().to_string(),
        worker_log: state.worker_log.to_string_lossy().to_string(),
        worker_error: state.worker.last_error(),
        project_open: open,
    })
}

#[tauri::command]
pub async fn worker_ping(state: State<'_, AppState>) -> AppResult<WorkerPing> {
    let info = state.worker.ping()?;
    Ok(WorkerPing {
        python: info.python,
        pillow: info.pillow,
        platform: info.platform,
    })
}

#[tauri::command]
pub async fn worker_logs(state: State<'_, AppState>) -> AppResult<()> {
    util::open_path_in_explorer(&state.data_dir.join("logs"))
}

#[tauri::command]
pub async fn app_settings_get(state: State<'_, AppState>) -> AppResult<AppSettings> {
    Ok(state.settings())
}

#[tauri::command]
pub async fn app_settings_set(state: State<'_, AppState>, settings: AppSettings) -> AppResult<AppSettings> {
    let mut normalized = settings;
    normalized.grid_card_min = normalized.grid_card_min.clamp(112, 168);
    normalized.inspector_width = normalized.inspector_width.clamp(280, 420);
    normalized.image_slots = normalized.image_slots.clamp(1, 8);
    state.save_settings(&normalized)?;
    Ok(normalized)
}

#[tauri::command]
pub async fn recent_projects(state: State<'_, AppState>) -> AppResult<Vec<RecentProject>> {
    state.mark_recent_missing()?;
    Ok(state::recent_list(&state))
}

#[tauri::command]
pub async fn recent_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.remove_recent(&id)
}

#[tauri::command]
pub async fn recent_pin(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.toggle_recent_pin(&id)
}

async fn pick_folder(title: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(&title)
            .pick_folder()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn dialog_pick_folder(title: Option<String>) -> AppResult<Option<String>> {
    Ok(pick_folder(title.unwrap_or_else(|| "选择文件夹".into())).await)
}

#[tauri::command]
pub async fn dialog_pick_images(title: Option<String>) -> AppResult<Vec<String>> {
    let title = title.unwrap_or_else(|| "选择图片".into());
    let paths = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(&title)
            .add_filter("图片", &["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"])
            .pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| AppError::new("DIALOG_ERROR", format!("打开文件选择器失败：{e}")))?;
    Ok(paths)
}

#[tauri::command]
pub async fn dialog_pick_zip(title: Option<String>) -> AppResult<Option<String>> {
    let title = title.unwrap_or_else(|| "选择备份文件".into());
    let path = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(&title)
            .add_filter("Yoyoku 备份", &["zip"])
            .pick_file()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten();
    Ok(path)
}

#[tauri::command]
pub async fn dialog_save_zip(default_name: Option<String>) -> AppResult<Option<String>> {
    let name = default_name.unwrap_or_else(|| "yoyoku-backup.zip".into());
    let path = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("保存项目备份")
            .add_filter("Yoyoku 备份", &["zip"])
            .set_file_name(&name)
            .save_file()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten();
    Ok(path)
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn project_create(state: State<'_, AppState>, req: project::CreateProjectRequest) -> AppResult<ProjectInfo> {
    let created = project::create_project(&req)?;
    let project = Arc::new(created);
    let info = project::project_info(&project)?;
    state.set_project(Some(project.clone()));
    {
        let mut recent = state.recent.write();
        state::upsert_recent(&mut recent, &info, &project.root);
        state::save_recent(&state.data_dir, &recent)?;
    }
    Ok(info)
}

#[tauri::command]
pub async fn project_create_sample(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ProjectInfo> {
    let (_project, info) = sample::create_sample_project(&app, &state)?;
    Ok(info)
}

#[tauri::command]
pub async fn project_open(state: State<'_, AppState>, path: String) -> AppResult<ProjectInfo> {
    let project = state.open_project_path(Path::new(&util::expand_user_home(&path)))?;
    jobs::mark_interrupted(&project)?;
    project::project_info(&project)
}

#[tauri::command]
pub async fn project_open_recent(state: State<'_, AppState>, id: String) -> AppResult<ProjectInfo> {
    let path = state
        .recent
        .read()
        .projects
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.path.clone())
        .ok_or_else(|| AppError::not_found("最近项目"))?;
    if !Path::new(&path).join(project::PROJECT_FILE).exists() {
        return Err(AppError::new(
            "PROJECT_MISSING",
            "项目文件夹已被移动或删除，请重新定位。",
        ));
    }
    let project = state.open_project_path(Path::new(&path))?;
    jobs::mark_interrupted(&project)?;
    project::project_info(&project)
}

#[tauri::command]
pub async fn project_relocate(state: State<'_, AppState>, id: String, path: String) -> AppResult<ProjectInfo> {
    let project = project::open_project(Path::new(&util::expand_user_home(&path)))?;
    if project.id != id {
        return Err(AppError::new(
            "PROJECT_MISMATCH",
            "所选文件夹不是目标项目。请选择包含 project.json 的项目根目录。",
        ));
    }
    let arc = Arc::new(project);
    let info = project::project_info(&arc)?;
    state.set_project(Some(arc.clone()));
    {
        let mut recent = state.recent.write();
        state::upsert_recent(&mut recent, &info, &arc.root);
        state::save_recent(&state.data_dir, &recent)?;
    }
    jobs::mark_interrupted(&arc)?;
    Ok(info)
}

#[tauri::command]
pub async fn project_close(state: State<'_, AppState>) -> AppResult<()> {
    state.set_project(None);
    Ok(())
}

#[tauri::command]
pub async fn project_get(state: State<'_, AppState>) -> AppResult<ProjectInfo> {
    let project = state.project()?;
    project::project_info(&project)
}

#[tauri::command]
pub async fn project_update(
    state: State<'_, AppState>,
    req: project::ProjectUpdate,
) -> AppResult<ProjectInfo> {
    let project = state.project()?;
    project::update_project(&project, &req)
}

#[tauri::command]
pub async fn reveal_path(path: String) -> AppResult<()> {
    let path = PathBuf::from(util::expand_user_home(&path));
    if !path.exists() {
        return Err(AppError::new("PATH_MISSING", "文件夹不存在，可能已被移动或删除。"));
    }
    util::open_path_in_explorer(&path)
}

#[tauri::command]
pub async fn project_reveal(state: State<'_, AppState>) -> AppResult<()> {
    let project = state.project()?;
    util::open_path_in_explorer(&project.root)
}

#[tauri::command]
pub async fn project_backup(
    state: State<'_, AppState>,
    req: backup::BackupRequest,
) -> AppResult<backup::BackupResult> {
    let project = state.project()?;
    backup::backup(&project, &req)
}

#[tauri::command]
pub async fn project_restore(
    state: State<'_, AppState>,
    zip_path: String,
    target_parent: String,
) -> AppResult<backup::RestoreResult> {
    backup::restore(&state, &zip_path, &target_parent)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkRootRequest {
    pub old_root: String,
    pub new_root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkResult {
    pub relinked: i64,
    pub missing: Vec<String>,
}

#[tauri::command]
pub async fn asset_relink_root(
    state: State<'_, AppState>,
    req: RelinkRootRequest,
) -> AppResult<RelinkResult> {
    let project = state.project()?;
    let new_root = PathBuf::from(util::expand_user_home(&req.new_root))
        .canonicalize()
        .map_err(|e| AppError::new("SOURCE_MISSING", format!("新目录不可访问：{e}")))?;
    let mut conn = project.conn();
    let root: Option<(String, String)> = conn
        .query_row(
            "SELECT id, mode FROM source_roots WHERE path = ?1",
            rusqlite::params![req.old_root],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let Some((root_id, mode)) = root else {
        return Err(AppError::not_found("来源目录"));
    };
    if mode != "ref" {
        return Err(AppError::new(
            "NOT_REFERENCE",
            "受管理原件不通过来源目录重新定位；请从备份恢复。",
        ));
    }
    let assets: Vec<(String, String, String)> = {
        let mut statement = conn.prepare(
            "SELECT id, original_name, rel_path FROM assets WHERE source_root_id = ?1",
        )?;
        let rows = statement.query_map(rusqlite::params![root_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let now = util::now_iso();
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE source_roots SET path = ?1 WHERE id = ?2",
        rusqlite::params![new_root.to_string_lossy(), root_id],
    )?;
    let mut relinked = 0i64;
    let mut missing = Vec::new();
    for (id, name, rel_path) in assets {
        let path = new_root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if path.exists() {
            relinked += 1;
            let metadata = std::fs::metadata(&path).ok();
            tx.execute(
                "UPDATE assets SET missing = 0, source_size = ?1, revision = revision + 1 WHERE id = ?2",
                rusqlite::params![metadata.map(|m| m.len() as i64).unwrap_or(0), id],
            )?;
        } else {
            missing.push(name);
            tx.execute(
                "UPDATE assets SET missing = 1 WHERE id = ?1",
                rusqlite::params![id],
            )?;
        }
    }
    tx.execute(
        "UPDATE project SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, project.id],
    )?;
    tx.commit()?;
    db::mark_quality_stale(&conn)?;
    Ok(RelinkResult { relinked, missing })
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn import_scan(state: State<'_, AppState>, req: ScanRequest) -> AppResult<ScanPreview> {
    let project = state.project()?;
    let cache = import::scan(&project, &req)?;
    let preview = import::preview_of(&cache);
    let mut scans = state.scans.lock();
    scans.clear();
    scans.insert(cache.id.clone(), cache);
    Ok(preview)
}

#[tauri::command]
pub async fn import_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scan_id: String,
    collection_id: Option<String>,
) -> AppResult<ImportResult> {
    let project = state.project()?;
    let mut cache = state
        .scans
        .lock()
        .remove(&scan_id)
        .or_else(|| import::load_scan(&project, &scan_id).ok())
        .ok_or_else(|| AppError::new("SCAN_EXPIRED", "扫描结果已过期，请重新扫描"))?;
    cache.options.collection_id = collection_id.filter(|value| !value.trim().is_empty());
    let total = cache.entries.iter().filter(|e| e.status == "ok").count() as i64;
    let job_id = import::start_import(app, project, cache)?;
    Ok(ImportResult { job_id, total })
}

#[tauri::command]
pub async fn import_retry(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> AppResult<ImportResult> {
    let project = state.project()?;
    let job = jobs::get_job(&project, &job_id)?;
    let scan_id = job
        .input
        .get("scanId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::new("SCAN_EXPIRED", "任务没有可重试的扫描结果"))?;
    let cache = import::load_scan(&project, scan_id)?;
    let total = cache.entries.iter().filter(|e| e.status == "ok").count() as i64;
    let new_job = import::start_import(app, project, cache)?;
    Ok(ImportResult { job_id: new_job, total })
}

// ---------------------------------------------------------------------------
// 图库与资产
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsQueryRequest {
    pub filter: AssetFilter,
    pub sort: AssetSort,
    pub offset: i64,
    pub limit: i64,
}

#[tauri::command]
pub async fn assets_query(state: State<'_, AppState>, req: AssetsQueryRequest) -> AppResult<AssetsPage> {
    let project = state.project()?;
    assets::query(&project, &req.filter, &req.sort, req.offset, req.limit)
}

#[tauri::command]
pub async fn assets_ids(state: State<'_, AppState>, filter: AssetFilter) -> AppResult<Vec<String>> {
    let project = state.project()?;
    let conn = project.conn();
    assets::resolve_ids(&conn, &filter)
}

#[tauri::command]
pub async fn asset_get(state: State<'_, AppState>, id: String) -> AppResult<AssetDetail> {
    let project = state.project()?;
    assets::detail(&project, &id)
}

#[tauri::command]
pub async fn asset_update(
    state: State<'_, AppState>,
    id: String,
    patch: AssetPatch,
) -> AppResult<assets::AssetUpdateResult> {
    let project = state.project()?;
    assets::update(&project, &id, &patch)
}

#[tauri::command]
pub async fn asset_display(state: State<'_, AppState>, id: String) -> AppResult<String> {
    let project = state.project()?;
    let asset = {
        let conn = project.conn();
        db::get_asset(&conn, &id)?
    };
    transform::ensure_display(&project, &state.worker, &asset)
}

#[tauri::command]
pub async fn assets_summaries(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<AssetSummary>> {
    let project = state.project()?;
    assets::summaries(&project, &ids)
}

#[tauri::command]
pub async fn asset_reveal(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let project = state.project()?;
    let asset = {
        let conn = project.conn();
        db::get_asset(&conn, &id)?
    };
    let path = project.source_path(&asset)?;
    util::open_path_in_explorer(&path)
}

#[tauri::command]
pub async fn batch_preview(
    state: State<'_, AppState>,
    req: BatchRequest,
) -> AppResult<BatchPreview> {
    let project = state.project()?;
    let batch_id = util::new_id();
    let (preview, pending) = assets::batch_preview(&project, &req, &batch_id)?;
    let mut previews = state.batch_previews.lock();
    if previews.len() > 12 {
        previews.clear();
    }
    previews.insert(batch_id, pending);
    Ok(preview)
}

#[tauri::command]
pub async fn batch_apply(
    state: State<'_, AppState>,
    preview_id: String,
) -> AppResult<BatchResult> {
    let project = state.project()?;
    let pending = state
        .batch_previews
        .lock()
        .remove(&preview_id)
        .ok_or_else(|| AppError::new("PREVIEW_EXPIRED", "批量预览已过期，请重新预览"))?;
    assets::apply_batch(&project, pending)
}

#[tauri::command]
pub async fn undo(state: State<'_, AppState>) -> AppResult<Option<history::UndoOutcome>> {
    let project = state.project()?;
    history::undo_last(&project)
}

#[tauri::command]
pub async fn redo(state: State<'_, AppState>) -> AppResult<Option<history::UndoOutcome>> {
    let project = state.project()?;
    history::redo_last(&project)
}

#[tauri::command]
pub async fn history_recent(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<HistoryEntry>> {
    let project = state.project()?;
    history::recent_history(&project, limit.unwrap_or(30))
}

// ---------------------------------------------------------------------------
// 集合
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn collections_list(state: State<'_, AppState>) -> AppResult<Vec<CollectionInfo>> {
    let project = state.project()?;
    collections::list(&project)
}

#[tauri::command]
pub async fn collection_create(
    state: State<'_, AppState>,
    req: collections::CollectionCreate,
) -> AppResult<CollectionInfo> {
    let project = state.project()?;
    collections::create(&project, &req)
}

#[tauri::command]
pub async fn collection_update(
    state: State<'_, AppState>,
    req: collections::CollectionUpdate,
) -> AppResult<CollectionInfo> {
    let project = state.project()?;
    collections::update(&project, &req)
}

#[tauri::command]
pub async fn collection_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let project = state.project()?;
    collections::delete(&project, &id)
}

#[tauri::command]
pub async fn collection_ids(
    state: State<'_, AppState>,
    id: String,
    offset: Option<i64>,
    limit: Option<i64>,
) -> AppResult<Vec<String>> {
    let project = state.project()?;
    collections::ids(&project, &id, offset.unwrap_or(0), limit.unwrap_or(5000))
}

// ---------------------------------------------------------------------------
// 变换与标注
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformPreviewRequest {
    pub asset_id: String,
    pub plan: TransformPlan,
    #[serde(default)]
    pub max_side: Option<u32>,
}

#[tauri::command]
pub async fn transform_preview(
    state: State<'_, AppState>,
    req: TransformPreviewRequest,
) -> AppResult<transform::TransformPreview> {
    let project = state.project()?;
    transform::preview(
        &project,
        &state.worker,
        &req.asset_id,
        &req.plan,
        req.max_side.unwrap_or(1600),
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformSaveRequest {
    pub asset_id: String,
    pub plan: TransformPlan,
    pub expected_revision: i64,
}

#[tauri::command]
pub async fn transform_save(
    state: State<'_, AppState>,
    req: TransformSaveRequest,
) -> AppResult<transform::TransformSaveResult> {
    let project = state.project()?;
    transform::save(&project, &state.worker, &req.asset_id, &req.plan, req.expected_revision)
}

#[tauri::command]
pub async fn transform_draft_save(
    state: State<'_, AppState>,
    asset_id: String,
    plan: TransformPlan,
) -> AppResult<transform::DraftSaveResult> {
    let project = state.project()?;
    transform::save_draft(&project, &asset_id, &plan)
}

#[tauri::command]
pub async fn transform_draft_clear(state: State<'_, AppState>, asset_id: String) -> AppResult<()> {
    let project = state.project()?;
    transform::clear_draft(&project, &asset_id)
}

#[tauri::command]
pub async fn caption_save(
    state: State<'_, AppState>,
    req: captions::CaptionSaveRequest,
) -> AppResult<captions::CaptionSaveResult> {
    let project = state.project()?;
    captions::save(&project, &req)
}

#[tauri::command]
pub async fn caption_preview(
    state: State<'_, AppState>,
    req: captions::CaptionPreviewRequest,
) -> AppResult<captions::CaptionPreviewResult> {
    let project = state.project()?;
    captions::preview(&project, &req)
}

#[tauri::command]
pub async fn caption_convert_preview(
    state: State<'_, AppState>,
    asset_id: String,
    target_mode: String,
) -> AppResult<captions::ConvertPreview> {
    let project = state.project()?;
    captions::convert_preview(&project, &asset_id, &target_mode)
}

#[tauri::command]
pub async fn caption_tag_state_get(
    state: State<'_, AppState>,
    asset_id: String,
) -> AppResult<captions::TagState> {
    let project = state.project()?;
    captions::tag_state_get(&project, &asset_id)
}

#[tauri::command]
pub async fn caption_tag_state_set(
    state: State<'_, AppState>,
    asset_id: String,
    tag_state: captions::TagState,
) -> AppResult<()> {
    let project = state.project()?;
    captions::tag_state_set(&project, &asset_id, &tag_state)
}

#[tauri::command]
pub async fn caption_tag_totals(
    state: State<'_, AppState>,
    asset_ids: Vec<String>,
) -> AppResult<captions::TagTotalsResult> {
    let project = state.project()?;
    captions::tag_totals(&project, &asset_ids)
}

#[tauri::command]
pub async fn caption_tag_bulk(
    state: State<'_, AppState>,
    req: captions::TagBulkRequest,
) -> AppResult<captions::TagBulkResult> {
    let project = state.project()?;
    captions::tag_bulk(&project, &req)
}

#[tauri::command]
pub async fn caption_suggestions(
    state: State<'_, AppState>,
    asset_id: String,
) -> AppResult<Vec<captions::SuggestionInfo>> {
    let project = state.project()?;
    captions::list_suggestions(&project, &asset_id)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionRequest {
    pub asset_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub threshold: Option<f64>,
    #[serde(default)]
    pub character_threshold: Option<f64>,
}

#[tauri::command]
pub async fn suggestion_generate(
    state: State<'_, AppState>,
    req: SuggestionRequest,
) -> AppResult<SuggestionResult> {
    let project = state.project()?;
    tagging::generate(
        &state,
        &project,
        &req.asset_id,
        &req.model,
        req.threshold.unwrap_or(0.35),
        req.character_threshold.unwrap_or(0.85),
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionApplyRequest {
    pub revision_id: String,
    pub expected_revision: i64,
}

#[tauri::command]
pub async fn suggestion_apply(
    state: State<'_, AppState>,
    req: SuggestionApplyRequest,
) -> AppResult<captions::CaptionSaveResult> {
    let project = state.project()?;
    captions::apply_suggestion(&project, &req.revision_id, req.expected_revision)
}

// ---------------------------------------------------------------------------
// 质检
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn quality_run(state: State<'_, AppState>) -> AppResult<quality::QualityRunResult> {
    let project = state.project()?;
    quality::run(&project)
}

#[tauri::command]
pub async fn quality_summary(state: State<'_, AppState>) -> AppResult<QualitySummary> {
    let project = state.project()?;
    let conn = project.conn();
    quality::summary(&conn)
}

#[tauri::command]
pub async fn quality_issues(
    state: State<'_, AppState>,
    rule: String,
    include_ignored: Option<bool>,
    split: Option<String>,
) -> AppResult<QualityIssues> {
    let project = state.project()?;
    quality::issues_for_rule(
        &project,
        &rule,
        include_ignored.unwrap_or(false),
        split.as_deref().filter(|value| !value.is_empty()),
    )
}

#[tauri::command]
pub async fn quality_ignore(
    state: State<'_, AppState>,
    issue_id: String,
    reason: String,
) -> AppResult<()> {
    let project = state.project()?;
    quality::ignore(&project, &issue_id, &reason)
}

#[tauri::command]
pub async fn quality_unignore(state: State<'_, AppState>, issue_id: String) -> AppResult<()> {
    let project = state.project()?;
    quality::unignore(&project, &issue_id)
}

#[tauri::command]
pub async fn quality_duplicates(state: State<'_, AppState>) -> AppResult<Vec<DuplicateGroupView>> {
    let project = state.project()?;
    quality::duplicate_groups(&project)
}

#[tauri::command]
pub async fn quality_duplicate_action(
    state: State<'_, AppState>,
    req: quality::DuplicateAction,
) -> AppResult<i64> {
    let project = state.project()?;
    quality::duplicate_action(&project, &req)
}

#[tauri::command]
pub async fn quality_overview(state: State<'_, AppState>) -> AppResult<QualityOverview> {
    let project = state.project()?;
    quality::overview(&project)
}

// ---------------------------------------------------------------------------
// 图片去重 / 回收区
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn dedupe_scan(
    state: State<'_, AppState>,
    threshold: Option<u32>,
) -> AppResult<quality::DedupeScan> {
    let project = state.project()?;
    quality::dedupe_scan(&project, threshold)
}

#[tauri::command]
pub async fn dedupe_recycled(state: State<'_, AppState>) -> AppResult<Vec<quality::DedupeRecycled>> {
    let project = state.project()?;
    quality::dedupe_recycled(&project)
}

#[tauri::command]
pub async fn dedupe_recycle(
    state: State<'_, AppState>,
    asset_ids: Vec<String>,
) -> AppResult<quality::DedupeActionResult> {
    let project = state.project()?;
    quality::dedupe_recycle(&project, &asset_ids)
}

#[tauri::command]
pub async fn dedupe_restore(
    state: State<'_, AppState>,
    asset_ids: Vec<String>,
) -> AppResult<quality::DedupeActionResult> {
    let project = state.project()?;
    quality::dedupe_restore(&project, &asset_ids)
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn export_preview(
    state: State<'_, AppState>,
    config: ExportConfig,
) -> AppResult<ExportPreview> {
    validate_export_config(&config)?;
    let project = state.project()?;
    let pending = exports::preview(&project, &config)?;
    let preview = pending.preview.clone();
    let mut previews = state.export_previews.lock();
    if previews.len() > 8 {
        previews.clear();
    }
    previews.insert(preview.id.clone(), pending);
    Ok(preview)
}

fn validate_export_config(config: &ExportConfig) -> AppResult<()> {
    if !matches!(config.target.as_str(), "kohya" | "imagefolder") {
        return Err(AppError::new("INVALID_CONFIG", "未知的导出目标"));
    }
    if !matches!(config.package.as_str(), "folder" | "zip") {
        return Err(AppError::new("INVALID_CONFIG", "未知的封装方式"));
    }
    if !matches!(config.naming.as_str(), "index" | "original") {
        return Err(AppError::new("INVALID_CONFIG", "未知的命名方式"));
    }
    if !matches!(config.image_format.as_str(), "png" | "jpg") {
        return Err(AppError::new("INVALID_CONFIG", "不支持的图片编码"));
    }
    if !matches!(config.size.mode.as_str(), "perAsset" | "preserve" | "fitCrop" | "fitPad") {
        return Err(AppError::new("INVALID_CONFIG", "未知的输出尺寸策略"));
    }
    if matches!(config.size.mode.as_str(), "fitCrop" | "fitPad")
        && (config.size.width.unwrap_or(0) == 0 || config.size.height.unwrap_or(0) == 0)
    {
        return Err(AppError::new("INVALID_CONFIG", "固定尺寸策略需要有效的宽高"));
    }
    if config.quality < 1 || config.quality > 100 {
        return Err(AppError::new("INVALID_CONFIG", "JPEG 质量需在 1–100 之间"));
    }
    if !matches!(config.caption_extension.as_str(), ".txt" | ".caption") {
        return Err(AppError::new("INVALID_CONFIG", "不支持的标注扩展名"));
    }
    Ok(())
}

#[tauri::command]
pub async fn export_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    preview_id: String,
) -> AppResult<ExportStartResult> {
    let project = state.project()?;
    let pending = state
        .export_previews
        .lock()
        .get(&preview_id)
        .cloned()
        .ok_or_else(|| AppError::new("PREVIEW_EXPIRED", "导出预检已过期，请重新预检"))?;
    let job_id = exports::start(app, project, pending)?;
    Ok(ExportStartResult { job_id })
}

#[tauri::command]
pub async fn export_snapshot_config(
    state: State<'_, AppState>,
    snapshot_id: String,
) -> AppResult<ExportConfig> {
    let project = state.project()?;
    let conn = project.conn();
    let json: String = conn
        .query_row(
            "SELECT config_json FROM export_snapshots WHERE id = ?1",
            rusqlite::params![snapshot_id],
            |row| row.get(0),
        )
        .map_err(|_| AppError::new("SNAPSHOT_MISSING", "导出快照不存在"))?;
    serde_json::from_str(&json)
        .map_err(|_| AppError::new("SNAPSHOT_CORRUPT", "导出快照配置无法读取"))
}

#[tauri::command]
pub async fn export_records(state: State<'_, AppState>) -> AppResult<Vec<ExportRecordInfo>> {
    let project = state.project()?;
    exports::list_records(&project)
}

#[tauri::command]
pub async fn export_record(state: State<'_, AppState>, id: String) -> AppResult<ExportRecordInfo> {
    let project = state.project()?;
    exports::record_detail(&project, &id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingEntry {
    pub path: String,
    pub command: String,
}

#[tauri::command]
pub async fn export_absolute_entry(
    state: State<'_, AppState>,
    record_id: String,
) -> AppResult<TrainingEntry> {
    let project = state.project()?;
    let (path, command) = exports::write_absolute_entry(&project, &record_id)?;
    Ok(TrainingEntry { path, command })
}

#[tauri::command]
pub async fn export_open_output(state: State<'_, AppState>, record_id: String) -> AppResult<()> {
    let project = state.project()?;
    let record = exports::record_detail(&project, &record_id)?;
    let path = PathBuf::from(&record.output_path);
    if path.is_file() {
        #[cfg(windows)]
        {
            util::hidden_command("explorer.exe")
                .arg(format!("/select,{}", path.to_string_lossy()))
                .spawn()
                .map_err(|e| AppError::io("无法打开资源管理器", e))?;
            return Ok(());
        }
    }
    util::open_path_in_explorer(&path)
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn jobs_list(state: State<'_, AppState>) -> AppResult<Vec<JobInfo>> {
    let project = state.project()?;
    jobs::list_jobs(&project)
}

#[tauri::command]
pub async fn jobs_pause(state: State<'_, AppState>, job_id: String) -> AppResult<()> {
    let controls = state.job_controls.lock();
    if let Some(control) = controls.get(&job_id) {
        control.pause.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    } else {
        Err(AppError::new("JOB_NOT_RUNNING", "任务已不在运行中"))
    }
}

#[tauri::command]
pub async fn jobs_resume(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> AppResult<Option<ImportResult>> {
    if let Some(control) = state.job_controls.lock().get(&job_id) {
        control.pause.store(false, std::sync::atomic::Ordering::SeqCst);
        return Ok(None);
    }
    let project = state.project()?;
    let job = jobs::get_job(&project, &job_id)?;
    if job.kind == "import" {
        if let Some(scan_id) = job.input.get("scanId").and_then(|v| v.as_str()) {
            let cache = import::load_scan(&project, scan_id)?;
            let total = cache.entries.iter().filter(|e| e.status == "ok").count() as i64;
            let new_job = import::start_import(app, project, cache)?;
            return Ok(Some(ImportResult { job_id: new_job, total }));
        }
    }
    Err(AppError::new(
        "JOB_NOT_RESUMABLE",
        "该任务在应用重启时中断，请重新预检或重试。",
    ))
}

#[tauri::command]
pub async fn jobs_cancel(state: State<'_, AppState>, job_id: String) -> AppResult<()> {
    if let Some(control) = state.job_controls.lock().get(&job_id) {
        control.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        control.pause.store(false, std::sync::atomic::Ordering::SeqCst);
        return Ok(());
    }
    let project = state.project()?;
    jobs::set_status(
        &project,
        &job_id,
        "cancelled",
        Some(serde_json::json!({ "code": "CANCELLED", "message": "任务已取消" })),
        None,
    );
    Ok(())
}

#[tauri::command]
pub async fn jobs_retry_failed(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> AppResult<Option<ImportResult>> {
    let project = state.project()?;
    let job = jobs::get_job(&project, &job_id)?;
    match job.kind.as_str() {
        "import" => {
            let scan_id = job
                .input
                .get("scanId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::new("SCAN_EXPIRED", "扫描结果已过期，请重新扫描"))?;
            let cache = import::load_scan(&project, scan_id)?;
            let total = cache.entries.iter().filter(|e| e.status == "ok").count() as i64;
            let new_job = import::start_import(app, project, cache)?;
            Ok(Some(ImportResult { job_id: new_job, total }))
        }
        "export" => {
            let preview_id = job
                .input
                .get("previewId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::new("PREVIEW_EXPIRED", "导出预检已过期，请重新预检"))?;
            let pending = state
                .export_previews
                .lock()
                .get(preview_id)
                .cloned()
                .ok_or_else(|| AppError::new("PREVIEW_EXPIRED", "导出预检已过期，请重新预检"))?;
            exports::start(app, project, pending)?;
            Ok(None)
        }
        _ => Err(AppError::new("JOB_NOT_RETRYABLE", "该任务不支持重试")),
    }
}

// ---------------------------------------------------------------------------
// 模型与存储
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn models_list(state: State<'_, AppState>) -> AppResult<Vec<ModelInfo>> {
    Ok(tagging::list_models(&state))
}

#[tauri::command]
pub async fn models_catalog(state: State<'_, AppState>) -> AppResult<Vec<ModelCatalogEntry>> {
    Ok(tagging::catalog(&state))
}

#[tauri::command]
pub async fn model_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    model_id: String,
) -> AppResult<ModelDownloadResult> {
    let python = state.python.clone();
    let script = state
        .worker_script
        .parent()
        .map(|dir| dir.join("tagging").join("download_model.py"))
        .ok_or_else(|| AppError::new("MODEL_UNAVAILABLE", "缺少模型下载脚本"))?;
    let root = tagging::download_root(&state);
    tauri::async_runtime::spawn_blocking(move || {
        tagging::download_model_blocking(&app, &python, &script, &root, &model_id)
    })
    .await
    .map_err(|error| {
        AppError::new(
            "MODEL_DOWNLOAD_FAILED",
            format!("模型下载线程异常：{error}"),
        )
    })?
}

#[tauri::command]
pub async fn models_open_dir(state: State<'_, AppState>) -> AppResult<()> {
    let path = tagging::download_root(&state);
    util::ensure_dir(&path)?;
    util::open_path_in_explorer(&path)
}

#[tauri::command]
pub async fn storage_stats(state: State<'_, AppState>) -> AppResult<StorageStats> {
    let project = state.project()?;
    project::storage_stats(&project)
}

#[tauri::command]
pub async fn cache_clear(state: State<'_, AppState>) -> AppResult<StorageStats> {
    let project = state.project()?;
    for dir in [project.thumbs_dir(), project.displays_dir(), project.previews_dir()] {
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| AppError::io("清理缓存失败", e))?;
        }
        util::ensure_dir(&dir)?;
    }
    project::storage_stats(&project)
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPlanInfo {
    pub asset_id: String,
    pub revision: i64,
    pub plan: TransformPlan,
}

#[tauri::command]
pub async fn assets_transform_plans(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<AssetPlanInfo>> {
    let project = state.project()?;
    let conn = project.conn();
    let mut result = Vec::new();
    for id in ids.into_iter().take(5000) {
        if let Ok(asset) = db::get_asset(&conn, &id) {
            let plan = asset
                .transform_revision_id
                .as_deref()
                .and_then(|revision_id| {
                    conn.query_row(
                        "SELECT plan_json FROM transform_revisions WHERE id = ?1",
                        rusqlite::params![revision_id],
                        |row| row.get::<_, String>(0),
                    )
                    .ok()
                })
                .and_then(|json| serde_json::from_str::<TransformPlan>(&json).ok())
                .unwrap_or_default();
            result.push(AssetPlanInfo {
                asset_id: id,
                revision: asset.revision,
                plan,
            });
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateRequest {
    pub texts: Vec<String>,
    #[serde(default)]
    pub to: String,
}

#[tauri::command]
pub async fn prompt_library_count(state: State<'_, AppState>) -> AppResult<i64> {
    let project = state.project()?;
    let conn = project.conn();
    prompt_library::count(&conn)
}

#[tauri::command]
pub async fn prompt_library_list(
    state: State<'_, AppState>,
) -> AppResult<Vec<prompt_library::PromptEntry>> {
    let project = state.project()?;
    let conn = project.conn();
    prompt_library::list(&conn)
}

#[tauri::command]
pub async fn prompt_library_import(
    state: State<'_, AppState>,
    entries: Vec<prompt_library::PromptEntry>,
) -> AppResult<usize> {
    let project = state.project()?;
    let mut conn = project.conn();
    prompt_library::import(&mut conn, &entries)
}

#[tauri::command]
pub async fn prompt_library_upsert(
    state: State<'_, AppState>,
    req: prompt_library::PromptUpsertRequest,
) -> AppResult<prompt_library::PromptEntry> {
    let project = state.project()?;
    let mut conn = project.conn();
    prompt_library::upsert(&mut conn, &req)
}

#[tauri::command]
pub async fn prompt_library_delete(state: State<'_, AppState>, key: String) -> AppResult<()> {
    let project = state.project()?;
    let conn = project.conn();
    prompt_library::delete(&conn, &key)
}

#[tauri::command]
pub async fn translation_cache_get(
    state: State<'_, AppState>,
    texts: Vec<String>,
    to: String,
) -> AppResult<Vec<prompt_library::CachedTranslation>> {
    let project = state.project()?;
    let target = if to == "en" { "en" } else { "zh" };
    let conn = project.conn();
    let mut result = Vec::new();
    for text in texts.into_iter().take(200) {
        if let Some(item) = prompt_library::cache_lookup(&conn, &text, target) {
            result.push(item);
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateResult {
    pub translations: Vec<String>,
    pub provider: String,
}

#[tauri::command]
pub async fn translate_texts(
    state: State<'_, AppState>,
    req: TranslateRequest,
) -> AppResult<TranslateResult> {
    let texts: Vec<String> = req
        .texts
        .into_iter()
        .map(|text| text.trim().chars().take(200).collect::<String>())
        .filter(|text| !text.is_empty())
        .take(50)
        .collect();
    if texts.is_empty() {
        return Err(AppError::new("TRANSLATE_FAILED", "没有需要翻译的文本"));
    }
    let to = if req.to == "en" { "en" } else { "zh" };
    let project = state.project().ok();

    // 先查本地翻译缓存；只把未命中的文本发送到网络。
    let mut cached: Vec<Option<prompt_library::CachedTranslation>> = vec![None; texts.len()];
    if let Some(project) = &project {
        let conn = project.conn();
        for (index, text) in texts.iter().enumerate() {
            cached[index] = prompt_library::cache_lookup(&conn, text, to);
        }
    }
    let missing_indices: Vec<usize> = cached
        .iter()
        .enumerate()
        .filter_map(|(index, item)| if item.is_none() { Some(index) } else { None })
        .collect();

    if missing_indices.is_empty() {
        return Ok(TranslateResult {
            translations: cached
                .into_iter()
                .map(|item| item.map(|value| value.translated).unwrap_or_default())
                .collect(),
            provider: "cache".into(),
        });
    }

    let script = state
        .worker_script
        .parent()
        .map(|dir| dir.join("translate.py"))
        .ok_or_else(|| AppError::new("TRANSLATE_FAILED", "缺少翻译脚本"))?;
    if !script.exists() {
        return Err(AppError::new(
            "TRANSLATE_FAILED",
            format!("缺少翻译脚本：{}", script.display()),
        ));
    }
    let python = state.python.clone();
    let settings = state.settings();
    let missing_texts: Vec<String> = missing_indices
        .iter()
        .map(|index| texts[*index].clone())
        .collect();
    let payload = serde_json::json!({
        "texts": missing_texts,
        "to": to,
        "appid": settings.baidu_translate_app_id.unwrap_or_default(),
        "key": settings.baidu_translate_key.unwrap_or_default(),
    });
    let (mut translations, provider) = tauri::async_runtime::spawn_blocking(move || {
        let mut child = util::hidden_command(&python)
            .arg("-I")
            .arg("-X")
            .arg("utf8")
            .arg(&script)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| AppError::new("TRANSLATE_FAILED", format!("无法启动翻译运行时：{error}")))?;
        if let Some(mut input) = child.stdin.take() {
            input
                .write_all(payload.to_string().as_bytes())
                .map_err(|error| AppError::new("TRANSLATE_FAILED", format!("写入翻译请求失败：{error}")))?;
        }
        let output = child
            .wait_with_output()
            .map_err(|error| AppError::new("TRANSLATE_FAILED", format!("读取翻译结果失败：{error}")))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout
            .lines()
            .rev()
            .find(|line| line.trim_start().starts_with('{'))
            .ok_or_else(|| AppError::new("TRANSLATE_FAILED", "翻译服务没有返回结构化结果"))?;
        let value: serde_json::Value = serde_json::from_str(line)
            .map_err(|error| AppError::new("TRANSLATE_FAILED", format!("翻译结果解析失败：{error}")))?;
        if let Some(message) = value.get("error").and_then(|v| v.as_str()) {
            return Err(AppError::new("TRANSLATE_FAILED", message.to_string()).retryable(true));
        }
        let translations = value
            .get("translations")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().unwrap_or("").to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let provider = value
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        Ok((translations, provider))
    })
    .await
    .map_err(|error| AppError::new("TRANSLATE_FAILED", format!("翻译任务失败：{error}")))??;

    if translations.len() != missing_indices.len() {
        return Err(AppError::new(
            "TRANSLATE_FAILED",
            "翻译服务返回数量与请求不一致",
        )
        .retryable(true));
    }
    if let Some(project) = &project {
        let conn = project.conn();
        for (slot, index) in missing_indices.iter().enumerate() {
            let source = &texts[*index];
            let translated = &translations[slot];
            if !translated.trim().is_empty() {
                let _ = prompt_library::cache_store(&conn, source, to, translated, &provider);
            }
        }
    }

    let mut result = vec![String::new(); texts.len()];
    for (index, item) in cached.into_iter().enumerate() {
        if let Some(item) = item {
            result[index] = item.translated;
        }
    }
    for (slot, index) in missing_indices.iter().enumerate() {
        result[*index] = translations[slot].clone();
    }
    let provider = if missing_indices.len() < texts.len() {
        format!("cache+{provider}")
    } else {
        provider
    };
    Ok(TranslateResult {
        translations: result,
        provider,
    })
}
