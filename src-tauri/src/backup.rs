use crate::db;
use crate::error::{AppError, AppResult};
use crate::model::ProjectInfo;
use crate::project::{Project, PROJECT_FILE};
use crate::util;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRequest {
    pub dest_path: String,
    pub portable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub portable: bool,
    pub files: i64,
    pub missing: Vec<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub project: ProjectInfo,
    pub restored_path: String,
    pub portable: bool,
    pub warnings: Vec<String>,
}

fn safe_member_path(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    let mut path = PathBuf::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return None;
        }
        path.push(part);
    }
    if path.components().all(|c| matches!(c, Component::Normal(_))) {
        Some(path)
    } else {
        None
    }
}

pub fn backup(project: &Project, request: &BackupRequest) -> AppResult<BackupResult> {
    if request.dest_path.trim().is_empty() {
        return Err(AppError::new("INVALID_PATH", "请选择备份文件位置"));
    }
    let dest = PathBuf::from(util::expand_user_home(&request.dest_path));
    let dest = if dest.extension().map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false) {
        dest
    } else {
        dest.with_extension("zip")
    };
    if let Some(parent) = dest.parent() {
        util::ensure_dir(parent)?;
    }
    let staging = project
        .staging_dir()
        .join(format!("backup-{}", util::short_id(10)));
    util::remove_dir_if_exists(&staging)?;
    util::ensure_dir(&staging)?;

    let result = (|| -> AppResult<BackupResult> {
        // 元数据
        fs::copy(project.root.join(PROJECT_FILE), staging.join(PROJECT_FILE))
            .map_err(|e| AppError::io("复制 project.json 失败", e))?;
        // 一致的数据库副本
        {
            let conn = project.conn();
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(AppError::sql)?;
            let db_copy = staging.join("database.sqlite");
            conn.execute("VACUUM INTO ?1", params![db_copy.to_string_lossy()])
                .map_err(AppError::sql)?;
        }
        // 受管理原件
        copy_tree(&project.originals_dir(), &staging.join("originals"))?;

        let mut missing: Vec<String> = Vec::new();
        let mut relink: Vec<serde_json::Value> = Vec::new();
        let mut portable_roots: Vec<serde_json::Value> = Vec::new();
        let roots: Vec<(String, String, String)> = {
            let conn = project.conn();
            let mut statement = conn.prepare("SELECT id, path, mode FROM source_roots ORDER BY path")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let assets: Vec<(String, String, Option<String>, String)> = {
            let conn = project.conn();
            let mut statement =
                conn.prepare("SELECT id, original_name, source_root_id, rel_path FROM assets")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for (index, (root_id, root_path, mode)) in roots.iter().enumerate() {
            if mode != "ref" {
                continue;
            }
            let target_rel = format!("sources/{index}");
            let target = staging.join(&target_rel);
            let mut copied = 0;
            for (asset_id, name, source_root_id, rel_path) in &assets {
                if source_root_id.as_deref() != Some(root_id) {
                    continue;
                }
                let source = util::safe_join(Path::new(root_path), rel_path)
                    .unwrap_or_else(|_| Path::new(root_path).join(rel_path));
                if !source.exists() {
                    missing.push(format!("{name}（{}）", source.display()));
                    relink.push(serde_json::json!({
                        "assetId": asset_id, "name": name, "root": root_path, "relPath": rel_path
                    }));
                    continue;
                }
                let dest_file = target.join(rel_path);
                util::copy_atomic(&source, &dest_file)?;
                copied += 1;
            }
            if request.portable {
                if missing.iter().any(|m| m.contains(root_path.as_str())) && copied == 0 {
                    // 全部缺失时仍记录映射，便于用户修复
                }
                portable_roots.push(serde_json::json!({
                    "oldPath": root_path,
                    "newPath": target_rel,
                    "entries": copied,
                }));
            }
        }
        if request.portable && !missing.is_empty() {
            return Err(AppError::new(
                "PORTABLE_BACKUP_MISSING_SOURCES",
                format!(
                    "便携备份发现 {} 个失联引用，请先重新定位或改用普通备份。",
                    missing.len()
                ),
            )
            .details(serde_json::json!({ "missing": missing }))
            .items(relink.iter().filter_map(|v| v.get("assetId")).filter_map(|v| v.as_str().map(str::to_string)).collect()));
        }
        if request.portable {
            let portable = serde_json::json!({
                "version": 1,
                "roots": portable_roots,
            });
            util::write_atomic(&staging.join("portable.json"), serde_json::to_string_pretty(&portable)?.as_bytes())?;
        } else {
            let relink_doc = serde_json::json!({
                "version": 1,
                "note": "普通备份不包含引用源文件。恢复后可按此清单重新定位。",
                "items": relink,
            });
            util::write_atomic(&staging.join("relink-needed.json"), serde_json::to_string_pretty(&relink_doc)?.as_bytes())?;
        }

        let files = util::count_files(&staging) as i64;
        let file = File::create(&dest).map_err(|e| AppError::io("创建备份文件失败", e))?;
        let mut writer = zip::ZipWriter::new(file);
        let timestamp = zip::DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0).expect("valid zip timestamp");
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(timestamp)
            .unix_permissions(0o644);
        let mut entries: Vec<PathBuf> = walkdir::WalkDir::new(&staging)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .map(|e| e.path().to_path_buf())
            .collect();
        entries.sort();
        for path in entries {
            let rel = path
                .strip_prefix(&staging)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            writer
                .start_file(rel, options)
                .map_err(|e| AppError::new("ZIP_ERROR", format!("写入备份失败：{e}")))?;
            let mut input = File::open(&path).map_err(|e| AppError::io("读取备份内容失败", e))?;
            std::io::copy(&mut input, &mut writer).map_err(|e| AppError::io("写入备份失败", e))?;
        }
        writer
            .finish()
            .map_err(|e| AppError::new("ZIP_ERROR", format!("完成备份失败：{e}")))?;
        let bytes = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        Ok(BackupResult {
            path: dest.to_string_lossy().to_string(),
            portable: request.portable,
            files,
            missing,
            bytes,
        })
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

fn copy_tree(src: &Path, dst: &Path) -> AppResult<()> {
    if !src.exists() {
        return Ok(());
    }
    for entry in walkdir::WalkDir::new(src).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(src).unwrap_or(entry.path());
        util::copy_atomic(entry.path(), &dst.join(rel))?;
    }
    Ok(())
}

fn read_zip_project_name(archive: &mut zip::ZipArchive<File>) -> AppResult<(String, String)> {
    let mut text = String::new();
    let mut found = false;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| AppError::new("ZIP_ERROR", format!("读取备份条目失败：{e}")))?;
        if entry.name().replace('\\', "/") == PROJECT_FILE {
            entry
                .read_to_string(&mut text)
                .map_err(|e| AppError::new("ZIP_ERROR", format!("读取 project.json 失败：{e}")))?;
            found = true;
            break;
        }
    }
    if !found {
        return Err(AppError::new(
            "BACKUP_CORRUPT",
            "备份中缺少 project.json，不是有效的 Yoyoku 项目备份。",
        ));
    }
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::new("BACKUP_CORRUPT", format!("project.json 无效：{e}")))?;
    let name = value.get("name").and_then(|v| v.as_str()).unwrap_or("恢复的项目").to_string();
    let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Ok((name, id))
}

pub fn restore(
    state: &crate::state::AppState,
    zip_path: &str,
    target_parent: &str,
) -> AppResult<RestoreResult> {
    let zip_path = PathBuf::from(util::expand_user_home(zip_path));
    let parent = PathBuf::from(util::expand_user_home(target_parent));
    util::ensure_dir(&parent)?;
    let file = File::open(&zip_path).map_err(|e| AppError::io("打开备份失败", e))?;
    let archive_size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::new("BACKUP_CORRUPT", format!("备份 ZIP 无效：{e}")))?;
    if archive.len() > 50_000 {
        return Err(AppError::new("BACKUP_CORRUPT", "备份条目数量异常"));
    }
    let mut total_size: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| AppError::new("BACKUP_CORRUPT", format!("读取备份条目失败：{e}")))?;
        total_size = total_size.saturating_add(entry.size());
        if safe_member_path(entry.name()).is_none() {
            return Err(AppError::new(
                "BACKUP_CORRUPT",
                format!("备份包含不安全的路径：{}", entry.name()),
            ));
        }
    }
    if archive_size > 0 && total_size / archive_size.max(1) > 200 {
        return Err(AppError::new("BACKUP_CORRUPT", "备份压缩比异常，已拒绝解包"));
    }
    if total_size > 200 * 1024 * 1024 * 1024 {
        return Err(AppError::new("BACKUP_CORRUPT", "备份展开体积超过 200 GB，已拒绝解包"));
    }
    let (name, _id) = read_zip_project_name(&mut archive)?;
    let folder = util::sanitize_stem(&format!("{name}-恢复"));
    let mut target = parent.join(&folder);
    let mut attempt = 1;
    while target.exists() {
        attempt += 1;
        target = parent.join(format!("{folder}-{attempt}"));
        if attempt > 999 {
            return Err(AppError::new("TARGET_BUSY", "无法创建恢复目录"));
        }
    }
    util::ensure_dir(&target)?;

    let extract = (|| -> AppResult<()> {
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|e| AppError::new("BACKUP_CORRUPT", format!("读取备份条目失败：{e}")))?;
            let Some(rel) = safe_member_path(entry.name()) else {
                continue;
            };
            let out = target.join(rel);
            if entry.is_dir() {
                util::ensure_dir(&out)?;
                continue;
            }
            if let Some(parent) = out.parent() {
                util::ensure_dir(parent)?;
            }
            let mut output = File::create(&out).map_err(|e| AppError::io("解包文件失败", e))?;
            std::io::copy(&mut entry, &mut output).map_err(|e| AppError::io("解包文件失败", e))?;
        }
        Ok(())
    })();
    if let Err(error) = extract {
        let _ = fs::remove_dir_all(&target);
        return Err(error);
    }

    let mut warnings: Vec<String> = Vec::new();
    let mut portable = false;
    if let Ok(text) = fs::read_to_string(target.join("portable.json")) {
        portable = true;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(roots) = value.get("roots").and_then(|v| v.as_array()) {
                let conn = db::open_connection(&target.join("database.sqlite"))?;
                for root in roots {
                    let old = root.get("oldPath").and_then(|v| v.as_str()).unwrap_or("");
                    let new_rel = root.get("newPath").and_then(|v| v.as_str()).unwrap_or("");
                    let new_path = target.join(new_rel);
                    if old.is_empty() || new_rel.is_empty() {
                        continue;
                    }
                    conn.execute(
                        "UPDATE source_roots SET path = ?1, mode = 'ref' WHERE path = ?2",
                        params![new_path.to_string_lossy(), old],
                    )?;
                }
                warnings.push("便携备份的引用源已重写为恢复目录内的 sources/ 路径。".into());
            }
        }
    } else if target.join("relink-needed.json").exists() {
        warnings.push("普通备份不包含引用源文件；请按 relink-needed.json 重新定位相关图片。".into());
    }

    let project = Arc::new(crate::project::open_project(&target)?);
    let info = crate::project::project_info(&project)?;
    state.set_project(Some(project));
    {
        let mut recent = state.recent.write();
        crate::state::upsert_recent(&mut recent, &info, &target);
        let _ = crate::state::save_recent(&state.data_dir, &recent);
    }
    Ok(RestoreResult {
        project: info,
        restored_path: target.to_string_lossy().to_string(),
        portable,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "manual acceptance against a real backup archive"]
    fn restore_example_backup_manual() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests")
            .join("out");
        let zip = root.join("example-normal.zip");
        let target = root.join("restore-target");
        let data_dir = root.join("appdata-restore");
        if target.exists() {
            fs::remove_dir_all(&target).expect("clean target");
        }
        let state = crate::state::AppState::new(data_dir, None, None).expect("state");
        let result = restore(&state, zip.to_str().unwrap(), target.to_str().unwrap()).expect("restore");
        eprintln!(
            "restored={} portable={} total={} collections={}",
            result.restored_path, result.portable, result.project.counts.total, result.project.counts.collections
        );
        assert_eq!(result.project.counts.total, 30);
        assert_eq!(result.project.counts.collections, 1);
        assert!(!result.portable);
        assert!(Path::new(&result.restored_path).join("database.sqlite").exists());
    }

    #[test]
    #[ignore = "manual acceptance against a real backup archive"]
    fn portable_backup_roundtrip_manual() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests")
            .join("out");
        let source = root.join("restore-target").join("Yoyoku 示例项目-恢复");
        let zip = root.join("example-portable.zip");
        let target = root.join("restore-portable");
        let data_dir = root.join("appdata-portable");
        if target.exists() {
            fs::remove_dir_all(&target).expect("clean target");
        }
        let _ = fs::remove_file(&zip);
        let state = crate::state::AppState::new(data_dir, None, None).expect("state");
        let project = state.open_project_path(&source).expect("open source");
        let made = backup(
            &project,
            &BackupRequest {
                dest_path: zip.to_string_lossy().to_string(),
                portable: true,
            },
        )
        .expect("portable backup");
        eprintln!("portable backup files={} missing={} bytes={}", made.files, made.missing.len(), made.bytes);
        let result = restore(&state, zip.to_str().unwrap(), target.to_str().unwrap()).expect("restore");
        eprintln!(
            "portable restored={} portable={} total={}",
            result.restored_path, result.portable, result.project.counts.total
        );
        assert!(result.portable);
        assert_eq!(result.project.counts.total, 30);
        assert!(Path::new(&result.restored_path).join("portable.json").exists());
    }

    #[test]
    fn restore_rejects_parent_traversal_archive() {
        let root = std::env::temp_dir().join(format!("yoyoku-backup-test-{}", util::short_id(8)));
        util::ensure_dir(&root).expect("temp dir");
        let zip_path = root.join("evil.zip");
        {
            let file = File::create(&zip_path).expect("zip");
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("../evil.txt", options).expect("entry");
            writer.write_all(b"evil").expect("payload");
            writer.finish().expect("finish");
        }
        let state = crate::state::AppState::new(root.join("appdata"), None, None).expect("state");
        let target = root.join("target");
        let error = restore(&state, zip_path.to_str().unwrap(), target.to_str().unwrap())
            .expect_err("must reject traversal");
        assert_eq!(error.code, "BACKUP_CORRUPT");
        assert!(!root.join("evil.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
