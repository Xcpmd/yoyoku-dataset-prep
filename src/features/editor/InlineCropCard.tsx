import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetSummary, CropRect, TransformPlan } from "../../lib/types";
import { classNames, displayUrl, gridThumbUrl } from "../../lib/utils";
import { warmImage } from "../../lib/imageCache";
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

/** Ctrl 将缩放步长收细到 1/5，Shift 收细到 1/10。 */
function zoomPrecision(event: { ctrlKey: boolean; shiftKey: boolean }): number {
  if (event.shiftKey) return 0.1;
  if (event.ctrlKey) return 0.2;
  return 1;
}

const SAVE_DEBOUNCE_MS = 320;
const SAVE_MIN_INTERVAL_MS = 900;

function matchesTarget(crop: CropRect, width: number, height: number, targetWidth: number, targetHeight: number): boolean {
  const target = targetWidth / targetHeight;
  const current = (crop.w * width) / (crop.h * height);
  return Math.abs(current - target) / target < 0.02;
}

/** 归一化裁剪是否与当前视图一致；用于避免保存回包触发无意义的视图回跳。 */
function cropsClose(a: CropRect, b: CropRect): boolean {
  const epsilon = 0.0015;
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.w - b.w) < epsilon &&
    Math.abs(a.h - b.h) < epsilon
  );
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
  /** 连续拖动/滚轮期间不把外部配方同步回视图，避免保存回包把画面拉回旧位置。 */
  const interactingUntilRef = useRef(0);
  const markInteracting = () => {
    interactingUntilRef.current = Date.now() + 450;
  };
  const pendingViewRef = useRef<View | null>(null);
  const lastCommitAtRef = useRef(0);
  const planRef = useRef(plan);
  planRef.current = plan;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
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

  const cropForView = (target: View): CropRect => {
    const imageW = geometry.baseW * target.zoom;
    const imageH = geometry.baseH * target.zoom;
    const imageLeft = stageSize.width / 2 + target.panX - imageW / 2;
    const imageTop = stageSize.height / 2 + target.panY - imageH / 2;
    const w = clamp(geometry.frameW / imageW, 0.01, 1);
    const h = clamp(geometry.frameH / imageH, 0.01, 1);
    return {
      x: clamp((geometry.frameLeft - imageLeft) / imageW, 0, 1 - w),
      y: clamp((geometry.frameTop - imageTop) / imageH, 0, 1 - h),
      w,
      h,
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
    // 用户仍在拖动/滚轮惯性内，或本卡片还有未落盘的方案时，保持本地视图。
    if (dragRef.current) return;
    if (saving) return;
    if (Date.now() < interactingUntilRef.current) return;
    if (commitTimer.current !== undefined || pendingViewRef.current) return;
    // 保存回包与当前视图本质上是同一个裁剪时不重设视图，避免亚像素回跳。
    if (cropsClose(cropForView(viewRef.current), plan.crop)) return;
    const next = viewFromCrop(plan.crop);
    if (next) setView(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    plan.crop,
    saving,
    geometry.baseW,
    geometry.baseH,
    geometry.frameW,
    geometry.frameH,
    stageSize.width,
    stageSize.height,
    asset.width,
    asset.height,
    targetWidth,
    targetHeight,
  ]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      requestHighRes();
      markInteracting();
      const current = viewRef.current;
      const factor = Math.exp(-event.deltaY * 0.0015 * zoomPrecision(event));
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

  /**
   * 拖动/滚轮结束后延迟保存：短时间内的连续调整合并为一次，
   * 并用最小保存间隔节流，避免快速操作触发大量写请求。
   */
  const scheduleCommit = (nextView?: View) => {
    setDirty(true);
    pendingViewRef.current = nextView ?? viewRef.current;
    if (commitTimer.current !== undefined) {
      window.clearTimeout(commitTimer.current);
    }
    const elapsed = Date.now() - lastCommitAtRef.current;
    const wait = Math.max(SAVE_DEBOUNCE_MS, SAVE_MIN_INTERVAL_MS - elapsed);
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = undefined;
      const pending = pendingViewRef.current;
      if (!pending) {
        setDirty(false);
        return;
      }
      pendingViewRef.current = null;
      lastCommitAtRef.current = Date.now();
      setDirty(false);
      onCommitRef.current({
        ...planRef.current,
        rotation: 0,
        flipH: false,
        flipV: false,
        crop: cropForView(pending),
        scaleMode: "fitCrop",
        width: targetWidth,
        height: targetHeight,
        allowUpscale: true,
        resample: "lanczos",
      });
    }, wait);
  };

  const imageW = geometry.baseW * view.zoom;
  const imageH = geometry.baseH * view.zoom;
  const source = displayUrl(asset.id, asset.displayVersion || `card-${asset.thumbVersion}`);
  const preview = gridThumbUrl(asset);
  const imageLeft = stageSize.width / 2 + view.panX - imageW / 2;
  const imageTop = stageSize.height / 2 + view.panY - imageH / 2;

  return (
    <article
      className={classNames("crop-board-card inline-crop-card", selected && "selected")}
      onPointerEnter={() => {
        // 悬停即后台预热大图；真正拖动/选中时不用再等一次磁盘解码。
        if (!highResReady) void warmImage(source);
      }}
    >
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
        />
        <div
          className="crop-card-drag-layer"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            requestHighRes();
            markInteracting();
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            // 新的拖动会覆盖尚未落盘的旧视角，取消旧计时避免中间状态被保存。
            if (commitTimer.current !== undefined) {
              window.clearTimeout(commitTimer.current);
              commitTimer.current = undefined;
            }
            dragRef.current = { startX: event.clientX, startY: event.clientY, view: viewRef.current };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) return;
            markInteracting();
            const next = clampView({
              zoom: drag.view.zoom,
              panX: drag.view.panX + (event.clientX - drag.startX),
              panY: drag.view.panY + (event.clientY - drag.startY),
            });
            // 同步写入 ref：pointerup 可能早于本轮 React 渲染，避免保存上一帧的位置。
            viewRef.current = next;
            setView(next);
          }}
          onPointerUp={(event) => {
            if (!dragRef.current) return;
            dragRef.current = null;
            markInteracting();
            event.currentTarget.releasePointerCapture(event.pointerId);
            scheduleCommit(viewRef.current);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            markInteracting();
            scheduleCommit(viewRef.current);
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
          {saving ? <><Spinner /> 保存中…</> : savedFlash ? <><Icon name="check" className="sm" /> 已保存</> : ""}
        </span>
      </div>
    </article>
  );
}
