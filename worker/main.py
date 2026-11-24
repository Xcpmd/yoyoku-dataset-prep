#!/usr/bin/env python3
"""Yoyoku Dataset Prep 图像工作进程。

协议：stdin/stdout 逐行 JSON。
  请求  {"id": 1, "op": "render", "params": {...}}
  响应  {"id": 1, "ok": true, "result": {...}}
         {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}

像素数据只通过项目缓存文件交换，stdout 仅用于协议消息。stderr 写入日志。
"""
import io
import json
import math
import os
import sys
import traceback

from PIL import Image, ImageChops, ImageCms, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps, ImageStat

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")

RESAMPLE = {
    "lanczos": Image.Resampling.LANCZOS,
    "bicubic": Image.Resampling.BICUBIC,
}

# 所有会实际解码原图的入口共用同一个像素上限；与 Rust 侧的 80 MP 约束一致。
MAX_PIXELS = 80_000_000


class OpError(Exception):
    """带协议错误码的操作异常。"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def round_half_up(value):
    return int(math.floor(value + 0.5))


def respond(request_id, ok, result=None, error=None):
    message = {"id": request_id, "ok": ok}
    if ok:
        message["result"] = result
    else:
        message["error"] = error
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_color(value):
    """#rrggbb / #rrggbbaa / transparent -> RGBA tuple."""
    if value is None:
        return (255, 255, 255, 255)
    if value == "transparent":
        return (0, 0, 0, 0)
    raw = value.strip()
    if raw.startswith("#"):
        raw = raw[1:]
    try:
        if len(raw) == 6:
            return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16), 255)
        if len(raw) == 8:
            return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16), int(raw[6:8], 16))
    except ValueError:
        pass
    return (255, 255, 255, 255)


def has_alpha(im):
    return im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)


def load_normalized(path, draft_max=None, max_pixels=MAX_PIXELS, single_frame=False):
    """解码、EXIF 归正、ICC 转 sRGB。返回 (image, meta)。

    draft_max 仅用于分析/缩略统计：JPEG 让解码器直接输出较低分辨率，
    避免为 32x32 哈希和 512 统计解码整张 4K 图片。归一化尺寸仍按原图计算。

    max_pixels 与 single_frame 在真正解码之前检查，覆盖扫描后路径被替换的情况；
    导出、显示与缩略图的入口都走同一份约束。
    """
    source = None
    try:
        source = Image.open(path)
    except Image.DecompressionBombError as error:
        raise OpError("TOO_LARGE", "图片像素超过上限 80 MP") from error
    frames = int(getattr(source, "n_frames", 1) or 1)
    raw_width, raw_height = source.size
    if max_pixels and raw_width * raw_height > max_pixels:
        raise OpError(
            "TOO_LARGE",
            f"图片像素超过上限 80 MP（当前 {raw_width}×{raw_height}）",
        )
    if single_frame and frames > 1:
        raise OpError("UNSUPPORTED_FORMAT", "多帧图片不支持导入")
    orientation = 1
    icc_bytes = source.info.get("icc_profile")
    try:
        orientation = int(source.getexif().get(274, 1) or 1)
    except Exception:
        orientation = 1

    alpha_source = has_alpha(source)
    source_format = source.format or os.path.splitext(path)[1].lstrip(".").upper()
    if draft_max and str(source_format).upper() in ("JPEG", "MPO"):
        try:
            source.draft("RGB", (int(draft_max), int(draft_max)))
        except Exception:
            pass

    im = ImageOps.exif_transpose(source)
    im.load()

    icc_description = None
    if icc_bytes:
        try:
            src_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_bytes))
            icc_description = src_profile.profile_description or "ICC"
            dst_profile = ImageCms.createProfile("sRGB")
            working_mode = im.mode if im.mode in ("RGB", "RGBA", "L", "LA") else "RGB"
            if im.mode != working_mode:
                im = im.convert(working_mode)
            im = ImageCms.profileToProfile(
                im, src_profile, dst_profile, outputMode=working_mode, renderingIntent=0
            )
        except Exception:
            icc_description = "ICC(未转换)"

    # 统一到 RGB / RGBA，其余模式转换
    if im.mode not in ("RGB", "RGBA", "L", "LA"):
        if has_alpha(im):
            im = im.convert("RGBA")
        else:
            im = im.convert("RGB")
    if im.mode == "L":
        im = im.convert("RGB")
    elif im.mode == "LA":
        im = im.convert("RGBA")

    normalized_width, normalized_height = (
        (raw_height, raw_width) if orientation in (5, 6, 7, 8) else (raw_width, raw_height)
    )
    meta = {
        "rawWidth": raw_width,
        "rawHeight": raw_height,
        "width": normalized_width,
        "height": normalized_height,
        "format": str(source_format).upper(),
        "mode": im.mode,
        "frames": frames,
        "hasAlpha": has_alpha(im),
        "icc": bool(icc_bytes),
        "iccDescription": icc_description,
        "orientation": orientation,
    }
    return im, meta


def flatten(im, background):
    """把透明像素合成到指定背景。"""
    bg = parse_color(background)
    if im.mode == "RGBA":
        if bg[3] == 0:
            return im
        base = Image.new("RGBA", im.size, bg)
        base.alpha_composite(im)
        return base.convert("RGB")
    if im.mode != "RGB":
        im = im.convert("RGB")
    return im


def rotate_flip(im, plan):
    rotation = int(plan.get("rotation") or 0) % 360
    if rotation == 90:
        im = im.transpose(Image.Transpose.ROTATE_270)  # 顺时针 90°
    elif rotation == 180:
        im = im.transpose(Image.Transpose.ROTATE_180)
    elif rotation == 270:
        im = im.transpose(Image.Transpose.ROTATE_90)
    if plan.get("flipH"):
        im = im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if plan.get("flipV"):
        im = im.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    return im


def crop_pixels(im, crop):
    width, height = im.size
    x = float(crop.get("x", 0.0))
    y = float(crop.get("y", 0.0))
    w = float(crop.get("w", 1.0))
    h = float(crop.get("h", 1.0))
    x0 = max(0, min(width - 1, int(math.floor(x * width))))
    y0 = max(0, min(height - 1, int(math.floor(y * height))))
    x1 = min(width, max(x0 + 1, int(math.ceil((x + w) * width))))
    y1 = min(height, max(y0 + 1, int(math.ceil((y + h) * height))))
    return x0, y0, x1, y1


def resize(im, width, height, plan):
    width = max(1, int(width))
    height = max(1, int(height))
    if (width, height) == im.size:
        return im
    method = RESAMPLE.get(plan.get("resample", "lanczos"), Image.Resampling.LANCZOS)
    return im.resize((width, height), method)


def render_plan(source_image, plan):
    """按处理计划生成最终画面。返回 (image, geometry)。"""
    plan = plan or {}
    fill_transparent = bool(plan.get("fillTransparent", True))
    normalized_width, normalized_height = source_image.size
    im = rotate_flip(source_image, plan)
    rotated_width, rotated_height = im.size
    box = crop_pixels(im, plan.get("crop") or {})
    im = im.crop(box)
    crop_width, crop_height = im.size

    mode = plan.get("scaleMode") or "preserve"
    allow_upscale = bool(plan.get("allowUpscale"))
    pad_ratio = 0.0
    padded = False
    target_width = int(plan.get("width") or 0)
    target_height = int(plan.get("height") or 0)
    longest_edge = int(plan.get("longestEdge") or 0)

    if mode == "fitCrop" and target_width > 0 and target_height > 0:
        scale = max(target_width / crop_width, target_height / crop_height)
        # 禁止放大时由预检阻塞；预览仍按目标几何渲染，便于用户看到真实构图。
        scaled_width = max(1, round_half_up(crop_width * scale))
        scaled_height = max(1, round_half_up(crop_height * scale))
        im = resize(im, scaled_width, scaled_height, plan)
        left = max(0, (im.width - target_width) // 2)
        top = max(0, (im.height - target_height) // 2)
        im = im.crop((left, top, left + target_width, top + target_height))
        out_width, out_height = target_width, target_height
        scale_ratio = scale
    elif mode == "fitPad" and target_width > 0 and target_height > 0:
        scale = min(target_width / crop_width, target_height / crop_height)
        if not allow_upscale:
            scale = min(scale, 1.0)
        scaled_width = max(1, round_half_up(crop_width * scale))
        scaled_height = max(1, round_half_up(crop_height * scale))
        im = resize(im, scaled_width, scaled_height, plan)
        background = parse_color(plan.get("background") or "#ffffff")
        if im.mode == "RGBA" and fill_transparent:
            # 先按白底合成图像本身，补边仍使用用户选择的背景色。
            im = flatten(im, "#ffffff")
        elif im.mode == "RGBA" and background[3] > 0:
            base = Image.new("RGBA", (scaled_width, scaled_height), background)
            base.alpha_composite(im)
            im = base
        elif background[3] == 0 and im.mode == "RGB":
            im = im.convert("RGBA")
        elif background[3] > 0 and im.mode != "RGBA":
            im = im.convert("RGBA")
        canvas = Image.new("RGBA" if background[3] == 0 else "RGB", (target_width, target_height), background)
        left = (target_width - im.width) // 2
        top = (target_height - im.height) // 2
        if im.mode == "RGBA" and canvas.mode == "RGB":
            im = flatten(im, "#ffffff")
            canvas = Image.new("RGB", (target_width, target_height), background)
        canvas.paste(im, (left, top))
        im = canvas
        padded = True
        out_width, out_height = target_width, target_height
        pad_ratio = 1.0 - (scaled_width * scaled_height) / float(target_width * target_height)
        pad_ratio = max(0.0, min(1.0, pad_ratio))
        scale_ratio = scale
    else:
        scale = 1.0
        if longest_edge > 0:
            if allow_upscale:
                scale = longest_edge / float(max(crop_width, crop_height))
            else:
                scale = min(1.0, longest_edge / float(max(crop_width, crop_height)))
        scaled_width = max(1, round_half_up(crop_width * scale))
        scaled_height = max(1, round_half_up(crop_height * scale))
        im = resize(im, scaled_width, scaled_height, plan)
        out_width, out_height = im.size
        scale_ratio = scale

    if im.mode == "RGBA":
        # fitPad 已在贴图前处理图像自身的透明像素；保留用户选择的补边背景。
        if fill_transparent and not padded:
            im = flatten(im, "#ffffff")
    elif im.mode != "RGB":
        im = im.convert("RGB")

    color = plan.get("color") or {}
    brightness = float(color.get("brightness", 1.0) or 1.0)
    contrast = float(color.get("contrast", 1.0) or 1.0)
    saturation = float(color.get("saturation", 1.0) or 1.0)
    if abs(brightness - 1.0) > 1e-6:
        im = ImageEnhance.Brightness(im).enhance(max(0.0, brightness))
    if abs(contrast - 1.0) > 1e-6:
        im = ImageEnhance.Contrast(im).enhance(max(0.0, contrast))
    if abs(saturation - 1.0) > 1e-6:
        im = ImageEnhance.Color(im).enhance(max(0.0, saturation))

    crop_ratio = 1.0 - (crop_width * crop_height) / float(rotated_width * rotated_height)
    geometry = {
        "normalizedWidth": normalized_width,
        "normalizedHeight": normalized_height,
        "rotatedWidth": rotated_width,
        "rotatedHeight": rotated_height,
        "cropWidth": crop_width,
        "cropHeight": crop_height,
        "scaledWidth": max(1, round_half_up(crop_width * scale_ratio)),
        "scaledHeight": max(1, round_half_up(crop_height * scale_ratio)),
        "outWidth": out_width,
        "outHeight": out_height,
        "cropRatio": max(0.0, min(1.0, crop_ratio)),
        "padRatio": pad_ratio,
        "scaleRatio": scale_ratio,
    }
    return im, geometry


def save_image(im, out_path, plan, force_format=None):
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    fmt = (force_format or plan.get("format") or "png").lower()
    if fmt in ("jpg", "jpeg"):
        if im.mode == "RGBA":
            im = flatten(im, "#ffffff")
        elif im.mode != "RGB":
            im = im.convert("RGB")
        quality = int(plan.get("quality") or 95)
        im.save(out_path, format="JPEG", quality=quality, optimize=True, subsampling=0)
    elif fmt == "webp":
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if has_alpha(im) else "RGB")
        im.save(out_path, format="WEBP", lossless=True, quality=100, method=3)
    else:
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if has_alpha(im) else "RGB")
        im.save(out_path, format="PNG", optimize=True)


def analyze_loaded(im, meta):
    # 透明像素按白底参与哈希与统计
    flat = flatten(im, "#ffffff") if im.mode == "RGBA" else im.convert("RGB")

    proxy = flat.copy()
    proxy.thumbnail((512, 512), Image.Resampling.LANCZOS)
    gray = proxy.convert("L")

    # 拉普拉斯方差（模糊）
    try:
        lap = gray.filter(ImageFilter.Kernel((3, 3), (0, 1, 0, 1, -4, 1, 0, 1, 0), scale=1, offset=0))
        blur = float(ImageStat.Stat(lap).var[0])
    except Exception:
        blur = 0.0

    histogram = gray.histogram()
    total = float(sum(histogram) or 1)
    dark_ratio = sum(histogram[0:13]) / total
    bright_ratio = sum(histogram[243:256]) / total

    # 排序指标：曝光（平均亮度）、对比度（亮度标准差）、饱和度与颜色丰富度。
    gray_stat = ImageStat.Stat(gray)
    exposure = float(gray_stat.mean[0]) / 255.0
    contrast = float(gray_stat.stddev[0]) / 255.0
    saturation = float(ImageStat.Stat(proxy.convert("HSV")).mean[1]) / 255.0
    r, g, b = proxy.split()
    rg_diff = ImageChops.difference(r, g)
    rg_mean = float(ImageStat.Stat(r).mean[0]) - float(ImageStat.Stat(g).mean[0])
    rg_std = float(ImageStat.Stat(rg_diff).stddev[0])
    avg_rg = ImageChops.add(r, g, scale=2.0)
    yb_diff = ImageChops.difference(avg_rg, b)
    yb_mean = float(ImageStat.Stat(avg_rg).mean[0]) - float(ImageStat.Stat(b).mean[0])
    yb_std = float(ImageStat.Stat(yb_diff).stddev[0])
    colorfulness = (math.hypot(rg_std, yb_std) + 0.3 * math.hypot(rg_mean, yb_mean)) / 255.0

    return {
        **meta,
        "phash": perceptual_hash(flat),
        "blur": blur,
        "darkRatio": dark_ratio,
        "brightRatio": bright_ratio,
        "exposure": round(exposure, 5),
        "contrast": round(contrast, 5),
        "saturation": round(saturation, 5),
        "colorfulness": round(colorfulness, 5),
    }


def analyze_image(path):
    im, meta = load_normalized(path, draft_max=1024, single_frame=True)
    return analyze_loaded(im, meta)


_DCT_TABLE = None


def _dct_table(n=32):
    global _DCT_TABLE
    if _DCT_TABLE is None:
        table = []
        for u in range(n):
            row = []
            for x in range(n):
                row.append(math.cos((2 * x + 1) * u * math.pi / (2 * n)))
            table.append(row)
        _DCT_TABLE = table
    return _DCT_TABLE


def perceptual_hash(im):
    """64 位 pHash（32×32 DCT 左上 8×8，去掉直流项后取中位数）。"""
    small = im.convert("L").resize((32, 32), Image.Resampling.LANCZOS)
    pixels = list(small.getdata())
    table = _dct_table(32)
    # 先按行做 DCT，只保留前 8 个频率
    rows = []
    for y in range(32):
        base = y * 32
        row = []
        for u in range(8):
            acc = 0.0
            coef = table[u]
            for x in range(32):
                acc += pixels[base + x] * coef[x]
            row.append(acc)
        rows.append(row)
    # 再按列做 DCT
    low = []
    for v in range(8):
        coef = table[v]
        for u in range(8):
            acc = 0.0
            for y in range(32):
                acc += rows[y][u] * coef[y]
            low.append(acc)
    values = low[1:]
    median = sorted(values)[len(values) // 2]
    bits = 0
    for value in low[1:]:
        bits = (bits << 1) | (1 if value > median else 0)
    return format(bits, "016x")


def op_analyze(params):
    path = params["path"]
    im, meta = load_normalized(path, draft_max=1024, single_frame=True)
    info = analyze_loaded(im, meta)
    thumb_out = params.get("thumbOut")
    if thumb_out:
        try:
            size = int(params.get("thumbSize") or 256)
            rendered = flatten(im, "#ffffff") if im.mode == "RGBA" else im.convert("RGB")
            rendered.thumbnail((size, size), Image.Resampling.LANCZOS)
            os.makedirs(os.path.dirname(thumb_out) or ".", exist_ok=True)
            save_image(rendered, thumb_out, {"format": "jpg", "quality": 86})
        except Exception:
            # 缩略图失败不阻塞导入，图库请求时会再次按需生成。
            pass
    return info


def op_render(params):
    plan = params.get("plan") or {}
    path = params["path"]
    out = params["out"]
    im, meta = load_normalized(path)
    rendered, geometry = render_plan(im, plan)
    max_side = int(params.get("maxSide") or 0)
    if max_side > 0 and max(rendered.size) > max_side:
        rendered.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    force_format = params.get("format")
    save_image(rendered, out, plan, force_format=force_format)
    return {
        "width": rendered.width,
        "height": rendered.height,
        "geometry": geometry,
        "frames": meta.get("frames", 1),
    }


def op_thumbnail(params):
    """生成图库缩略图：完整画面，contain 到正方形内。"""
    plan = params.get("plan")
    size = int(params.get("size") or 384)
    path = params["path"]
    out = params["out"]
    im, _ = load_normalized(path, draft_max=max(512, size * 2))
    if plan:
        rendered, _geometry = render_plan(im, plan)
    else:
        rendered = flatten(im, "#ffffff") if im.mode == "RGBA" else im.convert("RGB")
    if rendered.mode != "RGB":
        rendered = rendered.convert("RGB")
    rendered.thumbnail((size, size), Image.Resampling.LANCZOS)
    save_image(rendered, out, {"format": "jpg", "quality": 86})
    return {"width": rendered.width, "height": rendered.height}


def op_display(params):
    path = params["path"]
    out = params["out"]
    max_side = int(params.get("maxSide") or 2048)
    im, meta = load_normalized(path)
    im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    save_image(im, out, {"format": "webp"})
    return {
        "width": im.width,
        "height": im.height,
        "normalizedWidth": meta["width"],
        "normalizedHeight": meta["height"],
        "hasAlpha": meta["hasAlpha"],
    }


def op_ping(params):
    import platform

    return {
        "python": sys.version.split()[0],
        "pillow": Image.__version__,
        "platform": platform.platform(),
    }


# ---------------------------------------------------------------------------
# 示例项目素材（全部为程序生成，可随项目分发）
# ---------------------------------------------------------------------------


def gradient(size, top, bottom):
    width, height = size
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / max(1, height - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (width, y)], fill=color)
    return image


def draw_moon(draw, center, radius, color=(246, 241, 214)):
    cx, cy = center
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=color)
    draw.ellipse((cx - radius * 0.25, cy - radius * 0.2, cx + radius * 0.15, cy + radius * 0.2),
                 fill=(235, 226, 188))


def make_street_scene(size):
    width, height = size
    image = gradient(size, (14, 22, 44), (58, 74, 112))
    draw = ImageDraw.Draw(image, "RGBA")
    draw_moon(draw, (int(width * 0.72), int(height * 0.28)), int(min(width, height) * 0.12))
    horizon = int(height * 0.72)
    draw.rectangle((0, horizon, width, height), fill=(22, 26, 38, 255))
    for index in range(7):
        x = int(width * (0.06 + index * 0.14))
        building_height = int(height * (0.24 + (index % 3) * 0.09))
        draw.rectangle((x, horizon - building_height, x + int(width * 0.09), horizon), fill=(30, 36, 52, 255))
        for row in range(3):
            for col in range(2):
                if (row + col + index) % 3 == 0:
                    wx = x + 12 + col * 28
                    wy = horizon - building_height + 16 + row * 34
                    draw.rectangle((wx, wy, wx + 12, wy + 16), fill=(240, 210, 138, 220))
    draw.rectangle((0, horizon + int(height * 0.1), width, horizon + int(height * 0.11)), fill=(120, 128, 150, 180))
    return image


def make_lantern_scene(size):
    width, height = size
    image = gradient(size, (26, 18, 34), (92, 52, 58))
    draw = ImageDraw.Draw(image, "RGBA")
    for index in range(5):
        x = int(width * (0.18 + index * 0.16))
        y = int(height * (0.28 + (index % 2) * 0.1))
        radius = int(min(width, height) * (0.05 + (index % 3) * 0.012))
        draw.line((x, 0, x, y - radius), fill=(60, 44, 44, 180), width=2)
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(232, 108, 72, 235))
        draw.ellipse((x - radius * 0.5, y - radius * 0.5, x + radius * 0.5, y + radius * 0.5),
                     fill=(255, 196, 120, 120))
    draw.rectangle((0, int(height * 0.82), width, height), fill=(24, 20, 28, 255))
    return image


def make_fox_mask(size):
    width, height = size
    image = gradient(size, (232, 226, 216), (188, 176, 162))
    draw = ImageDraw.Draw(image)
    cx, cy = width // 2, height // 2
    spread = min(width, height) * 0.36
    draw.polygon([(cx - spread, cy - spread * 0.8), (cx - spread * 0.72, cy - spread * 0.2),
                  (cx + spread * 0.72, cy - spread * 0.2), (cx + spread, cy - spread * 0.8),
                  (cx + spread * 0.35, cy + spread * 0.95), (cx - spread * 0.35, cy + spread * 0.95)],
                 fill=(206, 118, 68))
    draw.polygon([(cx - spread * 0.62, cy - spread * 0.45), (cx - spread * 0.3, cy - spread * 0.1),
                  (cx - spread * 0.08, cy - spread * 0.45)], fill=(246, 240, 230))
    draw.polygon([(cx + spread * 0.62, cy - spread * 0.45), (cx + spread * 0.3, cy - spread * 0.1),
                  (cx + spread * 0.08, cy - spread * 0.45)], fill=(246, 240, 230))
    draw.ellipse((cx - spread * 0.14, cy + spread * 0.28, cx + spread * 0.14, cy + spread * 0.55),
                 fill=(48, 38, 34))
    return image


def make_emblem(size):
    width, height = size
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    radius = int(min(width, height) * 0.36)
    cx, cy = width // 2, height // 2
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius),
                 outline=(236, 242, 255, 255), width=max(4, radius // 8))
    draw.ellipse((cx - radius * 0.58, cy - radius * 0.58, cx + radius * 0.12, cy + radius * 0.12),
                 fill=(176, 208, 255, 210))
    draw.ellipse((cx + radius * 0.02, cy - radius * 0.08, cx + radius * 0.44, cy + radius * 0.34),
                 fill=(38, 54, 96, 255))
    for index in range(8):
        angle = index * math.pi / 4
        x1 = cx + math.cos(angle) * radius * 0.78
        y1 = cy + math.sin(angle) * radius * 0.78
        x2 = cx + math.cos(angle) * radius * 1.08
        y2 = cy + math.sin(angle) * radius * 1.08
        draw.line((x1, y1, x2, y2), fill=(236, 242, 255, 190), width=max(2, radius // 18))
    return image


def make_banner(size):
    width, height = size
    image = gradient(size, (234, 236, 244), (176, 190, 218))
    draw = ImageDraw.Draw(image)
    for index in range(9):
        x = int(width * (0.05 + index * 0.105))
        draw.polygon([(x, height * 0.72), (x + width * 0.05, height * 0.28), (x + width * 0.085, height * 0.72)],
                     fill=(46 + index * 12, 66 + index * 10, 112 + index * 8))
    return image


def make_blurred(size):
    image = make_street_scene(size)
    return image.filter(ImageFilter.GaussianBlur(10))


def make_overexposed(size):
    width, height = size
    image = gradient(size, (250, 250, 248), (244, 240, 230))
    draw = ImageDraw.Draw(image)
    draw.ellipse((width * 0.2, height * 0.1, width * 0.75, height * 0.9), fill=(255, 255, 252))
    draw.rectangle((0, int(height * 0.82), width, height), fill=(250, 248, 240))
    return image


def write_caption(directory, stem, text):
    with open(os.path.join(directory, stem + ".txt"), "w", encoding="utf-8") as handle:
        handle.write(text)


def op_sample(params):
    directory = params["dir"]
    os.makedirs(directory, exist_ok=True)

    # 1. 横图 + 标注
    street = make_street_scene((1280, 853))
    street.save(os.path.join(directory, "moonlit_street.jpg"), quality=92)
    write_caption(directory, "moonlit_street", "ink drawing, moonlit street, night, city")

    # 2. 竖图 + 标注
    lantern = make_lantern_scene((800, 1200))
    lantern.save(os.path.join(directory, "lantern_keeper.png"))
    write_caption(directory, "lantern_keeper", "ink drawing, lantern, warm light, festival")

    # 3. 方图，缺失标注
    make_fox_mask((900, 900)).save(os.path.join(directory, "fox_mask.png"))

    # 4. 透明 PNG + 标注
    make_emblem((900, 900)).save(os.path.join(directory, "moon_emblem.png"))
    write_caption(directory, "moon_emblem", "ink drawing, emblem, transparent, moon")

    # 5. 精确重复（同字节不同文件名）
    import shutil

    shutil.copyfile(os.path.join(directory, "moonlit_street.jpg"),
                    os.path.join(directory, "moonlit_street_copy.jpg"))
    write_caption(directory, "moonlit_street_copy", "ink drawing, moonlit street, night, city")

    # 6. 近似重复
    near = make_street_scene((1280, 853))
    near = ImageEnhance.Brightness(near).enhance(1.04)
    near = ImageEnhance.Color(near).enhance(1.05)
    near.save(os.path.join(directory, "street_variant.jpg"), quality=92)
    write_caption(directory, "street_variant", "ink drawing, street, night, city lights")

    # 7. EXIF Orientation = 6（显示时需旋转 90°）
    rotated = make_lantern_scene((1200, 800))
    exif = Image.Exif()
    exif[274] = 6
    rotated.save(os.path.join(directory, "exif_rotated.jpg"), quality=92, exif=exif)
    write_caption(directory, "exif_rotated", "ink drawing, lantern, rotated source")

    # 8. 低分辨率、缺失标注
    make_emblem((300, 200)).convert("RGB").save(os.path.join(directory, "tiny_sketch.jpg"), quality=90)

    # 9. 超长比例
    make_banner((1600, 300)).save(os.path.join(directory, "wide_banner.png"))
    write_caption(directory, "wide_banner", "ink drawing, banner, wide composition")

    # 10. 过曝
    make_overexposed((900, 600)).save(os.path.join(directory, "overexposed.jpg"), quality=90)
    write_caption(directory, "overexposed", "ink drawing, bright, high key")

    # 11. 模糊
    make_blurred((900, 600)).save(os.path.join(directory, "blurred.jpg"), quality=90)
    write_caption(directory, "blurred", "ink drawing, street, blur")

    # 12. 中文文件名 + 标注，并制造 sidecar 冲突（.caption 同时存在）
    chinese = make_street_scene((1024, 768))
    chinese.save(os.path.join(directory, "月夜街道.png"))
    write_caption(directory, "月夜街道", "ink drawing, 月夜, 街道, 中文文件名")
    with open(os.path.join(directory, "月夜街道.caption"), "w", encoding="utf-8") as handle:
        handle.write("ink drawing, 月夜, 街道, 备用标注")

    # 孤立标注
    with open(os.path.join(directory, "orphan_note.txt"), "w", encoding="utf-8") as handle:
        handle.write("ink drawing, orphan caption")

    return {"images": 12, "directory": directory}


OPERATIONS = {
    "ping": op_ping,
    "analyze": op_analyze,
    "render": op_render,
    "thumbnail": op_thumbnail,
    "display": op_display,
    "sample": op_sample,
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            message = json.loads(line)
            request_id = message.get("id")
            op = message.get("op")
            params = message.get("params") or {}
            if op not in OPERATIONS:
                raise ValueError(f"未知操作：{op}")
            result = OPERATIONS[op](params)
            respond(request_id, True, result)
        except Exception as error:  # noqa: BLE001
            traceback.print_exc()
            code = getattr(error, "code", "WORKER_OP_FAILED")
            respond(request_id, False, error={"code": code, "message": str(error)})


if __name__ == "__main__":
    main()
