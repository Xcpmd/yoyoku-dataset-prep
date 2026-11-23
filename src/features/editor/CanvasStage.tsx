import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetDetail, TransformPlan, CropRect } from "../../lib/types";
import { S } from "../../lib/strings";
import { classNames, clamp, displayUrl, previewUrl as previewSrc } from "../../lib/utils";
import { Icon } from "../../components/Icon";
import { Dropdown, IconButton, MenuItem, MenuLabel, Segmented, Spinner } from "../../components/ui";

export type CanvasMode = "edit" | "original" | "compare";
export type CanvasBackground = "gray" | "black" | "white" | "checker";

interface Props {
  asset: AssetDetail;
  plan: TransformPlan;
  previewUrl: string | null;
  previewLoading: boolean;
  aspect: number | null;
  mode: CanvasMode;
  setMode: (mode: CanvasMode) => void;
  background: CanvasBackground;
  setBackground: (background: CanvasBackground) => void;
  onChangeCrop: (crop: CropRect) => void;
  active: boolean;
  /** 裁剪页可拖拽裁框；打标页只看图与对比，避免误改裁剪。 */
  croppable?: boolean;
  /** 平滑缩放画布；捏合手势期间自动关闭，避免跟手延迟。 */
  smoothZoom?: boolean;
}

type Gesture =
  | { kind: "move"; startX: number; startY: number; startCrop: CropRect }
  | {
      kind: "resize";
      handle: string;
      startCrop: CropRect;
    }
  | { kind: "new"; startX: number; startY: number; currentX: number; currentY: number };

export function CanvasStage({
  asset,
  plan,
  previewUrl,
  previewLoading,
  aspect,
  mode,
  setMode,
  background,
  setBackground,
  onChangeCrop,
  active,
  croppable = true,
  smoothZoom = true,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 900, height: 600 });
  const [zoom, setZoom] = useState(0.5);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [autoFit, setAutoFit] = useState(true);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [pinching, setPinching] = useState(false);
  // 记录“哪张素材已载入/失败”而不是单纯布尔值：切换页面时缓存图片可能在
  // effect 重置前就触发 onLoad，布尔值被重置后会一直停在载入态。
  const [imageState, setImageState] = useState<{ id: string; status: "loaded" | "failed" } | null>(null);
  const imageReady = imageState?.id === asset.summary.id && imageState.status === "loaded";
  const imageFailed = imageState?.id === asset.summary.id && imageState.status === "failed";
  const [compareStyle, setCompareStyle] = useState<"side" | "split">("side");
  const [split, setSplit] = useState(50);

  const gestureRef = useRef<Gesture | null>(null);
  const panRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number; midX: number; midY: number } | null>(null);
  const planRef = useRef(plan);
  planRef.current = plan;

  const rotated = plan.rotation === 90 || plan.rotation === 270;
  const baseWidth = rotated ? asset.normHeight : asset.normWidth;
  const baseHeight = rotated ? asset.normWidth : asset.normHeight;
  const display = useMemo(
    () => displayUrl(asset.summary.id, `src-${asset.sha256.slice(0, 10)}`),
    [asset.summary.id, asset.sha256],
  );

  const fitScale = useMemo(() => {
    const availableW = Math.max(80, stageSize.width - 48);
    const availableH = Math.max(80, stageSize.height - 48);
    const fitWidth = mode === "original" ? asset.normWidth : baseWidth;
    const fitHeight = mode === "original" ? asset.normHeight : baseHeight;
    return clamp(Math.min(availableW / fitWidth, availableH / fitHeight), 0.01, 4);
  }, [stageSize.width, stageSize.height, baseWidth, baseHeight, mode, asset.normWidth, asset.normHeight]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => setStageSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // 载入状态由 imageState + 当前素材 id 派生，这里只需复位视图。
    setAutoFit(true);
  }, [asset.summary.id]);

  useEffect(() => {
    setAutoFit(true);
  }, [mode]);

  useEffect(() => {
    if (autoFit) {
      setZoom(fitScale);
      setPan({ x: 0, y: 0 });
    }
  }, [autoFit, fitScale, asset.summary.id]);

  const zoomAt = useCallback(
    (nextZoom: number, clientX?: number, clientY?: number) => {
      const next = clamp(nextZoom, 0.015, 4);
      setAutoFit(false);
      const stage = stageRef.current;
      if (stage && clientX !== undefined && clientY !== undefined) {
        const rect = stage.getBoundingClientRect();
        const cursorX = clientX - (rect.left + rect.width / 2);
        const cursorY = clientY - (rect.top + rect.height / 2);
        setPan((current) => ({
          x: cursorX - ((cursorX - current.x) * next) / zoom,
          y: cursorY - ((cursorY - current.y) * next) / zoom,
        }));
      }
      setZoom(next);
    },
    [zoom],
  );

  const fit = useCallback(() => {
    setAutoFit(true);
    setZoom(fitScale);
    setPan({ x: 0, y: 0 });
  }, [fitScale]);

  // Wheel zoom (non-passive)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (mode === "compare") return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0018);
      zoomAt(zoom * factor, event.clientX, event.clientY);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [mode, zoom, zoomAt]);

  // Space pan key
  useEffect(() => {
    if (!active) return;
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.tagName === "BUTTON" ||
        target.tagName === "A" ||
        target.isContentEditable ||
        Boolean(target.closest("button, a, [role='button'], input, textarea, select")));
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !isTyping(event.target)) {
        event.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      setSpaceHeld(false);
    };
  }, [active]);

  // Touch pinch zoom
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const distance = (touches: TouchList) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };
    const onStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        event.preventDefault();
        gestureRef.current = null;
        setPinching(true);
        pinchRef.current = {
          distance: distance(event.touches),
          zoom,
          midX: (event.touches[0].clientX + event.touches[1].clientX) / 2,
          midY: (event.touches[0].clientY + event.touches[1].clientY) / 2,
        };
      }
    };
    const onMove = (event: TouchEvent) => {
      if (event.touches.length === 2 && pinchRef.current) {
        event.preventDefault();
        const next = (pinchRef.current.zoom * distance(event.touches)) / Math.max(10, pinchRef.current.distance);
        zoomAt(next, pinchRef.current.midX, pinchRef.current.midY);
      }
    };
    const onEnd = () => {
      if (pinchRef.current) pinchRef.current = null;
      setPinching(false);
    };
    stage.addEventListener("touchstart", onStart, { passive: false });
    stage.addEventListener("touchmove", onMove, { passive: false });
    stage.addEventListener("touchend", onEnd);
    return () => {
      stage.removeEventListener("touchstart", onStart);
      stage.removeEventListener("touchmove", onMove);
      stage.removeEventListener("touchend", onEnd);
    };
  }, [zoom, zoomAt]);

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setPanning(true);
    panRef.current = { startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
    const move = (moveEvent: PointerEvent) => {
      if (!panRef.current) return;
      setPan({
        x: panRef.current.panX + (moveEvent.clientX - panRef.current.startX),
        y: panRef.current.panY + (moveEvent.clientY - panRef.current.startY),
      });
    };
    const up = () => {
      panRef.current = null;
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const screenToNorm = (clientX: number, clientY: number) => {
    const element = worldRef.current;
    if (!element) return { x: 0.5, y: 0.5 };
    const rect = element.getBoundingClientRect();
    return {
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1),
    };
  };

  const startCropGesture = (event: React.PointerEvent, kind: "move" | "resize" | "new", handle?: string) => {
    if (spaceHeld || event.button === 1) return;
    event.stopPropagation();
    event.preventDefault();
    const point = screenToNorm(event.clientX, event.clientY);
    if (kind === "new") {
      gestureRef.current = { kind, startX: point.x, startY: point.y, currentX: point.x, currentY: point.y };
    } else if (kind === "move") {
      gestureRef.current = { kind, startX: point.x, startY: point.y, startCrop: { ...planRef.current.crop } };
    } else {
      gestureRef.current = { kind: "resize", handle: handle || "se", startCrop: { ...planRef.current.crop } };
    }

    const move = (moveEvent: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const current = screenToNorm(moveEvent.clientX, moveEvent.clientY);
      if (gesture.kind === "new") {
        gesture.currentX = current.x;
        gesture.currentY = current.y;
        const x = Math.min(gesture.startX, current.x);
        const y = Math.min(gesture.startY, current.y);
        let w = Math.abs(current.x - gesture.startX);
        let h = Math.abs(current.y - gesture.startY);
        if (aspect) {
          if (w / Math.max(h, 0.0001) > aspect) h = w / aspect;
          else w = h * aspect;
          if (x + w > 1) w = 1 - x;
          if (y + h > 1) h = 1 - y;
          if (w / h > aspect) w = h * aspect;
          else h = w / aspect;
        }
        onChangeCrop({
          x: clamp(x, 0, 1),
          y: clamp(y, 0, 1),
          w: clamp(w, 0.01, 1 - x),
          h: clamp(h, 0.01, 1 - y),
        });
      } else if (gesture.kind === "move") {
        const dx = current.x - gesture.startX;
        const dy = current.y - gesture.startY;
        const crop = gesture.startCrop;
        const x = clamp(crop.x + dx, 0, 1 - crop.w);
        const y = clamp(crop.y + dy, 0, 1 - crop.h);
        onChangeCrop({ ...crop, x, y });
      } else {
        onChangeCrop(resizeCrop(gesture.startCrop, gesture.handle, current, aspect));
      }
    };
    const up = () => {
      gestureRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const crop = plan.crop;
  const colorFilter =
    mode === "edit"
      ? `brightness(${plan.color.brightness}) contrast(${plan.color.contrast}) saturate(${plan.color.saturation})`
      : undefined;

  const imageTransform =
    mode === "original"
      ? "translate(-50%, -50%)"
      : `translate(-50%, -50%) scaleX(${plan.flipH ? -1 : 1}) scaleY(${plan.flipV ? -1 : 1}) rotate(${plan.rotation}deg)`;

  const originalRotation = mode === "original" ? 0 : plan.rotation;
  const originalRotated = originalRotation === 90 || originalRotation === 270;
  const worldWidth = (originalRotated ? asset.normHeight : asset.normWidth) * zoom;
  const worldHeight = (originalRotated ? asset.normWidth : asset.normHeight) * zoom;
  const imageWidth = asset.normWidth * zoom;
  const imageHeight = asset.normHeight * zoom;

  const cropPixelWidth = Math.round(crop.w * (rotated ? asset.normHeight : asset.normWidth));
  const cropPixelHeight = Math.round(crop.h * (rotated ? asset.normWidth : asset.normHeight));

  const compareOriginal = (
    <div className="compare-pane" style={{ background: "var(--canvas)" }}>
      <img src={display} alt={S.workbench.original} />
      <span className="pane-label">{S.workbench.original}</span>
    </div>
  );
  const compareProcessed = (
    <div className="compare-pane" style={{ background: "var(--canvas)" }}>
      {previewUrl ? <img src={previewSrc(previewUrl)} alt={S.crop.preview} /> : null}
      {!previewUrl ? (
        <div className="loading-line">
          <Spinner /> {previewLoading ? "正在生成预览…" : "暂无预览"}
        </div>
      ) : null}
      <span className="pane-label">处理后</span>
    </div>
  );

  return (
    <div className="wb-canvas-wrap">
      <div className="canvas-toolbar">
        <Segmented
          compact
          value={mode}
          onChange={(value) => setMode(value as CanvasMode)}
          options={
            croppable
              ? [
                  { value: "edit", label: "编辑", icon: "crop" },
                  { value: "original", label: "原图", icon: "image" },
                  { value: "compare", label: "对比", icon: "split" },
                ]
              : [
                  { value: "edit", label: "查看", icon: "image" },
                  { value: "compare", label: "对比", icon: "split" },
                ]
          }
        />
        {mode === "compare" ? (
          <Segmented
            compact
            value={compareStyle}
            onChange={(value) => setCompareStyle(value as "side" | "split")}
            options={[
              { value: "side", label: S.workbench.sideBySide },
              { value: "split", label: S.workbench.split },
            ]}
          />
        ) : (
          <span className="hint" style={{ paddingLeft: 6 }}>
            {cropPixelWidth}×{cropPixelHeight} px
          </span>
        )}
        <div className="spacer" />
        <Dropdown
          width={200}
          align="end"
          renderTrigger={(toggle) => (
            <IconButton icon="layers" label={S.workbench.background} onClick={toggle} />
          )}
        >
          {(close) => (
            <>
              <MenuLabel>{S.workbench.background}</MenuLabel>
              {(
                [
                  ["gray", "灰色"],
                  ["black", "黑色"],
                  ["white", "白色"],
                  ["checker", "棋盘格"],
                ] as [CanvasBackground, string][]
              ).map(([value, label]) => (
                <MenuItem
                  key={value}
                  icon={background === value ? "check" : "circle"}
                  onClick={() => {
                    setBackground(value);
                    close();
                  }}
                >
                  {label}
                </MenuItem>
              ))}
            </>
          )}
        </Dropdown>
        {mode !== "compare" ? (
          <>
            <IconButton icon="zoom-out" label="缩小" onClick={() => zoomAt(zoom / 1.25)} />
            <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
            <IconButton icon="zoom-in" label="放大" onClick={() => zoomAt(zoom * 1.25)} />
            <IconButton icon="maximize" label={S.workbench.fit} onClick={fit} />
            <button type="button" className="btn ghost sm" onClick={() => zoomAt(1)}>
              100%
            </button>
          </>
        ) : null}
      </div>

      <div
        className={classNames(
          "canvas-stage",
          `bg-${background}`,
          panning && "panning",
          spaceHeld && "space-ready",
        )}
        ref={stageRef}
        onPointerDown={(event) => {
          if (event.button === 1 || spaceHeld) startPan(event);
        }}
        onDoubleClick={() => {
          if (mode !== "compare") fit();
        }}
      >
        {mode === "compare" ? (
          compareStyle === "side" ? (
            <div className="compare-grid">
              {compareOriginal}
              {compareProcessed}
            </div>
          ) : (
            <div style={{ position: "absolute", inset: 0, background: "var(--canvas)", overflow: "hidden" }}>
              <img
                src={display}
                alt={S.workbench.original}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
              />
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  clipPath: `inset(0 0 0 ${split}%)`,
                  background: "var(--canvas)",
                }}
              >
                {previewUrl ? (
                  <img
                    src={previewSrc(previewUrl)}
                    alt={S.crop.preview}
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                ) : null}
              </div>
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${split}%`,
                  width: 2,
                  background: "rgba(255,255,255,.9)",
                  boxShadow: "0 0 0 1px rgba(0,0,0,.25)",
                  cursor: "ew-resize",
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  const move = (moveEvent: PointerEvent) => {
                    const stage = stageRef.current;
                    if (!stage) return;
                    const rect = stage.getBoundingClientRect();
                    setSplit(clamp(((moveEvent.clientX - rect.left) / rect.width) * 100, 2, 98));
                  };
                  const up = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  };
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up, { once: true });
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%,-50%)",
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "var(--surface)",
                    border: "1px solid var(--line-strong)",
                    display: "grid",
                    placeItems: "center",
                    color: "var(--muted)",
                  }}
                >
                  <Icon name="move" className="sm" />
                </div>
              </div>
              <span className="pane-label" style={{ left: 10, top: 10, position: "absolute" }}>
                {S.workbench.original} / 处理后
              </span>
            </div>
          )
        ) : (
          <div className="canvas-scroll">
            <div
              className={classNames(
                "canvas-world",
                background === "checker" && "checker",
                smoothZoom && !pinching && "smooth-zoom",
              )}
              ref={worldRef}
              style={{
                width: worldWidth,
                height: worldHeight,
                transform: `translate(${pan.x}px, ${pan.y}px)`,
                backgroundColor:
                  background === "black"
                    ? "#0a0c10"
                    : background === "white"
                      ? "#f7f8fb"
                      : background === "gray"
                        ? "var(--canvas)"
                        : undefined,
                boxShadow: "0 12px 42px rgba(0,0,0,.22)",
              }}
            >
              {!imageFailed ? (
                <img
                  className="canvas-image"
                  src={display}
                  alt={asset.summary.name}
                  draggable={false}
                  style={{
                    width: imageWidth,
                    height: imageHeight,
                    transform: imageTransform,
                    filter: colorFilter,
                    opacity: imageReady ? 1 : 0,
                  }}
                  onLoad={() => setImageState({ id: asset.summary.id, status: "loaded" })}
                  onError={() => setImageState({ id: asset.summary.id, status: "failed" })}
                />
              ) : null}
              {!imageReady && !imageFailed ? (
                <div className="image-loading">
                  <Spinner /> 载入图片…
                </div>
              ) : null}
              {imageFailed ? (
                <div className="image-loading" style={{ color: "var(--danger)", padding: 20, textAlign: "center" }}>
                  <Icon name="alert" />
                  无法读取显示图。源文件可能已失联。
                </div>
              ) : null}
              {croppable && imageReady && mode === "edit" ? (
                <div
                  className="crop-layer"
                  onPointerDown={(event) => startCropGesture(event, "new")}
                >
                  <div
                    className="crop-rect"
                    style={{
                      left: `${crop.x * 100}%`,
                      top: `${crop.y * 100}%`,
                      width: `${crop.w * 100}%`,
                      height: `${crop.h * 100}%`,
                    }}
                    onPointerDown={(event) => {
                      const target = event.target as HTMLElement;
                      const handle = target.closest("[data-handle]")?.getAttribute("data-handle");
                      startCropGesture(event, handle ? "resize" : "move", handle || undefined);
                    }}
                  >
                    <div className="thirds" />
                    {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((handle) => (
                      <div key={handle} className={`crop-handle ${handle}`} data-handle={handle} />
                    ))}
                    <div className="crop-size">
                      {cropPixelWidth}×{cropPixelHeight}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
        {mode !== "compare" ? (
          <div className="canvas-hint">
            <Icon name="mouse" className="sm" />
            滚轮缩放 · 空格拖拽 · 双击适合
          </div>
        ) : null}
      </div>
    </div>
  );
}

function resizeCrop(start: CropRect, handle: string, point: { x: number; y: number }, aspect: number | null): CropRect {
  const min = 0.02;
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle.includes("w")) left = Math.min(point.x, right - min);
  if (handle.includes("e")) right = Math.max(point.x, left + min);
  if (handle.includes("n")) top = Math.min(point.y, bottom - min);
  if (handle.includes("s")) bottom = Math.max(point.y, top + min);
  left = clamp(left, 0, 1);
  top = clamp(top, 0, 1);
  right = clamp(right, 0, 1);
  bottom = clamp(bottom, 0, 1);
  let width = Math.max(min, right - left);
  let height = Math.max(min, bottom - top);
  if (aspect && ["nw", "ne", "se", "sw"].includes(handle)) {
    if (width / height > aspect) height = width / aspect;
    else width = height * aspect;
    if (handle.includes("w")) left = right - width;
    if (handle.includes("n")) top = bottom - height;
    if (left < 0) {
      left = 0;
      width = right;
      height = width / aspect;
    }
    if (top < 0) {
      top = 0;
      height = bottom;
      width = height * aspect;
    }
    if (left + width > 1) {
      width = 1 - left;
      height = width / aspect;
    }
    if (top + height > 1) {
      height = 1 - top;
      width = height * aspect;
    }
  }
  return {
    x: clamp(left, 0, 1 - width),
    y: clamp(top, 0, 1 - height),
    w: clamp(width, min, 1),
    h: clamp(height, min, 1),
  };
}
