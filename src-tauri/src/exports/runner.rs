use crate::db;
use crate::error::{AppError, AppResult};
use crate::exports::adapters;
use crate::exports::{ExportItem, PendingExport};
use crate::model::*;
use crate::project::jobs::{JobContext, JobOutcome, JobRun};
use crate::project::Project;
use crate::util;
use serde_json::json;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

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

fn ensure_writable_parent(parent: &Path) -> AppResult<()> {
    util::ensure_dir(parent)?;
    let probe = parent.join(format!(".yoyoku-write-{}", util::short_id(8)));
    std::fs::write(&probe, b"probe")
        .map_err(|error| AppError::io(&format!("导出目标目录不可写：{}", parent.display()), error))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

fn copy_dir_recursive(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last_error = None;
    for attempt in 0..4 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt < 3 {
                    std::thread::sleep(Duration::from_millis(150 * (attempt as u64 + 1)));
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

fn commit_directory(source: &Path, target: &Path) -> AppResult<()> {
    if rename_with_retry(source, target).is_ok() {
        return Ok(());
    }
    // Windows may deny renaming a directory while Explorer / antivirus / an
    // indexer holds a handle to one of the freshly written files. Copying the
    // verified tree is slower but avoids leaving a fully rendered export behind.
    if target.exists() {
        return Err(AppError::new(
            "EXPORT_TARGET_EXISTS",
            format!("目标目录已存在，请重新预检后再导出：{}", target.display()),
        ));
    }
    if let Err(error) = copy_dir_recursive(source, target) {
        let _ = std::fs::remove_dir_all(target);
        return Err(AppError::io(
            &format!("提交导出目录失败（目标被占用或不可写）：{}", target.display()),
            error,
        ));
    }
    let _ = std::fs::remove_dir_all(source);
    Ok(())
}

fn commit_file(source: &Path, target: &Path) -> AppResult<()> {
    if rename_with_retry(source, target).is_ok() {
        return Ok(());
    }
    if target.exists() {
        return Err(AppError::new(
            "EXPORT_TARGET_EXISTS",
            format!("目标 ZIP 已存在，请重新预检后再导出：{}", target.display()),
        ));
    }
    if let Err(error) = std::fs::copy(source, target) {
        let _ = std::fs::remove_file(target);
        return Err(AppError::io(
            &format!("提交 ZIP 失败（目标被占用或不可写）：{}", target.display()),
            error,
        ));
    }
    let _ = std::fs::remove_file(source);
    Ok(())
}

fn kohya_caption(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_newline = false;
    for ch in text.chars() {
        if ch == '\r' || ch == '\n' {
            if !last_newline {
                out.push(' ');
                last_newline = true;
            }
        } else {
            out.push(ch);
            last_newline = false;
        }
    }
    out.trim().to_string()
}

fn imagefolder_line(item: &ExportItem) -> serde_json::Value {
    let dir = adapters::split_dir(&item.split);
    let file_name = item
        .image_path
        .strip_prefix(&format!("{dir}/"))
        .unwrap_or(&item.image_path);
    json!({ "file_name": file_name, "text": item.caption })
}

pub fn run_export(mut ctx: JobContext, pending: PendingExport) -> AppResult<JobOutcome> {
    let project = ctx.project.clone();
    let total = pending.items.len() as i64;
    let config = pending.config.clone();
    let parent = config
        .dest_dir
        .as_deref()
        .map(util::expand_user_home)
        .map(PathBuf::from)
        .unwrap_or_else(|| project.exports_dir());
    util::ensure_dir(&parent)?;
    ensure_writable_parent(&parent)?;

    let preview_name = Path::new(&pending.preview.output_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("yoyoku-{}", config.target));
    let final_path = if config.package == "zip" {
        let base = if preview_name.to_lowercase().ends_with(".zip") {
            preview_name
        } else {
            format!("{preview_name}.zip")
        };
        unique_path(&parent, &base)
    } else {
        unique_path(&parent, &preview_name)
    };
    let output_name = final_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "dataset".into());

    let temp_root = parent.join(format!(".yoyoku-tmp-{}", ctx.job_id));
    util::remove_dir_if_exists(&temp_root)?;
    util::ensure_dir(&temp_root)?;
    let sources_dir = temp_root.join(".sources");
    util::ensure_dir(&sources_dir)?;

    let model: String = project
        .conn()
        .query_row("SELECT model FROM project LIMIT 1", [], |row| row.get(0))
        .unwrap_or_else(|_| "sdxl".into());
    let mut manifest_entries: Vec<serde_json::Value> = Vec::new();
    let mut errors: Vec<JobItemError> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut failed = 0i64;
    let mut done = 0i64;
    let mut output_bytes = 0u64;

    ctx.checkpoint(0, 0, total, "生成图片", true)?;
    for item in &pending.items {
        let state = ctx.app.state::<crate::state::AppState>();
        match render_one(
            &state.worker,
            &temp_root,
            &sources_dir,
            item,
            &config,
        ) {
            Ok(result) => {
                output_bytes += result.2;
                manifest_entries.push(result.0);
                if let Some(warning) = result.1 {
                    if !warnings.contains(&warning) {
                        warnings.push(warning);
                    }
                }
            }
            Err(error) => {
                failed += 1;
                if errors.len() < 200 {
                    errors.push(JobItemError {
                        item_id: item.asset_id.clone(),
                        path: item.source_path.clone(),
                        message: error.message.clone(),
                        code: error.code.clone(),
                    });
                }
            }
        }
        done += 1;
        if let JobRun::Cancelled = ctx.checkpoint(done, failed, total, "生成图片", false)? {
            cleanup_temp(&temp_root);
            return Ok(JobOutcome {
                status: "cancelled".into(),
                result: json!({
                    "cancelled": true,
                    "success": done - failed,
                    "failed": failed,
                    "errors": errors,
                    "tempPath": temp_root.to_string_lossy(),
                }),
            });
        }
    }
    let _ = std::fs::remove_dir_all(&sources_dir);

    if failed > 0 {
        let details = json!({
            "tempPath": temp_root.to_string_lossy(),
            "errors": errors,
            "hint": "临时区已保留，可重新预检后重试；已提交的导出包不受影响。",
        });
        return Err(AppError::new(
            "EXPORT_ITEMS_FAILED",
            format!("{failed} 张图片渲染失败，本次导出未提交。"),
        )
        .retryable(true)
        .details(details));
    }

    ctx.set_phase("写入配置")?;
    // 配置文件
    let mut config_files: Vec<(String, String)> = Vec::new();
    if config.target == "kohya" {
        let toml = adapters::toml_content(&config, &pending.items);
        let path = temp_root.join("dataset.toml");
        util::write_atomic(&path, toml.as_bytes())?;
        config_files.push(("dataset.toml".into(), util::sha256_text(&toml)));
    } else {
        for split in ["train", "val"] {
            let content = adapters::jsonl_content(&pending.items, split);
            if content.is_empty() {
                continue;
            }
            let rel = format!("{}/metadata.jsonl", adapters::split_dir(split));
            util::write_atomic(&temp_root.join(&rel), content.as_bytes())?;
            config_files.push((rel, util::sha256_text(&content)));
        }
    }
    let readme = adapters::readme_content(&config, &pending.preview.split, &output_name, &model);
    util::write_atomic(&temp_root.join("README.md"), readme.as_bytes())?;
    config_files.push(("README.md".into(), util::sha256_text(&readme)));

    // 清单
    let manifest = adapters::manifest_json(
        &config,
        &pending.items,
        &manifest_entries,
        &pending.preview.fingerprint,
        &pending.preview.split,
        &config_files,
        &model,
        &output_name,
    );
    util::write_atomic(&temp_root.join("manifest.json"), manifest.as_bytes())?;
    let manifest_hash = util::sha256_text(&manifest);

    ctx.set_phase("校验输出")?;
    let validation = validate_export(&temp_root, &pending.items, &config, &manifest_entries)?;
    if validation["ok"].as_bool() != Some(true) {
        return Err(AppError::new(
            "EXPORT_VALIDATION_FAILED",
            "导出内容结构校验未通过，未提交安装包。",
        )
        .details(json!({
            "tempPath": temp_root.to_string_lossy(),
            "validation": validation,
        }))
        .retryable(true));
    }

    ctx.set_phase("提交导出包")?;
    let committed_path = if config.package == "zip" {
        let temp_zip = parent.join(format!(".yoyoku-tmp-{}.zip", ctx.job_id));
        let count = create_zip(&temp_root, &output_name, &temp_zip)?;
        verify_zip(&temp_zip, count)?;
        if final_path.exists() {
            let retry = unique_path(&parent, &final_path.file_name().unwrap_or_default().to_string_lossy());
            commit_file(&temp_zip, &retry)?;
            cleanup_temp(&temp_root);
            retry
        } else {
            commit_file(&temp_zip, &final_path)?;
            cleanup_temp(&temp_root);
            final_path.clone()
        }
    } else {
        let target = if final_path.exists() {
            unique_path(&parent, &final_path.file_name().unwrap_or_default().to_string_lossy())
        } else {
            final_path.clone()
        };
        commit_directory(&temp_root, &target)?;
        target
    };

    let record_id = util::new_id();
    let counts = json!({
        "total": pending.items.len(),
        "train": pending.preview.split.train,
        "val": pending.preview.split.val,
        "bytes": output_bytes,
    });
    {
        let conn = project.conn();
        conn.execute(
            "INSERT INTO export_records(id, snapshot_id, target, package, output_path, counts_json,
                validation_json, manifest_sha256, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                record_id,
                pending.preview.id,
                config.target,
                config.package,
                committed_path.to_string_lossy(),
                serde_json::to_string(&counts)?,
                serde_json::to_string(&validation)?,
                manifest_hash,
                util::now_iso()
            ],
        )?;
    }
    Ok(JobOutcome {
        status: "completed".into(),
        result: json!({
            "recordId": record_id,
            "outputPath": committed_path.to_string_lossy(),
            "counts": counts,
            "validation": validation,
            "warnings": warnings,
            "manifestSha256": manifest_hash,
        }),
    })
}

fn cleanup_temp(temp_root: &Path) {
    let _ = std::fs::remove_dir_all(temp_root);
}

/// 返回 (manifest entry, warning, bytes)
fn render_one(
    worker: &crate::worker::WorkerPool,
    temp_root: &Path,
    sources_dir: &Path,
    item: &ExportItem,
    config: &ExportConfig,
) -> AppResult<(serde_json::Value, Option<String>, u64)> {
    let source = PathBuf::from(&item.source_path);
    if !source.exists() {
        return Err(AppError::new("SOURCE_MISSING", "源文件已失联"));
    }
    let (hash, _) = util::sha256_file(&source).map_err(|e| AppError::io("读取源文件失败", e))?;
    if hash != item.source_hash {
        return Err(AppError::new(
            "SOURCE_CHANGED",
            "源文件内容与快照校验不一致",
        ));
    }
    // 复制已验证字节，后续渲染只读取副本，避免导出过程中源文件再次变化。
    let copy = sources_dir.join(format!("{}.{}", item.asset_id, Path::new(&item.source_path).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "bin".into())));
    util::copy_atomic(&source, &copy)?;
    let (copy_hash, _) = util::sha256_file(&copy).map_err(|e| AppError::io("校验源副本失败", e))?;
    if copy_hash != item.source_hash {
        let _ = std::fs::remove_file(&copy);
        return Err(AppError::new("SOURCE_CHANGED", "源文件在导出期间发生变化"));
    }

    let image_path = temp_root.join(&item.image_path);
    let render = worker.render(&copy, &item.plan, &image_path, None, None, 600);
    let _ = std::fs::remove_file(&copy);
    let render = render?;
    let (width, height, bytes) = match image::image_dimensions(&image_path) {
        Ok((width, height)) => (
            width,
            height,
            std::fs::metadata(&image_path).map(|m| m.len()).unwrap_or(0),
        ),
        Err(error) => {
            return Err(AppError::new(
                "DECODE_FAILED",
                format!("无法读取导出图片：{error}"),
            ))
        }
    };
    if width != item.width || height != item.height {
        // 使用实际像素并给出提示，仍可完成导出
        let warning = format!(
            "{} 实际输出 {}×{}，计划 {}×{}",
            item.original_name, width, height, item.width, item.height
        );
        let image_sha = util::sha256_file(&image_path)
            .map_err(|e| AppError::io("计算导出图片哈希失败", e))?
            .0;
        let caption_sha;
        if config.target == "kohya" {
            let caption = kohya_caption(&item.caption);
            let caption_path = temp_root.join(&item.caption_path);
            util::write_atomic(&caption_path, caption.as_bytes())?;
            caption_sha = util::sha256_text(&caption);
        } else {
            caption_sha = util::sha256_text(&item.caption);
        }
        let entry = json!({
            "asset_id": item.asset_id,
            "split": item.split,
            "subset": item.subset_label,
            "image_path": item.image_path,
            "image_sha256": image_sha,
            "width": width,
            "height": height,
            "caption_path": item.caption_path,
            "caption_sha256": caption_sha,
            "metadata_line": if config.target == "imagefolder" { Some(imagefolder_line(item)) } else { None },
        });
        return Ok((entry, Some(warning), bytes));
    }
    let image_sha = util::sha256_file(&image_path)
        .map_err(|e| AppError::io("计算导出图片哈希失败", e))?
        .0;
    let caption_sha;
    if config.target == "kohya" {
        let caption = kohya_caption(&item.caption);
        let caption_path = temp_root.join(&item.caption_path);
        util::write_atomic(&caption_path, caption.as_bytes())?;
        caption_sha = util::sha256_text(&caption);
    } else {
        caption_sha = util::sha256_text(&item.caption);
    }
    let entry = json!({
        "asset_id": item.asset_id,
        "split": item.split,
        "subset": item.subset_label,
        "image_path": item.image_path,
        "image_sha256": image_sha,
        "width": width,
        "height": height,
        "caption_path": item.caption_path,
        "caption_sha256": caption_sha,
        "metadata_line": if config.target == "imagefolder" { Some(imagefolder_line(item)) } else { None },
    });
    let _ = render;
    Ok((entry, None, bytes))
}

fn validate_export(
    root: &Path,
    items: &[ExportItem],
    config: &ExportConfig,
    entries: &[serde_json::Value],
) -> AppResult<serde_json::Value> {
    let mut checks: Vec<serde_json::Value> = Vec::new();
    let mut ok = true;
    let mut push = |name: &str, passed: bool, detail: String| {
        if !passed {
            ok = false;
        }
        checks.push(json!({ "name": name, "ok": passed, "detail": detail }));
    };

    // 图片数量与像素（以实际写入的清单记录为准）
    let expected_dims: HashMap<String, (u32, u32)> = entries
        .iter()
        .filter_map(|entry| {
            let path = entry.get("image_path")?.as_str()?.to_string();
            let width = entry.get("width")?.as_u64()? as u32;
            let height = entry.get("height")?.as_u64()? as u32;
            Some((path, (width, height)))
        })
        .collect();
    let mut missing_images = 0;
    let mut bad_dimensions = 0;
    for item in items {
        let path = root.join(&item.image_path);
        if !path.exists() {
            missing_images += 1;
            continue;
        }
        match image::image_dimensions(&path) {
            Ok((width, height)) => {
                if let Some((expected_w, expected_h)) = expected_dims.get(&item.image_path) {
                    if width != *expected_w || height != *expected_h {
                        bad_dimensions += 1;
                    }
                }
            }
            Err(_) => bad_dimensions += 1,
        }
    }
    push(
        "图片文件",
        missing_images == 0,
        format!("计划 {}，缺失 {}，异常尺寸 {}", items.len(), missing_images, bad_dimensions),
    );

    // 标注配对
    if config.target == "kohya" {
        let mut missing_captions = 0;
        let mut empty_captions = 0;
        for item in items {
            let path = root.join(&item.caption_path);
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    if content.trim().is_empty() {
                        empty_captions += 1;
                    }
                }
                Err(_) => missing_captions += 1,
            }
        }
        push(
            "标注配对",
            missing_captions == 0 && empty_captions == 0,
            format!("缺失 {}，空标注 {}", missing_captions, empty_captions),
        );
    } else {
        let mut problems: Vec<String> = Vec::new();
        for split in ["train", "val"] {
            let expected = items.iter().filter(|item| item.split == split).count();
            if expected == 0 {
                continue;
            }
            let dir = adapters::split_dir(split);
            let path = root.join(dir).join("metadata.jsonl");
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    let mut count = 0;
                    let mut empty = 0;
                    for line in content.lines().filter(|l| !l.trim().is_empty()) {
                        match serde_json::from_str::<serde_json::Value>(line) {
                            Ok(value) => {
                                count += 1;
                                let file_name = value.get("file_name").and_then(|v| v.as_str()).unwrap_or("");
                                let text = value.get("text").and_then(|v| v.as_str()).unwrap_or("");
                                if text.trim().is_empty() {
                                    empty += 1;
                                }
                                if !root.join(dir).join(file_name).exists() {
                                    problems.push(format!("{dir}/{file_name} 不存在"));
                                }
                            }
                            Err(error) => problems.push(format!("{dir}/metadata.jsonl 解析失败：{error}")),
                        }
                    }
                    if count != expected {
                        problems.push(format!("{dir} 行数 {count}，预期 {expected}"));
                    }
                    if empty > 0 {
                        problems.push(format!("{dir} 有 {empty} 条空文本"));
                    }
                }
                Err(error) => problems.push(format!("{dir}/metadata.jsonl 无法读取：{error}")),
            }
        }
        push(
            "JSONL 结构",
            problems.is_empty(),
            if problems.is_empty() {
                "每个分割目录的 metadata.jsonl 均可读取且与图片配对".into()
            } else {
                problems.join("；")
            },
        );
    }

    // 配置语法
    if config.target == "kohya" {
        let text = std::fs::read_to_string(root.join("dataset.toml")).unwrap_or_default();
        let parsed = toml::from_str::<toml::Value>(&text);
        push(
            "TOML 语法",
            parsed.is_ok(),
            parsed
                .as_ref()
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "dataset.toml 可解析".into()),
        );
        if let Ok(value) = parsed {
            let subsets = value
                .get("datasets")
                .and_then(|d| d.as_array())
                .map(|datasets| {
                    datasets
                        .iter()
                        .filter_map(|d| d.get("subsets").and_then(|s| s.as_array()))
                        .flatten()
                        .count()
                })
                .unwrap_or(0);
            push(
                "TOML 子集",
                subsets > 0,
                format!("解析到 {subsets} 个 [[datasets.subsets]]"),
            );
        }
    }

    // 清单一致性
    match std::fs::read_to_string(root.join("manifest.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    {
        Some(value) => {
            let count = value
                .get("items")
                .and_then(|v| v.as_array())
                .map(|items| items.len())
                .unwrap_or(0);
            push(
                "manifest.json",
                count == items.len() && value.get("snapshotFingerprint").is_some(),
                format!("清单包含 {count} 个条目，计划 {} 个", items.len()),
            );
        }
        None => push("manifest.json", false, "清单无法解析".into()),
    }

    // 抽样哈希
    let sample: Vec<&serde_json::Value> = entries.iter().take(8).collect();
    let mut hash_problems = Vec::new();
    for entry in &sample {
        let image_path = entry.get("image_path").and_then(|v| v.as_str()).unwrap_or("");
        let expected = entry.get("image_sha256").and_then(|v| v.as_str()).unwrap_or("");
        match util::sha256_file(&root.join(image_path)) {
            Ok((hash, _)) => {
                if hash != expected {
                    hash_problems.push(format!("{image_path} 哈希不一致"));
                }
            }
            Err(error) => hash_problems.push(format!("{image_path} 读取失败：{error}")),
        }
        if config.target == "kohya" {
            let caption_path = entry.get("caption_path").and_then(|v| v.as_str()).unwrap_or("");
            let expected = entry.get("caption_sha256").and_then(|v| v.as_str()).unwrap_or("");
            if let Ok(bytes) = std::fs::read(root.join(caption_path)) {
                if util::sha256_bytes(&bytes) != expected {
                    hash_problems.push(format!("{caption_path} 哈希不一致"));
                }
            }
        }
    }
    push(
        "抽样哈希",
        hash_problems.is_empty(),
        if hash_problems.is_empty() {
            format!("抽样 {} 个文件哈希一致", sample.len() * 2)
        } else {
            hash_problems.join("；")
        },
    );

    Ok(json!({
        "ok": ok,
        "checks": checks,
        "sampleSize": sample.len(),
    }))
}

fn create_zip(root: &Path, prefix: &str, zip_path: &Path) -> AppResult<usize> {
    let file = File::create(zip_path).map_err(|e| AppError::io("创建 ZIP 失败", e))?;
    let mut writer = zip::ZipWriter::new(file);
    let timestamp = zip::DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0)
        .expect("valid zip timestamp");
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(timestamp)
        .unix_permissions(0o644);
    let mut count = 0usize;
    let mut files: Vec<PathBuf> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .collect();
    files.sort();
    for path in files {
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let name = format!("{prefix}/{rel}");
        writer
            .start_file(name, options)
            .map_err(|e| AppError::new("ZIP_ERROR", format!("写入 ZIP 条目失败：{e}")))?;
        let mut input = File::open(&path).map_err(|e| AppError::io("读取导出文件失败", e))?;
        let mut buffer = [0u8; 65536];
        loop {
            let read = input.read(&mut buffer).map_err(|e| AppError::io("读取导出文件失败", e))?;
            if read == 0 {
                break;
            }
            writer
                .write_all(&buffer[..read])
                .map_err(|e| AppError::io("写入 ZIP 失败", e))?;
        }
        count += 1;
    }
    writer
        .finish()
        .map_err(|e| AppError::new("ZIP_ERROR", format!("完成 ZIP 写入失败：{e}")))?;
    Ok(count)
}

fn verify_zip(path: &Path, expected: usize) -> AppResult<()> {
    let file = File::open(path).map_err(|e| AppError::io("重新打开 ZIP 失败", e))?;
    let archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::new("ZIP_ERROR", format!("ZIP 校验失败：{e}")))?;
    if archive.len() != expected {
        return Err(AppError::new(
            "ZIP_ERROR",
            format!("ZIP 校验失败：条目数 {}，预期 {}", archive.len(), expected),
        ));
    }
    Ok(())
}
