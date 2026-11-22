use crate::error::{AppError, AppResult};
use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeInfo {
    pub width: u32,
    pub height: u32,
    pub raw_width: u32,
    pub raw_height: u32,
    pub format: String,
    pub mode: String,
    pub frames: u32,
    pub has_alpha: bool,
    pub icc: bool,
    pub icc_description: Option<String>,
    pub orientation: u32,
    pub phash: String,
    pub blur: f64,
    pub dark_ratio: f64,
    pub bright_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderGeometry {
    pub normalized_width: u32,
    pub normalized_height: u32,
    pub rotated_width: u32,
    pub rotated_height: u32,
    pub crop_width: u32,
    pub crop_height: u32,
    pub scaled_width: u32,
    pub scaled_height: u32,
    pub out_width: u32,
    pub out_height: u32,
    pub crop_ratio: f64,
    pub pad_ratio: f64,
    pub scale_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderInfo {
    pub width: u32,
    pub height: u32,
    pub geometry: RenderGeometry,
    pub frames: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingInfo {
    pub python: String,
    pub pillow: String,
    pub platform: String,
}

struct Worker {
    child: Child,
    stdin: ChildStdin,
    receiver: Receiver<String>,
    next_id: Arc<AtomicU64>,
}

impl Worker {
    fn spawn(python: &str, script: &Path, log_path: &Path) -> AppResult<Self> {
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let stderr = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .map(Some)
            .unwrap_or(None);
        let mut command = crate::util::hidden_command(python);
        command
            .arg("-I")
            .arg(script)
            .current_dir(script.parent().unwrap_or(Path::new(".")))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if let Some(file) = stderr {
            command.stderr(Stdio::from(file));
        } else {
            command.stderr(Stdio::null());
        }
        let mut child = command.spawn().map_err(|e| {
            AppError::new(
                "WORKER_UNAVAILABLE",
                format!("无法启动图像工作进程（{python}）：{e}"),
            )
            .retryable(true)
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::new("WORKER_UNAVAILABLE", "工作进程 stdin 不可用"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::new("WORKER_UNAVAILABLE", "工作进程 stdout 不可用"))?;
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
        Ok(Self {
            child,
            stdin,
            receiver,
            next_id: Arc::new(AtomicU64::new(1)),
        })
    }

    fn call(&mut self, op: &str, params: Value, timeout: Duration) -> AppResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = json!({ "id": id, "op": op, "params": params });
        let line = serde_json::to_string(&request)?;
        writeln!(self.stdin, "{line}")
            .and_then(|_| self.stdin.flush())
            .map_err(|e| {
                AppError::new("WORKER_INTERRUPTED", format!("写入工作进程失败：{e}")).retryable(true)
            })?;
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                self.kill();
                return Err(AppError::new(
                    "WORKER_TIMEOUT",
                    format!("图像处理超时（{op}）"),
                )
                .retryable(true));
            }
            match self.receiver.recv_timeout(deadline - now) {
                Ok(text) => {
                    let value: Value = match serde_json::from_str(&text) {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                    if value.get("id").and_then(|v| v.as_u64()) != Some(id) {
                        continue;
                    }
                    if value.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                    let error = value.get("error").cloned().unwrap_or(Value::Null);
                    let message = error
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("图像处理失败")
                        .to_string();
                    let code = error
                        .get("code")
                        .and_then(|v| v.as_str())
                        .unwrap_or("WORKER_OP_FAILED")
                        .to_string();
                    return Err(AppError::new(&code, message).retryable(true));
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.kill();
                    return Err(AppError::new(
                        "WORKER_TIMEOUT",
                        format!("图像处理超时（{op}）"),
                    )
                    .retryable(true));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.kill();
                    return Err(AppError::new(
                        "WORKER_INTERRUPTED",
                        "图像工作进程已退出，请重试",
                    )
                    .retryable(true));
                }
            }
        }
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.kill();
    }
}

/// 固定图像处理槽位（默认 2 个），任务与命令共享。
pub struct WorkerPool {
    slots: Vec<Arc<Mutex<Option<Worker>>>>,
    idle: Mutex<VecDeque<usize>>,
    cv: Condvar,
    python: String,
    script: PathBuf,
    log_path: PathBuf,
    last_error: Mutex<Option<String>>,
}

impl WorkerPool {
    pub fn new(python: String, script: PathBuf, log_path: PathBuf, slots: usize) -> Self {
        let count = slots.max(1);
        let mut queue = VecDeque::new();
        for index in 0..count {
            queue.push_back(index);
        }
        Self {
            slots: (0..count).map(|_| Arc::new(Mutex::new(None))).collect(),
            idle: Mutex::new(queue),
            cv: Condvar::new(),
            python,
            script,
            log_path,
            last_error: Mutex::new(None),
        }
    }

    pub fn python(&self) -> &str {
        &self.python
    }

    pub fn script(&self) -> &Path {
        &self.script
    }

    pub fn log_path(&self) -> &Path {
        &self.log_path
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().clone()
    }

    pub fn worker_count(&self) -> usize {
        self.slots.len()
    }

    pub fn ping(&self) -> AppResult<PingInfo> {
        let value = self.call("ping", json!({}), Duration::from_secs(30))?;
        let info: PingInfo = serde_json::from_value(value)
            .map_err(|e| AppError::new("WORKER_PROTOCOL", format!("工作进程响应异常：{e}")))?;
        Ok(info)
    }

    pub fn call(&self, op: &str, params: Value, timeout: Duration) -> AppResult<Value> {
        let index = self.acquire()?;
        let slot = self.slots[index].clone();
        let result = self.call_slot(&slot, op, params, timeout);
        if let Err(error) = &result {
            *self.last_error.lock() = Some(error.message.clone());
        }
        self.idle.lock().push_back(index);
        self.cv.notify_one();
        result
    }

    fn acquire(&self) -> AppResult<usize> {
        let deadline = Instant::now() + Duration::from_secs(180);
        let mut queue = self.idle.lock();
        loop {
            if let Some(index) = queue.pop_front() {
                return Ok(index);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(AppError::new(
                    "WORKER_BUSY",
                    "图像处理队列繁忙，请稍后重试",
                )
                .retryable(true));
            }
            if self
                .cv
                .wait_for(&mut queue, deadline - now)
                .timed_out()
            {
                return Err(AppError::new(
                    "WORKER_BUSY",
                    "图像处理队列繁忙，请稍后重试",
                )
                .retryable(true));
            }
        }
    }

    fn call_slot(
        &self,
        slot: &Arc<Mutex<Option<Worker>>>,
        op: &str,
        params: Value,
        timeout: Duration,
    ) -> AppResult<Value> {
        let mut guard = slot.lock();
        if guard.is_none() {
            *guard = Some(Worker::spawn(&self.python, &self.script, &self.log_path)?);
        }
        let worker = guard.as_mut().expect("worker initialized");
        match worker.call(op, params, timeout) {
            Ok(value) => {
                *self.last_error.lock() = None;
                Ok(value)
            }
            Err(error) => {
                *guard = None;
                Err(error)
            }
        }
    }

    pub fn analyze(&self, path: &Path) -> AppResult<AnalyzeInfo> {
        let value = self.call(
            "analyze",
            json!({ "path": path.to_string_lossy() }),
            Duration::from_secs(120),
        )?;
        serde_json::from_value(value)
            .map_err(|e| AppError::new("WORKER_PROTOCOL", format!("分析结果异常：{e}")))
    }

    pub fn render(
        &self,
        source: &Path,
        plan: &crate::model::TransformPlan,
        out: &Path,
        max_side: Option<u32>,
        format: Option<&str>,
        timeout_secs: u64,
    ) -> AppResult<RenderInfo> {
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut params = json!({
            "path": source.to_string_lossy(),
            "out": out.to_string_lossy(),
            "plan": plan,
        });
        if let Some(side) = max_side {
            params["maxSide"] = json!(side);
        }
        if let Some(format) = format {
            params["format"] = json!(format);
        }
        let value = self.call("render", params, Duration::from_secs(timeout_secs))?;
        serde_json::from_value(value)
            .map_err(|e| AppError::new("WORKER_PROTOCOL", format!("渲染结果异常：{e}")))
    }

    pub fn thumbnail(
        &self,
        source: &Path,
        plan: Option<&crate::model::TransformPlan>,
        out: &Path,
        size: u32,
    ) -> AppResult<()> {
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut params = json!({
            "path": source.to_string_lossy(),
            "out": out.to_string_lossy(),
            "size": size,
        });
        if let Some(plan) = plan {
            params["plan"] = serde_json::to_value(plan)?;
        }
        self.call("thumbnail", params, Duration::from_secs(120))?;
        Ok(())
    }

    pub fn display(&self, source: &Path, out: &Path, max_side: u32) -> AppResult<Value> {
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        self.call(
            "display",
            json!({
                "path": source.to_string_lossy(),
                "out": out.to_string_lossy(),
                "maxSide": max_side,
            }),
            Duration::from_secs(120),
        )
    }

    pub fn generate_sample(&self, dir: &Path) -> AppResult<Value> {
        std::fs::create_dir_all(dir)?;
        self.call(
            "sample",
            json!({ "dir": dir.to_string_lossy() }),
            Duration::from_secs(300),
        )
    }
}
