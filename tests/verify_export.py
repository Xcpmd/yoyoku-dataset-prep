#!/usr/bin/env python3
"""独立校验 Yoyoku 导出的 Kohya / ImageFolder 包。

用法：
  python tests/verify_export.py "path/to/package" [--zip]

不依赖训练端，只验证包结构、清单、图片、标注、TOML / JSONL 语法与哈希。
"""
import hashlib
import json
import sys
import tempfile
import tomllib
import zipfile
from pathlib import Path

from PIL import Image


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def read_bytes(root, rel):
    path = root / rel
    return path.read_bytes()


def main():
    if len(sys.argv) < 2:
        print("用法：python tests/verify_export.py <package-dir-or-zip>")
        return 2
    target = Path(sys.argv[1])
    temp = None
    if target.is_file() and target.suffix.lower() == ".zip":
        temp = tempfile.TemporaryDirectory()
        with zipfile.ZipFile(target) as archive:
            archive.extractall(temp.name)
        roots = list(Path(temp.name).iterdir())
        if len(roots) != 1 or not roots[0].is_dir():
            print("FAIL: ZIP 应只包含一个包根目录")
            return 1
        root = roots[0]
    elif target.is_dir():
        root = target
    else:
        print("FAIL: 路径不存在")
        return 1

    errors = []
    manifest_path = root / "manifest.json"
    if not manifest_path.exists():
        print("FAIL: 缺少 manifest.json")
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    target_type = manifest.get("adapter")
    items = manifest.get("items", [])
    print(f"package={root.name} adapter={target_type} items={len(items)}")

    # 清单文件哈希
    for file_info in manifest.get("files", []):
        path = root / file_info["path"]
        if not path.exists():
            errors.append(f"清单文件缺失：{file_info['path']}")
            continue
        if sha256_bytes(path.read_bytes()) != file_info["sha256"]:
            errors.append(f"清单文件哈希不一致：{file_info['path']}")

    # 图片 / 标注 / 像素
    for item in items:
        image_path = root / item["image_path"]
        if not image_path.exists():
            errors.append(f"图片缺失：{item['image_path']}")
            continue
        data = image_path.read_bytes()
        if sha256_bytes(data) != item["image_sha256"]:
            errors.append(f"图片哈希不一致：{item['image_path']}")
        try:
            with Image.open(image_path) as image:
                if image.size != (item["width"], item["height"]):
                    errors.append(
                        f"图片尺寸不一致：{item['image_path']} {image.size} != {(item['width'], item['height'])}"
                    )
                if image.mode not in ("RGB", "L"):
                    errors.append(f"图片不是 RGB：{item['image_path']} mode={image.mode}")
        except Exception as error:  # noqa: BLE001
            errors.append(f"图片无法解码：{item['image_path']} {error}")
        if target_type == "kohya":
            caption_path = root / item["caption_path"]
            if not caption_path.exists():
                errors.append(f"标注缺失：{item['caption_path']}")
                continue
            caption_data = caption_path.read_bytes()
            if sha256_bytes(caption_data) != item["caption_sha256"]:
                errors.append(f"标注哈希不一致：{item['caption_path']}")
            text = caption_data.decode("utf-8")
            if not text.strip():
                errors.append(f"空标注：{item['caption_path']}")
            if "\n" in text.rstrip("\n"):
                errors.append(f"Kohya 标注不是单行：{item['caption_path']}")

    if target_type == "kohya":
        toml_path = root / "dataset.toml"
        try:
            config = tomllib.loads(toml_path.read_text(encoding="utf-8"))
            subsets = config["datasets"][0]["subsets"]
            if not subsets:
                errors.append("TOML 没有 subsets")
            for subset in subsets:
                image_dir = root / subset["image_dir"]
                if not image_dir.is_dir():
                    errors.append(f"TOML image_dir 不存在：{subset['image_dir']}")
                elif not list(image_dir.glob("*.png")) and not list(image_dir.glob("*.jpg")):
                    errors.append(f"TOML image_dir 为空：{subset['image_dir']}")
        except Exception as error:  # noqa: BLE001
            errors.append(f"TOML 解析失败：{error}")
    elif target_type == "imagefolder":
        for split in ["train", "validation"]:
            expected = [item for item in items if item["split"] == ("val" if split == "validation" else split)]
            metadata_path = root / split / "metadata.jsonl"
            if expected and not metadata_path.exists():
                errors.append(f"缺少 {split}/metadata.jsonl")
                continue
            if not expected:
                continue
            lines = [line for line in metadata_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            if len(lines) != len(expected):
                errors.append(f"{split}/metadata.jsonl 行数 {len(lines)} != {len(expected)}")
            for line in lines:
                obj = json.loads(line)
                if not obj.get("text", "").strip():
                    errors.append(f"{split} 空文本：{obj.get('file_name')}")
                if not (root / split / obj["file_name"]).exists():
                    errors.append(f"{split} 文件不存在：{obj['file_name']}")

    if temp:
        temp.cleanup()

    if errors:
        print("FAIL")
        for error in errors:
            print(" -", error)
        return 1
    print("PASS: 包结构、清单、图片、标注与语法校验全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
