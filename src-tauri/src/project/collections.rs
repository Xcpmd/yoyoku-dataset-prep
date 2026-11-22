use crate::error::{AppError, AppResult};
use crate::model::{AssetFilter, AssetSort, CollectionInfo};
use crate::project::Project;
use crate::util;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCreate {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub query: Option<AssetFilter>,
    #[serde(default)]
    pub sort: Option<AssetSort>,
    #[serde(default)]
    pub target_width: Option<i64>,
    #[serde(default)]
    pub target_height: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionUpdate {
    pub id: String,
    pub name: Option<String>,
    pub query: Option<AssetFilter>,
    pub sort: Option<AssetSort>,
    #[serde(default)]
    pub target_width: Option<i64>,
    #[serde(default)]
    pub target_height: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDetail {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub count: i64,
    pub created_at: String,
    pub query: Option<AssetFilter>,
    pub sort: Option<AssetSort>,
    pub target_width: Option<i64>,
    pub target_height: Option<i64>,
}

pub fn list(project: &Project) -> AppResult<Vec<CollectionInfo>> {
    let conn = project.conn();
    let mut statement = conn.prepare(
        "SELECT c.id, c.name, c.kind, c.query_json, c.created_at,
                (SELECT COUNT(*) FROM collection_assets ca WHERE ca.collection_id = c.id),
                c.target_width, c.target_height
         FROM collections c ORDER BY c.created_at ASC",
    )?;
    let rows = statement.query_map([], |row| {
        let query_json: String = row.get(3)?;
        let (query, sort): (Option<AssetFilter>, Option<AssetSort>) =
            serde_json::from_str::<CollectionQuery>(&query_json)
                .map(|q| (q.filter, q.sort))
                .unwrap_or((None, None));
        Ok(CollectionInfo {
            id: row.get(0)?,
            name: row.get(1)?,
            kind: row.get(2)?,
            count: row.get(5)?,
            created_at: row.get(4)?,
            query,
            sort,
            target_width: row.get(6)?,
            target_height: row.get(7)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CollectionQuery {
    #[serde(default)]
    filter: Option<AssetFilter>,
    #[serde(default)]
    sort: Option<AssetSort>,
}

pub fn create(project: &Project, request: &CollectionCreate) -> AppResult<CollectionInfo> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::new("INVALID_NAME", "集合名称不能为空"));
    }
    let kind = if request.kind == "query" { "query" } else { "manual" };
    let id = util::new_id();
    let now = util::now_iso();
    let query_json = serde_json::to_string(&CollectionQuery {
        filter: request.query.clone(),
        sort: request.sort.clone(),
    })?;
    let conn = project.conn();
    conn.execute(
        "INSERT INTO collections(id, name, kind, query_json, created_at, target_width, target_height)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, name, kind, query_json, now, request.target_width, request.target_height],
    )?;
    Ok(CollectionInfo {
        id,
        name: name.to_string(),
        kind: kind.to_string(),
        count: 0,
        created_at: now,
        query: request.query.clone(),
        sort: request.sort.clone(),
        target_width: request.target_width,
        target_height: request.target_height,
    })
}

pub fn update(project: &Project, request: &CollectionUpdate) -> AppResult<CollectionInfo> {
    let conn = project.conn();
    let existing: Option<(String, String, String, String, String, Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT id, name, kind, query_json, created_at, target_width, target_height
             FROM collections WHERE id = ?1",
            params![request.id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let (id, mut name, kind, query_json, created_at, mut target_width, mut target_height) =
        existing.ok_or_else(|| AppError::not_found("集合"))?;
    if let Some(new_name) = &request.name {
        if new_name.trim().is_empty() {
            return Err(AppError::new("INVALID_NAME", "集合名称不能为空"));
        }
        name = new_name.trim().to_string();
        conn.execute(
            "UPDATE collections SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
    }
    let mut parsed: CollectionQuery = serde_json::from_str(&query_json).unwrap_or_default();
    if request.query.is_some() {
        parsed.filter = request.query.clone();
    }
    if request.sort.is_some() {
        parsed.sort = request.sort.clone();
    }
    if let Some(width) = request.target_width {
        target_width = if width > 0 { Some(width) } else { None };
    }
    if let Some(height) = request.target_height {
        target_height = if height > 0 { Some(height) } else { None };
    }
    conn.execute(
        "UPDATE collections SET query_json = ?1, target_width = ?2, target_height = ?3 WHERE id = ?4",
        params![serde_json::to_string(&parsed)?, target_width, target_height, id],
    )?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM collection_assets WHERE collection_id = ?1",
        params![id],
        |row| row.get(0),
    )?;
    Ok(CollectionInfo {
        id,
        name,
        kind,
        count,
        created_at,
        query: parsed.filter,
        sort: parsed.sort,
        target_width,
        target_height,
    })
}

pub fn delete(project: &Project, collection_id: &str) -> AppResult<()> {
    let conn = project.conn();
    conn.execute("DELETE FROM collections WHERE id = ?1", params![collection_id])?;
    Ok(())
}

pub fn ids(project: &Project, collection_id: &str, offset: i64, limit: i64) -> AppResult<Vec<String>> {
    let conn = project.conn();
    let mut statement = conn.prepare(
        "SELECT ca.asset_id FROM collection_assets ca
         JOIN assets a ON a.id = ca.asset_id
         WHERE ca.collection_id = ?1
         ORDER BY a.sort_index ASC, a.id ASC LIMIT ?2 OFFSET ?3",
    )?;
    let rows = statement.query_map(params![collection_id, limit.clamp(1, 5000), offset.max(0)], |row| {
        row.get::<_, String>(0)
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn members(project: &Project, collection_id: &str) -> AppResult<Vec<String>> {
    let conn = project.conn();
    let mut statement = conn.prepare(
        "SELECT asset_id FROM collection_assets WHERE collection_id = ?1",
    )?;
    let rows = statement.query_map(params![collection_id], |row| row.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}
