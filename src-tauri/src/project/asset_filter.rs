use crate::error::{AppError, AppResult};
use crate::model::{AssetFilter, FilterExpression, FilterMode};
use regex::{Regex, RegexBuilder};
use rusqlite::{functions::FunctionFlags, types::Value, Connection};

pub fn compile_regex(pattern: &str, ignore_case: bool) -> AppResult<Regex> {
    if pattern.is_empty() || pattern.len() > 4096 {
        return Err(AppError::new(
            "INVALID_REGEX",
            "请输入 1 至 4096 字节的正则表达式",
        ));
    }
    RegexBuilder::new(pattern)
        .case_insensitive(ignore_case)
        .size_limit(512 * 1024)
        .dfa_size_limit(128 * 1024)
        .nest_limit(32)
        .build()
        .map_err(|error| AppError::new("INVALID_REGEX", format!("正则表达式有误\n{error}")))
}

pub fn validate(filter: &AssetFilter) -> AppResult<()> {
    FilterSql::compile(filter).map(|_| ())
}

#[derive(Default)]
pub struct FilterSql {
    pub clauses: Vec<String>,
    pub values: Vec<Value>,
    patterns: Vec<Regex>,
}

impl FilterSql {
    pub fn compile(filter: &AssetFilter) -> AppResult<Self> {
        let mut sql = Self::default();
        if let Some(expression) = &filter.expression {
            let clause = sql.expression(expression, 1, &mut 0, &mut Vec::new())?;
            sql.clauses.push(clause);
        }
        if let Some(search) = &filter.regex_search {
            let clause = sql.regex_search(
                &search.pattern,
                &search.target,
                filter.search_case_sensitive,
            )?;
            sql.clauses.push(clause);
        }
        if uses_scoped_text_search(filter) {
            sql.add_text_search(
                &filter.query,
                filter.search_target.as_deref().unwrap_or("all"),
                filter.search_case_sensitive,
            )?;
        }
        Ok(sql)
    }

    pub fn run<T>(
        mut self,
        conn: &Connection,
        run: impl FnOnce(Self) -> AppResult<T>,
    ) -> AppResult<T> {
        if self.patterns.is_empty() {
            return run(self);
        }
        let patterns = std::mem::take(&mut self.patterns);
        conn.create_scalar_function(
            "gallery_regex",
            2,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            move |ctx| {
                let index = ctx.get::<usize>(0)?;
                let text = ctx.get_raw(1).as_str().unwrap_or_default();
                Ok(patterns
                    .get(index)
                    .is_some_and(|pattern| pattern.is_match(text)))
            },
        )?;
        let result = run(self);
        let removed = conn.remove_function("gallery_regex", 2);
        result.and_then(|value| {
            removed?;
            Ok(value)
        })
    }

    fn expression(
        &mut self,
        node: &FilterExpression,
        depth: usize,
        count: &mut usize,
        path: &mut Vec<usize>,
    ) -> AppResult<String> {
        *count += 1;
        if depth > 12 || *count > 128 {
            return Err(invalid("筛选最多支持 12 层、128 个条件与组"));
        }
        let (clause, negated) = match node {
            FilterExpression::Group {
                mode,
                negated,
                children,
            } => {
                if children.is_empty() {
                    return Err(at_path(invalid("请给条件组添加至少一个条件"), path));
                }
                let mut clauses = Vec::with_capacity(children.len().min(128));
                for (index, child) in children.iter().enumerate() {
                    path.push(index + 1);
                    clauses.push(self.expression(child, depth + 1, count, path)?);
                    path.pop();
                }
                (
                    format!(
                        "({})",
                        clauses.join(match mode {
                            FilterMode::All => " AND ",
                            FilterMode::Any => " OR ",
                        })
                    ),
                    *negated,
                )
            }
            FilterExpression::Rule {
                field,
                operator,
                value,
                negated,
            } => (
                format!(
                    "COALESCE(({}), 0)",
                    self.rule(field, operator, value)
                        .map_err(|error| at_path(error, path))?
                ),
                *negated,
            ),
        };
        Ok(if negated {
            format!("(NOT {clause})")
        } else {
            clause
        })
    }

    fn rule(&mut self, field: &str, operator: &str, value: &str) -> AppResult<String> {
        let trimmed = value.trim();
        if trimmed.is_empty() || value.len() > 4096 {
            return Err(invalid("请填写有效的条件值"));
        }
        match field {
            "width" | "height" | "outWidth" | "outHeight" | "shortEdge" | "longEdge"
            | "fileSize" | "ratio" => {
                let column = match field {
                    "width" => "a.norm_width",
                    "height" => "a.norm_height",
                    "outWidth" => "a.out_width",
                    "outHeight" => "a.out_height",
                    "shortEdge" => "min(a.norm_width, a.norm_height)",
                    "longEdge" => "max(a.norm_width, a.norm_height)",
                    "fileSize" => "a.bytes",
                    _ => "CAST(a.norm_width AS REAL) / NULLIF(a.norm_height, 0)",
                };
                let comparison = match operator {
                    "is" => "=",
                    "gte" => ">=",
                    "lte" => "<=",
                    "gt" => ">",
                    "lt" => "<",
                    _ => return Err(invalid("请选择有效的比较方式")),
                };
                let amount: f64 = trimmed.parse().map_err(|_| invalid("请输入有效数字"))?;
                let amount = if field == "fileSize" {
                    amount * 1_048_576.0
                } else {
                    amount
                };
                if !amount.is_finite() || amount < 0.0 {
                    return Err(invalid("请输入大于或等于零的有限数字"));
                }
                self.values.push(Value::Real(amount));
                Ok(format!("{column} {comparison} ?"))
            }
            "name" | "path" | "tag" | "caption" | "note" | "extension" => {
                let column = text_column(field).expect("known text field");
                let clause = match operator {
                    "is" => {
                        let trimmed = if field == "extension" {
                            trimmed.trim_start_matches('.')
                        } else {
                            trimmed
                        };
                        self.values.push(Value::Text(trimmed.to_lowercase()));
                        format!("lower({column}) = ?")
                    }
                    "contains" => {
                        self.values.push(Value::Text(trimmed.to_lowercase()));
                        format!("instr(lower({column}), ?) > 0")
                    }
                    "regex" => {
                        let index = self.add_regex(value, true)?;
                        format!("gallery_regex({index}, {column})")
                    }
                    _ => return Err(invalid("请选择有效的文本匹配方式")),
                };
                Ok(if field == "tag" {
                    tag_exists(&clause)
                } else {
                    clause
                })
            }
            _ => {
                if operator != "is" {
                    return Err(invalid("此条件只支持「是」"));
                }
                self.choice(field, trimmed)
            }
        }
    }

    fn choice(&mut self, field: &str, value: &str) -> AppResult<String> {
        let clause = match (field, value) {
            ("status", "pending" | "approved" | "review" | "excluded") => "a.review_status = ?",
            ("orientation", "portrait") => return Ok("a.norm_height > a.norm_width".into()),
            ("orientation", "landscape") => return Ok("a.norm_width > a.norm_height".into()),
            ("orientation", "square") => return Ok("a.norm_width = a.norm_height".into()),
            ("split", "unassigned") => return Ok("a.split_lock IS NULL".into()),
            ("split", "train" | "val") => "a.split_lock = ?",
            ("collection", _) => "EXISTS (SELECT 1 FROM collection_assets ca WHERE ca.collection_id = ? AND ca.asset_id = a.id)",
            ("issueRule", _) => "EXISTS (SELECT 1 FROM issues i WHERE i.asset_id = a.id AND i.rule = ?)",
            ("issueLevel", "blocking" | "suggestion") => "EXISTS (SELECT 1 FROM issues i WHERE i.asset_id = a.id AND i.level = ? AND i.ignored = 0)",
            ("issueLevel", "ignored") => return Ok("EXISTS (SELECT 1 FROM issues i WHERE i.asset_id = a.id AND i.ignored = 1)".into()),
            ("captionMode", "tags" | "nl" | "mixed") => "COALESCE(c.mode, (SELECT default_caption_mode FROM project LIMIT 1)) = ?",
            ("favorite" | "duplicate" | "draft" | "missing" | "alpha" | "hasCaption" | "cropped" | "triggerDisabled", "yes" | "no") => {
                let condition = match field {
                    "favorite" => "a.favorite = 1",
                    "duplicate" => "a.duplicate_group_id IS NOT NULL",
                    "draft" => "a.draft_transform_revision_id IS NOT NULL",
                    "missing" => "a.missing = 1",
                    "alpha" => "a.has_alpha = 1",
                    "cropped" => "a.transform_revision_id IS NOT NULL",
                    "triggerDisabled" => "a.trigger_disabled = 1",
                    _ => "(COALESCE(c.mode, 'nl') != 'nl' AND COALESCE(c.tags_json, '[]') != '[]') OR length(trim(COALESCE(c.text, ''))) > 0",
                };
                return Ok(if value == "yes" { format!("({condition})") } else { format!("NOT ({condition})") });
            }
            _ => return Err(invalid("请选择有效的筛选条件和值")),
        };
        self.values.push(Value::Text(value.into()));
        Ok(clause.into())
    }

    fn add_regex(&mut self, pattern: &str, ignore_case: bool) -> AppResult<usize> {
        let index = self.patterns.len();
        self.patterns.push(compile_regex(pattern, ignore_case)?);
        Ok(index)
    }

    fn regex_search(
        &mut self,
        pattern: &str,
        target: &str,
        case_sensitive: bool,
    ) -> AppResult<String> {
        let fields = search_fields(target)?;
        let index = self.add_regex(pattern, !case_sensitive)?;
        let match_field = |field| {
            let column = text_column(field).expect("known search field");
            let clause = format!("({column} IS NOT NULL AND gallery_regex({index}, {column}))");
            if field == "tag" {
                tag_exists(&clause)
            } else {
                clause
            }
        };
        let clauses: Vec<String> = fields.iter().copied().map(match_field).collect();
        Ok(format!("({})", clauses.join(" OR ")))
    }

    fn add_text_search(
        &mut self,
        query: &str,
        target: &str,
        case_sensitive: bool,
    ) -> AppResult<()> {
        let fields = search_fields(target)?;
        for term in query.split_whitespace() {
            let negated = term.starts_with('-');
            let term = term.strip_prefix('-').unwrap_or(term);
            let (term, fields) = match term.strip_prefix("tag:") {
                Some(tag) => (tag, search_fields("tag")?),
                None => (term, fields),
            };
            if term.is_empty() {
                continue;
            }
            let mut matches = Vec::with_capacity(fields.len());
            for field in fields {
                let column = text_column(field).expect("known search field");
                let (column, needle) = if case_sensitive {
                    (column.to_owned(), term.to_owned())
                } else {
                    (format!("lower({column})"), term.to_lowercase())
                };
                self.values.push(Value::Text(needle));
                let clause = format!("COALESCE(instr({column}, ?) > 0, 0)");
                matches.push(if *field == "tag" {
                    tag_exists(&clause)
                } else {
                    clause
                });
            }
            let matches = matches.join(" OR ");
            let invert = if negated { "NOT " } else { "" };
            self.clauses.push(format!("{invert}({matches})"));
        }
        Ok(())
    }
}

pub fn uses_scoped_text_search(filter: &AssetFilter) -> bool {
    filter.search_case_sensitive
        || filter
            .search_target
            .as_deref()
            .is_some_and(|target| target != "all")
}

fn search_fields(target: &str) -> AppResult<&'static [&'static str]> {
    match target {
        "all" => Ok(&["name", "path", "tag", "caption", "note"]),
        "name" => Ok(&["name"]),
        "path" => Ok(&["path"]),
        "tag" => Ok(&["tag"]),
        "caption" => Ok(&["caption"]),
        "note" => Ok(&["note"]),
        _ => Err(invalid("请选择有效的搜索字段")),
    }
}

fn text_column(field: &str) -> Option<&'static str> {
    match field {
        "name" => Some("a.original_name"),
        "path" => Some("a.rel_path"),
        "tag" => Some("tag.value"),
        "caption" => Some("c.text"),
        "note" => Some("a.note"),
        "extension" => Some("a.ext"),
        _ => None,
    }
}

fn tag_exists(clause: &str) -> String {
    format!(
        "(COALESCE(c.mode, '') IN ('tags', 'mixed') AND EXISTS (SELECT 1 FROM json_each(c.tags_json) tag WHERE tag.type = 'text' AND {clause}))"
    )
}

fn invalid(message: &str) -> AppError {
    AppError::new("INVALID_FILTER", message)
}

fn at_path(error: AppError, path: &[usize]) -> AppError {
    if path.is_empty() {
        return error;
    }
    let location = path
        .iter()
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join(".");
    AppError::new(&error.code, format!("条件 {location} · {}", error.message))
}
