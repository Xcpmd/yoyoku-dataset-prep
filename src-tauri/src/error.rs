use serde::Serialize;

pub type AppResult<T> = Result<T, AppError>;

/// 统一错误结构：code / message / retryable / details / itemIds。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_ids: Option<Vec<String>>,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: false,
            details: None,
            item_ids: None,
        }
    }

    pub fn msg(message: impl Into<String>) -> Self {
        Self::new("APP_ERROR", message)
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn items(mut self, ids: Vec<String>) -> Self {
        self.item_ids = Some(ids);
        self
    }

    pub fn io(context: &str, err: impl std::fmt::Display) -> Self {
        Self::new(
            "IO_ERROR",
            format!("{context}：{err}"),
        )
        .retryable(true)
    }

    pub fn sql(err: rusqlite::Error) -> Self {
        Self::new("DB_ERROR", format!("项目数据库操作失败：{err}")).retryable(true)
    }

    pub fn not_found(what: &str) -> Self {
        Self::new("NOT_FOUND", format!("未找到{what}"))
    }

    pub fn no_project() -> Self {
        Self::new("NO_PROJECT", "尚未打开项目")
    }

    pub fn revision_conflict(current: i64) -> Self {
        Self::new("REVISION_CONFLICT", "内容已被其他操作修改，请重新加载后再试")
            .details(serde_json::json!({ "currentRevision": current }))
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_else(|_| serde_json::json!({
            "code": "APP_ERROR", "message": self.message.clone(), "retryable": false
        }))
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        AppError::sql(value)
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::io("文件操作失败", value)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::new("SERIALIZE_ERROR", format!("数据格式处理失败：{value}"))
    }
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        AppError::new("APP_ERROR", value.to_string())
    }
}
