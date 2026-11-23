use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub const SCHEMA_VERSION: u32 = 4;

const PROMPT_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS prompt_library (
  normalized TEXT PRIMARY KEY,
  english TEXT NOT NULL,
  chinese TEXT NOT NULL,
  category TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_library_category ON prompt_library(category);

CREATE TABLE IF NOT EXISTS translation_cache (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  translated TEXT NOT NULL,
  provider TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(source, target)
);
"#;

const TAG_STATE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS caption_tag_state (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  order_json TEXT NOT NULL DEFAULT '[]',
  disabled_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
"#;

const SCHEMA_SQL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  template TEXT NOT NULL,
  trigger_word TEXT NOT NULL DEFAULT '',
  trigger_mode TEXT NOT NULL DEFAULT 'prefix',
  default_caption_mode TEXT NOT NULL DEFAULT 'tags',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS source_roots (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  source_root_id TEXT REFERENCES source_roots(id),
  rel_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  ext TEXT NOT NULL,
  format TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  orig_width INTEGER NOT NULL,
  orig_height INTEGER NOT NULL,
  norm_width INTEGER NOT NULL,
  norm_height INTEGER NOT NULL,
  out_width INTEGER NOT NULL,
  out_height INTEGER NOT NULL,
  has_alpha INTEGER NOT NULL DEFAULT 0,
  phash TEXT,
  blur_score REAL,
  dark_ratio REAL,
  bright_ratio REAL,
  analysis_json TEXT NOT NULL DEFAULT '{}',
  review_status TEXT NOT NULL DEFAULT 'pending',
  favorite INTEGER NOT NULL DEFAULT 0,
  excluded_reason TEXT,
  review_note TEXT,
  split_lock TEXT,
  last_human_at TEXT,
  imported_at TEXT NOT NULL,
  sort_index INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  transform_revision_id TEXT,
  caption_revision_id TEXT,
  draft_transform_revision_id TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  source_size INTEGER,
  source_mtime TEXT,
  duplicate_group_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  crop_ratio REAL NOT NULL DEFAULT 0,
  pad_ratio REAL NOT NULL DEFAULT 0,
  scale_ratio REAL NOT NULL DEFAULT 1,
  thumb_version TEXT NOT NULL DEFAULT 'src',
  trigger_disabled INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(content_hash);
CREATE INDEX IF NOT EXISTS idx_assets_source_path ON assets(source_root_id, rel_path);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(review_status);
CREATE INDEX IF NOT EXISTS idx_assets_sort ON assets(sort_index);

CREATE TABLE IF NOT EXISTS transform_revisions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  out_width INTEGER,
  out_height INTEGER,
  crop_ratio REAL,
  pad_ratio REAL,
  scale_ratio REAL,
  base_revision_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(asset_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_transform_asset ON transform_revisions(asset_id);

CREATE TABLE IF NOT EXISTS caption_revisions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  mode TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  parent_id TEXT,
  model_json TEXT NOT NULL DEFAULT '{}',
  search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(asset_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_caption_asset ON caption_revisions(asset_id);
CREATE INDEX IF NOT EXISTS idx_caption_search ON caption_revisions(search_text);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  query_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  target_width INTEGER,
  target_height INTEGER
);

CREATE TABLE IF NOT EXISTS collection_assets (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, asset_id)
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  ignored INTEGER NOT NULL DEFAULT 0,
  ignore_reason TEXT,
  rule_version TEXT NOT NULL DEFAULT '1',
  config_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(asset_id, rule)
);

CREATE INDEX IF NOT EXISTS idx_issues_rule ON issues(rule);
CREATE INDEX IF NOT EXISTS idx_issues_asset ON issues(asset_id);

CREATE TABLE IF NOT EXISTS duplicate_groups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  members_json TEXT NOT NULL,
  kept_asset_id TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_type TEXT NOT NULL,
  label TEXT NOT NULL,
  target_json TEXT NOT NULL DEFAULT '[]',
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  phase TEXT,
  error_json TEXT,
  result_json TEXT,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS export_snapshots (
  id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  asset_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS export_records (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  target TEXT NOT NULL,
  package TEXT NOT NULL,
  output_path TEXT NOT NULL,
  counts_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  manifest_sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quality_runs (
  id TEXT PRIMARY KEY,
  config_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"#;

pub fn open_connection(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path).map_err(AppError::sql)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(AppError::sql)?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;")
        .map_err(AppError::sql)?;
    Ok(conn)
}

pub fn migrate(conn: &mut Connection, backup_dir: &Path) -> AppResult<u32> {
    let version: u32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    if version > SCHEMA_VERSION {
        return Err(AppError::new(
            "PROJECT_VERSION_UNSUPPORTED",
            format!(
                "项目由更新版本的应用创建（数据库版本 {version}，当前最高支持 {SCHEMA_VERSION}）。请使用新版应用打开。"
            ),
        ));
    }
    if version < SCHEMA_VERSION {
        // 迁移前保留可恢复副本
        if version > 0 {
            let backup_path = backup_dir.join(format!(
                "pre-migration-v{version}-{}.sqlite",
                chrono::Utc::now().format("%Y%m%d-%H%M%S")
            ));
            if let Some(parent) = backup_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = conn.execute("VACUUM INTO ?1", params![backup_path.to_string_lossy()]);
        }
        if version < 1 {
            conn.execute_batch(SCHEMA_SQL).map_err(AppError::sql)?;
        }
        if version >= 1 && version < 2 {
            let _ = conn.execute("ALTER TABLE collections ADD COLUMN target_width INTEGER", []);
            let _ = conn.execute("ALTER TABLE collections ADD COLUMN target_height INTEGER", []);
        }
        if version < 3 {
            conn.execute_batch(PROMPT_SCHEMA_SQL).map_err(AppError::sql)?;
        }
        if version < 4 {
            conn.execute_batch(TAG_STATE_SCHEMA_SQL).map_err(AppError::sql)?;
        }
        // 批量导入按来源根目录 + 相对路径查重；老项目打开时补建索引。
        let _ = conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_assets_source_path ON assets(source_root_id, rel_path);",
        );
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(AppError::sql)?;
    }
    Ok(SCHEMA_VERSION)
}

pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn bump_asset_revision(conn: &Connection, asset_id: &str) -> AppResult<i64> {
    conn.execute(
        "UPDATE assets SET revision = revision + 1 WHERE id = ?1",
        params![asset_id],
    )?;
    let revision: i64 = conn.query_row(
        "SELECT revision FROM assets WHERE id = ?1",
        params![asset_id],
        |row| row.get(0),
    )?;
    Ok(revision)
}

pub fn mark_quality_stale(conn: &Connection) -> AppResult<()> {
    meta_set(conn, "quality_stale", "1")?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct AssetRow {
    pub id: String,
    pub content_hash: String,
    pub source_root_id: Option<String>,
    pub rel_path: String,
    pub original_name: String,
    pub ext: String,
    pub format: String,
    pub bytes: i64,
    pub orig_width: u32,
    pub orig_height: u32,
    pub norm_width: u32,
    pub norm_height: u32,
    pub out_width: u32,
    pub out_height: u32,
    pub has_alpha: bool,
    pub phash: Option<String>,
    pub blur_score: Option<f64>,
    pub dark_ratio: Option<f64>,
    pub bright_ratio: Option<f64>,
    pub analysis_json: String,
    pub review_status: String,
    pub favorite: bool,
    pub excluded_reason: Option<String>,
    pub review_note: Option<String>,
    pub split_lock: Option<String>,
    pub last_human_at: Option<String>,
    pub imported_at: String,
    pub sort_index: i64,
    pub revision: i64,
    pub transform_revision_id: Option<String>,
    pub caption_revision_id: Option<String>,
    pub draft_transform_revision_id: Option<String>,
    pub missing: bool,
    pub source_size: Option<i64>,
    pub source_mtime: Option<String>,
    pub duplicate_group_id: Option<String>,
    pub note: String,
    pub crop_ratio: f64,
    pub pad_ratio: f64,
    pub scale_ratio: f64,
    pub thumb_version: String,
    pub trigger_disabled: bool,
}

pub const ASSET_COLUMNS: &str = "id, content_hash, source_root_id, rel_path, original_name, ext, format, bytes, \
orig_width, orig_height, norm_width, norm_height, out_width, out_height, has_alpha, phash, blur_score, \
dark_ratio, bright_ratio, analysis_json, review_status, favorite, excluded_reason, review_note, split_lock, \
last_human_at, imported_at, sort_index, revision, transform_revision_id, caption_revision_id, \
draft_transform_revision_id, missing, source_size, source_mtime, duplicate_group_id, note, crop_ratio, \
pad_ratio, scale_ratio, thumb_version, trigger_disabled";

pub fn asset_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AssetRow> {
    Ok(AssetRow {
        id: row.get(0)?,
        content_hash: row.get(1)?,
        source_root_id: row.get(2)?,
        rel_path: row.get(3)?,
        original_name: row.get(4)?,
        ext: row.get(5)?,
        format: row.get(6)?,
        bytes: row.get(7)?,
        orig_width: row.get(8)?,
        orig_height: row.get(9)?,
        norm_width: row.get(10)?,
        norm_height: row.get(11)?,
        out_width: row.get(12)?,
        out_height: row.get(13)?,
        has_alpha: row.get::<_, i64>(14)? != 0,
        phash: row.get(15)?,
        blur_score: row.get(16)?,
        dark_ratio: row.get(17)?,
        bright_ratio: row.get(18)?,
        analysis_json: row.get(19)?,
        review_status: row.get(20)?,
        favorite: row.get::<_, i64>(21)? != 0,
        excluded_reason: row.get(22)?,
        review_note: row.get(23)?,
        split_lock: row.get(24)?,
        last_human_at: row.get(25)?,
        imported_at: row.get(26)?,
        sort_index: row.get(27)?,
        revision: row.get(28)?,
        transform_revision_id: row.get(29)?,
        caption_revision_id: row.get(30)?,
        draft_transform_revision_id: row.get(31)?,
        missing: row.get::<_, i64>(32)? != 0,
        source_size: row.get(33)?,
        source_mtime: row.get(34)?,
        duplicate_group_id: row.get(35)?,
        note: row.get(36)?,
        crop_ratio: row.get(37)?,
        pad_ratio: row.get(38)?,
        scale_ratio: row.get(39)?,
        thumb_version: row.get(40)?,
        trigger_disabled: row.get::<_, i64>(41)? != 0,
    })
}

pub fn get_asset(conn: &Connection, id: &str) -> AppResult<AssetRow> {
    conn.query_row(
        &format!("SELECT {ASSET_COLUMNS} FROM assets WHERE id = ?1"),
        params![id],
        asset_row,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("图片"))
}

pub fn find_asset_by_source(conn: &Connection, root_id: &str, rel_path: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM assets WHERE source_root_id = ?1 AND rel_path = ?2 LIMIT 1",
            params![root_id, rel_path],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

pub fn find_asset_by_hash(conn: &Connection, hash: &str) -> AppResult<Option<AssetRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {ASSET_COLUMNS} FROM assets WHERE content_hash = ?1 LIMIT 1"),
            params![hash],
            asset_row,
        )
        .optional()?)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub seq: i64,
    pub command_type: String,
    pub label: String,
    pub target: serde_json::Value,
    pub before: serde_json::Value,
    pub after: serde_json::Value,
    pub created_at: String,
    pub undone: bool,
}

pub fn push_history(
    conn: &Connection,
    command_type: &str,
    label: &str,
    targets: &[String],
    before: &serde_json::Value,
    after: &serde_json::Value,
    merge_within_ms: Option<i64>,
) -> AppResult<i64> {
    // 新命令写入时截断重做分支
    conn.execute("DELETE FROM history WHERE undone = 1", [])?;

    if let Some(window) = merge_within_ms {
        if let Ok(Some(seq)) = conn
            .query_row(
                "SELECT seq FROM history WHERE command_type = ?1 AND undone = 0 ORDER BY seq DESC LIMIT 1",
                params![command_type],
                |row| row.get::<_, i64>(0),
            )
            .optional()
        {
            let same_target: bool = conn
                .query_row(
                    "SELECT target_json FROM history WHERE seq = ?1",
                    params![seq],
                    |row| row.get::<_, String>(0),
                )
                .map(|t| serde_json::from_str::<Vec<String>>(&t).ok() == Some(targets.to_vec()))
                .unwrap_or(false);
            let recent: bool = conn
                .query_row(
                    "SELECT (julianday(?1) - julianday(created_at)) * 86400000 < ?2 FROM history WHERE seq = ?3",
                    params![crate::util::now_iso(), window, seq],
                    |row| row.get::<_, i64>(0),
                )
                .map(|v| v != 0)
                .unwrap_or(false);
            if same_target && recent {
                conn.execute(
                    "UPDATE history SET after_json = ?1, created_at = ?2 WHERE seq = ?3",
                    params![
                        serde_json::to_string(after)?,
                        crate::util::now_iso(),
                        seq
                    ],
                )?;
                return Ok(seq);
            }
        }
    }

    conn.execute(
        "INSERT INTO history(command_type, label, target_json, before_json, after_json, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            command_type,
            label,
            serde_json::to_string(targets)?,
            serde_json::to_string(before)?,
            serde_json::to_string(after)?,
            crate::util::now_iso()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}
