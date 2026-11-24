use crate::error::{AppError, AppResult};
use crate::model::{AppSettings, RecentProject, RecentStore};
use crate::project::Project;
use crate::util;
use crate::worker::WorkerPool;
use parking_lot::{Condvar, Mutex, RwLock};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub struct JobControl {
    pub cancel: AtomicBool,
    pub pause: AtomicBool,
}

/// 去重摘要缓存：按项目、候选指纹和阈值复用，避免图库角标重复扫描整库。
#[derive(Clone)]
pub struct DedupeCacheEntry {
    pub fingerprint: String,
    pub threshold: u32,
    pub summary: crate::project::quality::DedupeSummary,
}

/// 有界并发闸门：超过容量的图片协议请求排队，避免快速滚动时线程持续堆积。
pub struct ImageGate {
    capacity: usize,
    active: Mutex<usize>,
    cv: Condvar,
}

impl ImageGate {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            active: Mutex::new(0),
            cv: Condvar::new(),
        }
    }

    pub fn acquire(&self) -> ImageGateGuard<'_> {
        let mut active = self.active.lock();
        while *active >= self.capacity {
            self.cv.wait(&mut active);
        }
        *active += 1;
        ImageGateGuard { gate: self }
    }
}

pub struct ImageGateGuard<'a> {
    gate: &'a ImageGate,
}

impl Drop for ImageGateGuard<'_> {
    fn drop(&mut self) {
        let mut active = self.gate.active.lock();
        *active = active.saturating_sub(1);
        self.gate.cv.notify_one();
    }
}

impl Default for JobControl {
    fn default() -> Self {
        Self {
            cancel: AtomicBool::new(false),
            pause: AtomicBool::new(false),
        }
    }
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub settings: RwLock<AppSettings>,
    pub recent: RwLock<RecentStore>,
    pub project: RwLock<Option<Arc<Project>>>,
    pub worker: WorkerPool,
    pub scans: Mutex<HashMap<String, crate::project::import::ScanCache>>,
    pub batch_previews: Mutex<HashMap<String, crate::project::assets::PendingBatch>>,
    pub export_previews: Mutex<HashMap<String, crate::exports::PendingExport>>,
    pub job_controls: Mutex<HashMap<String, Arc<JobControl>>>,
    pub dedupe_cache: Mutex<HashMap<String, DedupeCacheEntry>>,
    /// 图片协议中同一张图的并发请求合并；键为项目/资产/变体/版本。
    pub asset_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// 限制图片协议同时等待图像槽位的请求数，避免快速滚动时线程堆积。
    pub protocol_gate: std::sync::Arc<ImageGate>,
    pub python: String,
    pub worker_script: PathBuf,
    pub worker_log: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf, resource_dir: Option<PathBuf>, python_override: Option<String>) -> AppResult<Self> {
        util::ensure_dir(&data_dir)?;
        util::ensure_dir(&data_dir.join("logs"))?;
        let settings = load_settings(&data_dir);
        let recent = load_recent(&data_dir);
        let python = resolve_python(
            python_override
                .or_else(|| settings.python_path.clone())
                .as_deref(),
        );
        let worker_script = resolve_worker_script(resource_dir.as_deref())?;
        let worker_log = data_dir.join("logs").join("worker.log");
        let image_slots = settings.image_slots.clamp(1, 8) as usize;
        let worker = WorkerPool::new(
            python.clone(),
            worker_script.clone(),
            worker_log.clone(),
            image_slots,
        );
        Ok(Self {
            data_dir,
            settings: RwLock::new(settings),
            recent: RwLock::new(recent),
            project: RwLock::new(None),
            worker,
            scans: Mutex::new(HashMap::new()),
            batch_previews: Mutex::new(HashMap::new()),
            export_previews: Mutex::new(HashMap::new()),
            job_controls: Mutex::new(HashMap::new()),
            dedupe_cache: Mutex::new(HashMap::new()),
            asset_locks: Mutex::new(HashMap::new()),
            protocol_gate: std::sync::Arc::new(ImageGate::new(image_slots * 2 + 2)),
            python,
            worker_script,
            worker_log,
        })
    }

    pub fn project(&self) -> AppResult<Arc<Project>> {
        self.project
            .read()
            .clone()
            .ok_or_else(AppError::no_project)
    }

    pub fn set_project(&self, project: Option<Arc<Project>>) {
        *self.project.write() = project;
    }

    pub fn open_project_path(&self, path: &Path) -> AppResult<Arc<Project>> {
        let project = Arc::new(crate::project::open_project(path)?);
        let info = crate::project::project_info(&project)?;
        self.set_project(Some(project.clone()));
        {
            let mut recent = self.recent.write();
            upsert_recent(&mut recent, &info, path);
            let _ = save_recent(&self.data_dir, &recent);
        }
        Ok(project)
    }

    pub fn remove_recent(&self, id: &str) -> AppResult<()> {
        let mut recent = self.recent.write();
        recent.projects.retain(|p| p.id != id);
        save_recent(&self.data_dir, &recent)
    }

    pub fn toggle_recent_pin(&self, id: &str) -> AppResult<()> {
        let mut recent = self.recent.write();
        if let Some(entry) = recent.projects.iter_mut().find(|p| p.id == id) {
            entry.pinned = !entry.pinned;
        }
        save_recent(&self.data_dir, &recent)
    }

    pub fn settings(&self) -> AppSettings {
        self.settings.read().clone()
    }

    pub fn save_settings(&self, settings: &AppSettings) -> AppResult<()> {
        *self.settings.write() = settings.clone();
        save_settings_file(&self.data_dir, settings)
    }

    pub fn mark_recent_missing(&self) -> AppResult<()> {
        let mut recent = self.recent.write();
        let mut changed = false;
        for entry in recent.projects.iter_mut() {
            let missing = !Path::new(&entry.path).join(crate::project::PROJECT_FILE).exists();
            if entry.missing != missing {
                entry.missing = missing;
                changed = true;
            }
        }
        if changed {
            save_recent(&self.data_dir, &recent)?;
        }
        Ok(())
    }
}

pub fn load_settings(data_dir: &Path) -> AppSettings {
    std::fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_settings_file(data_dir: &Path, settings: &AppSettings) -> AppResult<()> {
    util::write_atomic(
        &data_dir.join("settings.json"),
        serde_json::to_string_pretty(settings)?.as_bytes(),
    )
}

pub fn load_recent(data_dir: &Path) -> RecentStore {
    let mut store: RecentStore = std::fs::read_to_string(data_dir.join("recent.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    for entry in store.projects.iter_mut() {
        entry.missing = !Path::new(&entry.path).join(crate::project::PROJECT_FILE).exists();
    }
    store
}

pub fn save_recent(data_dir: &Path, store: &RecentStore) -> AppResult<()> {
    util::write_atomic(
        &data_dir.join("recent.json"),
        serde_json::to_string_pretty(store)?.as_bytes(),
    )
}

pub fn recent_list(state: &AppState) -> Vec<RecentProject> {
    let mut entries = state.recent.read().projects.clone();
    for entry in entries.iter_mut() {
        entry.missing = !Path::new(&entry.path).join(crate::project::PROJECT_FILE).exists();
    }
    entries.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.last_opened.cmp(&a.last_opened))
    });
    entries
}

pub fn sync_recent_for_project(state: &AppState, project: &Project) {
    if let Ok(info) = crate::project::project_info(project) {
        let mut recent = state.recent.write();
        upsert_recent(&mut recent, &info, &project.root);
        let _ = save_recent(&state.data_dir, &recent);
    }
}

pub fn upsert_recent(store: &mut RecentStore, info: &crate::model::ProjectInfo, path: &Path) {
    let canonical = path.to_string_lossy().to_string();
    if let Some(entry) = store.projects.iter_mut().find(|p| p.id == info.id) {
        entry.name = info.name.clone();
        entry.model = info.model.clone();
        entry.path = canonical;
        entry.image_count = info.counts.total;
        entry.last_opened = util::now_iso();
        entry.missing = false;
    } else {
        store.projects.push(RecentProject {
            id: info.id.clone(),
            name: info.name.clone(),
            model: info.model.clone(),
            path: canonical,
            image_count: info.counts.total,
            last_opened: util::now_iso(),
            pinned: false,
            missing: false,
        });
    }
    if store.projects.len() > 60 {
        store.projects.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.last_opened.cmp(&a.last_opened))
        });
        store.projects.truncate(60);
    }
}

/// 开发机上的候选运行时。发布构建不应探测构建机的绝对路径与 wd14Tagger，
/// 否则同机测试会掩盖目标机缺少 Python / Pillow 的问题。
fn existing_python(script_root: &Path) -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let candidates = [
        script_root.join("runtime").join("python").join("python.exe"),
        script_root.join("python").join("python.exe"),
        script_root.join("wd14Tagger").join("python31010").join("python.exe"),
        PathBuf::from("C:\\Python313\\python.exe"),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 图像工作进程、WD14 与 Florence 共用的解释器解析顺序：
/// 设置中的 Python → `YOYOKU_PYTHON` → 开发机候选 → PATH 中的 `python`。
pub fn resolve_python(preferred: Option<&str>) -> String {
    if let Some(path) = preferred {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(env_path) = std::env::var("YOYOKU_PYTHON") {
        if !env_path.trim().is_empty() {
            return env_path;
        }
    }
    if let Some(found) = existing_python(&workspace_root()) {
        return found;
    }
    "python".to_string()
}

pub fn resolve_worker_script(resource_dir: Option<&Path>) -> AppResult<PathBuf> {
    if let Ok(path) = std::env::var("YOYOKU_WORKER_SCRIPT") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(resource) = resource_dir {
        candidates.push(resource.join("worker").join("main.py"));
        candidates.push(resource.join("_up_").join("worker").join("main.py"));
    }
    if cfg!(debug_assertions) {
        // 仅在开发构建中使用仓库内的脚本，避免发布版误用构建机源码。
        candidates.push(workspace_root().join("worker").join("main.py"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("worker").join("main.py"));
            candidates.push(parent.join("..").join("worker").join("main.py"));
        }
    }
    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }
    Err(AppError::new(
        "WORKER_MISSING",
        "未找到图像工作进程 script（worker/main.py），请检查安装是否完整。",
    ))
}
