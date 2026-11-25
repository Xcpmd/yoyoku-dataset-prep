#!/usr/bin/env python3
"""WD14 tagger 本地推理适配器。

由 Yoyoku 应用通过自带的 Python 运行，读取本地 ONNX 模型并与
selected_tags.csv 按模型列顺序映射。默认输出单行 JSON；使用
`--serve` 时进入常驻模式，模型只加载一次，逐行处理图片请求。
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
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")


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


def load_model(model_dir, cpu):
    model_path = os.path.join(model_dir, "model.onnx")
    tags_path = os.path.join(model_dir, "selected_tags.csv")
    if not os.path.exists(model_path) or not os.path.exists(tags_path):
        raise FileNotFoundError("模型目录缺少 model.onnx 或 selected_tags.csv")

    providers = ["CPUExecutionProvider"]
    if not cpu and "CUDAExecutionProvider" in get_available_providers():
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    session = InferenceSession(model_path, providers=providers)

    input_meta = session.get_inputs()[0]
    shape = input_meta.shape
    size = int(shape[1]) if isinstance(shape[1], int) else 448
    input_name = input_meta.name
    output_name = session.get_outputs()[0].name

    with open(tags_path, "r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    device = "GPU" if providers and providers[0].startswith("CUDA") else "CPU"
    return session, rows, input_name, output_name, size, device


def infer(session, rows, input_name, output_name, size, model_dir, device, image_path,
          threshold, character_threshold, max_tags):
    started = time.time()
    tensor = load_image(image_path, size)
    outputs = session.run([output_name], {input_name: tensor})[0][0]
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
        limit = character_threshold if category == "4" else threshold
        if score >= limit:
            tags.append({"tag": name, "score": round(score, 4), "category": category})
    tags.sort(key=lambda item: item["score"], reverse=True)
    tags = tags[:max_tags]

    return {
        "tags": [item["tag"] for item in tags],
        "scores": tags,
        "ratings": ratings,
        "device": device,
        "elapsedMs": int((time.time() - started) * 1000),
        "inputSize": size,
        "model": os.path.basename(model_dir),
        "runtime": "onnxruntime",
    }


def serve(args):
    session, rows, input_name, output_name, size, device = load_model(
        args.model_dir, args.cpu
    )
    print(
        json.dumps(
            {
                "ready": True,
                "model": os.path.basename(args.model_dir),
                "device": device,
                "runtime": "onnxruntime",
                "inputSize": size,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            image = request.get("image")
            if not image:
                raise ValueError("缺少 image 参数")
            result = infer(
                session,
                rows,
                input_name,
                output_name,
                size,
                args.model_dir,
                device,
                image,
                float(request.get("threshold", args.threshold)),
                float(request.get("characterThreshold", args.character_threshold)),
                int(request.get("maxTags", args.max_tags)),
            )
            print(
                json.dumps({"id": request_id, "ok": True, "result": result}, ensure_ascii=False),
                flush=True,
            )
        except Exception as error:  # noqa: BLE001
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "ok": False,
                        "error": {"code": "MODEL_ERROR", "message": str(error)},
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threshold", type=float, default=0.35)
    parser.add_argument("--character-threshold", type=float, default=0.85)
    parser.add_argument("--max-tags", type=int, default=80)
    parser.add_argument("--cpu", action="store_true")
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()

    if args.serve:
        serve(args)
        return
    if not args.image:
        raise ValueError("缺少 --image 参数")

    session, rows, input_name, output_name, size, device = load_model(
        args.model_dir, args.cpu
    )
    result = infer(
        session,
        rows,
        input_name,
        output_name,
        size,
        args.model_dir,
        device,
        args.image,
        args.threshold,
        args.character_threshold,
        args.max_tags,
    )
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
