#!/usr/bin/env python3
"""Generate the Yoyoku app icon set from public/icon.jpg.

The source art stays full-bleed; only the corners are clipped by the
fifth-power superellipse |x|^5 + |y|^5 <= 1 (a rounded square, not a circle).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public" / "icon.jpg"
ICONS = ROOT / "src-tauri" / "icons"
PUBLIC_ICON = ROOT / "public" / "app-icon.png"
MASTER_SIZE = 1024
EXPONENT = 5.0
SUPERSAMPLE = 4


def superellipse_alpha(size: int) -> Image.Image:
    big = size * SUPERSAMPLE
    coords = (np.arange(big, dtype=np.float64) + 0.5) / big * 2.0 - 1.0
    x, y = np.meshgrid(coords, coords)
    inside = np.abs(x) ** EXPONENT + np.abs(y) ** EXPONENT <= 1.0
    raw = Image.fromarray((inside * 255).astype(np.uint8), mode="L")
    return raw.resize((size, size), Image.Resampling.LANCZOS)


def masked_icon(size: int) -> Image.Image:
    image = (
        Image.open(SOURCE)
        .convert("RGBA")
        .resize((size, size), Image.Resampling.LANCZOS)
    )
    image.putalpha(superellipse_alpha(size))
    return image


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    master = masked_icon(MASTER_SIZE)
    master.save(ICONS / "1024x1024.png")

    for name, size in {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "256x256.png": 256,
        "512x512.png": 512,
        "icon.png": 512,
    }.items():
        masked_icon(size).save(ICONS / name)

    master.resize((256, 256), Image.Resampling.LANCZOS).save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    master.save(ICONS / "icon.icns", format="ICNS")

    # Windows tile logos. These are not used by the NSIS bundle, but keeping
    # them in sync avoids a stale default icon in future MSIX work.
    for name, size in {
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }.items():
        masked_icon(size).save(ICONS / name)

    masked_icon(256).save(PUBLIC_ICON)
    print(f"icons written from {SOURCE}")


if __name__ == "__main__":
    main()
