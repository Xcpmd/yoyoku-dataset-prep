#!/usr/bin/env python3
"""Download a public WD14 ONNX tagger from Hugging Face.

Emits one JSON object per line on stdout:
  {"event":"progress","file":...,"downloaded":...,"total":...,"percent":...}
Only the Python standard library is required.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

CHUNK = 1024 * 1024


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def safe_name(name: str) -> str:
    base = Path(name).name
    if not base or base in {".", ".."}:
        raise ValueError(f"invalid file name: {name}")
    return base


def download(repo: str, target: Path, files: list[str]) -> None:
    target.mkdir(parents=True, exist_ok=True)
    total_planned = len(files)
    for index, file in enumerate(files, start=1):
        name = safe_name(file)
        url = f"https://huggingface.co/{repo}/resolve/main/{name}"
        temp = target / f".{name}.part"
        final = target / name
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Yoyoku-Dataset-Prep/1.0 (+local model downloader)",
                "Accept": "application/octet-stream",
            },
        )
        emit(
            {
                "event": "start",
                "file": name,
                "index": index,
                "count": total_planned,
            }
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            total = int(response.headers.get("Content-Length") or 0)
            downloaded = 0
            last = 0.0
            with open(temp, "wb") as output:
                while True:
                    chunk = response.read(CHUNK)
                    if not chunk:
                        break
                    output.write(chunk)
                    downloaded += len(chunk)
                    now = time.monotonic()
                    if now - last >= 0.35:
                        last = now
                        percent = (downloaded / total * 100.0) if total else 0.0
                        emit(
                            {
                                "event": "progress",
                                "file": name,
                                "index": index,
                                "count": total_planned,
                                "downloaded": downloaded,
                                "total": total,
                                "percent": round(percent, 2),
                            }
                        )
                output.flush()
                os.fsync(output.fileno())
        os.replace(temp, final)
        emit(
            {
                "event": "progress",
                "file": name,
                "index": index,
                "count": total_planned,
                "downloaded": final.stat().st_size,
                "total": final.stat().st_size,
                "percent": 100.0,
            }
        )
        emit({"event": "file_done", "file": name, "index": index, "count": total_planned})
    emit({"event": "done", "count": total_planned})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--files", required=True)
    args = parser.parse_args()
    files = [part.strip() for part in args.files.split(",") if part.strip()]
    if not files:
        emit({"event": "error", "message": "no files requested"})
        return 2
    try:
        download(args.repo, Path(args.target), files)
    except Exception as error:  # noqa: BLE001
        emit({"event": "error", "message": str(error)})
        print(str(error), file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
