mod backup;
mod caption;
mod commands;
mod db;
mod error;
mod exports;
mod model;
mod project;
mod state;
mod tagging;
mod util;
mod worker;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{http::Response, Manager};

fn forbid() -> Response<Vec<u8>> {
    Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(b"not found".to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn asset_response(path: Option<&Path>, mime: &str) -> Response<Vec<u8>> {
    let Some(path) = path else {
        return forbid();
    };
    match std::fs::read(path) {
        Ok(bytes) => Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Cache-Control", "no-cache")
            .body(bytes)
            .unwrap_or_else(|_| forbid()),
        Err(_) => forbid(),
    }
}

fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn variant_temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.part-{}", crate::util::short_id(8)))
}

/// 合并同一张图、同一变体的并发请求；生成完成后原子发布到缓存路径。
fn with_variant_lock<F>(state: &state::AppState, key: &str, body: F)
where
    F: FnOnce(),
{
    let lock = {
        let mut locks = state.asset_locks.lock();
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(parking_lot::Mutex::new(())))
            .clone()
    };
    {
        let _guard = lock.lock();
        body();
    }
    let mut locks = state.asset_locks.lock();
    if locks
        .get(key)
        .map(|entry| Arc::strong_count(entry) <= 2)
        .unwrap_or(false)
    {
        locks.remove(key);
    }
}

fn serve_asset(app: &tauri::AppHandle, request: &tauri::http::Request<Vec<u8>>) -> Response<Vec<u8>> {
    let segments: Vec<&str> = request
        .uri()
        .path()
        .trim_start_matches('/')
        .split('/')
        .collect();
    let state = app.state::<state::AppState>();
    let project = match state.project.read().clone() {
        Some(project) => project,
        None => return forbid(),
    };
    match segments.as_slice() {
        ["thumb", asset_id, version] if safe_token(asset_id) && safe_token(version) => {
            let path = project.thumb_path(asset_id, version);
            if !path.exists() {
                let key = format!("{}:thumb:{asset_id}:{version}", project.id);
                with_variant_lock(&state, &key, || {
                    // 等待键锁期间另一请求可能已经生成。
                    if path.exists() {
                        return;
                    }
                    let _gate = state.protocol_gate.acquire();
                    let size = if version.starts_with("low-") { 256 } else { 512 };
                    let (asset, plan) = {
                        let conn = project.conn();
                        let Ok(asset) = db::get_asset(&conn, asset_id) else {
                            return;
                        };
                        // `source-` 版本是未套用裁剪配方、按源图比例生成的原图缩略图；
                        // `low-` 前缀为图库网格/小预览使用的 256 px 版本。
                        let is_source =
                            version.starts_with("source-") || version.starts_with("low-source-");
                        let plan = if is_source {
                            None
                        } else {
                            asset
                                .transform_revision_id
                                .as_deref()
                                .and_then(|id| {
                                    conn.query_row(
                                        "SELECT plan_json FROM transform_revisions WHERE id = ?1",
                                        rusqlite::params![id],
                                        |row| row.get::<_, String>(0),
                                    )
                                    .ok()
                                })
                                .and_then(|json| {
                                    serde_json::from_str::<model::TransformPlan>(&json).ok()
                                })
                        };
                        (asset, plan)
                    };
                    let Ok(source) = project.source_path(&asset) else {
                        return;
                    };
                    let tmp = variant_temp_path(&path);
                    match state
                        .worker
                        .thumbnail(&source, plan.as_ref(), &tmp, size)
                    {
                        Ok(()) => {
                            let _ = std::fs::rename(&tmp, &path);
                        }
                        Err(_) => {
                            let _ = std::fs::remove_file(&tmp);
                        }
                    }
                });
            }
            asset_response(Some(&path), "image/jpeg")
        }
        ["display", asset_id, version] if safe_token(asset_id) && safe_token(version) => {
            let path = project.display_path(asset_id, version);
            if !path.exists() {
                let key = format!("{}:display:{asset_id}:{version}", project.id);
                with_variant_lock(&state, &key, || {
                    if path.exists() {
                        return;
                    }
                    let _gate = state.protocol_gate.acquire();
                    let asset = {
                        let conn = project.conn();
                        match db::get_asset(&conn, asset_id) {
                            Ok(asset) => asset,
                            Err(_) => return,
                        }
                    };
                    let Ok(source) = project.source_path(&asset) else {
                        return;
                    };
                    let tmp = variant_temp_path(&path);
                    match state.worker.display(&source, &tmp, 1600) {
                        Ok(_) => {
                            let _ = std::fs::rename(&tmp, &path);
                        }
                        Err(_) => {
                            let _ = std::fs::remove_file(&tmp);
                        }
                    }
                });
            }
            asset_response(Some(&path), "image/webp")
        }
        ["preview", file] if safe_token(file) && file.ends_with(".jpg") => {
            let path = project.previews_dir().join(file);
            asset_response(Some(&path), "image/jpeg")
        }
        _ => forbid(),
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
            let resource_dir = app.path().resource_dir().ok();
            let state = state::AppState::new(data_dir, resource_dir, None)
                .map_err(|error| format!("初始化失败：{error}"))?;
            app.manage(state);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("ykasset", |ctx, request, responder| {
            // 协议回调不在主线程执行查库、解码和读写，避免阻塞窗口事件。
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(serve_asset(&app, &request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::worker_ping,
            commands::worker_logs,
            commands::translate_texts,
            commands::prompt_library_count,
            commands::prompt_library_list,
            commands::prompt_library_import,
            commands::prompt_library_upsert,
            commands::prompt_library_delete,
            commands::translation_cache_get,
            commands::app_settings_get,
            commands::app_settings_set,
            commands::recent_projects,
            commands::recent_remove,
            commands::recent_pin,
            commands::dialog_pick_folder,
            commands::dialog_pick_images,
            commands::dialog_pick_zip,
            commands::dialog_save_zip,
            commands::project_create,
            commands::project_create_sample,
            commands::project_open,
            commands::project_open_recent,
            commands::project_relocate,
            commands::project_close,
            commands::project_get,
            commands::project_update,
            commands::project_reveal,
            commands::reveal_path,
            commands::project_backup,
            commands::project_restore,
            commands::asset_relink_root,
            commands::import_scan,
            commands::import_start,
            commands::import_retry,
            commands::assets_query,
            commands::assets_ids,
            commands::asset_get,
            commands::asset_update,
            commands::asset_display,
            commands::assets_summaries,
            commands::assets_transform_plans,
            commands::asset_reveal,
            commands::batch_preview,
            commands::batch_apply,
            commands::undo,
            commands::redo,
            commands::history_recent,
            commands::collections_list,
            commands::collection_create,
            commands::collection_update,
            commands::collection_delete,
            commands::collection_ids,
            commands::transform_preview,
            commands::transform_save,
            commands::transform_draft_save,
            commands::transform_draft_clear,
            commands::caption_save,
            commands::caption_preview,
            commands::caption_convert_preview,
            commands::caption_tag_state_get,
            commands::caption_tag_state_set,
            commands::caption_tag_totals,
            commands::caption_tag_bulk,
            commands::caption_suggestions,
            commands::suggestion_generate,
            commands::suggestion_apply,
            commands::quality_run,
            commands::quality_summary,
            commands::quality_issues,
            commands::quality_ignore,
            commands::quality_unignore,
            commands::quality_duplicates,
            commands::quality_duplicate_action,
            commands::quality_overview,
            commands::dedupe_scan,
            commands::dedupe_summary,
            commands::dedupe_recycled,
            commands::dedupe_recycle,
            commands::dedupe_restore,
            commands::assets_metrics_backfill,
            commands::assets_recycle,
            commands::export_preview,
            commands::export_start,
            commands::export_snapshot_config,
            commands::export_records,
            commands::export_record,
            commands::export_absolute_entry,
            commands::export_open_output,
            commands::jobs_list,
            commands::jobs_pause,
            commands::jobs_resume,
            commands::jobs_cancel,
            commands::jobs_retry_failed,
            commands::models_list,
            commands::models_catalog,
            commands::model_download,
            commands::models_open_dir,
            commands::storage_stats,
            commands::cache_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
