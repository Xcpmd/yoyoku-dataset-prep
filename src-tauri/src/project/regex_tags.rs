use crate::caption::{normalize_key, normalize_tags};
use crate::error::{AppError, AppResult};
use crate::model::{BatchOp, BatchTagChanges, ExtractSyntax};
use crate::project::asset_filter::compile_regex;
use regex::{Captures, Regex};
use std::collections::{HashMap, HashSet};

const MAX_TAG_BYTES: usize = 1024;

pub enum RegexTags {
    Extract(Regex, Vec<Template>),
    Remove(Regex),
    Replace(Regex, Template),
}

pub struct Template(Vec<Part>);

enum Part {
    Literal(String),
    Capture(usize, String),
}

pub struct TagUpdate {
    pub tags: Vec<String>,
    pub order: Option<Vec<String>>,
    pub changes: BatchTagChanges,
}

impl RegexTags {
    pub fn compile(op: &BatchOp) -> AppResult<Option<Self>> {
        Ok(Some(match op {
            BatchOp::ExtractTags {
                pattern,
                syntax,
                templates,
            } => {
                let regex = match syntax {
                    ExtractSyntax::Template => filename_regex(pattern)?,
                    ExtractSyntax::Regex => compile_regex(pattern, false)?,
                };
                if templates.is_empty() || templates.len() > 32 {
                    return Err(invalid("请填写 1 至 32 行标签模板"));
                }
                let templates = templates
                    .iter()
                    .map(|value| Template::parse(value, &regex))
                    .collect::<AppResult<_>>()?;
                Self::Extract(regex, templates)
            }
            BatchOp::RegexRemoveTags { pattern } => Self::Remove(compile_regex(pattern, false)?),
            BatchOp::RegexReplaceTags {
                pattern,
                replacement,
            } => {
                let regex = compile_regex(pattern, false)?;
                let template = Template::parse(replacement, &regex)?;
                Self::Replace(regex, template)
            }
            _ => return Ok(None),
        }))
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Extract(..) => "从文件名添加标签",
            Self::Remove(..) => "正则删除标签",
            Self::Replace(..) => "正则替换标签",
        }
    }

    pub fn applies_to_prose(&self) -> bool {
        matches!(self, Self::Extract(..))
    }

    pub fn apply(
        &self,
        filename: &str,
        tags: &[String],
        order: Option<&[String]>,
        disabled: &[String],
        trigger_word: &str,
        activate_tags: bool,
    ) -> Result<TagUpdate, String> {
        let disabled_keys: HashSet<_> = disabled.iter().map(|tag| normalize_key(tag)).collect();
        let existing: HashSet<_> = tags.iter().map(|tag| normalize_key(tag)).collect();
        let (next, next_order) = match self {
            Self::Extract(regex, templates) => {
                let captures = regex.captures(filename).ok_or("文件名未匹配")?;
                let mut additions = Vec::new();
                let mut seen = existing;
                let mut has_enabled_match = false;
                for template in templates {
                    let output = template.render(&captures)?;
                    let tag = valid_tag(&output, false)?;
                    let key = normalize_key(tag);
                    if disabled_keys.contains(&key) {
                        continue;
                    }
                    has_enabled_match = true;
                    if seen.insert(key) {
                        additions.push(tag.to_owned());
                    }
                }
                if !has_enabled_match {
                    return Err("生成的标签均已停用".into());
                }
                let next_order =
                    order.map(|order| normalize_tags(order.iter().chain(&additions).cloned()));
                (
                    tags.iter().chain(&additions).cloned().collect::<Vec<_>>(),
                    next_order,
                )
            }
            _ => {
                let trigger = normalize_key(trigger_word);
                let mut edits = HashMap::new();
                let mut next = Vec::with_capacity(tags.len());
                for tag in tags {
                    let key = normalize_key(tag);
                    if key == trigger || disabled_keys.contains(&key) {
                        next.push(tag.clone());
                        continue;
                    }
                    let value = match self {
                        Self::Remove(regex) if regex.is_match(tag) => Some(String::new()),
                        Self::Replace(regex, template) => replace_matches(regex, template, tag)?,
                        _ => None,
                    };
                    if let Some(value) = value {
                        let value = valid_tag(&value, true)?;
                        if value == tag {
                            next.push(tag.clone());
                            continue;
                        }
                        if disabled_keys.contains(&normalize_key(value)) {
                            return Err("替换结果与停用标签同名".into());
                        }
                        let replacement = (!value.is_empty()).then(|| value.to_owned());
                        next.extend(replacement.iter().cloned());
                        edits.insert(key, replacement);
                    } else {
                        next.push(tag.clone());
                    }
                }
                if edits.is_empty() {
                    return Err("没有需要修改的标签".into());
                }
                let next_order = order.map(|order| {
                    normalize_tags(order.iter().filter_map(|tag| {
                        edits
                            .get(&normalize_key(tag))
                            .cloned()
                            .unwrap_or_else(|| Some(tag.clone()))
                    }))
                });
                (normalize_tags(next), next_order)
            }
        };
        if next == tags && !activate_tags {
            return Err("标签无变化".into());
        }
        let before: HashSet<_> = tags.iter().filter(|_| !activate_tags).collect();
        let after: HashSet<_> = next.iter().collect();
        let changes = BatchTagChanges {
            added: next
                .iter()
                .filter(|tag| !before.contains(tag))
                .cloned()
                .collect(),
            removed: tags
                .iter()
                .filter(|tag| !after.contains(tag))
                .cloned()
                .collect(),
        };
        Ok(TagUpdate {
            tags: next,
            order: next_order,
            changes,
        })
    }
}

fn valid_tag(value: &str, allow_empty: bool) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() && !allow_empty {
        return Err("标签模板生成了空标签".into());
    }
    if value.len() > MAX_TAG_BYTES || value.contains([',', '，', '\n', '\r', '\0']) {
        return Err("生成的标签过长或含有逗号、换行等分隔符".into());
    }
    Ok(value)
}

fn replace_matches(
    regex: &Regex,
    template: &Template,
    tag: &str,
) -> Result<Option<String>, String> {
    let mut output = String::new();
    let mut end = 0;
    let mut matched = false;
    for captures in regex.captures_iter(tag) {
        let whole = captures.get(0).expect("match zero");
        matched = true;
        output.push_str(&tag[end..whole.start()]);
        output.push_str(&template.render(&captures)?);
        if output.len() > MAX_TAG_BYTES {
            return Err("替换后的标签过长".into());
        }
        end = whole.end();
    }
    if !matched {
        return Ok(None);
    }
    output.push_str(&tag[end..]);
    Ok(Some(output))
}

impl Template {
    fn parse(input: &str, regex: &Regex) -> AppResult<Self> {
        let mut parts = Vec::new();
        parse_placeholders(
            input,
            &mut parts,
            |parts, literal| parts.push(Part::Literal(literal.to_owned())),
            |parts, var| {
                let index = var
                    .parse::<usize>()
                    .ok()
                    .filter(|index| *index < regex.captures_len())
                    .or_else(|| regex.capture_names().position(|name| name == Some(var)))
                    .ok_or_else(|| invalid(&format!("找不到捕获变量「{var}」")))?;
                parts.push(Part::Capture(index, var.to_owned()));
                Ok(())
            },
        )?;
        Ok(Self(parts))
    }

    fn render(&self, captures: &Captures<'_>) -> Result<String, String> {
        let mut output = String::new();
        for part in &self.0 {
            match part {
                Part::Literal(literal) => output.push_str(literal),
                Part::Capture(index, name) => {
                    let value = captures
                        .get(*index)
                        .ok_or_else(|| format!("变量「{name}」未匹配"))?;
                    output.push_str(value.as_str());
                }
            }
            if output.len() > MAX_TAG_BYTES {
                return Err("生成的标签过长".into());
            }
        }
        Ok(output)
    }
}

fn filename_regex(input: &str) -> AppResult<Regex> {
    let mut regex = String::from(r"\A");
    let mut names = HashSet::new();
    parse_placeholders(
        input,
        &mut regex,
        |regex, literal| regex.push_str(&regex::escape(literal)),
        |regex, var| {
            let (name, kind) = var
                .split_once(':')
                .map(|(name, kind)| (name.trim(), kind.trim()))
                .unwrap_or((var, "str"));
            let mut chars = name.chars();
            let valid_name = chars
                .next()
                .is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic())
                && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric());
            if !valid_name || !names.insert(name.to_owned()) {
                return Err(invalid(&format!("变量名「{name}」无效或重复")));
            }
            let pattern = match kind {
                "str" => ".+?",
                "int" => "[0-9]+",
                _ => return Err(invalid("文件名模板的变量类型可用 str 或 int")),
            };
            regex.push_str(&format!("(?P<{name}>{pattern})"));
            Ok(())
        },
    )?;
    if names.is_empty() {
        return Err(invalid("文件名模板需要至少一个变量，例如 {{artist: str}}"));
    }
    regex.push_str(r"\z");
    compile_regex(&regex, true)
}

fn parse_placeholders<T>(
    input: &str,
    output: &mut T,
    mut literal: impl FnMut(&mut T, &str),
    mut variable: impl FnMut(&mut T, &str) -> AppResult<()>,
) -> AppResult<()> {
    if input.len() > 4096 {
        return Err(invalid("每个模板最多 4096 字节"));
    }
    let mut rest = input;
    while let Some((before, after)) = rest.split_once("{{") {
        literal(output, before);
        let (name, tail) = after
            .split_once("}}")
            .ok_or_else(|| invalid("变量缺少结束符号 }}"))?;
        variable(output, name.trim())?;
        rest = tail;
    }
    literal(output, rest);
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::new("INVALID_TAG_TEMPLATE", message)
}
