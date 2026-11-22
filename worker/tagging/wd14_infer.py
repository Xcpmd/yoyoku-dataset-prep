#!/usr/bin/env python3
"""WD14 tagger 本地推理适配器。

由 Yoyoku 应用通过自带的 Python 运行，读取本地 ONNX 模型并与
selected_tags.csv 按模型列顺序映射。输出单行 JSON。
"""
import argparse
import csv
import json
import os
import sys
import time

import numpy as np
from PIL import Image, ImageOps
from onnxruntime import InferenceSession, get_available_providers

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def load_image(path, size):
    image = Image.open(path)
    image = ImageOps.exif_transpose(image)
    image = image.convert("RGBA")
    canvas = Image.new("RGBA", image.size, (255, 255, 255, 255))
    canvas.alpha_composite(image)
    image = canvas.convert("RGB")
    # 保持比例，补白到正方形
    width, height = image.size
    side = max(width, height)
    square = Image.new("RGB", (side, side), (255, 255, 255))
    square.paste(image, ((side - width) // 2, (side - height) // 2))
    image = square.resize((size, size), Image.Resampling.LANCZOS)
    array = np.asarray(image).astype(np.float32)
    array = array[:, :, ::-1]  # RGB -> BGR
    return np.expand_dims(array, 0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threshold", type=float, default=0.35)
    parser.add_argument("--character-threshold", type=float, default=0.85)
    parser.add_argument("--max-tags", type=int, default=80)
    parser.add_argument("--cpu", action="store_true")
    args = parser.parse_args()

    started = time.time()
    model_path = os.path.join(args.model_dir, "model.onnx")
    tags_path = os.path.join(args.model_dir, "selected_tags.csv")
    if not os.path.exists(model_path) or not os.path.exists(tags_path):
        raise FileNotFoundError("模型目录缺少 model.onnx 或 selected_tags.csv")

    providers = ["CPUExecutionProvider"]
    if not args.cpu and "CUDAExecutionProvider" in get_available_providers():
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    session = InferenceSession(model_path, providers=providers)

    input_meta = session.get_inputs()[0]
    shape = input_meta.shape
    size = int(shape[1]) if isinstance(shape[1], int) else 448
    input_name = input_meta.name
    output_name = session.get_outputs()[0].name

    tensor = load_image(args.image, size)
    outputs = session.run([output_name], {input_name: tensor})[0][0]

    with open(tags_path, "r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != len(outputs):
        raise ValueError(f"标签数量 {len(rows)} 与模型输出 {len(outputs)} 不一致")

    ratings = {}
    tags = []
    for index, row in enumerate(rows):
        name = (row.get("name") or "").strip()
        category = (row.get("category") or "0").strip()
        score = float(outputs[index])
        if index < 4 or category == "9":
            ratings[name] = round(score, 4)
            continue
        threshold = args.character_threshold if category == "4" else args.threshold
        if score >= threshold:
            tags.append({"tag": name, "score": round(score, 4), "category": category})
    tags.sort(key=lambda item: item["score"], reverse=True)
    tags = tags[: args.max_tags]

    result = {
        "tags": [item["tag"] for item in tags],
        "scores": tags,
        "ratings": ratings,
        "device": "GPU" if providers and providers[0].startswith("CUDA") else "CPU",
        "elapsedMs": int((time.time() - started) * 1000),
        "inputSize": size,
        "model": os.path.basename(args.model_dir),
        "runtime": "onnxruntime",
    }
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
