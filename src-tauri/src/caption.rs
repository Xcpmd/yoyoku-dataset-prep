use unicode_normalization::UnicodeNormalization;

/// 比较键：Unicode NFKC、去首尾空白、合并连续空白、大小写折叠。
pub fn normalize_key(value: &str) -> String {
    let normalized: String = value.nfkc().collect();
    let mut out = String::with_capacity(normalized.len());
    let mut last_space = false;
    for ch in normalized.trim().chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out.to_lowercase()
}

pub fn split_caption_text(text: &str) -> Vec<String> {
    text.split(|c| c == ',' || c == '，' || c == '\n' || c == '\r')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

/// 解析并去重标签，保留首次采用的文本形式。
pub fn normalize_tags<I: IntoIterator<Item = String>>(tags: I) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = normalize_key(trimmed);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        result.push(trimmed.to_string());
    }
    result
}

pub fn tags_to_text(tags: &[String]) -> String {
    tags.join(", ")
}

pub fn replace_tag(tags: &mut Vec<String>, from_key: &str, to: &str) -> bool {
    if !tags.iter().any(|tag| normalize_key(tag) == from_key) {
        return false;
    }
    let next = normalize_tags(tags.iter().map(|tag| {
        if normalize_key(tag) == from_key {
            to.to_owned()
        } else {
            tag.clone()
        }
    }));
    if next == *tags {
        return false;
    }
    *tags = next;
    true
}

pub fn search_text(mode: &str, tags: &[String], text: &str) -> String {
    let mut pieces = Vec::new();
    if mode != "nl" {
        pieces.extend(tags.iter().cloned());
    }
    if !text.trim().is_empty() {
        pieces.push(text.to_string());
    }
    pieces.join(" \n ").to_lowercase()
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn contains_trigger(text: &str, trigger: &str) -> bool {
    let text_lower = text.to_lowercase();
    let trigger_lower = trigger.to_lowercase();
    if trigger_lower.is_empty() {
        return false;
    }
    let mut offset = 0usize;
    while let Some(found) = text_lower[offset..].find(&trigger_lower) {
        let start = offset + found;
        let end = start + trigger_lower.len();
        let before_ok = text_lower[..start]
            .chars()
            .next_back()
            .map(|c| !is_word_char(c))
            .unwrap_or(true);
        let after_ok = text_lower[end..]
            .chars()
            .next()
            .map(|c| !is_word_char(c))
            .unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
        offset = end;
        if offset >= text_lower.len() {
            break;
        }
    }
    false
}

/// 所有标注栏、质检与导出共用的最终标注函数。
pub fn finalize_caption(
    mode: &str,
    tags: &[String],
    text: &str,
    trigger_word: &str,
    trigger_mode: &str,
    trigger_disabled: bool,
) -> String {
    let trigger = trigger_word.trim();
    let mixed = mode == "mixed";
    if mode == "tags" || mixed {
        let mut result = normalize_tags(tags.iter().cloned());
        let body = text.trim().replace(['\r', '\n'], " ");
        let body = body.trim_matches(|c: char| c == ',' || c == '，' || c.is_whitespace());
        if result.is_empty() && body.is_empty() {
            return String::new();
        }
        if !trigger.is_empty() && !trigger_disabled {
            let key = normalize_key(trigger);
            if let Some(index) = result.iter().position(|tag| normalize_key(tag) == key) {
                // 移除同义重复项，保留最先出现的展示形式并移到首位
                let display = result.remove(index);
                result.retain(|tag| normalize_key(tag) != key);
                result.insert(0, display);
            } else {
                result.insert(0, trigger.to_string());
            }
        }
        let tag_text = tags_to_text(&result);
        if !mixed {
            return tag_text;
        }
        if body.is_empty() {
            return tag_text;
        }
        if tag_text.is_empty() {
            return body.to_string();
        }
        if normalize_key(body) == normalize_key(&tags_to_text(&normalize_tags(tags.iter().cloned()))) {
            return tag_text;
        }
        return format!("{tag_text}, {body}");
    }

    let body = text.trim().to_string();
    if trigger.is_empty() || trigger_disabled || trigger_mode == "manual" || body.is_empty() {
        return body;
    }
    if contains_trigger(&body, trigger) {
        return body;
    }
    if trigger_mode == "prefix" {
        format!("{trigger}, {body}")
    } else {
        body
    }
}

pub fn caption_preview(mode: &str, tags: &[String], text: &str, max_len: usize) -> String {
    let source = if mode == "tags" {
        tags_to_text(tags)
    } else if mode == "mixed" {
        let tags_text = tags_to_text(tags);
        let body = text.trim().replace(['\r', '\n'], " · ");
        if tags_text.is_empty() {
            body
        } else if body.is_empty() {
            tags_text
        } else {
            format!("{tags_text} · {body}")
        }
    } else {
        text.trim().replace(['\r', '\n'], " · ")
    };
    if source.chars().count() <= max_len {
        source
    } else {
        let truncated: String = source.chars().take(max_len.saturating_sub(1)).collect();
        format!("{truncated}…")
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionStats {
    pub char_count: usize,
    pub tag_count: usize,
    pub token_estimate: Option<usize>,
    pub tokenizer_note: String,
}

pub fn caption_stats(mode: &str, tags: &[String], text: &str) -> CaptionStats {
    let content = if mode == "tags" {
        tags_to_text(tags)
    } else if mode == "mixed" {
        let tags_text = tags_to_text(tags);
        let body = text.trim();
        if tags_text.is_empty() {
            body.to_string()
        } else if body.is_empty() {
            tags_text
        } else {
            format!("{tags_text}, {body}")
        }
    } else {
        text.to_string()
    };
    let char_count = content.chars().count();
    let tag_count = if mode != "nl" { tags.len() } else { 0 };
    let mut latin_words = 0usize;
    let mut cjk = 0usize;
    let mut current_word = false;
    for ch in content.chars() {
        if ch.is_ascii_alphanumeric() {
            if !current_word {
                latin_words += 1;
                current_word = true;
            }
        } else {
            current_word = false;
            if is_cjk(ch) {
                cjk += 1;
            }
        }
    }
    let estimate = latin_words + cjk;
    CaptionStats {
        char_count,
        tag_count,
        token_estimate: if content.is_empty() { Some(0) } else { Some(estimate) },
        tokenizer_note: "估算值；安装所选训练端 tokenizer 后显示精确计数。".into(),
    }
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch,
        '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{3040}'..='\u{30FF}'
            | '\u{AC00}'..='\u{D7AF}'
    )
}

pub fn apply_tag_transform(
    op: &crate::model::BatchOp,
    mode: &str,
    tags: &[String],
    text: &str,
    trigger_word: &str,
) -> (Vec<String>, String) {
    use crate::model::BatchOp;
    let trigger_key = normalize_key(trigger_word);
    match op {
        BatchOp::AddTags { tags: additions } => {
            let mut result = tags.to_vec();
            result.extend(additions.iter().cloned());
            (normalize_tags(result), text.to_string())
        }
        BatchOp::RemoveTags { tags: removals } => {
            let keys: Vec<String> = removals.iter().map(|t| normalize_key(t)).collect();
            let result: Vec<String> = tags
                .iter()
                .filter(|tag| {
                    let key = normalize_key(tag);
                    !keys.contains(&key) || (!trigger_key.is_empty() && key == trigger_key)
                })
                .cloned()
                .collect();
            (result, text.to_string())
        }
        BatchOp::ReplaceTag { from, to } => {
            let from_key = normalize_key(from);
            let to_clean = to.trim().to_string();
            if !trigger_key.is_empty() && from_key == trigger_key {
                return (tags.to_vec(), text.to_string());
            }
            let mut result = tags.to_vec();
            if mode != "nl" || text.is_empty() || from.trim().is_empty() {
                replace_tag(&mut result, &from_key, &to_clean);
            }
            (result, text.to_string())
        }
        BatchOp::MoveToFront { tag } => {
            let key = normalize_key(tag);
            let mut result = tags.to_vec();
            if let Some(index) = result.iter().position(|value| normalize_key(value) == key) {
                let value = result.remove(index);
                result.insert(0, value);
            }
            (result, text.to_string())
        }
        BatchOp::Lowercase => {
            let result: Vec<String> = tags.iter().map(|tag| tag.to_lowercase()).collect();
            (normalize_tags(result), text.to_lowercase())
        }
        BatchOp::Underscores => {
            let result: Vec<String> = tags
                .iter()
                .map(|tag| tag.trim().replace(' ', "_"))
                .collect();
            (normalize_tags(result), text.to_string())
        }
        BatchOp::CleanShort { max_len } => {
            let result = tags
                .iter()
                .filter(|tag| {
                    let key = normalize_key(tag);
                    if !trigger_key.is_empty() && key == trigger_key {
                        return true;
                    }
                    tag.chars().count() > *max_len
                })
                .cloned()
                .collect();
            (result, text.to_string())
        }
        BatchOp::CopyCaption { .. } => (tags.to_vec(), text.to_string()),
        _ => (tags.to_vec(), text.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_deduplicated_by_nfkc_key() {
        let tags = normalize_tags(vec![
            "Long Hair".into(),
            "long  hair".into(),
            "Ｌｏｎｇ Hair".into(),
            "blue eyes".into(),
        ]);
        assert_eq!(tags, vec!["Long Hair", "blue eyes"]);
    }

    #[test]
    fn replacing_a_missing_tag_does_not_normalize_legacy_tags() {
        let original = vec!["Long Hair".into(), "long  hair".into()];
        let mut tags = original.clone();
        assert!(!replace_tag(&mut tags, "blue_eyes", "green eyes"));
        assert_eq!(tags, original);
    }

    #[test]
    fn trigger_moves_to_front_without_duplicates() {
        let text = finalize_caption(
            "tags",
            &["blue eyes".into(), "yoyoku_style".into(), "smile".into()],
            "",
            "yoyoku_style",
            "first",
            false,
        );
        assert_eq!(text, "yoyoku_style, blue eyes, smile");
    }

    #[test]
    fn empty_tags_stay_empty_without_trigger() {
        let text = finalize_caption("tags", &[], "", "yoyoku_style", "first", false);
        assert_eq!(text, "");
    }

    #[test]
    fn trigger_is_added_when_missing() {
        let text = finalize_caption("tags", &["smile".into()], "", "yoyoku_style", "first", false);
        assert_eq!(text, "yoyoku_style, smile");
        let disabled = finalize_caption("tags", &["smile".into()], "", "yoyoku_style", "first", true);
        assert_eq!(disabled, "smile");
    }

    #[test]
    fn natural_language_prefix_respects_existing_trigger() {
        let text = finalize_caption(
            "nl",
            &[],
            "A quiet street at night.",
            "yoyoku_style",
            "prefix",
            false,
        );
        assert_eq!(text, "yoyoku_style, A quiet street at night.");
        let existing = finalize_caption(
            "nl",
            &[],
            "yoyoku_style, a quiet street.",
            "yoyoku_style",
            "prefix",
            false,
        );
        assert_eq!(existing, "yoyoku_style, a quiet street.");
    }

    #[test]
    fn mixed_caption_keeps_phrases_and_natural_language() {
        let text = finalize_caption(
            "mixed",
            &["blue eyes".into(), "smile".into()],
            "A quiet street at night.
Soft moonlight.",
            "yoyoku_style",
            "first",
            false,
        );
        assert_eq!(
            text,
            "yoyoku_style, blue eyes, smile, A quiet street at night. Soft moonlight."
        );
        let only_nl = finalize_caption("mixed", &[], "A quiet street.", "yoyoku_style", "first", false);
        assert_eq!(only_nl, "yoyoku_style, A quiet street.");
        let disabled = finalize_caption("mixed", &[], "A quiet street.", "yoyoku_style", "first", true);
        assert_eq!(disabled, "A quiet street.");
    }

    #[test]
    fn mixed_caption_stats_and_search_include_both_fields() {
        let stats = caption_stats("mixed", &["蓝月".into(), "ink".into()], "夜空中的街道");
        assert_eq!(stats.tag_count, 2);
        assert!(stats.char_count >= 11);
        let search = search_text("mixed", &["Blue Moon".into()], "quiet street");
        assert!(search.contains("blue moon"));
        assert!(search.contains("quiet street"));
    }

    #[test]
    fn caption_stats_count_cjk_and_latin() {
        let stats = caption_stats("tags", &["蓝月".into(), "ink drawing".into()], "");
        assert_eq!(stats.char_count, 15);
        assert_eq!(stats.tag_count, 2);
        assert!(stats.token_estimate.unwrap() >= 4);
    }
}
