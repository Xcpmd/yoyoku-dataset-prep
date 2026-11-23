import type {
  AssetFilter,
  AssetSummary,
  Geometry,
  ProjectInfo,
  TransformPlan,
  CropRect,
} from "./types";

export const ASSET_BASE = "http://ykasset.localhost";

export function thumbUrl(asset: Pick<AssetSummary, "id" | "thumbVersion">): string {
  return `${ASSET_BASE}/thumb/${asset.id}/${asset.thumbVersion}`;
}

/** 未裁切的原图缩略图，用于导入页图库与检查器完整显示。 */
export function sourceThumbUrl(
  asset: Pick<AssetSummary, "id" | "displayVersion">,
): string {
  return `${ASSET_BASE}/thumb/${asset.id}/source-${asset.displayVersion}`;
}

export function thumbUrlRaw(assetId: string, version: string): string {
  return `${ASSET_BASE}/thumb/${assetId}/${version}`;
}

export function displayUrl(assetId: string, version: string): string {
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "");
  return `${ASSET_BASE}/display/${assetId}/${safeVersion}`;
}

export function previewUrl(path: string): string {
  return `${ASSET_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("zh-CN");
}

/** 输出尺寸统一为 64 的倍数，便于 SD / SDXL 分桶训练。 */
export function snapSize64(value: number | null | undefined, fallback = 64): number {
  const source = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(8192, Math.max(64, Math.round(source / 64) * 64));
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso).getTime();
  if (Number.isNaN(date)) return "—";
  const diff = Date.now() - date;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(iso);
}

export function prettyPath(path: string): string {
  if (!path) return "";
  const prefix = "\\\\?\\";
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function shortPath(path: string, max = 48): string {
  if (!path) return "";
  path = prettyPath(path);
  if (path.length <= max) return path;
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.length <= 2) return `${path.slice(0, max - 1)}…`;
  return `…/${parts.slice(-2).join("/")}`;
}

export function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

export function baseName(path: string): string {
  const name = fileName(path);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

export function normalizeKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeTagList(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = normalizeKey(tag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

export function splitCaption(text: string): string[] {
  return text
    .split(/[,，\n\r]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function statusLabel(status: string): string {
  switch (status) {
    case "approved":
      return "已通过";
    case "review":
      return "需复核";
    case "excluded":
      return "已排除";
    default:
      return "待审核";
  }
}

export function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "approved":
      return "success";
    case "review":
      return "warning";
    case "excluded":
      return "danger";
    default:
      return "neutral";
  }
}

export function emptyFilter(): AssetFilter {
  return {
    query: "",
    statuses: [],
    orientations: [],
    collectionIds: [],
    issueRules: [],
    issueLevels: [],
    split: null,
    duplicateOnly: false,
    favoriteOnly: false,
    minShortEdge: null,
    maxShortEdge: null,
    hasDraft: false,
    recycledOnly: false,
  };
}

export function filterActiveCount(filter: AssetFilter): number {
  let count = 0;
  if (filter.query.trim()) count += 1;
  count += filter.statuses.length;
  count += filter.orientations.length;
  count += filter.collectionIds.length;
  count += filter.issueRules.length;
  count += filter.issueLevels.length;
  if (filter.split) count += 1;
  if (filter.duplicateOnly) count += 1;
  if (filter.favoriteOnly) count += 1;
  if (filter.hasDraft) count += 1;
  if (filter.recycledOnly) count += 1;
  if (filter.minShortEdge) count += 1;
  if (filter.maxShortEdge) count += 1;
  return count;
}

export function defaultPlan(baseResolution: number): TransformPlan {
  return {
    version: 1,
    rotation: 0,
    flipH: false,
    flipV: false,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    scaleMode: "preserve",
    width: null,
    height: null,
    longestEdge: baseResolution,
    allowUpscale: false,
    resample: "lanczos",
    background: "#ffffff",
    fillTransparent: true,
    color: { brightness: 1, contrast: 1, saturation: 1 },
    format: "png",
    quality: 95,
  };
}

export function projectBaseResolution(project: ProjectInfo | null): number {
  const resolution = project?.settings?.resolution;
  if (Array.isArray(resolution) && typeof resolution[0] === "number") return resolution[0];
  return project?.model === "sd15" ? 512 : 1024;
}

export function planFromProject(project: ProjectInfo | null): TransformPlan {
  const stored = project?.settings?.processing as Partial<TransformPlan> | undefined;
  const base = defaultPlan(projectBaseResolution(project));
  if (!stored) return base;
  return {
    ...base,
    ...stored,
    crop: { ...base.crop, ...(stored.crop || {}) },
    color: { ...base.color, ...(stored.color || {}) },
  };
}

export function sanitizePlan(plan: TransformPlan): TransformPlan {
  const crop = {
    x: Math.min(Math.max(plan.crop.x, 0), 1),
    y: Math.min(Math.max(plan.crop.y, 0), 1),
    w: Math.min(Math.max(plan.crop.w, 0.001), 1),
    h: Math.min(Math.max(plan.crop.h, 0.001), 1),
  };
  crop.w = Math.min(crop.w, 1 - crop.x);
  crop.h = Math.min(crop.h, 1 - crop.y);
  return {
    ...plan,
    rotation: ([0, 90, 180, 270].includes(plan.rotation) ? plan.rotation : 0) as number,
    crop,
    quality: Math.min(Math.max(Math.round(plan.quality), 1), 100),
  };
}

export function computeGeometry(
  inputPlan: TransformPlan,
  normalizedWidth: number,
  normalizedHeight: number,
): Geometry {
  const plan = sanitizePlan(inputPlan);
  const normW = Math.max(1, normalizedWidth);
  const normH = Math.max(1, normalizedHeight);
  const rotated = plan.rotation === 90 || plan.rotation === 270;
  const width = rotated ? normH : normW;
  const height = rotated ? normW : normH;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(plan.crop.x * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(plan.crop.y * height)));
  const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((plan.crop.x + plan.crop.w) * width)));
  const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil((plan.crop.y + plan.crop.h) * height)));
  const cropWidth = Math.max(1, x1 - x0);
  const cropHeight = Math.max(1, y1 - y0);
  const cropRatio = Math.max(0, Math.min(1, 1 - (cropWidth * cropHeight) / (width * height)));
  let scale = 1;
  let outWidth = cropWidth;
  let outHeight = cropHeight;
  let scaledWidth = cropWidth;
  let scaledHeight = cropHeight;
  let padRatio = 0;
  let blocked = false;
  let blockedReason: string | null = null;
  const round = (value: number) => Math.max(1, Math.round(value));

  if (plan.scaleMode === "fitCrop" && plan.width && plan.height) {
    scale = Math.max(plan.width / cropWidth, plan.height / cropHeight);
    if (scale > 1 && !plan.allowUpscale) {
      blocked = true;
      blockedReason = `目标 ${plan.width}×${plan.height} 需要放大，当前禁止放大`;
    }
    outWidth = plan.width;
    outHeight = plan.height;
    scaledWidth = round(cropWidth * scale);
    scaledHeight = round(cropHeight * scale);
  } else if (plan.scaleMode === "fitPad" && plan.width && plan.height) {
    scale = Math.min(plan.width / cropWidth, plan.height / cropHeight);
    if (scale > 1 && !plan.allowUpscale) scale = 1;
    scaledWidth = round(cropWidth * scale);
    scaledHeight = round(cropHeight * scale);
    outWidth = plan.width;
    outHeight = plan.height;
    padRatio = Math.max(0, Math.min(1, 1 - (scaledWidth * scaledHeight) / (plan.width * plan.height)));
  } else if (plan.longestEdge && plan.longestEdge > 0) {
    const needed = plan.longestEdge / Math.max(cropWidth, cropHeight);
    scale = plan.allowUpscale ? needed : Math.min(1, needed);
    scaledWidth = round(cropWidth * scale);
    scaledHeight = round(cropHeight * scale);
    outWidth = scaledWidth;
    outHeight = scaledHeight;
  }

  return {
    outWidth,
    outHeight,
    cropWidth,
    cropHeight,
    scaledWidth,
    scaledHeight,
    cropRatio,
    padRatio,
    scaleRatio: scale,
    blocked,
    blockedReason,
  };
}

/* 旋转/翻转时把裁剪矩形映射到新坐标系 */
export function rotateCrop(crop: CropRect, clockwise: boolean): CropRect {
  if (clockwise) {
    return { x: 1 - (crop.y + crop.h), y: crop.x, w: crop.h, h: crop.w };
  }
  return { x: crop.y, y: 1 - (crop.x + crop.w), w: crop.h, h: crop.w };
}

export function flipCrop(crop: CropRect, horizontal: boolean): CropRect {
  return horizontal
    ? { ...crop, x: 1 - (crop.x + crop.w) }
    : { ...crop, y: 1 - (crop.y + crop.h) };
}

export const ASPECT_PRESETS: { label: string; value: number | null }[] = [
  { label: "自由", value: null },
  { label: "1:1", value: 1 },
  { label: "3:2", value: 3 / 2 },
  { label: "2:3", value: 2 / 3 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
];

export function applyAspect(crop: CropRect, aspect: number | null, center = true): CropRect {
  if (!aspect) return crop;
  const current = crop.w / crop.h;
  let w = crop.w;
  let h = crop.h;
  if (current > aspect) {
    w = crop.h * aspect;
  } else {
    h = crop.w / aspect;
  }
  w = Math.min(w, 1);
  h = Math.min(h, 1);
  let x = center ? crop.x + (crop.w - w) / 2 : crop.x;
  let y = center ? crop.y + (crop.h - h) / 2 : crop.y;
  x = Math.min(Math.max(x, 0), 1 - w);
  y = Math.min(Math.max(y, 0), 1 - h);
  return { x, y, w, h };
}

export function shortTrigger(text: string, trigger: string): boolean {
  if (!trigger.trim()) return false;
  return normalizeKey(text).includes(normalizeKey(trigger));
}

export function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function classNames(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

export function debounce<T extends (...args: any[]) => void>(fn: T, delay: number) {
  let timer: number | undefined;
  const wrapped = (...args: Parameters<T>) => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
  wrapped.cancel = () => {
    if (timer) window.clearTimeout(timer);
  };
  return wrapped;
}

export function uniqueName(existing: string[], base: string): string {
  const set = new Set(existing.map((name) => name.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!set.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export function splitLabel(split: string | null | undefined): string {
  if (split === "train") return "训练";
  if (split === "val") return "验证";
  return "未分配";
}

export function finalizeCaptionLocal(
  mode: "tags" | "nl" | "mixed",
  tags: string[],
  text: string,
  triggerWord: string,
  triggerMode: string,
  triggerDisabled: boolean,
): string {
  const trigger = triggerWord.trim();
  if (mode === "tags" || mode === "mixed") {
    const result = normalizeTagList(tags);
    const body = text
      .trim()
      .replace(/[\r\n]+/g, " ")
      .replace(/^[,，\s]+|[,，\s]+$/g, "");
    if (result.length === 0 && !body) return "";
    if (trigger && !triggerDisabled) {
      const key = normalizeKey(trigger);
      const index = result.findIndex((tag) => normalizeKey(tag) === key);
      if (index >= 0) {
        const display = result.splice(index, 1)[0];
        const filtered = result.filter((tag) => normalizeKey(tag) !== key);
        filtered.unshift(display);
        result.splice(0, result.length, ...filtered);
      } else {
        result.unshift(trigger);
      }
    }
    const tagText = result.join(", ");
    if (mode === "tags" || !body) return tagText;
    if (!tagText) return body;
    return `${tagText}, ${body}`;
  }
  const body = text.trim();
  if (!trigger || triggerDisabled || !body) return body;
  if (triggerMode === "manual") return body;
  if (normalizeKey(body).includes(normalizeKey(trigger))) return body;
  return triggerMode === "prefix" ? `${trigger}, ${body}` : body;
}

export function captionStatsLocal(
  mode: "tags" | "nl" | "mixed",
  tags: string[],
  text: string,
): { charCount: number; tagCount: number; tokenEstimate: number | null; tokenizerNote: string } {
  const tagText = normalizeTagList(tags).join(", ");
  const body = text.trim();
  const content =
    mode === "tags" ? tagText : mode === "mixed" ? (tagText && body ? `${tagText}, ${body}` : tagText || body) : text;
  let latin = 0;
  let cjk = 0;
  let inWord = false;
  for (const ch of content) {
    if (/[A-Za-z0-9]/.test(ch)) {
      if (!inWord) {
        latin += 1;
        inWord = true;
      }
    } else {
      inWord = false;
      if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(ch)) cjk += 1;
    }
  }
  return {
    charCount: [...content].length,
    tagCount: mode === "nl" ? 0 : normalizeTagList(tags).length,
    tokenEstimate: content ? latin + cjk : 0,
    tokenizerNote: "估算值；安装所选训练端 tokenizer 后显示精确计数。",
  };
}
