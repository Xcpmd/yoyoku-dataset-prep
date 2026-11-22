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

use std::path::Path;
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
                let asset = {
                    let conn = project.conn();
                    db::get_asset(&conn, asset_id)
                };
                if let Ok(asset) = asset {
                    // `source-` 版本是未套用裁剪配方、按源图比例生成的原图缩略图。
                    let plan = if version.starts_with("source-") {
                        None
                    } else {
                        let conn = project.conn();
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
                            .and_then(|json| serde_json::from_str::<model::TransformPlan>(&json).ok())
                    };
                    if let Ok(source) = project.source_path(&asset) {
                        let _ = state
                            .worker
                            .thumbnail(&source, plan.as_ref(), &path, 512);
                    }
                }
            }
            asset_response(Some(&path), "image/jpeg")
        }
        ["display", asset_id, version] if safe_token(asset_id) && safe_token(version) => {
            let path = project.display_path(asset_id, version);
            if !path.exists() {
                if let Ok(asset) = {
                    let conn = project.conn();
                    db::get_asset(&conn, asset_id)
                } {
                    if let Ok(source) = project.source_path(&asset) {
                        let _ = state.worker.display(&source, &path, 2048);
                    }
                }
            }
            asset_response(Some(&path), "image/png")
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
        .register_uri_scheme_protocol("ykasset", |ctx, request| {
            serve_asset(ctx.app_handle(), &request)
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
