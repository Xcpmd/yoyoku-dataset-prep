#!/usr/bin/env python3
"""Florence-2 local caption adapter.

Reads one JSON object from stdout, matching the WD14 adapter:
  {"text": "...", "device": "CPU", "elapsedMs": 123, "model": "...", "runtime": "transformers"}
Run with a Python that has torch / transformers / einops. The embedded WD14
runtime only contains onnxruntime and intentionally is not used here.
"""
from __future__ import annotations

import argparse
import importlib.machinery
import importlib.util
import json
import sys
import time
import types


def install_timm_shim() -> None:
    """Florence remote code imports two small timm utilities for training only.

    Keep the adapter usable without installing timm; inference never enables
    stochastic drop path, so a minimal compatible shim is sufficient.
    """
    if importlib.util.find_spec("timm") is not None:
        return
    try:
        import torch
    except Exception:
        return

    timm = types.ModuleType("timm")
    timm.__spec__ = importlib.machinery.ModuleSpec("timm", None)
    layers = types.ModuleType("timm.layers")
    layers.__spec__ = importlib.machinery.ModuleSpec("timm.layers", None)

    class DropPath(torch.nn.Module):
        def __init__(self, drop_prob: float = 0.0) -> None:
            super().__init__()
            self.drop_prob = drop_prob

        def forward(self, x):
            return x

    def trunc_normal_(tensor, mean=0.0, std=1.0, a=-2.0, b=2.0):
        return torch.nn.init.trunc_normal_(tensor, mean=mean, std=std, a=a, b=b)

    layers.DropPath = DropPath
    layers.trunc_normal_ = trunc_normal_
    timm.layers = layers
    sys.modules["timm"] = timm
    sys.modules["timm.layers"] = layers


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--task", default="<MORE_DETAILED_CAPTION>")
    parser.add_argument("--max-new-tokens", type=int, default=256)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    args = parser.parse_args()

    try:
        import torch
        from PIL import Image
    except Exception as error:  # noqa: BLE001
        print(
            f"Florence-2 运行时缺少依赖：{error}。请在设置中指定安装 torch、transformers、einops 的 Python 3.10+。",
            file=sys.stderr,
        )
        return 2

    install_timm_shim()
    try:
        from transformers import AutoModelForCausalLM, AutoProcessor
    except Exception as error:  # noqa: BLE001
        print(
            f"Florence-2 无法加载 transformers：{error}。需要 torch、transformers、einops 与 Pillow。",
            file=sys.stderr,
        )
        return 2

    started = time.time()
    use_cuda = args.device == "cuda" or (args.device == "auto" and torch.cuda.is_available())
    device = "cuda" if use_cuda else "cpu"
    dtype = torch.float16 if use_cuda else torch.float32

    try:
        processor = AutoProcessor.from_pretrained(
            args.model_dir, trust_remote_code=True, local_files_only=True
        )
        model = AutoModelForCausalLM.from_pretrained(
            args.model_dir,
            trust_remote_code=True,
            local_files_only=True,
            torch_dtype=dtype,
        )
        model.to(device)
        model.eval()

        image = Image.open(args.image).convert("RGB")
        inputs = processor(text=args.task, images=image, return_tensors="pt")
        inputs = {
            key: (
                value.to(device=device, dtype=dtype)
                if hasattr(value, "is_floating_point") and value.is_floating_point()
                else value.to(device)
            )
            if hasattr(value, "to")
            else value
            for key, value in inputs.items()
        }
        with torch.inference_mode():
            generated = model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                max_new_tokens=max(32, min(args.max_new_tokens, 512)),
                num_beams=2,
                do_sample=False,
            )
        decoded = processor.batch_decode(generated, skip_special_tokens=False)[0]
        parsed = processor.post_process_generation(
            decoded, task=args.task, image_size=(image.width, image.height)
        )
        value = parsed.get(args.task)
        if isinstance(value, list):
            value = value[0] if value else ""
        text = str(value or decoded).strip()
        if not text:
            raise ValueError("Florence-2 没有返回描述")
        print(
            json.dumps(
                {
                    "text": text,
                    "device": "GPU" if use_cuda else "CPU",
                    "elapsedMs": int((time.time() - started) * 1000),
                    "model": "Florence-2 base-ft",
                    "runtime": "transformers",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0
    except Exception as error:  # noqa: BLE001
        print(f"Florence-2 推理失败：{error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
