import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetSummary, CropRect, TransformPlan } from "../../lib/types";
import { classNames, displayUrl, gridThumbUrl } from "../../lib/utils";
import { Icon } from "../../components/Icon";
import { Spinner } from "../../components/ui";

interface Props {
  asset: AssetSummary;
  plan: TransformPlan;
  targetWidth: number;
  targetHeight: number;
  selected: boolean;
  saving: boolean;
  onToggle: (checked: boolean) => void;
  onCommit: (plan: TransformPlan) => void;
}

interface View {
  zoom: number;
  panX: number;
  panY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function matchesTarget(crop: CropRect, width: number, height: number, targetWidth: number, targetHeight: number): boolean {
  const target = targetWidth / targetHeight;
  const current = (crop.w * width) / (crop.h * height);
  return Math.abs(current - target) / target < 0.02;
}

export function InlineCropCard({
  asset,
  plan,
  targetWidth,
  targetHeight,
  selected,
  saving,
  onToggle,
  onCommit,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; view: View } | null>(null);
  const commitTimer = useRef<number | undefined>(undefined);
  const [stageSize, setStageSize] = useState({ width: 240, height: 220 });
  const [view, setView] = useState<View>({ zoom: 1, panX: 0, panY: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [imageReady, setImageReady] = useState(false);
  const [highResRequested, setHighResRequested] = useState(false);
  const [highResReady, setHighResReady] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [dirty, setDirty] = useState(false);

  // 裁剪板默认只加载 256 px 原图代理；交互或进入选中后升级到 1600 px 大图。
  const requestHighRes = () => setHighResRequested(true);
  useEffect(() => {
    if (selected) setHighResRequested(true);
  }, [selected]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => setStageSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const stageW = Math.max(1, stageSize.width);
    const stageH = Math.max(1, stageSize.height);
    const availableW = Math.max(1, stageW - 4);
    const availableH = Math.max(1, stageH - 4);
    const targetAspect = targetWidth / targetHeight;
    let frameW = availableW;
    let frameH = frameW / targetAspect;
    if (frameH > availableH) {
      frameH = availableH;
      frameW = frameH * targetAspect;
    }
    return {
      baseW: stageW,
      baseH: stageH,
      frameW,
      frameH,
      frameLeft: (stageW - frameW) / 2,
      frameTop: (stageH - frameH) / 2,
    };
  }, [stageSize.width, stageSize.height, targetWidth, targetHeight]);

  const coverZoom = Math.max(geometry.frameW / geometry.baseW, geometry.frameH / geometry.baseH);
  const minZoom = Math.min(1, coverZoom);

  const clampView = (next: View): View => {
    const zoom = clamp(next.zoom, minZoom, 12);
    const imageW = geometry.baseW * zoom;
    const imageH = geometry.baseH * zoom;
    const minPanX = geometry.frameLeft + geometry.frameW - stageSize.width / 2 - imageW / 2;
    const maxPanX = geometry.frameLeft - stageSize.width / 2 + imageW / 2;
    const minPanY = geometry.frameTop + geometry.frameH - stageSize.height / 2 - imageH / 2;
    const maxPanY = geometry.frameTop - stageSize.height / 2 + imageH / 2;
    return {
      zoom,
      panX: clamp(next.panX, minPanX, maxPanX),
      panY: clamp(next.panY, minPanY, maxPanY),
    };
  };

  const viewFromCrop = (crop: CropRect): View | null => {
    if (!crop || !matchesTarget(crop, asset.width, asset.height, targetWidth, targetHeight)) return null;
    const imageW = geometry.frameW / crop.w;
    const imageH = geometry.frameH / crop.h;
    const zoom = imageW / geometry.baseW;
    const imageLeft = geometry.frameLeft - crop.x * imageW;
    const imageTop = geometry.frameTop - crop.y * imageH;
    return clampView({
      zoom,
      panX: imageLeft - stageSize.width / 2 + imageW / 2,
      panY: imageTop - stageSize.height / 2 + imageH / 2,
    });
  };

  useEffect(() => {
    if (dragRef.current) return;
    const next = viewFromCrop(plan.crop);
    if (next) setView(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.crop, geometry.baseW, geometry.baseH, geometry.frameW, geometry.frameH, stageSize.width, stageSize.height]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      requestHighRes();
      const current = viewRef.current;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const next = clampView({
        zoom: current.zoom * factor,
        panX: current.panX * factor,
        panY: current.panY * factor,
      });
      setView(next);
      scheduleCommit(next);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry.baseW, geometry.baseH, geometry.frameW, geometry.frameH, stageSize.width, stageSize.height, minZoom]);

  useEffect(() => () => window.clearTimeout(commitTimer.current), []);

  useEffect(() => {
    if (!saving && !dirty) {
      setSavedFlash(true);
      const timer = window.setTimeout(() => setSavedFlash(false), 1100);
      return () => window.clearTimeout(timer);
    }
  }, [saving, dirty]);

  const currentCrop = (): CropRect => {
    const imageW = geometry.baseW * view.zoom;
    const imageH = geometry.baseH * view.zoom;
    const imageLeft = stageSize.width / 2 + view.panX - imageW / 2;
    const imageTop = stageSize.height / 2 + view.panY - imageH / 2;
    const w = geometry.frameW / imageW;
    const h = geometry.frameH / imageH;
    return {
      x: clamp((geometry.frameLeft - imageLeft) / imageW, 0, 1 - w),
      y: clamp((geometry.frameTop - imageTop) / imageH, 0, 1 - h),
      w: clamp(w, 0.01, 1),
      h: clamp(h, 0.01, 1),
    };
  };

  const scheduleCommit = (nextView?: View, immediate = false) => {
    setDirty(true);
    window.clearTimeout(commitTimer.current);
    const commit = () => {
      const crop = nextView
        ? (() => {
            const imageW = geometry.baseW * nextView.zoom;
            const imageH = geometry.baseH * nextView.zoom;
            const imageLeft = stageSize.width / 2 + nextView.panX - imageW / 2;
            const imageTop = stageSize.height / 2 + nextView.panY - imageH / 2;
            return {
              x: clamp((geometry.frameLeft - imageLeft) / imageW, 0, 1),
              y: clamp((geometry.frameTop - imageTop) / imageH, 0, 1),
              w: clamp(geometry.frameW / imageW, 0.01, 1),
              h: clamp(geometry.frameH / imageH, 0.01, 1),
            };
          })()
        : currentCrop();
      setDirty(false);
      onCommit({
        ...plan,
        rotation: 0,
        flipH: false,
        flipV: false,
        crop,
        scaleMode: "fitCrop",
        width: targetWidth,
        height: targetHeight,
        allowUpscale: true,
        resample: "lanczos",
      });
    };
    if (immediate) commit();
    else commitTimer.current = window.setTimeout(commit, 650);
  };

  const imageW = geometry.baseW * view.zoom;
  const imageH = geometry.baseH * view.zoom;
  const source = displayUrl(asset.id, asset.displayVersion || `card-${asset.thumbVersion}`);
  const preview = gridThumbUrl(asset);
  const imageLeft = stageSize.width / 2 + view.panX - imageW / 2;
  const imageTop = stageSize.height / 2 + view.panY - imageH / 2;

  return (
    <article className={classNames("crop-board-card inline-crop-card", selected && "selected")}>
      <div
        className="crop-card-stage"
        ref={stageRef}
        style={{ aspectRatio: `${asset.width} / ${asset.height}` }}
      >
        <img
          src={preview}
          alt=""
          className="crop-card-full"
          draggable={false}
          onLoad={() => setImageReady(true)}
          style={{ width: imageW, height: imageH, left: imageLeft, top: imageTop }}
        />
        {highResRequested ? (
          <img
            src={source}
            alt={asset.name}
            className="crop-card-full"
            draggable={false}
            onLoad={() => setHighResReady(true)}
            style={{
              width: imageW,
              height: imageH,
              left: imageLeft,
              top: imageTop,
              opacity: highResReady ? 1 : 0,
              transition: "opacity 180ms var(--ease, ease)",
            }}
          />
        ) : null}
        <div
          className="crop-card-frame"
          style={{
            left: geometry.frameLeft,
            top: geometry.frameTop,
            width: geometry.frameW,
            height: geometry.frameH,
          }}
        >
          <span className="crop-card-target">{targetWidth}×{targetHeight}</span>
        </div>
        <div
          className="crop-card-drag-layer"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            requestHighRes();
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { startX: event.clientX, startY: event.clientY, view: viewRef.current };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) return;
            const next = clampView({
              zoom: drag.view.zoom,
              panX: drag.view.panX + (event.clientX - drag.startX),
              panY: drag.view.panY + (event.clientY - drag.startY),
            });
            setView(next);
          }}
          onPointerUp={(event) => {
            if (!dragRef.current) return;
            dragRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            scheduleCommit(viewRef.current, true);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
        />
        <button
          type="button"
          className={classNames("crop-card-select", selected && "selected")}
          aria-label={selected ? `取消选择 ${asset.name}` : `选择 ${asset.name}`}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(!selected);
          }}
        >
          <Icon name="check" className="sm" />
        </button>
        {!imageReady ? <div className="crop-card-loading"><Spinner /></div> : null}
      </div>
      <div className="crop-board-meta">
        <span className="crop-board-name" title={asset.name}>{asset.name}</span>
        <span className="tiny faint">
          {saving ? <><Spinner /> 保存中…</> : savedFlash ? <><Icon name="check" className="sm" /> 已保存</> : `${asset.width}×${asset.height} · 拖动/滚轮直接调整`}
        </span>
      </div>
    </article>
  );
}
