import type { CropRect, Geometry, TransformPlan } from "../../lib/types";
import { S } from "../../lib/strings";
import {
  applyAspect,
  ASPECT_PRESETS,
  classNames,
  formatPercent,
  previewUrl as previewSrc,
  snapSize64,
} from "../../lib/utils";
import { Icon } from "../../components/Icon";
import { Badge, Notice, Segmented, Spinner, Toggle } from "../../components/ui";

interface Props {
  plan: TransformPlan;
  geometry: Geometry;
  aspect: number | null;
  normWidth: number;
  normHeight: number;
  previewUrl: string | null;
  previewLoading: boolean;
  previewError: string | null;
  dirty: boolean;
  draftSavedAt: string | null;
  applying: boolean;
  onChange: (plan: TransformPlan) => void;
  onAspect: (aspect: number | null) => void;
  onRotate: (clockwise: boolean) => void;
  onFlip: (horizontal: boolean) => void;
  onCenter: () => void;
  onResetCrop: () => void;
  onApply: () => void;
  onDiscard: () => void;
}

export function CropPanel({
  plan,
  geometry,
  aspect,
  normWidth,
  normHeight,
  previewUrl,
  previewLoading,
  previewError,
  dirty,
  draftSavedAt,
  applying,
  onChange,
  onAspect,
  onRotate,
  onFlip,
  onCenter,
  onResetCrop,
  onApply,
  onDiscard,
}: Props) {
  const rotated = plan.rotation === 90 || plan.rotation === 270;
  const rotatedWidth = rotated ? normHeight : normWidth;
  const rotatedHeight = rotated ? normWidth : normHeight;

  const patch = (value: Partial<TransformPlan>) => onChange({ ...plan, ...value });

  const cropPixels = {
    x: Math.round(plan.crop.x * rotatedWidth),
    y: Math.round(plan.crop.y * rotatedHeight),
    w: Math.round(plan.crop.w * rotatedWidth),
    h: Math.round(plan.crop.h * rotatedHeight),
  };

  const setCropPixels = (patchCrop: Partial<typeof cropPixels>) => {
    const next = { ...cropPixels, ...patchCrop };
    const w = Math.min(Math.max(1, next.w), rotatedWidth);
    const h = Math.min(Math.max(1, next.h), rotatedHeight);
    const x = Math.min(Math.max(0, next.x), rotatedWidth - w);
    const y = Math.min(Math.max(0, next.y), rotatedHeight - h);
    onChange({
      ...plan,
      crop: {
        x: x / rotatedWidth,
        y: y / rotatedHeight,
        w: w / rotatedWidth,
        h: h / rotatedHeight,
      },
    });
  };

  const chooseAspect = (value: string) => {
    if (value === "") {
      onAspect(null);
      return;
    }
    if (value === "current") {
      const ratio = geometry.outWidth / Math.max(1, geometry.outHeight);
      onAspect(ratio);
      onChange({ ...plan, crop: applyAspect(plan.crop, ratio) });
      return;
    }
    const ratio = Number(value);
    onAspect(ratio);
    onChange({ ...plan, crop: applyAspect(plan.crop, ratio) });
  };

  const aspectValue =
    aspect === null
      ? ""
      : ASPECT_PRESETS.some((item) => item.value !== null && Math.abs((item.value as number) - aspect) < 0.001)
        ? String(aspect)
        : "current";

  return (
    <div className="crop-form">
      <div className="form-block">
        <div className="form-block-head">
          <Icon name="crop" className="sm" />
          <h4>{S.crop.title}</h4>
          <div className="spacer" />
          {dirty ? <Badge tone="warning">{S.crop.draft}</Badge> : <Badge tone="success">{S.crop.applied}</Badge>}
        </div>
        <div className="grid-2" style={{ gap: 8 }}>
          <label className="field">
            <span className="label">{S.crop.aspect}</span>
            <select className="select" value={aspectValue} onChange={(event) => chooseAspect(event.target.value)}>
              {ASPECT_PRESETS.map((item) => (
                <option key={item.label} value={item.value === null ? "" : String(item.value)}>
                  {item.label}
                </option>
              ))}
              <option value="current">{S.crop.current}</option>
            </select>
          </label>
          <div className="row" style={{ alignItems: "flex-end", gap: 4 }}>
            <button type="button" className="btn subtle" onClick={() => onRotate(false)} title={S.crop.rotateLeft}>
              <Icon name="rotate-left" />
            </button>
            <button type="button" className="btn subtle" onClick={() => onRotate(true)} title={S.crop.rotateRight}>
              <Icon name="rotate-right" />
            </button>
            <button type="button" className="btn subtle" onClick={() => onFlip(true)} title={S.crop.flipH}>
              <Icon name="flip-h" />
            </button>
            <button type="button" className="btn subtle" onClick={() => onFlip(false)} title={S.crop.flipV}>
              <Icon name="flip-v" />
            </button>
          </div>
        </div>
        <div className="crop-grid">
          {(["x", "y", "w", "h"] as const).map((key) => (
            <label className="number-field" key={key}>
              <span className="label">{key.toUpperCase()}</span>
              <input
                className="input number"
                type="number"
                min={key === "x" || key === "y" ? 0 : 1}
                max={key === "x" ? rotatedWidth - cropPixels.w : key === "y" ? rotatedHeight - cropPixels.h : key === "w" ? rotatedWidth - cropPixels.x : rotatedHeight - cropPixels.y}
                value={cropPixels[key]}
                onChange={(event) => setCropPixels({ [key]: Number(event.target.value) || 0 })}
              />
              <span className="tiny faint">px</span>
            </label>
          ))}
        </div>
        <div className="row-wrap">
          <button type="button" className="btn ghost sm" onClick={onCenter}>
            <Icon name="move" className="sm" />
            {S.crop.center}
          </button>
          <button type="button" className="btn ghost sm" onClick={onResetCrop}>
            <Icon name="refresh" className="sm" />
            {S.crop.resetCrop}
          </button>
          <span className="hint">实际可用裁剪：{rotatedWidth}×{rotatedHeight}</span>
        </div>
      </div>

      <div className="form-block">
        <div className="form-block-head">
          <Icon name="sliders" className="sm" />
          <h4>{S.crop.scaleMode}</h4>
        </div>
        <Segmented
          value={plan.scaleMode}
          onChange={(value) =>
            patch({
              scaleMode: value as TransformPlan["scaleMode"],
              width: value === "preserve" ? plan.width : plan.width || geometry.cropWidth,
              height: value === "preserve" ? plan.height : plan.height || geometry.cropHeight,
            })
          }
          options={[
            { value: "preserve", label: S.crop.preserve },
            { value: "fitCrop", label: S.crop.fitCrop },
            { value: "fitPad", label: S.crop.fitPad },
          ]}
          compact
        />
        {plan.scaleMode === "preserve" ? (
          <div className="grid-2">
            <label className="field">
              <span className="label">{S.crop.longestEdge}</span>
              <input
                className="input number"
                type="number"
                min={64}
                max={8192}
                step={64}
                value={plan.longestEdge ?? ""}
                placeholder="不限制"
                onChange={(event) =>
                  patch({ longestEdge: event.target.value ? Number(event.target.value) : null })
                }
                onBlur={(event) => {
                  if (!event.target.value) return;
                  patch({ longestEdge: snapSize64(Number(event.target.value), 1024) });
                }}
              />
            </label>
            <label className="field">
              <span className="label">{S.crop.allowUpscale}</span>
              <Toggle checked={plan.allowUpscale} onChange={(value) => patch({ allowUpscale: value })} label="" />
            </label>
          </div>
        ) : (
          <>
            <div className="grid-2">
              <label className="field">
                <span className="label">{S.crop.targetWidth}</span>
                <input
                  className="input number"
                  type="number"
                  min={64}
                  max={8192}
                  step={64}
                  value={plan.width ?? ""}
                  onChange={(event) => patch({ width: event.target.value ? Number(event.target.value) : null })}
                  onBlur={(event) => {
                    if (!event.target.value) return;
                    patch({ width: snapSize64(Number(event.target.value), 1024) });
                  }}
                />
              </label>
              <label className="field">
                <span className="label">{S.crop.targetHeight}</span>
                <input
                  className="input number"
                  type="number"
                  min={64}
                  max={8192}
                  step={64}
                  value={plan.height ?? ""}
                  onChange={(event) => patch({ height: event.target.value ? Number(event.target.value) : null })}
                  onBlur={(event) => {
                    if (!event.target.value) return;
                    patch({ height: snapSize64(Number(event.target.value), 1024) });
                  }}
                />
              </label>
            </div>
            <Toggle
              checked={plan.allowUpscale}
              onChange={(value) => patch({ allowUpscale: value })}
              label={S.crop.allowUpscale}
            />
          </>
        )}
        <div className="grid-2">
          <label className="field">
            <span className="label">{S.crop.resample}</span>
            <select
              className="select"
              value={plan.resample}
              onChange={(event) => patch({ resample: event.target.value as TransformPlan["resample"] })}
            >
              <option value="lanczos">{S.crop.lanczos}</option>
              <option value="bicubic">{S.crop.bicubic}</option>
            </select>
          </label>
          <label className="field">
            <span className="label">{S.crop.background}</span>
            <div className="row" style={{ gap: 6 }}>
              <input
                type="color"
                value={plan.background === "transparent" ? "#ffffff" : plan.background}
                onChange={(event) => patch({ background: event.target.value })}
                style={{ width: 44, height: 38, border: "1px solid var(--line-strong)", borderRadius: 8, background: "var(--surface)" }}
                aria-label={S.crop.background}
              />
              <span className="mono tiny faint">{plan.background}</span>
            </div>
          </label>
        </div>
        <div className="grid-2">
          <label className="field">
            <span className="label">{S.crop.format}</span>
            <Segmented
              value={plan.format}
              onChange={(value) => patch({ format: value as TransformPlan["format"] })}
              options={[
                { value: "png", label: "PNG" },
                { value: "jpg", label: "JPEG" },
              ]}
              compact
            />
          </label>
          {plan.format === "jpg" ? (
            <label className="field">
              <span className="label">
                {S.crop.quality} · {plan.quality}
              </span>
              <input
                type="range"
                min={40}
                max={100}
                value={plan.quality}
                onChange={(event) => patch({ quality: Number(event.target.value) })}
              />
            </label>
          ) : null}
        </div>
      </div>

      <div className="form-block">
        <div className="form-block-head">
          <Icon name="sun" className="sm" />
          <h4>{S.crop.colorAdjust}</h4>
          <div className="spacer" />
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => patch({ color: { brightness: 1, contrast: 1, saturation: 1 } })}
          >
            {S.common.reset}
          </button>
        </div>
        {(
          [
            ["brightness", S.crop.brightness],
            ["contrast", S.crop.contrast],
            ["saturation", S.crop.saturation],
          ] as const
        ).map(([key, label]) => (
          <label className="field" key={key}>
            <span className="label" style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{label}</span>
              <span className="mono">{plan.color[key].toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.01}
              value={plan.color[key]}
              onChange={(event) =>
                patch({ color: { ...plan.color, [key]: Number(event.target.value) } })
              }
            />
          </label>
        ))}
      </div>

      <div className="form-block">
        <div className="form-block-head">
          <Icon name="eye" className="sm" />
          <h4>{S.crop.preview}</h4>
          {previewLoading ? <Spinner /> : null}
        </div>
        <div className="preview-box checker">
          {previewUrl ? (
            <img src={previewSrc(previewUrl)} alt={S.crop.preview} />
          ) : previewError ? (
            <div className="preview-empty" style={{ color: "var(--danger)" }}>{previewError}</div>
          ) : (
            <div className="preview-empty">{previewLoading ? "正在按配方渲染预览…" : "修改参数后显示处理后预览"}</div>
          )}
        </div>
        <div className="geom-grid">
          <div className="geom-item">
            <div className="k">{S.crop.output}</div>
            <div className="v">
              {geometry.outWidth}×{geometry.outHeight}
            </div>
          </div>
          <div className="geom-item">
            <div className="k">{S.crop.cropRatio}</div>
            <div className="v">{formatPercent(geometry.cropRatio, 0)}</div>
          </div>
          <div className="geom-item">
            <div className="k">{S.crop.padRatio}</div>
            <div className="v">{formatPercent(geometry.padRatio, 0)}</div>
          </div>
          <div className="geom-item">
            <div className="k">{S.crop.scaleRatio}</div>
            <div className="v">{formatPercent(geometry.scaleRatio, 0)}</div>
          </div>
        </div>
        {geometry.blocked ? <Notice tone="danger">{geometry.blockedReason}</Notice> : null}
        {draftSavedAt ? (
          <div className="hint">草稿已自动保存 · {new Date(draftSavedAt).toLocaleTimeString("zh-CN")}</div>
        ) : null}
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn primary grow"
            onClick={onApply}
            disabled={applying || !dirty}
          >
            {applying ? <Spinner /> : <Icon name="check" />}
            {applying ? S.crop.applying : S.crop.apply}
          </button>
          {dirty ? (
            <button type="button" className="btn subtle" onClick={onDiscard} disabled={applying}>
              {S.common.discard}
            </button>
          ) : null}
        </div>
        {dirty ? <div className="hint">裁剪草稿会在切换图片前自动保存；点击「应用配方」才会写入正式版本。</div> : null}
      </div>
    </div>
  );
}
