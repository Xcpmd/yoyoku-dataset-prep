use crate::caption;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::model::{ModelCatalogEntry, ModelDownloadProgress, ModelDownloadResult, ModelInfo, SuggestionResult};
use crate::project::captions;
use crate::project::Project;
use crate::state::AppState;
use crate::util;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct TaggerOutput {
    tags: Vec<String>,
    ratings: serde_json::Value,
    device: String,
    elapsed_ms: u64,
    model: String,
    runtime: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlorenceOutput {
    text: String,
    device: String,
    elapsed_ms: u64,
    model: String,
    runtime: String,
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn tagger_root() -> Option<PathBuf> {
    let root = workspace_root().join("wd14Tagger");
    if root.exists() {
        Some(root)
    } else {
        None
    }
}

fn candidate_roots(state: &AppState) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let settings = state.settings();
    if let Some(dir) = settings.models_dir.filter(|d| !d.trim().is_empty()) {
        let path = PathBuf::from(util::expand_user_home(&dir));
        if path.exists() {
            roots.push(path);
        }
    }
    let app_models = state.data_dir.join("models");
    if app_models.exists() {
        roots.push(app_models);
    }
    if let Some(root) = tagger_root() {
        roots.push(root.join("models"));
    }
    roots
}

fn models_root(state: &AppState) -> Option<PathBuf> {
    candidate_roots(state).into_iter().next().or_else(|| Some(download_root(state)))
}

pub fn download_root(state: &AppState) -> PathBuf {
    let settings = state.settings();
    if let Some(dir) = settings.models_dir.filter(|d| !d.trim().is_empty()) {
        return PathBuf::from(util::expand_user_home(&dir));
    }
    state.data_dir.join("models")
}

/// WD14 与基础图像工作进程共用设置中的 Python 运行时；
/// 未配置时按 `YOYOKU_PYTHON`、开发机候选、PATH 的顺序解析。
fn tagger_python(state: &AppState) -> String {
    crate::state::resolve_python(state.settings().python_path.as_deref())
}

fn model_dirs(state: &AppState) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for root in candidate_roots(state) {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || !path.join("model.onnx").exists() || !path.join("selected_tags.csv").exists() {
                continue;
            }
            let key = path.canonicalize().unwrap_or_else(|_| path.clone());
            if dirs.iter().any(|existing| existing.canonicalize().unwrap_or_else(|_| existing.clone()) == key) {
                continue;
            }
            dirs.push(path);
        }
    }
    dirs.sort();
    dirs
}

const FLORENCE_ID: &str = "microsoft--Florence-2-base-ft";
const FLORENCE_FILES: &[&str] = &[
    "config.json",
    "configuration_florence2.py",
    "model.safetensors",
    "modeling_florence2.py",
    "preprocessor_config.json",
    "processing_florence2.py",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
];
const FLORENCE_REQUIRED: &[&str] = &[
    "config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "model.safetensors",
];

fn is_florence_installed(dir: &Path) -> bool {
    FLORENCE_REQUIRED.iter().all(|file| {
        let path = dir.join(file);
        path.is_file() && std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0) > 0
    })
}

fn florence_model_dir(state: &AppState) -> Option<PathBuf> {
    candidate_roots(state)
        .into_iter()
        .map(|root| root.join(FLORENCE_ID))
        .find(|dir| is_florence_installed(dir))
}

/**
 * Florence-2 needs torch / transformers / einops, which are not part of the
 * embedded WD14 Python. Use the explicitly configured Python, otherwise the
 * system Python from PATH.
 */
fn florence_python(state: &AppState) -> String {
    if let Some(path) = state
        .settings()
        .python_path
        .filter(|path| !path.trim().is_empty())
    {
        return path;
    }
    std::env::var("YOYOKU_PYTHON")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "python".to_string())
}

pub fn list_models(state: &AppState) -> Vec<ModelInfo> {
    let mut models: Vec<ModelInfo> = model_dirs(state)
        .into_iter()
        .map(|dir| {
            let name = dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let display = name
                .replace("SmilingWolf--", "SmilingWolf / ")
                .replace("--", " / ");
            ModelInfo {
                id: name,
                name: display,
                kind: "wd14-tagger".into(),
                version: "v3 / ONNX".into(),
                size_bytes: util::dir_size(&dir),
                path: dir.to_string_lossy().to_string(),
                device: "CPU（自动检测 GPU）".into(),
                status: "available".into(),
                license: "模型许可见 Hugging Face 发布页".into(),
                note: "本地 ONNX 标签模型；由自带 Python 运行，不上传图片。".into(),
            }
        })
        .collect();
    let florence_dir = florence_model_dir(state);
    models.push(ModelInfo {
        id: FLORENCE_ID.into(),
        name: "Florence-2 base-ft".into(),
        kind: "caption".into(),
        version: "safetensors / transformers".into(),
        size_bytes: florence_dir.as_deref().map(util::dir_size).unwrap_or(0),
        path: florence_dir
            .as_deref()
            .map(|dir| dir.to_string_lossy().to_string())
            .or_else(|| models_root(state).map(|p| p.to_string_lossy().to_string()))
            .unwrap_or_default(),
        device: "CPU / GPU".into(),
        status: if florence_dir.is_some() { "available".into() } else { "unavailable".into() },
        license: "MIT（模型卡）".into(),
        note: if florence_dir.is_some() {
            "权重已下载，可作为自然语言描述模型调用。需要 Python 安装 torch、transformers、einops；在设置中填写该 Python 路径后可指定。".into()
        } else {
            "自然语言描述模型尚未安装。可在设置中下载 Florence-2 权重，下载后即可在打标页选择。".into()
        },
    });
    models
}

struct DownloadSpec {
    id: &'static str,
    name: &'static str,
    repo: &'static str,
    size: &'static str,
    files: &'static [&'static str],
    required: &'static [&'static str],
}

const WD14_FILES: &[&str] = &["model.onnx", "selected_tags.csv"];

const DOWNLOADABLE_MODELS: &[DownloadSpec] = &[
    DownloadSpec {
        id: "SmilingWolf--wd-vit-tagger-v3",
        name: "WD ViT Tagger v3",
        repo: "SmilingWolf/wd-vit-tagger-v3",
        size: "约 361 MB",
        files: WD14_FILES,
        required: WD14_FILES,
    },
    DownloadSpec {
        id: "SmilingWolf--wd-vit-large-tagger-v3",
        name: "WD ViT Large Tagger v3",
        repo: "SmilingWolf/wd-vit-large-tagger-v3",
        size: "约 1.17 GB",
        files: WD14_FILES,
        required: WD14_FILES,
    },
    DownloadSpec {
        id: "SmilingWolf--wd-swinv2-tagger-v3",
        name: "WD SwinV2 Tagger v3",
        repo: "SmilingWolf/wd-swinv2-tagger-v3",
        size: "约 446 MB",
        files: WD14_FILES,
        required: WD14_FILES,
    },
    DownloadSpec {
        id: "SmilingWolf--wd-v1-4-convnext-tagger-v2",
        name: "WD v1.4 ConvNeXt Tagger v2",
        repo: "SmilingWolf/wd-v1-4-convnext-tagger-v2",
        size: "约 360 MB",
        files: WD14_FILES,
        required: WD14_FILES,
    },
    DownloadSpec {
        id: FLORENCE_ID,
        name: "Florence-2 base-ft（自然语言）",
        repo: "microsoft/Florence-2-base-ft",
        size: "约 0.5 GB",
        files: FLORENCE_FILES,
        required: FLORENCE_REQUIRED,
    },
];

fn spec_installed(dir: &Path, spec: &DownloadSpec) -> bool {
    spec.required.iter().all(|file| {
        let path = dir.join(file);
        path.is_file() && std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0) > 0
    })
}

pub fn catalog(state: &AppState) -> Vec<ModelCatalogEntry> {
    let root = download_root(state);
    let roots = candidate_roots(state);
    DOWNLOADABLE_MODELS
        .iter()
        .map(|spec| {
            let target = root.join(spec.id);
            let installed_path = roots
                .iter()
                .map(|root| root.join(spec.id))
                .find(|dir| spec_installed(dir, spec));
            ModelCatalogEntry {
                id: spec.id.into(),
                name: spec.name.into(),
                repo: spec.repo.into(),
                files: spec.files.iter().map(|file| (*file).to_string()).collect(),
                approx_size: spec.size.into(),
                installed: installed_path.is_some(),
                path: installed_path
                    .map(|dir| dir.to_string_lossy().to_string())
                    .unwrap_or_else(|| target.to_string_lossy().to_string()),
            }
        })
        .collect()
}

/// 下载 WD14 ONNX 模型。下载脚本只使用 Python 标准库，进度通过 Tauri 事件推送。
pub fn download_model_blocking(
    app: &tauri::AppHandle,
    python: &str,
    script: &Path,
    root: &Path,
    model_id: &str,
) -> AppResult<ModelDownloadResult> {
    use tauri::Emitter;

    let spec = DOWNLOADABLE_MODELS
        .iter()
        .find(|spec| spec.id == model_id)
        .ok_or_else(|| AppError::new("MODEL_UNAVAILABLE", "未知的可下载模型"))?;
    if !script.exists() {
        return Err(AppError::new(
            "MODEL_UNAVAILABLE",
            format!("缺少模型下载脚本：{}", script.display()),
        ));
    }
    util::ensure_dir(root)?;
    let target = root.join(spec.id);
    util::ensure_dir(&target)?;
    let mut child = util::hidden_command(python)
        .arg("-I")
        .arg(script)
        .arg("--repo")
        .arg(spec.repo)
        .arg("--target")
        .arg(&target)
        .arg("--files")
        .arg(spec.files.join(","))
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AppError::new(
                "MODEL_DOWNLOAD_FAILED",
                format!("无法启动模型下载运行时：{error}"),
            )
        })?;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().flatten() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value.get("event").and_then(|v| v.as_str()) != Some("progress") {
                continue;
            }
            let progress = ModelDownloadProgress {
                model_id: spec.id.into(),
                file: value.get("file").and_then(|v| v.as_str()).unwrap_or("model").into(),
                downloaded: value.get("downloaded").and_then(|v| v.as_u64()).unwrap_or(0),
                total: value.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
                percent: value.get("percent").and_then(|v| v.as_f64()).unwrap_or(0.0),
            };
            let _ = app.emit("model:download-progress", progress);
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| AppError::new("MODEL_DOWNLOAD_FAILED", format!("读取下载结果失败：{error}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::new(
            "MODEL_DOWNLOAD_FAILED",
            format!(
                "模型下载失败：{}",
                stderr.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("未知错误")
            ),
        )
        .retryable(true));
    }
    for file in spec.required {
        let path = target.join(file);
        if !path.exists() || std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) == 0 {
            return Err(AppError::new(
                "MODEL_DOWNLOAD_FAILED",
                format!("下载完成但缺少文件：{file}"),
            ));
        }
    }
    Ok(ModelDownloadResult {
        model_id: spec.id.into(),
        path: target.to_string_lossy().to_string(),
        files: spec.files.iter().map(|file| (*file).to_string()).collect(),
        bytes: util::dir_size(&target),
    })
}

fn resolve_model_dir(state: &AppState, model: &str) -> AppResult<PathBuf> {
    let dirs = model_dirs(state);
    if dirs.is_empty() {
        return Err(AppError::new(
            "MODEL_UNAVAILABLE",
            "未找到本地标签模型。请把 WD14 ONNX 模型放入 wd14Tagger/models 或在设置中指定模型目录。",
        ));
    }
    if model.trim().is_empty() {
        return Ok(dirs[0].clone());
    }
    dirs.into_iter()
        .find(|dir| dir.file_name().map(|n| n.to_string_lossy() == model).unwrap_or(false))
        .ok_or_else(|| AppError::new("MODEL_UNAVAILABLE", "所选模型不可用"))
}

fn run_tagger(
    image: &Path,
    model_dir: &Path,
    threshold: f64,
    character_threshold: f64,
    script: &Path,
    python: &str,
) -> AppResult<TaggerOutput> {
    let mut child = util::hidden_command(python)
        .arg("-I")
        .arg(script)
        .arg("--image")
        .arg(image)
        .arg("--model-dir")
        .arg(model_dir)
        .arg("--threshold")
        .arg(format!("{threshold}"))
        .arg("--character-threshold")
        .arg(format!("{character_threshold}"))
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppError::new(
                "MODEL_UNAVAILABLE",
                format!("无法启动本地标注模型运行时：{e}"),
            )
        })?;
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::new("MODEL_TIMEOUT", "本地标注模型推理超时"));
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(error) => {
                return Err(AppError::new("MODEL_ERROR", format!("模型进程异常：{error}")))
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::new("MODEL_ERROR", format!("读取模型输出失败：{e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::new(
            "MODEL_ERROR",
            format!("本地标注模型执行失败：{}", stderr.lines().last().unwrap_or("未知错误")),
        )
        .retryable(true));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .ok_or_else(|| AppError::new("MODEL_ERROR", "模型没有返回结构化结果"))?;
    serde_json::from_str::<TaggerOutput>(line)
        .map_err(|e| AppError::new("MODEL_ERROR", format!("模型结果解析失败：{e}")))
}

fn run_florence(
    image: &Path,
    model_dir: &Path,
    script: &Path,
    python: &str,
) -> AppResult<FlorenceOutput> {
    let mut child = util::hidden_command(python)
        .arg(script)
        .arg("--image")
        .arg(image)
        .arg("--model-dir")
        .arg(model_dir)
        .arg("--max-new-tokens")
        .arg("256")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppError::new(
                "MODEL_UNAVAILABLE",
                format!("无法启动 Florence-2 运行时：{e}。请在设置中指定安装 torch/transformers 的 Python。"),
            )
        })?;
    let deadline = Instant::now() + Duration::from_secs(360);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::new("MODEL_TIMEOUT", "Florence-2 推理超时"));
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(error) => {
                return Err(AppError::new("MODEL_ERROR", format!("Florence-2 进程异常：{error}")))
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::new("MODEL_ERROR", format!("读取 Florence-2 输出失败：{e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("未知错误");
        return Err(AppError::new(
            "MODEL_ERROR",
            format!("Florence-2 执行失败：{detail}"),
        )
        .retryable(true));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .ok_or_else(|| AppError::new("MODEL_ERROR", "Florence-2 没有返回结构化结果"))?;
    serde_json::from_str::<FlorenceOutput>(line)
        .map_err(|e| AppError::new("MODEL_ERROR", format!("Florence-2 结果解析失败：{e}")))
}

fn split_sentence_tags(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        match ch {
            '.' | '!' | '?' | '。' | '！' | '？' | '\n' | '\r' => {
                let sentence = current.trim();
                if !sentence.is_empty() {
                    sentences.push(sentence.to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let sentence = current.trim();
    if !sentence.is_empty() {
        sentences.push(sentence.to_string());
    }
    sentences
}

pub fn generate(
    state: &AppState,
    project: &Project,
    asset_id: &str,
    model_id: &str,
    threshold: f64,
    character_threshold: f64,
) -> AppResult<SuggestionResult> {
    let asset = {
        let conn = project.conn();
        db::get_asset(&conn, asset_id)?
    };
    let source = project.require_source(&asset)?;
    let is_florence = model_id == FLORENCE_ID;
    let script_name = if is_florence {
        "florence_infer.py"
    } else {
        "wd14_infer.py"
    };
    let script = state
        .worker_script
        .parent()
        .map(|dir| dir.join("tagging").join(script_name))
        .ok_or_else(|| AppError::new("MODEL_UNAVAILABLE", "缺少本地模型适配器脚本"))?;
    if !script.exists() {
        return Err(AppError::new(
            "MODEL_UNAVAILABLE",
            format!("缺少适配器脚本：{}", script.display()),
        ));
    }

    let (mode, tags, text, model_name, model_version, threshold_value, device, elapsed_ms, model_json, source_kind) =
        if is_florence {
            let model_dir = florence_model_dir(state).ok_or_else(|| {
                AppError::new(
                    "MODEL_UNAVAILABLE",
                    "未找到 Florence-2 权重。请先在设置中下载，或把 microsoft--Florence-2-base-ft 放入模型目录。",
                )
            })?;
            let python = florence_python(state);
            let result = run_florence(&source, &model_dir, &script, &python)?;
            let raw_text = result.text.trim().to_string();
            let tags = caption::normalize_tags(split_sentence_tags(&raw_text));
            if tags.is_empty() {
                return Err(AppError::new("MODEL_ERROR", "Florence-2 没有生成有效句子"));
            }
            let model_json = serde_json::json!({
                "model": result.model.clone(),
                "version": "safetensors",
                "task": "<MORE_DETAILED_CAPTION>",
                "device": result.device.clone(),
                "runtime": result.runtime.clone(),
                "elapsedMs": result.elapsed_ms,
                "rawText": raw_text,
                "generatedAt": util::now_iso(),
            });
            (
                "tags".to_string(),
                tags,
                String::new(),
                result.model,
                "safetensors / transformers".to_string(),
                0.0,
                result.device,
                result.elapsed_ms,
                model_json,
                "florence",
            )
        } else {
            let model_dir = resolve_model_dir(state, model_id)?;
            let python = tagger_python(state);
            let result =
                run_tagger(&source, &model_dir, threshold, character_threshold, &script, &python)?;
            let mode = {
                let conn = project.conn();
                asset
                    .caption_revision_id
                    .as_deref()
                    .and_then(|id| {
                        conn.query_row(
                            "SELECT mode FROM caption_revisions WHERE id = ?1",
                            rusqlite::params![id],
                            |row| row.get::<_, String>(0),
                        )
                        .ok()
                    })
                    .unwrap_or_else(|| project.default_caption_mode(&conn))
            };
            let tags = caption::normalize_tags(result.tags.iter().cloned());
            let text = if mode == "nl" {
                tags.join(", ")
            } else {
                String::new()
            };
            let model_json = serde_json::json!({
                "model": result.model.clone(),
                "version": "onnx",
                "threshold": threshold,
                "characterThreshold": character_threshold,
                "device": result.device.clone(),
                "runtime": result.runtime.clone(),
                "elapsedMs": result.elapsed_ms,
                "ratings": result.ratings,
                "generatedAt": util::now_iso(),
            });
            (
                mode,
                tags,
                text,
                result.model,
                "v3 / ONNX".to_string(),
                threshold,
                result.device,
                result.elapsed_ms,
                model_json,
                "wd14",
            )
        };

    let revision_id = {
        let conn = project.conn();
        captions::insert_suggestion(
            &conn,
            &asset,
            &mode,
            &tags,
            &text,
            source_kind,
            &model_json,
        )?
    };
    Ok(SuggestionResult {
        asset_id: asset_id.to_string(),
        revision_id,
        mode,
        tags,
        text,
        model: model_name,
        model_version,
        threshold: threshold_value,
        device,
        elapsed_ms,
    })
}
