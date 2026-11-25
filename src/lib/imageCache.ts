import { useEffect } from "react";

/**
 * 跨页面的图片预取缓存。
 *
 * 图库、裁剪、打标实际显示的是同一批资产的不同尺寸变体。WebView 的 HTTP
 * 缓存负责字节复用，这里额外保留最近解码完成的 Image 对象，让页面切换和
 * 前后翻页时可以直接命中已解码的位图，减少重新解码造成的闪白。
 */
const MAX_DECODED = 40;
/** 解码位图按像素估算，超过预算先淘汰最久未用的图，避免长期占满内存。 */
const MAX_BYTES = 160 * 1024 * 1024;
const decoded = new Map<string, HTMLImageElement>();
const inflight = new Map<string, Promise<boolean>>();
const queue: string[] = [];
let pumping = false;
let decodedBytes = 0;

function footprint(image: HTMLImageElement): number {
  return Math.max(0, image.naturalWidth * image.naturalHeight * 4);
}

function remember(url: string, image: HTMLImageElement): void {
  const previous = decoded.get(url);
  if (previous) {
    decoded.delete(url);
    decodedBytes -= footprint(previous);
  }
  decoded.set(url, image);
  decodedBytes += footprint(image);
  while (decoded.size > MAX_DECODED || decodedBytes > MAX_BYTES) {
    const oldest = decoded.keys().next().value;
    if (!oldest) break;
    const dropped = decoded.get(oldest);
    decoded.delete(oldest);
    if (dropped) decodedBytes -= footprint(dropped);
  }
}

function schedule(task: () => void): void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };
  if (typeof idleWindow.requestIdleCallback === "function") {
    idleWindow.requestIdleCallback(task, { timeout: 1500 });
  } else {
    window.setTimeout(task, 120);
  }
}

/**
 * 立即预取一张图；同一 URL 的并发请求会合并。
 * `retain=false` 时只借助浏览器缓存完成预取，不长期持有解码位图（用于超大图）。
 */
export function warmImage(url: string | null | undefined, retain = true): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  const cached = decoded.get(url);
  if (cached) {
    if (retain) remember(url, cached);
    return Promise.resolve(cached.naturalWidth > 0);
  }
  const existing = inflight.get(url);
  if (existing) return existing;
  const promise = new Promise<boolean>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (retain) remember(url, image);
      inflight.delete(url);
      resolve(image.naturalWidth > 0);
    };
    image.onerror = () => {
      inflight.delete(url);
      resolve(false);
    };
    image.src = url;
  });
  inflight.set(url, promise);
  return promise;
}

/** 在浏览器空闲时按顺序预热图片，避免和可见内容抢带宽与解码线程。 */
export function warmImages(urls: Iterable<string | null | undefined>): void {
  for (const url of urls) {
    if (!url) continue;
    if (decoded.has(url) || inflight.has(url) || queue.includes(url)) continue;
    queue.push(url);
  }
  pump();
}

function pump(): void {
  if (pumping || queue.length === 0) return;
  pumping = true;
  schedule(() => {
    const url = queue.shift();
    pumping = false;
    if (!url) {
      pump();
      return;
    }
    void warmImage(url).finally(pump);
  });
}

/** 页面级预取：URL 列表变化时在后台补齐，不阻塞当前渲染。 */
export function useWarmImages(urls: (string | null | undefined)[], enabled = true): void {
  const key = urls.filter(Boolean).join("|");
  useEffect(() => {
    if (!enabled || !key) return;
    warmImages(urls);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
}
