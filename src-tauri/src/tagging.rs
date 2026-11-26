use crate::caption;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::model::{ModelCatalogEntry, ModelDownloadProgress, ModelDownloadResult, ModelInfo, SuggestionResult, TransformPlan};
use crate::project::captions;
use crate::project::Project;
use crate::state::AppState;
use crate::util;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
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
    // 发布版的唯一默认目录。旧目录仍作为兼容来源保留在后面。
    roots.push(state.install_root.join("models"));
    let settings = state.settings();
    if let Some(dir) = settings.models_dir.filter(|d| !d.trim().is_empty()) {
        let path = PathBuf::from(util::expand_user_home(&dir));
        if path.exists() {
            roots.push(path);
        }
    }
    let app_models = state.data_dir.join("models");
    roots.push(app_models);
    if let Some(root) = tagger_root() {
        roots.push(root.join("models"));
    }
    roots
}

fn models_root(state: &AppState) -> Option<PathBuf> {
    candidate_roots(state).into_iter().next().or_else(|| Some(download_root(state)))
}

pub fn download_root(state: &AppState) -> PathBuf {
    state.install_root.join("models")
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
    models.extend(crate::vlm::list_models(state));
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
            "未找到本地标签模型。请把 WD14 ONNX 模型放入应用安装目录下的 models 文件夹，或在设置页下载模型。",
        ));
    }
    if model.trim().is_empty() {
        return Ok(dirs[0].clone());
    }
    dirs.into_iter()
        .find(|dir| dir.file_name().map(|n| n.to_string_lossy() == model).unwrap_or(false))
        .ok_or_else(|| AppError::new("MODEL_UNAVAILABLE", "所选模型不可用"))
}

pub type SharedTaggerSession = Arc<Mutex<TaggerSession>>;

/// 批量打标期间常驻的模型进程；模型在批次开始时加载，结束后随会话销毁。
pub struct TaggerSession {
    child: Child,
    stdin: ChildStdin,
    receiver: Receiver<String>,
    next_id: u64,
    model_id: String,
    model_name: String,
    device: String,
    runtime: String,
    load_ms: u64,
}

impl TaggerSession {
    fn spawn(
        python: &str,
        script: &Path,
        model_dir: &Path,
        model_id: &str,
        isolated: bool,
        log_path: &Path,
        load_timeout: Duration,
    ) -> AppResult<Self> {
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let stderr = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(log_path)
            .ok();
        let mut command = util::hidden_command(python);
        if isolated {
            command.arg("-I");
        }
        command
            .arg(script)
            .arg("--model-dir")
            .arg(model_dir)
            .arg("--serve")
            .env("PYTHONIOENCODING", "utf-8")
            .current_dir(script.parent().unwrap_or(Path::new(".")))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if let Some(file) = stderr {
            command.stderr(Stdio::from(file));
        } else {
            command.stderr(Stdio::null());
        }

        let started = Instant::now();
        let mut child = command.spawn().map_err(|error| {
            AppError::new(
                "MODEL_UNAVAILABLE",
                format!("无法启动本地打标进程（{python}）：{error}"),
            )
            .retryable(true)
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::new("MODEL_UNAVAILABLE", "打标进程 stdin 不可用"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::new("MODEL_UNAVAILABLE", "打标进程 stdout 不可用"))?;
        let (tx, receiver) = channel::<String>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if tx.send(text).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let mut session = Self {
            child,
            stdin,
            receiver,
            next_id: 1,
            model_id: model_id.to_string(),
            model_name: String::new(),
            device: String::new(),
            runtime: String::new(),
            load_ms: 0,
        };
        let ready = session.wait_ready(load_timeout, log_path)?;
        session.model_name = ready
            .get("model")
            .and_then(|value| value.as_str())
            .unwrap_or("本地模型")
            .to_string();
        session.device = ready
            .get("device")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        session.runtime = ready
            .get("runtime")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        session.load_ms = started.elapsed().as_millis() as u64;
        Ok(session)
    }

    fn wait_ready(&mut self, timeout: Duration, log_path: &Path) -> AppResult<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                self.kill();
                return Err(AppError::new("MODEL_TIMEOUT", "本地模型加载超时").retryable(true));
            }
            match self.receiver.recv_timeout(deadline - now) {
                Ok(text) => {
                    let Ok(value) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if value.get("ready").and_then(|item| item.as_bool()) == Some(true) {
                        return Ok(value);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.kill();
                    return Err(AppError::new("MODEL_TIMEOUT", "本地模型加载超时").retryable(true));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.kill();
                    let tail = log_tail(log_path);
                    let detail = if tail.is_empty() {
                        String::new()
                    } else {
                        format!("：{tail}")
                    };
                    return Err(AppError::new(
                        "MODEL_ERROR",
                        format!("本地模型加载失败{detail}"),
                    )
                    .retryable(true));
                }
            }
        }
    }

    fn call(&mut self, image: &Path, params: Value, timeout: Duration) -> AppResult<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let mut request = match params {
            Value::Object(map) => Value::Object(map),
            _ => serde_json::json!({}),
        };
        request["id"] = serde_json::json!(id);
        request["image"] = serde_json::json!(image.to_string_lossy());
        let line = serde_json::to_string(&request)?;
        writeln!(self.stdin, "{line}")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| {
                AppError::new("MODEL_INTERRUPTED", format!("写入打标进程失败：{error}"))
                    .retryable(true)
            })?;

        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                self.kill();
                return Err(AppError::new("MODEL_TIMEOUT", "本地模型推理超时").retryable(true));
            }
            match self.receiver.recv_timeout(deadline - now) {
                Ok(text) => {
                    let Ok(value) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if value.get("id").and_then(|item| item.as_u64()) != Some(id) {
                        continue;
                    }
                    if value.get("ok").and_then(|item| item.as_bool()) == Some(true) {
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                    let error = value.get("error").cloned().unwrap_or(Value::Null);
                    let message = error
                        .get("message")
                        .and_then(|item| item.as_str())
                        .unwrap_or("本地模型推理失败")
                        .to_string();
                    let code = error
                        .get("code")
                        .and_then(|item| item.as_str())
                        .unwrap_or("MODEL_ERROR")
                        .to_string();
                    return Err(AppError::new(&code, message).retryable(true));
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.kill();
                    return Err(AppError::new("MODEL_TIMEOUT", "本地模型推理超时").retryable(true));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.kill();
                    return Err(
                        AppError::new("MODEL_INTERRUPTED", "本地打标进程已退出，请重试")
                            .retryable(true),
                    );
                }
            }
        }
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        // 终止进程后最多等待 300ms 回收，绝不无限阻塞：
        // 某些模型进程在退出前会卡在驱动/显存释放里，如果这里一直 wait，
        // tagger_batch_end 就永远不返回，下一次批量打标会被前端锁死。
        for _ in 0..15 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => return,
            }
        }
    }
}

impl Drop for TaggerSession {
    fn drop(&mut self) {
        self.kill();
    }
}

fn log_tail(path: &Path) -> String {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| {
            text.lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaggerModelSessionInfo {
    pub model_id: String,
    pub model: String,
    pub device: String,
    pub runtime: String,
    pub load_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaggerBatchInfo {
    pub models: Vec<TaggerModelSessionInfo>,
    pub load_ms: u64,
}

/// 批量打标开始时加载所有选中模型；同一批次内复用，直到 end_batch。
pub fn begin_batch(state: &AppState, model_ids: &[String]) -> AppResult<TaggerBatchInfo> {
    let mut ids: Vec<String> = Vec::new();
    for model_id in model_ids {
        let model_id = model_id.trim();
        if model_id.is_empty() {
            continue;
        }
        if !ids.iter().any(|existing| existing == model_id) {
            ids.push(model_id.to_string());
        }
    }
    if ids.is_empty() {
        return Err(AppError::new("MODEL_UNAVAILABLE", "未选择打标模型"));
    }

    // 清掉上一次可能残留的常驻进程，避免批量切换模型时占用显存/内存。
    end_batch(state);
    let generation = state.tagger_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut sessions: Vec<(String, SharedTaggerSession)> = Vec::new();
    let mut infos: Vec<TaggerModelSessionInfo> = Vec::new();
    for model_id in ids.iter().filter(|model_id| !crate::vlm::is_model(model_id)) {
        let session = spawn_session(state, model_id).map_err(|mut error| {
            error.message = format!("{model_id}：{}", error.message);
            error
        })?;
        infos.push(TaggerModelSessionInfo {
            model_id: session.model_id.clone(),
            model: session.model_name.clone(),
            device: session.device.clone(),
            runtime: session.runtime.clone(),
            load_ms: session.load_ms,
        });
        sessions.push((model_id.clone(), Arc::new(Mutex::new(session))));
    }
    // 模型加载期间用户可能已经取消/重新发起批次；旧批次不得把会话回填到状态里。
    if state.tagger_generation.load(Ordering::SeqCst) != generation {
        drop(sessions);
        return Err(AppError::new(
            "MODEL_INTERRUPTED",
            "批量打标已被新的批次替代，请重新开始",
        ));
    }
    let load_ms = infos.iter().map(|info| info.load_ms).sum();
    {
        let mut map = state.tagger_sessions.lock();
        for (model_id, session) in sessions {
            map.insert(model_id, session);
        }
    }
    Ok(TaggerBatchInfo {
        models: infos,
        load_ms,
    })
}

/// 批量打标结束后释放所有常驻模型进程。
pub fn end_batch(state: &AppState) {
    // 递增代际：让仍在加载的旧 begin_batch 失效，避免它在释放后回填会话。
    state.tagger_generation.fetch_add(1, Ordering::SeqCst);
    let drained: Vec<SharedTaggerSession> = {
        let mut map = state.tagger_sessions.lock();
        map.drain().map(|(_, session)| session).collect()
    };
    drop(drained);
}

fn spawn_session(state: &AppState, model_id: &str) -> AppResult<TaggerSession> {
    let (python, script, model_dir, isolated, timeout) = if model_id == FLORENCE_ID {
        let model_dir = florence_model_dir(state).ok_or_else(|| {
            AppError::new(
                "MODEL_UNAVAILABLE",
                "未找到 Florence-2 权重。请先在设置中下载，或把 microsoft--Florence-2-base-ft 放入模型目录。",
            )
        })?;
        (
            florence_python(state),
            adapter_script(state, "florence_infer.py")?,
            model_dir,
            false,
            Duration::from_secs(600),
        )
    } else {
        (
            tagger_python(state),
            adapter_script(state, "wd14_infer.py")?,
            resolve_model_dir(state, model_id)?,
            true,
            Duration::from_secs(300),
        )
    };
    let digest = util::sha256_text(model_id);
    let log_path = state
        .data_dir
        .join("logs")
        .join(format!("tagger-{}.log", digest.get(..10).unwrap_or("model")));
    TaggerSession::spawn(
        &python,
        &script,
        &model_dir,
        model_id,
        isolated,
        &log_path,
        timeout,
    )
}

fn session_for(state: &AppState, model_id: &str) -> Option<SharedTaggerSession> {
    state.tagger_sessions.lock().get(model_id).cloned()
}

fn drop_session_if(state: &AppState, model_id: &str, session: &SharedTaggerSession) {
    let removed = {
        let mut map = state.tagger_sessions.lock();
        let same = map
            .get(model_id)
            .map(|existing| Arc::ptr_eq(existing, session))
            .unwrap_or(false);
        if same {
            map.remove(model_id)
        } else {
            None
        }
    };
    drop(removed);
}

fn session_error_is_fatal(error: &AppError) -> bool {
    matches!(
        error.code.as_str(),
        "MODEL_TIMEOUT" | "MODEL_INTERRUPTED" | "MODEL_UNAVAILABLE" | "MODEL_PROTOCOL"
    )
}

fn call_tagger_session(
    session: &SharedTaggerSession,
    image: &Path,
    threshold: f64,
    character_threshold: f64,
) -> AppResult<TaggerOutput> {
    let result = {
        let mut guard = session.lock();
        guard.call(
            image,
            serde_json::json!({
                "threshold": threshold,
                "characterThreshold": character_threshold,
                "maxTags": 80,
            }),
            Duration::from_secs(240),
        )
    }?;
    serde_json::from_value::<TaggerOutput>(result)
        .map_err(|error| AppError::new("MODEL_PROTOCOL", format!("模型结果解析失败：{error}")))
}

fn call_florence_session(
    session: &SharedTaggerSession,
    image: &Path,
) -> AppResult<FlorenceOutput> {
    let result = {
        let mut guard = session.lock();
        guard.call(
            image,
            serde_json::json!({
                "task": "<MORE_DETAILED_CAPTION>",
                "maxNewTokens": 256,
            }),
            Duration::from_secs(360),
        )
    }?;
    serde_json::from_value::<FlorenceOutput>(result)
        .map_err(|error| AppError::new("MODEL_PROTOCOL", format!("模型结果解析失败：{error}")))
}

fn run_tagger_once(
    state: &AppState,
    source: &Path,
    model_id: &str,
    threshold: f64,
    character_threshold: f64,
) -> AppResult<TaggerOutput> {
    let model_dir = resolve_model_dir(state, model_id)?;
    let script = adapter_script(state, "wd14_infer.py")?;
    let python = tagger_python(state);
    run_tagger(source, &model_dir, threshold, character_threshold, &script, &python)
}

fn run_florence_once(state: &AppState, source: &Path) -> AppResult<FlorenceOutput> {
    let model_dir = florence_model_dir(state).ok_or_else(|| {
        AppError::new(
            "MODEL_UNAVAILABLE",
            "未找到 Florence-2 权重。请先在设置中下载，或把 microsoft--Florence-2-base-ft 放入模型目录。",
        )
    })?;
    let script = adapter_script(state, "florence_infer.py")?;
    let python = florence_python(state);
    run_florence(source, &model_dir, &script, &python)
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

/// 临时文件在离开作用域时删除，避免打标失败留下大图副本。
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// 当前素材已应用的裁剪配方。
fn applied_plan(project: &Project, asset: &db::AssetRow) -> TransformPlan {
    let json = {
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
    };
    json.and_then(|text| serde_json::from_str::<TransformPlan>(&text).ok())
        .unwrap_or_default()
        .sanitized()
}

/// 生成打标输入：按已应用的裁剪配方渲染，原图不直接送入模型。
fn render_for_tagging(
    state: &AppState,
    project: &Project,
    asset: &db::AssetRow,
) -> AppResult<TempFile> {
    let source = project.require_source(asset)?;
    let plan = applied_plan(project, asset);
    let out = project
        .staging_dir()
        .join(format!("tagging-{}-{}.png", &asset.id[..8.min(asset.id.len())], util::short_id(8)));
    if let Some(parent) = out.parent() {
        util::ensure_dir(parent)?;
    }
    let out = TempFile(out);
    state
        .worker
        .render_interactive(&source, &plan, &out.0, Some(2048), Some("png"), 300)?;
    Ok(out)
}

struct ModelRun {
    kind: &'static str,
    tags: Vec<String>,
    mode: String,
    text: String,
    model: String,
    version: String,
    threshold: f64,
    device: String,
    elapsed_ms: u64,
    model_json: serde_json::Value,
}

fn adapter_script(state: &AppState, script_name: &str) -> AppResult<PathBuf> {
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
    Ok(script)
}

/// 运行单个模型，返回该模型的标签与元数据；多模型并集在 generate 中合并。
fn run_model(
    state: &AppState,
    project: &Project,
    asset: &db::AssetRow,
    source: &Path,
    model_id: &str,
    threshold: f64,
    character_threshold: f64,
) -> AppResult<ModelRun> {
    if crate::vlm::is_model(model_id) {
        let start = Instant::now();
        let run = crate::vlm::run(state, model_id, source)?;
        let mode = match (run.output.tags.is_empty(), run.output.caption.is_empty()) {
            (true, _) => "nl",
            (_, true) => "tags",
            _ => "mixed",
        };
        return Ok(ModelRun {
            kind: "vlm", tags: run.output.tags, mode: mode.into(), text: run.output.caption,
            model: run.name, version: run.provider, threshold: 0.0, device: "HTTP".into(),
            elapsed_ms: start.elapsed().as_millis() as u64, model_json: run.metadata,
        });
    }
    if model_id == FLORENCE_ID {
        let result = if let Some(session) = session_for(state, FLORENCE_ID) {
            match call_florence_session(&session, source) {
                Ok(result) => result,
                Err(error) if session_error_is_fatal(&error) => {
                    // 常驻进程异常时移除会话，本张回退到一次性进程。
                    drop_session_if(state, FLORENCE_ID, &session);
                    drop(session);
                    run_florence_once(state, source)?
                }
                Err(error) => return Err(error),
            }
        } else {
            run_florence_once(state, source)?
        };
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
        Ok(ModelRun {
            kind: "florence",
            tags,
            mode: "tags".to_string(),
            text: String::new(),
            model: result.model,
            version: "safetensors / transformers".to_string(),
            threshold: 0.0,
            device: result.device,
            elapsed_ms: result.elapsed_ms,
            model_json,
        })
    } else {
        let result = if let Some(session) = session_for(state, model_id) {
            match call_tagger_session(&session, source, threshold, character_threshold) {
                Ok(result) => result,
                Err(error) if session_error_is_fatal(&error) => {
                    // 常驻进程异常时移除会话，本张回退到一次性进程。
                    drop_session_if(state, model_id, &session);
                    drop(session);
                    run_tagger_once(state, source, model_id, threshold, character_threshold)?
                }
                Err(error) => return Err(error),
            }
        } else {
            run_tagger_once(state, source, model_id, threshold, character_threshold)?
        };
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
        Ok(ModelRun {
            kind: "wd14",
            tags,
            mode,
            text,
            model: result.model,
            version: "v3 / ONNX".to_string(),
            threshold,
            device: result.device,
            elapsed_ms: result.elapsed_ms,
            model_json,
        })
    }
}

pub fn generate(
    state: &AppState,
    project: &Project,
    asset_id: &str,
    model_ids: &[String],
    threshold: f64,
    character_threshold: f64,
) -> AppResult<SuggestionResult> {
    let asset = {
        let conn = project.conn();
        db::get_asset(&conn, asset_id)?
    };
    // 模型输入统一使用按裁剪配方渲染后的图片；原图只用于生成临时副本。
    let tag_source = render_for_tagging(state, project, &asset)?;
    let source = tag_source.0.as_path();

    let mut ids: Vec<String> = Vec::new();
    for model_id in model_ids {
        let model_id = model_id.trim();
        if model_id.is_empty() {
            continue;
        }
        if !ids.iter().any(|existing| existing == model_id) {
            ids.push(model_id.to_string());
        }
    }
    if ids.is_empty() {
        // 兼容旧请求：空模型时由 resolve_model_dir 选择第一个 WD14 模型。
        ids.push(String::new());
    }

    let mut runs: Vec<ModelRun> = Vec::with_capacity(ids.len());
    for model_id in &ids {
        let run = run_model(
            state,
            project,
            &asset,
            source,
            model_id,
            threshold,
            character_threshold,
        )
        .map_err(|mut error| {
            if !model_id.is_empty() {
                error.message = format!("{model_id}：{}", error.message);
            }
            error
        })?;
        runs.push(run);
    }

    let multiple = runs.len() > 1;
    // 多模型结果按首次出现顺序取并集；normalize_tags 负责全半角/大小写归一化去重。
    let tags = if multiple {
        caption::normalize_tags(runs.iter().flat_map(|run| run.tags.iter().cloned()))
    } else {
        runs[0].tags.clone()
    };
    let vision_language = runs.iter().any(|run| run.kind == "vlm");
    let text = if !multiple {
        runs[0].text.clone()
    } else {
        let mut seen = std::collections::HashSet::new();
        runs.iter().filter(|run| run.kind == "vlm")
            .flat_map(|run| run.text.split_inclusive(['.', '!', '?']))
            .map(str::trim)
            .filter(|sentence| !sentence.is_empty() && seen.insert(sentence.to_ascii_lowercase()))
            .collect::<Vec<_>>().join(" ")
    };
    let mode = if !multiple {
        runs[0].mode.clone()
    } else if text.is_empty() {
        "tags".into()
    } else if tags.is_empty() {
        "nl".into()
    } else {
        "mixed".into()
    };
    let model_name = if multiple {
        runs.iter()
            .map(|run| run.model.clone())
            .collect::<Vec<_>>()
            .join(" + ")
    } else {
        runs[0].model.clone()
    };
    let model_version = if multiple {
        "multi-model".to_string()
    } else {
        runs[0].version.clone()
    };
    let mut devices: Vec<String> = Vec::new();
    for run in &runs {
        if !devices.iter().any(|device| device == &run.device) {
            devices.push(run.device.clone());
        }
    }
    let device = if multiple {
        devices.join(" + ")
    } else {
        runs[0].device.clone()
    };
    let elapsed_ms = if multiple {
        runs.iter().map(|run| run.elapsed_ms).sum::<u64>()
    } else {
        runs[0].elapsed_ms
    };
    let threshold_value = if multiple {
        runs.iter()
            .map(|run| run.threshold)
            .find(|value| *value > 0.0)
            .unwrap_or(0.0)
    } else {
        runs[0].threshold
    };
    let source_kind = if multiple { "multi" } else { runs[0].kind };
    let model_json = if multiple {
        serde_json::json!({
            "model": model_name.clone(),
            "version": model_version.clone(),
            "threshold": threshold_value,
            "device": device.clone(),
            "elapsedMs": elapsed_ms,
            "models": runs.iter().map(|run| run.model_json.clone()).collect::<Vec<_>>(),
            "generatedAt": util::now_iso(),
        })
    } else {
        runs[0].model_json.clone()
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
        vision_language,
        model: model_name,
        model_version,
        threshold: threshold_value,
        device,
        elapsed_ms,
    })
}
