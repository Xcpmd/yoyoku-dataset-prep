use crate::error::AppResult;
use crate::exports::{ExportItem, ADAPTER_VERSION, DIFFUSERS_COMPAT, KOHYA_COMPAT};
use crate::model::*;
use crate::util;
use serde_json::json;
use std::collections::BTreeSet;
use std::path::Path;

pub fn toml_content(config: &ExportConfig, items: &[ExportItem]) -> String {
    let all_tags = items
        .iter()
        .filter(|item| item.split == "train")
        .all(|item| item.caption_mode == "tags");
    let shuffle = config.kohya.shuffle_caption && all_tags;
    let caption_extension = if config.caption_extension == ".caption" {
        ".caption"
    } else {
        ".txt"
    };
    let mut out = String::new();
    out.push_str("[general]\n");
    out.push_str(&format!("caption_extension = \"{caption_extension}\"\n"));
    out.push_str(&format!("shuffle_caption = {}\n\n", if shuffle { "true" } else { "false" }));
    out.push_str("[[datasets]]\n");
    out.push_str(&format!(
        "resolution = [{}, {}]\n",
        config.kohya.resolution[0], config.kohya.resolution[1]
    ));
    out.push_str(&format!("batch_size = {}\n", config.kohya.batch_size.max(1)));
    out.push_str(&format!(
        "enable_bucket = {}\n",
        if config.kohya.enable_bucket { "true" } else { "false" }
    ));
    out.push_str(&format!(
        "bucket_no_upscale = {}\n",
        if config.kohya.bucket_no_upscale { "true" } else { "false" }
    ));
    out.push_str(&format!("bucket_reso_steps = {}\n\n", config.kohya.bucket_steps.max(8)));

    use std::collections::BTreeMap;
    let mut subsets: BTreeMap<String, (u32, u32)> = BTreeMap::new();
    for item in items.iter().filter(|item| item.split == "train") {
        let dir = if item.subset.is_empty() {
            "train".to_string()
        } else {
            format!("train/{}", item.subset)
        };
        let entry = subsets.entry(dir).or_insert((item.repeats.max(1), item.keep_tokens));
        entry.0 = entry.0.max(1);
    }
    if subsets.is_empty() {
        subsets.insert("train".into(), (1, config.kohya.keep_tokens));
    }
    for (dir, (repeats, keep_tokens)) in subsets {
        out.push_str("[[datasets.subsets]]\n");
        out.push_str(&format!("image_dir = \"{dir}\"\n"));
        out.push_str(&format!("num_repeats = {}\n", repeats.max(1)));
        if keep_tokens > 0 {
            out.push_str(&format!("keep_tokens = {keep_tokens}\n"));
        }
        out.push('\n');
    }
    out
}

pub fn split_dir(split: &str) -> &'static str {
    match split {
        "val" | "validation" => "validation",
        _ => "train",
    }
}

pub fn jsonl_content(items: &[ExportItem], split: &str) -> String {
    let mut out = String::new();
    let dir = split_dir(split);
    for item in items.iter().filter(|item| item.split == split) {
        let file_name = item
            .image_path
            .strip_prefix(&format!("{dir}/"))
            .unwrap_or(&item.image_path);
        let line = json!({ "file_name": file_name, "text": item.caption });
        out.push_str(&serde_json::to_string(&line).unwrap_or_default());
        out.push('\n');
    }
    out
}

pub fn manifest_json(
    config: &ExportConfig,
    items: &[ExportItem],
    entries: &[serde_json::Value],
    fingerprint: &str,
    split: &SplitSummary,
    files: &[(String, String)],
    model: &str,
    output_name: &str,
) -> String {
    let train = items.iter().filter(|i| i.split == "train").count();
    let val = items.iter().filter(|i| i.split == "val").count();
    let subsets: Vec<serde_json::Value> = {
        let mut map: std::collections::BTreeMap<String, (String, u32, i64)> = Default::default();
        for item in items.iter().filter(|i| i.split == "train") {
            let key = if item.subset.is_empty() {
                "train".to_string()
            } else {
                format!("train/{}", item.subset)
            };
            let entry = map
                .entry(key)
                .or_insert((item.subset_label.clone(), item.repeats.max(1), 0));
            entry.2 += 1;
        }
        map.into_iter()
            .map(|(dir, (label, repeats, count))| {
                json!({ "dir": dir, "name": label, "repeats": repeats, "items": count })
            })
            .collect()
    };
    let manifest = json!({
        "manifestVersion": 1,
        "app": format!("yoyoku-dataset-prep/{}", env!("CARGO_PKG_VERSION")),
        "adapter": config.target,
        "adapterVersion": ADAPTER_VERSION,
        "upstream": if config.target == "kohya" { KOHYA_COMPAT } else { DIFFUSERS_COMPAT },
        "baseModel": model,
        "outputName": output_name,
        "snapshotFingerprint": fingerprint,
        "seed": config.validation.seed,
        "createdAt": util::now_iso(),
        "package": config.package,
        "split": {
            "enabled": split.enabled,
            "mode": split.mode,
            "train": train,
            "val": val,
            "groups": split.groups,
        },
        "counts": {
            "total": items.len(),
            "train": train,
            "val": val,
            "subsets": subsets,
        },
        "items": entries,
        "files": files
            .iter()
            .map(|(path, hash)| json!({ "path": path, "sha256": hash }))
            .collect::<Vec<_>>(),
    });
    serde_json::to_string_pretty(&manifest).unwrap_or_default()
}

pub fn readme_content(
    config: &ExportConfig,
    split: &SplitSummary,
    output_name: &str,
    model: &str,
) -> String {
    if config.target == "kohya" {
        format!(
r#"# {output_name}

由 Yoyoku Dataset Prep 生成。目标训练端：Kohya `sd-scripts`（DreamBooth 同名标注结构）。
基础模型：{model}。适配器版本：{ADAPTER_VERSION}。

## 目录结构

```text
{output_name}/
  train/                 # 训练图片与同名 .{caption_ext}
  validation/            # 可选：留出验证目录（不写入 TOML）
  dataset.toml           # 训练配置
  dataset.absolute.toml  # 可选：由「复制训练入口」生成
  manifest.json          # 文件、图片与标注校验信息
  README.md
```

训练图片 {train} 张，验证图片 {val} 张。分桶 {bucket}，步长 {steps} px，禁止放大 {no_upscale}。
{split_note}

## 启动

在包根目录运行：

```bash
accelerate launch --num_cpu_threads_per_process 1 sdxl_train_network.py --dataset_config dataset.toml
```

SD 1.5 LoRA 可将脚本替换为 `train_network.py`。相对路径 `image_dir` 以启动命令的工作目录为基准；
从其他目录启动时请使用「复制训练入口」生成的绝对版 TOML，或把 `--dataset_config` 指向绝对路径。

## 兼容与验证

- 结构按 sd-scripts 的 DreamBooth 数据集配置组织；`train/` 与 `validation/` 目录分离。
- 本次导出完成计数、图片解码、图片/标注配对、TOML 语法与清单一致性校验（见 `manifest.json`）。
- 上游脚本与 commit 未随包分发；升级 sd-scripts 后建议先跑一次 1 步 dry run 检查字段兼容。
"#,
            caption_ext = if config.caption_extension == ".caption" { "caption" } else { "txt" },
            train = split.train,
            val = split.val,
            bucket = if config.kohya.enable_bucket { "启用" } else { "关闭" },
            steps = config.kohya.bucket_steps,
            no_upscale = if config.kohya.bucket_no_upscale { "true" } else { "false" },
            split_note = if split.enabled {
                format!("拆分方式：{}；{}", split.mode, split.note)
            } else {
                "未启用验证集。".to_string()
            },
        )
    } else {
        format!(
r#"# {output_name}

由 Yoyoku Dataset Prep 生成。目标训练端：Hugging Face ImageFolder / Diffusers LoRA 示例。
基础模型：{model}。适配器版本：{ADAPTER_VERSION}。

## 目录结构

```text
{output_name}/
  train/
    000001.png
    metadata.jsonl
  validation/            # 可选
    000001.png
    metadata.jsonl
  manifest.json
  README.md
```

训练图片 {train} 张，验证图片 {val} 张。每个分割目录内的 `metadata.jsonl` 逐行保存
`file_name` 与 `text`，`file_name` 相对该 JSONL 文件所在目录。

## 读取

```python
from datasets import load_dataset
ds = load_dataset("imagefolder", data_dir="{output_name}")
```

Diffusers SDXL LoRA 训练入口：

```bash
accelerate launch train_text_to_image_lora_sdxl.py \
  --train_data_dir "{output_name}/train" \
  --image_column image --caption_column text
```

SD 1.5 使用 `train_text_to_image_lora.py`。验证目录供后续验证流程显式使用。
{split_note}

## 兼容与验证

- 本次导出完成计数、图片解码、JSONL 语法、图片/标注配对与清单一致性校验。
- 上游脚本与 commit 未随包分发；升级 Diffusers 后建议先确认脚本参数名（`image_column` / `caption_column`）。
"#,
            train = split.train,
            val = split.val,
            split_note = if split.enabled {
                format!("拆分方式：{}；{}", split.mode, split.note)
            } else {
                "未启用验证集。".to_string()
            },
        )
    }
}

pub fn fill_preview_files(
    preview: &mut ExportPreview,
    items: &[ExportItem],
    config: &ExportConfig,
    model: &str,
) -> AppResult<()> {
    let mut files = Vec::new();
    let mut tree = BTreeSet::new();
    if config.target == "kohya" {
        let toml = toml_content(config, items);
        files.push(PreviewFile { path: "dataset.toml".into(), content: Some(toml.clone()), kind: "toml".into() });
    } else {
        for split in ["train", "validation"] {
            let content = jsonl_content(items, split);
            files.push(PreviewFile {
                path: format!("{split}/metadata.jsonl"),
                content: Some(content.lines().take(5).collect::<Vec<_>>().join("\n")),
                kind: "jsonl".into(),
            });
        }
    }
    let readme = readme_content(config, &preview.split, &Path::new(&preview.output_path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), model);
    files.push(PreviewFile { path: "README.md".into(), content: Some(readme), kind: "readme".into() });
    let manifest_sample = json!({
        "manifestVersion": 1,
        "adapter": config.target,
        "adapterVersion": ADAPTER_VERSION,
        "snapshotFingerprint": preview.fingerprint,
        "counts": preview.counts,
        "items": items.iter().take(2).map(|item| json!({
            "asset_id": item.asset_id,
            "split": item.split,
            "subset": item.subset_label,
            "image_path": item.image_path,
            "width": item.width,
            "height": item.height,
            "caption_path": item.caption_path,
        })).collect::<Vec<_>>(),
    });
    files.push(PreviewFile {
        path: "manifest.json".into(),
        content: Some(serde_json::to_string_pretty(&manifest_sample).unwrap_or_default()),
        kind: "manifest".into(),
    });
    preview.files = files;

    for item in items.iter().take(300) {
        for path in [&item.image_path, &item.caption_path] {
            if path.is_empty() {
                continue;
            }
            let mut parts: Vec<&str> = path.split('/').collect();
            parts.pop();
            let mut prefix = String::new();
            for part in parts {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                tree.insert(format!("{prefix}/"));
            }
            tree.insert(path.clone());
        }
    }
    for file in &preview.files {
        tree.insert(file.path.clone());
    }
    if items.len() > 300 {
        preview.warnings.push(format!(
            "文件树仅展示前 300 个条目，实际 {} 张图片。",
            items.len()
        ));
    }
    preview.tree = tree.into_iter().collect();
    let mut samples = Vec::new();
    for split in ["train", "val"] {
        for item in items.iter().filter(|item| item.split == split).take(2) {
            samples.push(ExportSample {
                image_path: item.image_path.clone(),
                caption_path: item.caption_path.clone(),
                caption: item.caption.chars().take(200).collect(),
                split: item.split.clone(),
                width: item.width,
                height: item.height,
            });
        }
    }
    if samples.is_empty() {
        for item in items.iter().take(4) {
            samples.push(ExportSample {
                image_path: item.image_path.clone(),
                caption_path: item.caption_path.clone(),
                caption: item.caption.chars().take(200).collect(),
                split: item.split.clone(),
                width: item.width,
                height: item.height,
            });
        }
    }
    preview.samples = samples;
    Ok(())
}
