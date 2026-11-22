use crate::error::{AppError, AppResult};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

pub const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"];

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Spawn an external program without a console window on Windows.
/// Python, tasklist and other console tools would otherwise flash a terminal
/// window whenever the GUI app starts them (tagging, model download, etc.).
pub fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn short_id(len: usize) -> String {
    uuid::Uuid::new_v4().simple().to_string()[..len.min(32)].to_string()
}

pub fn sha256_file(path: &Path) -> std::io::Result<(String, u64)> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), total))
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn sha256_text(text: &str) -> String {
    sha256_bytes(text.as_bytes())
}

pub fn normalize_rel_path(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

pub fn relative_to(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    normalize_rel_path(&rel.to_string_lossy())
}

/// 解析项目内相对路径，并保证结果仍然位于根目录内。
pub fn safe_join(root: &Path, rel: &str) -> AppResult<PathBuf> {
    if rel.split(['/', '\\']).any(|part| part == "..") {
        return Err(AppError::new(
            "UNSAFE_PATH",
            format!("路径包含上级目录引用：{rel}"),
        ));
    }
    let normalized = normalize_rel_path(rel);
    let rel_path = Path::new(&normalized);
    for comp in rel_path.components() {
        match comp {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => {
                return Err(AppError::new(
                    "UNSAFE_PATH",
                    format!("路径超出允许范围：{rel}"),
                ))
            }
        }
    }
    Ok(root.join(rel_path))
}

pub fn ext_lower(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

pub fn is_supported_image(path: &Path) -> bool {
    SUPPORTED_EXTENSIONS.contains(&ext_lower(path).as_str())
}

pub fn is_sidecar(path: &Path) -> bool {
    matches!(ext_lower(path).as_str(), "txt" | "caption")
}

pub fn stem_lower(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SniffInfo {
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub animated: bool,
    pub pages: u32,
}

/// 读取文件头识别格式与尺寸；多帧、损坏、超限在导入阶段报告。
pub fn sniff_image(path: &Path) -> AppResult<SniffInfo> {
    let meta = fs::metadata(path).map_err(|e| AppError::io("无法读取图片文件", e))?;
    let bytes = meta.len();
    if bytes == 0 {
        return Err(AppError::new("DECODE_FAILED", "图片文件为空"));
    }
    let ext = ext_lower(path);
    if !SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::new(
            "UNSUPPORTED_FORMAT",
            format!("不支持的图片格式：.{ext}"),
        ));
    }

    let mut file = File::open(path).map_err(|e| AppError::io("无法打开图片", e))?;
    let mut head = vec![0u8; 4096];
    let n = file.read(&mut head).map_err(|e| AppError::io("无法读取图片", e))?;
    head.truncate(n);

    let mut animated = false;
    let mut pages = 1u32;
    if ext == "webp" && head.len() >= 30 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        if &head[12..16] == b"VP8X" {
            let flags = head[20];
            animated = flags & 0x02 != 0;
        } else if &head[12..16] == b"VP8 " || &head[12..16] == b"VP8L" {
            animated = false;
        }
    }
    if ext == "png" && head.windows(4).any(|w| w == b"acTL") {
        animated = true;
    }
    if ext == "gif" {
        animated = true;
    }
    if ext == "tif" || ext == "tiff" {
        pages = count_tiff_pages(path).unwrap_or(1);
    }

    file.seek(SeekFrom::Start(0)).ok();
    let reader = image::ImageReader::with_format(
        BufReader::new(file),
        format_from_ext(&ext),
    );
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| AppError::new("DECODE_FAILED", format!("无法解码图片：{e}")))?;

    if width == 0 || height == 0 {
        return Err(AppError::new("DECODE_FAILED", "图片尺寸无效"));
    }

    Ok(SniffInfo {
        format: format_name(&ext),
        width,
        height,
        bytes,
        animated,
        pages,
    })
}

pub fn format_from_ext(ext: &str) -> image::ImageFormat {
    match ext {
        "jpg" | "jpeg" => image::ImageFormat::Jpeg,
        "png" => image::ImageFormat::Png,
        "webp" => image::ImageFormat::WebP,
        "bmp" => image::ImageFormat::Bmp,
        "tif" | "tiff" => image::ImageFormat::Tiff,
        _ => image::ImageFormat::Png,
    }
}

pub fn format_name(ext: &str) -> String {
    match ext {
        "jpg" | "jpeg" => "JPEG".into(),
        "png" => "PNG".into(),
        "webp" => "WebP".into(),
        "bmp" => "BMP".into(),
        "tif" | "tiff" => "TIFF".into(),
        other => other.to_uppercase(),
    }
}

fn count_tiff_pages(path: &Path) -> std::io::Result<u32> {
    let mut file = File::open(path)?;
    let mut header = [0u8; 8];
    if file.read_exact(&mut header).is_err() {
        return Ok(1);
    }
    let little = &header[0..2] == b"II";
    let big = &header[0..2] == b"MM";
    if !little && !big {
        return Ok(1);
    }
    let read_u16 = |b: &[u8]| -> u16 {
        if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        }
    };
    let read_u32 = |b: &[u8]| -> u32 {
        if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        }
    };
    if read_u16(&header[2..4]) != 42 {
        return Ok(1);
    }
    let mut offset = read_u32(&header[4..8]) as u64;
    let mut pages = 0u32;
    while offset > 0 && pages < 1000 {
        if file.seek(SeekFrom::Start(offset)).is_err() {
            break;
        }
        let mut count = [0u8; 2];
        if file.read_exact(&mut count).is_err() {
            break;
        }
        let entries = read_u16(&count) as u64;
        let next_offset_pos = offset + 2 + entries * 12;
        if file.seek(SeekFrom::Start(next_offset_pos)).is_err() {
            break;
        }
        let mut next = [0u8; 4];
        if file.read_exact(&mut next).is_err() {
            break;
        }
        pages += 1;
        offset = read_u32(&next) as u64;
    }
    Ok(pages.max(1))
}

pub fn ensure_dir(path: &Path) -> AppResult<()> {
    fs::create_dir_all(path).map_err(|e| AppError::io("无法创建目录", e))
}

pub fn copy_atomic(src: &Path, dst: &Path) -> AppResult<u64> {
    if let Some(parent) = dst.parent() {
        ensure_dir(parent)?;
    }
    let tmp = dst.with_file_name(format!(
        ".{}.part-{}",
        dst.file_name().unwrap_or_default().to_string_lossy(),
        short_id(8)
    ));
    let result = (|| -> std::io::Result<u64> {
        let mut input = BufReader::new(File::open(src)?);
        let mut output = File::create(&tmp)?;
        let bytes = std::io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        Ok(bytes)
    })();
    match result {
        Ok(bytes) => {
            if let Err(e) = fs::rename(&tmp, dst) {
                let _ = fs::remove_file(&tmp);
                return Err(AppError::io("无法完成文件写入", e));
            }
            Ok(bytes)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(AppError::io("复制文件失败", e))
        }
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.part-{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        short_id(8)
    ));
    fs::write(&tmp, bytes).map_err(|e| AppError::io("写入文件失败", e))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::io("提交文件失败", e));
    }
    Ok(())
}

pub fn remove_dir_if_exists(path: &Path) -> AppResult<()> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(|e| AppError::io("无法清理临时目录", e))?;
    }
    Ok(())
}

const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Windows 安全的文件名（不含扩展名）。
pub fn sanitize_stem(stem: &str) -> String {
    let mut out = String::with_capacity(stem.len());
    for ch in stem.chars() {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let mut trimmed = out.trim_end_matches([' ', '.']).to_string();
    if trimmed.is_empty() {
        trimmed = "image".into();
    }
    if RESERVED_NAMES.contains(&trimmed.to_uppercase().as_str()) {
        trimmed = format!("_{trimmed}");
    }
    let mut chars: Vec<char> = trimmed.chars().collect();
    if chars.len() > 100 {
        chars.truncate(100);
    }
    let result: String = chars.into_iter().collect();
    result.trim_end_matches([' ', '.']).to_string()
}

pub fn expand_user_home(input: &str) -> String {
    let value = input.trim();
    if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        if let Some(home) = dirs_home() {
            return format!(
                "{}{}",
                home.to_string_lossy(),
                &value[1..].replace('/', std::path::MAIN_SEPARATOR_STR)
            );
        }
    }
    value.to_string()
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

pub fn open_path_in_explorer(path: &Path) -> AppResult<()> {
    let target = if path.is_file() {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    };
    #[cfg(windows)]
    {
        hidden_command("explorer.exe")
            .arg(target)
            .spawn()
            .map_err(|e| AppError::io("无法打开资源管理器", e))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        hidden_command("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| AppError::io("无法打开文件管理器", e))?;
        Ok(())
    }
}

pub fn dir_size(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

pub fn count_files(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .count() as u64
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn read_optional_text(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let bytes = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        &bytes[..]
    };
    String::from_utf8(bytes.to_vec()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_stem_handles_windows_reserved_names() {
        assert_eq!(sanitize_stem("CON"), "_CON");
        assert_eq!(sanitize_stem("a<b>c:d"), "a_b_c_d");
        assert_eq!(sanitize_stem("name. "), "name");
        assert_eq!(sanitize_stem("   "), "image");
    }

    #[test]
    fn safe_join_rejects_parent_traversal() {
        let root = Path::new("C:/project");
        assert!(safe_join(root, "../secret.txt").is_err());
        assert!(safe_join(root, "images/../ok.png").is_err());
        assert_eq!(
            safe_join(root, r"images\sub\a.png").unwrap(),
            root.join("images").join("sub").join("a.png")
        );
    }

    #[test]
    fn rel_paths_are_normalized() {
        assert_eq!(normalize_rel_path(r"a\b/../c.png"), "a/c.png");
        assert_eq!(normalize_rel_path("./a//b.png"), "a/b.png");
    }
}
