use crate::caption;
use crate::error::{AppError, AppResult};
use crate::util;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEntry {
    #[serde(default)]
    pub key: String,
    pub english: String,
    pub chinese: String,
    pub category: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptUpsertRequest {
    #[serde(default)]
    pub original_key: Option<String>,
    pub english: String,
    pub chinese: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTranslation {
    pub source: String,
    pub translated: String,
    pub provider: String,
}

pub fn normalize_prompt_key(value: &str) -> String {
    caption::normalize_key(&value.replace('_', " "))
}

pub fn count(conn: &Connection) -> AppResult<i64> {
    conn.query_row("SELECT COUNT(*) FROM prompt_library", [], |row| row.get(0))
        .map_err(AppError::sql)
}

pub fn import(conn: &mut Connection, entries: &[PromptEntry]) -> AppResult<usize> {
    if entries.len() > 100_000 {
        return Err(AppError::new(
            "PROMPT_LIBRARY_TOO_LARGE",
            "提示词库条目过多（上限 100,000）",
        ));
    }
    let tx = conn.transaction()?;
    let mut inserted = 0usize;
    {
        let mut statement = tx.prepare(
            "INSERT OR IGNORE INTO prompt_library(normalized, english, chinese, category)
             VALUES(?1, ?2, ?3, ?4)",
        )?;
        for entry in entries {
            let english = entry.english.trim();
            let chinese = entry.chinese.trim();
            let category = entry.category.trim();
            let key = normalize_prompt_key(english);
            if key.is_empty() || chinese.is_empty() {
                continue;
            }
            inserted += statement.execute(params![
                key,
                english,
                chinese,
                if category.is_empty() { "未分类" } else { category }
            ])?;
        }
    }
    tx.commit()?;
    Ok(inserted)
}

pub fn list(conn: &Connection) -> AppResult<Vec<PromptEntry>> {
    let mut statement = conn.prepare(
        "SELECT normalized, english, chinese, category
         FROM prompt_library ORDER BY category, english",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(PromptEntry {
            key: row.get(0)?,
            english: row.get(1)?,
            chinese: row.get(2)?,
            category: row.get(3)?,
        })
    })?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

pub fn cache_lookup(conn: &Connection, source: &str, target: &str) -> Option<CachedTranslation> {
    conn.query_row(
        "SELECT translated, provider FROM translation_cache WHERE source = ?1 AND target = ?2",
        params![source, target],
        |row| {
            Ok(CachedTranslation {
                source: source.to_string(),
                translated: row.get(0)?,
                provider: row.get(1)?,
            })
        },
    )
    .ok()
}

pub fn cache_store(
    conn: &Connection,
    source: &str,
    target: &str,
    translated: &str,
    provider: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO translation_cache(source, target, translated, provider, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source, target) DO UPDATE SET
           translated = excluded.translated,
           provider = excluded.provider,
           updated_at = excluded.updated_at",
        params![source, target, translated, provider, util::now_iso()],
    )?;
    Ok(())
}

pub fn upsert(conn: &mut Connection, request: &PromptUpsertRequest) -> AppResult<PromptEntry> {
    let english = request.english.trim();
    let chinese = request.chinese.trim();
    let category = request.category.trim();
    if english.is_empty() {
        return Err(AppError::new("PROMPT_EMPTY_ENGLISH", "英文提示词不能为空"));
    }
    if chinese.is_empty() {
        return Err(AppError::new("PROMPT_EMPTY_CHINESE", "中文翻译不能为空"));
    }
    if english.chars().count() > 200 || chinese.chars().count() > 500 {
        return Err(AppError::new("PROMPT_TOO_LONG", "提示词长度超出限制"));
    }
    if category.chars().count() > 80 {
        return Err(AppError::new("PROMPT_CATEGORY_TOO_LONG", "分类名称过长"));
    }
    let key = normalize_prompt_key(english);
    if key.is_empty() {
        return Err(AppError::new("PROMPT_EMPTY_ENGLISH", "英文提示词无效"));
    }
    let category = if category.is_empty() { "未分类" } else { category };
    let tx = conn.transaction()?;
    if let Some(original) = request
        .original_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let exists = tx
            .query_row(
                "SELECT 1 FROM prompt_library WHERE normalized = ?1",
                params![original],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Err(AppError::not_found("提示词"));
        }
        if original != key {
            let conflict = tx
                .query_row(
                    "SELECT 1 FROM prompt_library WHERE normalized = ?1",
                    params![key],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if conflict {
                return Err(AppError::new(
                    "PROMPT_DUPLICATE",
                    format!("提示词“{english}”已存在"),
                ));
            }
        }
        tx.execute(
            "UPDATE prompt_library SET normalized = ?1, english = ?2, chinese = ?3, category = ?4
             WHERE normalized = ?5",
            params![key, english, chinese, category, original],
        )?;
    } else {
        let conflict = tx
            .query_row(
                "SELECT 1 FROM prompt_library WHERE normalized = ?1",
                params![key],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if conflict {
            return Err(AppError::new(
                "PROMPT_DUPLICATE",
                format!("提示词“{english}”已存在"),
            ));
        }
        tx.execute(
            "INSERT INTO prompt_library(normalized, english, chinese, category)
             VALUES(?1, ?2, ?3, ?4)",
            params![key, english, chinese, category],
        )?;
    }
    tx.commit()?;
    Ok(PromptEntry {
        key,
        english: english.to_string(),
        chinese: chinese.to_string(),
        category: category.to_string(),
    })
}

pub fn delete(conn: &Connection, key: &str) -> AppResult<()> {
    let changed = conn.execute(
        "DELETE FROM prompt_library WHERE normalized = ?1",
        params![key.trim()],
    )?;
    if changed == 0 {
        return Err(AppError::not_found("提示词"));
    }
    Ok(())
}
