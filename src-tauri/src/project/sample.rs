use crate::error::{AppError, AppResult};
use crate::model::{ProjectInfo, ScanRequest};
use crate::project::{create_project, import, jobs, quality, Project};
use crate::state::AppState;
use crate::util;
use rusqlite::params;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

fn documents_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|home| {
            let docs = home.join("Documents");
            if docs.exists() {
                docs
            } else {
                home
            }
        })
        .unwrap_or_else(|| std::env::temp_dir())
}

pub fn create_sample_project(app: &AppHandle, state: &AppState) -> AppResult<(Arc<Project>, ProjectInfo)> {
    let parent = documents_dir().join("Yoyoku Dataset Prep");
    util::ensure_dir(&parent)?;
    let mut attempt = 0;
    let mut project = None;
    while attempt < 20 {
        let name = if attempt == 0 {
            "Yoyoku 示例项目".to_string()
        } else {
            format!("Yoyoku 示例项目 {}", attempt + 1)
        };
        let request = crate::project::CreateProjectRequest {
            name: name.clone(),
            parent_dir: parent.to_string_lossy().to_string(),
            model: "sdxl".into(),
            template: "style".into(),
            trigger_word: "yoyoku_style".into(),
            default_caption_mode: "tags".into(),
        };
        match create_project(&request) {
            Ok(created) => {
                project = Some(Arc::new(created));
                break;
            }
            Err(error) if error.code == "PROJECT_EXISTS" => {
                attempt += 1;
                continue;
            }
            Err(error) => return Err(error),
        }
    }
    let project = project.ok_or_else(|| AppError::new("PROJECT_EXISTS", "无法创建示例项目目录"))?;
    state.set_project(Some(project.clone()));
    {
        let info = crate::project::project_info(&project)?;
        let mut recent = state.recent.write();
        crate::state::upsert_recent(&mut recent, &info, &project.root);
        let _ = crate::state::save_recent(&state.data_dir, &recent);
    }

    let source_dir = project.root.join("示例素材");
    util::ensure_dir(&source_dir)?;
    state.worker.generate_sample(&source_dir)?;

    let request = ScanRequest {
        paths: vec![source_dir.to_string_lossy().to_string()],
        recursive: true,
        mode: "copy".into(),
        sidecar_priority: "txt".into(),
        duplicate_policy: "keep".into(),
        caption_conflict_policy: "keep-external".into(),
        collection_id: None,
    };
    let cache = import::scan(&project, &request)?;
    let total = cache
        .entries
        .iter()
        .filter(|entry| entry.status == "ok")
        .count() as i64;
    let job_id = jobs::insert_job(
        &project,
        "import",
        "示例素材导入",
        &serde_json::json!({ "sample": true, "scanId": cache.id }),
        total,
    )?;
    let outcome = jobs::run_sync(app, project.clone(), job_id, move |ctx| {
        import::run_import(ctx, cache, total)
    })?;
    if outcome.status != "completed" && outcome.status != "completed_with_errors" {
        return Err(AppError::new(
            "SAMPLE_IMPORT_FAILED",
            "示例素材导入未完成，请在任务中心查看详情。",
        ));
    }

    // 预设审核状态、用途与集合
    {
        let mut conn = project.conn();
        let now = util::now_iso();
        let tx = conn.transaction()?;
        let approved = ["moonlit_street.jpg", "lantern_keeper.png", "moon_emblem.png", "月夜街道.png", "wide_banner.png"];
        for name in approved {
            tx.execute(
                "UPDATE assets SET review_status = 'approved', last_human_at = ?1,
                 revision = revision + 1 WHERE original_name = ?2",
                params![now, name],
            )?;
        }
        for name in ["tiny_sketch.jpg", "exif_rotated.jpg", "blurred.jpg"] {
            tx.execute(
                "UPDATE assets SET review_status = 'review', last_human_at = ?1,
                 revision = revision + 1 WHERE original_name = ?2",
                params![now, name],
            )?;
        }
        tx.execute(
            "UPDATE assets SET split_lock = 'val' WHERE original_name = 'lantern_keeper.png'",
            [],
        )?;
        let collection_id = util::new_id();
        tx.execute(
            "INSERT INTO collections(id, name, kind, query_json, created_at) VALUES(?1, ?2, 'manual', '{}', ?3)",
            params![collection_id, "精选素材", now],
        )?;
        for name in ["moonlit_street.jpg", "moon_emblem.png", "月夜街道.png"] {
            tx.execute(
                "INSERT OR IGNORE INTO collection_assets(collection_id, asset_id)
                 SELECT ?1, id FROM assets WHERE original_name = ?2",
                params![collection_id, name],
            )?;
        }
        tx.execute(
            "UPDATE project SET updated_at = ?1 WHERE id = ?2",
            params![now, project.id],
        )?;
        tx.commit()?;
    }
    let _ = quality::run(&project);
    let info = crate::project::project_info(&project)?;
    Ok((project, info))
}
