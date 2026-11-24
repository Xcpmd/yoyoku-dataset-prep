import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, normalizeError } from "../../lib/api";
import type { AssetFilter, AssetSort, AssetSummary, BatchOp, ReviewStatus } from "../../lib/types";
import { useProject, type LibraryView } from "../../app/ProjectContext";
import { S } from "../../lib/strings";
import {
  classNames,
  emptyFilter,
  filterActiveCount,
  formatBytes,
  formatNumber,
  gridThumbUrl,
  lowThumbUrl,
  statusLabel,
  statusTone,
} from "../../lib/utils";
import { Icon } from "../../components/Icon";
import {
  Badge,
  ConfirmDialog,
  Dropdown,
  EmptyState,
  Field,
  IconButton,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  PromptDialog,
  Segmented,
  Select,
  Spinner,
  Toggle,
} from "../../components/ui";
import { ImportDialog } from "./ImportDialog";
import { DedupeDialog } from "./DedupeDialog";
import { Inspector } from "./Inspector";
import { BatchDialog } from "./BatchDialog";

const PAGE_SIZE = 200;
const GAP = 12;
/** 卡片缩略图之外的固定高度：内边距、间距与两行标注文字。 */
const GRID_CARD_EXTRA = 86;
/** 瀑布流上下额外挂载的像素范围。 */
const MASONRY_OVERSCAN = 720;

interface MasonryLayout {
  columns: number[][];
  tops: number[][];
  heights: number[];
  columnOf: number[];
  indexInColumn: number[];
  maxHeight: number;
  total: number;
}

/**
 * 按源图比例计算每张卡片高度，依次放入当前最短的列。
 * 列内纵向紧密排列，不再为同行水平对齐保留空隙。
 */
function buildMasonryLayout(
  items: AssetSummary[],
  columns: number,
  cardWidth: number,
): MasonryLayout {
  const columnCount = Math.max(1, columns);
  const inner = Math.max(60, cardWidth - 14);
  const columnsList: number[][] = Array.from({ length: columnCount }, () => []);
  const topsList: number[][] = Array.from({ length: columnCount }, () => []);
  const columnHeights = new Array<number>(columnCount).fill(0);
  const columnOf = new Array<number>(items.length).fill(0);
  const indexInColumn = new Array<number>(items.length).fill(0);
  const heights = new Array<number>(items.length).fill(0);
  let maxHeight = 0;
  for (let index = 0; index < items.length; index += 1) {
    const asset = items[index];
    const width = Math.max(1, asset.width);
    const height = Math.max(1, asset.height);
    const cardHeight = Math.ceil((inner * height) / width) + GRID_CARD_EXTRA;
    heights[index] = cardHeight;
    maxHeight = Math.max(maxHeight, cardHeight);
    let target = 0;
    for (let column = 1; column < columnCount; column += 1) {
      if (columnHeights[column] < columnHeights[target]) target = column;
    }
    columnOf[index] = target;
    indexInColumn[index] = columnsList[target].length;
    columnsList[target].push(index);
    topsList[target].push(columnHeights[target]);
    columnHeights[target] += cardHeight + GAP;
  }
  let total = 0;
  for (const height of columnHeights) total = Math.max(total, height - GAP);
  return {
    columns: columnsList,
    tops: topsList,
    heights,
    columnOf,
    indexInColumn,
    maxHeight,
    total: Math.max(0, total),
  };
}

/** 二分查找第一个 >= target 的位置。 */
function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** 命中点下最近的图片卡片；选区工具条等浮层不会挡住拖选。 */
function assetIdAtPoint(x: number, y: number): string | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const card = element.closest<HTMLElement>("[data-asset-id]");
    if (card?.dataset.assetId) return card.dataset.assetId;
  }
  return null;
}

export function LibraryPage({ active }: { active: boolean }) {
  const {
    project,
    settings,
    updateSettings,
    filter,
    setFilter,
    sort,
    setSort,
    view,
    setView,
    selection,
    selectionSet,
    setSelection,
    toggleSelected,
    clearSelection,
    focusedId,
    setFocusedId,
    openWorkbench,
    refreshToken,
    bumpRefresh,
    librarySignal,
    collections,
    reloadCollections,
    importSignal,
    searchSignal,
    setJobsOpen,
    reloadJobs,
    notify,
    navigate,
  } = useProject();

  const [items, setItems] = useState<AssetSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragSelectRef = useRef<{
    value: boolean;
    startIndex: number;
    base: string[];
  } | null>(null);
  const dragPointerRef = useRef<{ x: number; y: number } | null>(null);
  const dragAutoScrollFrame = useRef<number | null>(null);
  const dragEnterRef = useRef<(id: string) => void>(() => {});
  const dragAutoScrollRef = useRef<() => void>(() => {});
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [searchInput, setSearchInput] = useState(filter.query);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [visibleIds, setVisibleIds] = useState<Set<string> | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => {
    if (typeof window !== "undefined" && window.innerWidth < 960) return false;
    try {
      const stored = localStorage.getItem("yoyoku.inspectorOpen");
      if (stored !== null) return stored === "1";
    } catch {
      // ignore
    }
    return typeof window !== "undefined" && window.innerWidth >= 1280;
  });
  const [inspectorWidth, setInspectorWidth] = useState(settings.inspectorWidth || 336);
  const [importOpen, setImportOpen] = useState(false);
  const [importPaths, setImportPaths] = useState<string[]>([]);
  const [dedupeOpen, setDedupeOpen] = useState(false);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const dedupeNoticeRef = useRef<string | null>(null);
  const dedupeSeq = useRef(0);
  const metricsRequested = useRef(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [excludeTargets, setExcludeTargets] = useState<string[] | null>(null);
  const [collectionPrompt, setCollectionPrompt] = useState<"new" | "smart" | null>(null);
  const [deleteCollection, setDeleteCollection] = useState<{ id: string; name: string } | null>(null);
  const [filterDraft, setFilterDraft] = useState<AssetFilter>(filter);
  const [dragOver, setDragOver] = useState(false);
  const [dragging, setDragging] = useState(false);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const searchTimer = useRef<number | undefined>(undefined);
  const loadingMoreRef = useRef(false);
  const lastImportSignal = useRef(importSignal);
  const lastSearchSignal = useRef(searchSignal);
  const widthRef = useRef(inspectorWidth);
  widthRef.current = inspectorWidth;

  useEffect(() => {
    if (!active) return;
    const seq = ++dedupeSeq.current;
    const timer = window.setTimeout(() => {
      api
        .dedupeSummary(project.settings.thresholds?.duplicateDistance ?? 8)
        .then((summary) => {
          if (seq !== dedupeSeq.current) return;
          setDuplicateCount(summary.duplicates);
          if (summary.duplicates > 0 && dedupeNoticeRef.current !== project.id) {
            dedupeNoticeRef.current = project.id;
            notify({
              tone: "warning",
              title: "发现疑似重复图片",
              message: `${summary.duplicates} 张图片可能重复，可在「去重」中处理。`,
              actionLabel: "去重",
              onAction: () => setDedupeOpen(true),
            });
          }
        })
        .catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, project.id, project.counts.total, project.counts.excluded, project.settings.thresholds?.duplicateDistance]);

  useEffect(() => {
    metricsRequested.current = false;
  }, [project.id]);

  const ensureMetrics = useCallback(async () => {
    if (metricsRequested.current) return;
    metricsRequested.current = true;
    try {
      const result = await api.backfillMetrics();
      if (result.total > 0) {
        notify({
          message: `正在后台分析 ${result.total} 张图片的颜色 / 曝光指标，完成后自动刷新`,
        });
      }
    } catch {
      metricsRequested.current = false;
    }
  }, [notify]);

  useEffect(() => {
    if (["exposure", "colorfulness", "contrast", "saturation"].includes(sort.field)) {
      void ensureMetrics();
    }
  }, [sort.field, ensureMetrics]);

  const filterKey = useMemo(() => JSON.stringify({ filter, sort }), [filter, sort]);
  const filterCount = filterActiveCount(filter);

  const loadFirst = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.queryAssets(filter, sort, 0, PAGE_SIZE);
      if (seq !== requestSeq.current) return;
      setItems(page.items);
      setTotal(page.total);
      setNextOffset(page.nextOffset);
      setNextCursor(page.nextCursor);
      if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
      setScrollTop(0);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setError(normalizeError(error).message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [filter, sort]);

  const refreshLoaded = useCallback(async () => {
    if (items.length === 0) {
      await loadFirst();
      return;
    }
    const seq = ++requestSeq.current;
    const limit = Math.min(500, Math.max(PAGE_SIZE, items.length));
    try {
      const page = await api.queryAssets(filter, sort, 0, limit);
      if (seq !== requestSeq.current) return;
      setItems((current) => {
        if (page.nextOffset === null) return page.items;
        if (current.length <= page.items.length) return page.items;
        // 新记录插入后旧尾部可能已前移，按 ID 去重，避免滚动时出现重复卡片。
        const seen = new Set(page.items.map((item) => item.id));
        return [...page.items, ...current.slice(page.items.length).filter((item) => !seen.has(item.id))];
      });
      setTotal(page.total);
      setNextOffset(page.nextOffset);
      setNextCursor(page.nextCursor);
    } catch {
      // 保留现有内容
    }
  }, [filter, sort, items.length, loadFirst]);

  // 页面隐藏时停止查询；返回时按筛选是否变化选择首屏或可见窗口刷新。
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (!active) return;
    const changed = lastFilterKey.current !== filterKey;
    lastFilterKey.current = filterKey;
    if (changed || items.length === 0) {
      void loadFirst();
    } else {
      void refreshLoaded();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, active]);

  useEffect(() => {
    if (!active) return;
    if (refreshToken > 0) void refreshLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  // 导入批次提交后的增量刷新：空图库立即取首屏，其余合并 250 ms 内的多次提交。
  const lastLibrarySignal = useRef(librarySignal);
  const libraryRefreshTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (librarySignal === lastLibrarySignal.current) return;
    lastLibrarySignal.current = librarySignal;
    if (!active) return;
    if (libraryRefreshTimer.current) window.clearTimeout(libraryRefreshTimer.current);
    if (items.length === 0) {
      void loadFirst();
      return;
    }
    libraryRefreshTimer.current = window.setTimeout(() => {
      void refreshLoaded();
    }, 250);
    return () => {
      if (libraryRefreshTimer.current) window.clearTimeout(libraryRefreshTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [librarySignal, active]);

  useEffect(() => {
    setSearchInput(filter.query);
  }, [filter.query]);

  // Resize observer for grid metrics
  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const update = () => {
      setViewportWidth(element.clientWidth);
      setViewportHeight(element.clientHeight);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const columns = useMemo(() => {
    if (view === "list") return 1;
    return Math.max(1, Math.floor((viewportWidth + GAP) / (settings.gridCardMin + GAP)));
  }, [view, viewportWidth, settings.gridCardMin]);
  const cardWidth =
    view === "grid"
      ? Math.max(112, Math.floor((viewportWidth - GAP * (columns - 1)) / columns))
      : viewportWidth;
  const rowHeight = view === "grid" ? cardWidth + 88 : 70;
  const masonry = useMemo(
    () => (view === "grid" ? buildMasonryLayout(items, columns, cardWidth) : null),
    [view, items, columns, cardWidth],
  );

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || loading || (nextOffset === null && nextCursor === null)) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const seq = requestSeq.current;
    try {
      // 优先从上一页服务端返回的游标继续；失效时回退到最后一张或偏移分页。
      const cursor = nextCursor || items[items.length - 1]?.id;
      let page = cursor
        ? await api.queryAssets(filter, sort, 0, PAGE_SIZE, cursor)
        : await api.queryAssets(filter, sort, nextOffset ?? 0, PAGE_SIZE);
      if (seq !== requestSeq.current) return;
      if (cursor && page.items.length === 0 && items.length > 0) {
        page = await api.queryAssets(filter, sort, items.length, PAGE_SIZE);
        if (seq !== requestSeq.current) return;
      }
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setTotal(page.total);
      setNextOffset(page.nextOffset);
      setNextCursor(page.nextCursor);
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [filter, sort, nextOffset, nextCursor, items, loading, notify]);

  useEffect(() => {
    if (!loading && (nextOffset !== null || nextCursor !== null) && items.length > 0) {
      const element = scrollerRef.current;
      if (element && element.scrollHeight <= element.clientHeight + 200) {
        void loadMore();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, loading, nextOffset, nextCursor, viewportHeight, view]);

  // Selection visibility for hidden count
  useEffect(() => {
    if (!active) return;
    if (selection.length === 0) {
      setVisibleIds(null);
      return;
    }
    setVisibleIds(null);
    let cancelled = false;
    api
      .assetIds(filter)
      .then((ids) => {
        if (!cancelled) setVisibleIds(new Set(ids));
      })
      .catch(() => {
        if (!cancelled) setVisibleIds(new Set(items.map((item) => item.id)));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.length, filterKey, refreshToken, active]);

  const hiddenSelected = useMemo(() => {
    if (!visibleIds) return 0;
    return selection.filter((id) => !visibleIds.has(id)).length;
  }, [selection, visibleIds]);

  // Open inspector on selection at wide screens
  useEffect(() => {
    if (selection.length > 0 && window.innerWidth >= 1280) setInspectorOpen(true);
  }, [selection.length]);

  useEffect(() => {
    try {
      localStorage.setItem("yoyoku.inspectorOpen", inspectorOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [inspectorOpen]);

  useEffect(() => {
    setInspectorWidth(settings.inspectorWidth || 336);
  }, [settings.inspectorWidth]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 960) setInspectorOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Palette / shortcuts
  useEffect(() => {
    const toggle = () => setInspectorOpen((value) => !value);
    window.addEventListener("yoyoku:toggle-inspector", toggle);
    return () => window.removeEventListener("yoyoku:toggle-inspector", toggle);
  }, []);

  useEffect(() => {
    if (importSignal === lastImportSignal.current) return;
    lastImportSignal.current = importSignal;
    if (!active) return;
    setImportPaths([]);
    setImportOpen(true);
  }, [importSignal, active]);

  useEffect(() => {
    if (searchSignal === lastSearchSignal.current) return;
    lastSearchSignal.current = searchSignal;
    if (!active) return;
    window.setTimeout(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    }, 40);
  }, [searchSignal, active]);

  // Tauri native drag and drop
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload as any;
        if (!active) {
          if (payload.type === "leave" || payload.type === "drop") setDragOver(false);
          return;
        }
        if (payload.type === "enter" || payload.type === "over") {
          setDragOver(true);
        } else if (payload.type === "leave") {
          setDragOver(false);
        } else if (payload.type === "drop") {
          setDragOver(false);
          const paths: string[] = payload.paths || [];
          if (paths.length > 0) {
            setImportPaths(paths);
            setImportOpen(true);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active]);

  const changeSearch = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      setFilter((current) => ({ ...current, query: value }));
    }, 120);
  };

  const clearSearch = () => {
    setSearchInput("");
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    setFilter((current) => ({ ...current, query: "" }));
  };

  const openAsset = async (id: string) => {
    try {
      const ids = await api.assetIds(filter);
      openWorkbench(id, {
        sequence: ids,
        label: S.workbench.sequenceLibrary,
      });
    } catch {
      openWorkbench(id);
    }
  };

  const handleCardClick = (asset: AssetSummary, event: React.MouseEvent) => {
    dragSelectRef.current = null;
    scrollerRef.current?.focus({ preventScroll: true });
    if (event.shiftKey && focusedId) {
      const ids = items.map((item) => item.id);
      const from = ids.indexOf(focusedId);
      const to = ids.indexOf(asset.id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from <= to ? [from, to] : [to, from];
        setSelection(ids.slice(start, end + 1));
        setFocusedId(asset.id);
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      toggleSelected(asset.id);
      setFocusedId(asset.id);
      return;
    }
    const current = selectionRef.current;
    // 已有多个选中时，点击其他图片继续并入选区，避免误清空之前的选择。
    if (current.length > 1 && !current.includes(asset.id)) {
      const next = [...current, asset.id];
      selectionRef.current = next;
      setSelection(next);
      setFocusedId(asset.id);
      if (window.innerWidth >= 1280) setInspectorOpen(true);
      return;
    }
    setSelection([asset.id]);
    setFocusedId(asset.id);
    if (window.innerWidth >= 1280) setInspectorOpen(true);
  };

  const toggleSelectAll = async () => {
    if (total > 0 && selection.length >= total) {
      clearSelection();
      return;
    }
    try {
      const ids = await api.assetIds(filter);
      setSelection(ids);
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  };

  const startDragSelect = useCallback(
    (id: string, value: boolean, x?: number, y?: number) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return;
      dragPointerRef.current =
        typeof x === "number" && typeof y === "number" ? { x, y } : null;
      const base = selectionRef.current;
      dragSelectRef.current = { value, startIndex: index, base };
      const nextSet = new Set(base);
      if (value) nextSet.add(id);
      else nextSet.delete(id);
      const next = Array.from(nextSet);
      selectionRef.current = next;
      setSelection(next);
    },
    [items, setSelection],
  );

  const dragSelectEnter = useCallback(
    (id: string) => {
      const drag = dragSelectRef.current;
      if (!drag || !masonry) return;
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return;
      const startColumn = masonry.columnOf[drag.startIndex] ?? 0;
      const startRow = masonry.indexInColumn[drag.startIndex] ?? 0;
      const currentColumn = masonry.columnOf[index] ?? 0;
      const currentRow = masonry.indexInColumn[index] ?? 0;
      const startLeft = startColumn * (cardWidth + GAP);
      const currentLeft = currentColumn * (cardWidth + GAP);
      const startTop = masonry.tops[startColumn]?.[startRow] ?? 0;
      const currentTop = masonry.tops[currentColumn]?.[currentRow] ?? 0;
      const startHeight = masonry.heights[drag.startIndex] ?? 0;
      const currentHeight = masonry.heights[index] ?? 0;
      // 以起始卡片与当前卡片的矩形包络作为范围；列间不会为了对齐而误选。
      const left = Math.min(startLeft, currentLeft);
      const right = Math.max(startLeft + cardWidth, currentLeft + cardWidth);
      const top = Math.min(startTop, currentTop);
      const bottom = Math.max(startTop + startHeight, currentTop + currentHeight);
      const nextSet = new Set(drag.base);
      for (let cursor = 0; cursor < items.length; cursor += 1) {
        const column = masonry.columnOf[cursor] ?? 0;
        const row = masonry.indexInColumn[cursor] ?? 0;
        const itemLeft = column * (cardWidth + GAP);
        const itemTop = masonry.tops[column]?.[row] ?? 0;
        const itemHeight = masonry.heights[cursor] ?? 0;
        const intersects =
          itemLeft < right &&
          itemLeft + cardWidth > left &&
          itemTop < bottom &&
          itemTop + itemHeight > top;
        if (!intersects) continue;
        const assetId = items[cursor]?.id;
        if (!assetId) continue;
        if (drag.value) nextSet.add(assetId);
        else nextSet.delete(assetId);
      }
      const next = Array.from(nextSet);
      selectionRef.current = next;
      setSelection(next);
    },
    [items, masonry, cardWidth, setSelection],
  );

  dragEnterRef.current = dragSelectEnter;

  const stopDragAutoScroll = () => {
    if (dragAutoScrollFrame.current !== null) {
      window.cancelAnimationFrame(dragAutoScrollFrame.current);
      dragAutoScrollFrame.current = null;
    }
  };

  // 拖选时指针停在滚动区域上下边缘，持续滚动并把经过的图片纳入范围。
  dragAutoScrollRef.current = () => {
    dragAutoScrollFrame.current = null;
    if (!dragSelectRef.current) return;
    const scroller = scrollerRef.current;
    const pointer = dragPointerRef.current;
    if (!scroller || !pointer) return;
    const rect = scroller.getBoundingClientRect();
    const edge = 56;
    let delta = 0;
    if (pointer.y < rect.top + edge) {
      delta = -Math.max(8, Math.ceil((rect.top + edge - pointer.y) / 3));
    } else if (pointer.y > rect.bottom - edge) {
      delta = Math.max(8, Math.ceil((pointer.y - (rect.bottom - edge)) / 3));
    }
    if (delta === 0) return;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const nextTop = Math.max(0, Math.min(maxTop, scroller.scrollTop + delta));
    if (nextTop === scroller.scrollTop) return;
    scroller.scrollTop = nextTop;
    setScrollTop(nextTop);
    const hitId = assetIdAtPoint(pointer.x, pointer.y);
    if (hitId) dragEnterRef.current(hitId);
    dragAutoScrollFrame.current = window.requestAnimationFrame(() =>
      dragAutoScrollRef.current(),
    );
  };

  useEffect(() => {
    const end = () => {
      dragSelectRef.current = null;
      dragPointerRef.current = null;
      stopDragAutoScroll();
    };
    const move = (event: PointerEvent) => {
      if (!dragSelectRef.current) return;
      dragPointerRef.current = { x: event.clientX, y: event.clientY };
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) {
        stopDragAutoScroll();
        return;
      }
      const hitId = assetIdAtPoint(event.clientX, event.clientY);
      if (hitId) dragEnterRef.current(hitId);
      if (dragAutoScrollFrame.current === null) {
        dragAutoScrollFrame.current = window.requestAnimationFrame(() =>
          dragAutoScrollRef.current(),
        );
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") end();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("mouseup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", visibility);
      stopDragAutoScroll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) dragSelectRef.current = null;
  }, [active]);

  const handleGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const editable =
      event.target instanceof HTMLElement &&
      (event.target.tagName === "INPUT" ||
        event.target.tagName === "TEXTAREA" ||
        event.target.isContentEditable);
    if (editable) return;
    if (items.length === 0) return;
    const currentIndex = focusedId ? items.findIndex((item) => item.id === focusedId) : -1;
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = Math.min(items.length - 1, currentIndex + 1);
    else if (event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
    else if (event.key === "ArrowDown") {
      if (view === "grid" && masonry && currentIndex >= 0) {
        const column = masonry.columnOf[currentIndex] ?? 0;
        const row = masonry.indexInColumn[currentIndex] ?? 0;
        nextIndex =
          masonry.columns[column]?.[row + 1] ?? Math.min(items.length - 1, currentIndex + 1);
      } else {
        nextIndex = Math.min(
          items.length - 1,
          (currentIndex < 0 ? 0 : currentIndex) + columns,
        );
      }
    } else if (event.key === "ArrowUp") {
      if (view === "grid" && masonry && currentIndex >= 0) {
        const column = masonry.columnOf[currentIndex] ?? 0;
        const row = masonry.indexInColumn[currentIndex] ?? 0;
        nextIndex = masonry.columns[column]?.[row - 1] ?? Math.max(0, currentIndex - 1);
      } else {
        nextIndex = Math.max(0, (currentIndex < 0 ? 0 : currentIndex) - columns);
      }
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    else if (event.key === "Enter" && focusedId) {
      event.preventDefault();
      void openAsset(focusedId);
      return;
    } else if (event.key === " " && focusedId) {
      event.preventDefault();
      toggleSelected(focusedId);
      return;
    } else if (event.key === "a" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void api.assetIds(filter).then(setSelection).catch(() => undefined);
      return;
    } else {
      return;
    }
    event.preventDefault();
    const target = items[nextIndex];
    if (!target) return;
    setFocusedId(target.id);
    setSelection([target.id]);
    const element = scrollerRef.current;
    if (view === "grid" && masonry) {
      const column = masonry.columnOf[nextIndex] ?? 0;
      const row = masonry.indexInColumn[nextIndex] ?? 0;
      const top = masonry.tops[column]?.[row] ?? 0;
      if (element) {
        const visibleTop = element.scrollTop;
        const visibleBottom = visibleTop + element.clientHeight;
        if (top < visibleTop + 12 || top > visibleBottom - 80) {
          const nextTop = Math.max(0, top - 48);
          element.scrollTop = nextTop;
          setScrollTop(nextTop);
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              element
                .querySelector<HTMLElement>(`[data-asset-id="${target.id}"]`)
                ?.scrollIntoView({ block: "nearest", inline: "nearest" });
            });
          });
          return;
        }
        element
          .querySelector<HTMLElement>(`[data-asset-id="${target.id}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      return;
    }
    const row = Math.floor(nextIndex / columns);
    if (element) {
      const rowTop = row * rowHeight;
      if (rowTop < element.scrollTop || rowTop + rowHeight > element.scrollTop + element.clientHeight) {
        element.scrollTop = Math.max(0, rowTop - rowHeight);
      }
    }
  };

  const quickBatch = async (op: BatchOp) => {
    if (selection.length === 0) return;
    try {
      const preview = await api.batchPreview({ assetIds: selection, op });
      if (preview.count === 0) {
        notify({ message: preview.summary });
        return;
      }
      const result = await api.batchApply(preview.previewId);
      bumpRefresh();
      await reloadCollections();
      notify({
        tone: "success",
        title: result.label,
        message: `已更新 ${result.applied} 张图片`,
        actionLabel: S.common.undo,
        onAction: async () => {
          try {
            await api.undo();
            bumpRefresh();
            notify({ message: "已撤销" });
          } catch (error) {
            notify({ tone: "danger", message: normalizeError(error).message });
          }
        },
      });
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  };

  const recycleSelection = async () => {
    if (selection.length === 0) return;
    const ids = [...selection];
    try {
      const result = await api.recycleAssets(ids);
      // 立即从图库移除，避免刷新合并旧尾部时暂时保留已回收图片。
      const recycled = new Set(ids);
      setItems((current) => current.filter((item) => !recycled.has(item.id)));
      setTotal((current) => Math.max(0, current - result.moved));
      clearSelection();
      bumpRefresh();
      notify({
        tone: "success",
        title: "已移至回收区",
        message: `共 ${result.moved} 张，可在「去重 → 回收区」恢复`,
        actionLabel: S.common.undo,
        onAction: async () => {
          try {
            await api.undo();
            bumpRefresh();
          } catch (error) {
            notify({ tone: "danger", message: normalizeError(error).message });
          }
        },
      });
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  };

  const excludeWithReason = async (reason: string) => {
    const ids = excludeTargets || [];
    if (ids.length === 0) return;
    setExcludeTargets(null);
    try {
      const preview = await api.batchPreview({
        assetIds: ids,
        op: { kind: "setStatus", status: "excluded", reason },
      });
      if (preview.count === 0) {
        notify({ message: preview.summary });
        return;
      }
      const result = await api.batchApply(preview.previewId);
      bumpRefresh();
      notify({
        tone: "success",
        title: "已排除图片",
        message: `共 ${result.applied} 张`,
        actionLabel: S.common.undo,
        onAction: async () => {
          await api.undo();
          bumpRefresh();
        },
      });
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  };

  const createCollection = async (name: string) => {
    const mode = collectionPrompt;
    setCollectionPrompt(null);
    if (!name.trim()) return;
    try {
      if (mode === "smart") {
        await api.createCollection({ name: name.trim(), kind: "query", query: filter, sort });
        await reloadCollections();
        notify({ tone: "success", message: `已保存智能集合「${name.trim()}」` });
      } else {
        const collection = await api.createCollection({ name: name.trim(), kind: "manual" });
        await reloadCollections();
        if (selection.length > 0) {
          const preview = await api.batchPreview({
            assetIds: selection,
            op: { kind: "addToCollection", collection: collection.id },
          });
          if (preview.count > 0) await api.batchApply(preview.previewId);
          bumpRefresh();
          notify({ tone: "success", message: `已创建集合「${collection.name}」并加入 ${selection.length} 张图片` });
        } else {
          notify({ tone: "success", message: `已创建集合「${collection.name}」` });
        }
      }
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  };

  const deleteCollectionNow = async () => {
    if (!deleteCollection) return;
    try {
      await api.deleteCollection(deleteCollection.id);
      setDeleteCollection(null);
      await reloadCollections();
      notify({ message: "集合已删除" });
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  const applyFilterDraft = (close: () => void) => {
    setFilter({ ...filterDraft, query: filter.query });
    close();
  };

  const resetFilterDraft = () => {
    setFilterDraft({ ...emptyFilter(), query: filter.query });
  };

  const nowOpenFilter = (toggle: () => void) => {
    setFilterDraft(filter);
    toggle();
  };

  const assetNames = useMemo(() => {
    const map: Record<string, string> = {};
    items.forEach((item) => {
      map[item.id] = item.name;
    });
    return map;
  }, [items]);

  const summaryMap = useMemo(() => {
    const map: Record<string, AssetSummary> = {};
    items.forEach((item) => {
      map[item.id] = item;
    });
    return map;
  }, [items]);

  const rows = Math.ceil(items.length / columns);
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
  const endRow = Math.min(rows, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 2);

  const activeFilterChips = useMemo(() => {
    const chips: { key: string; label: string; remove: () => void }[] = [];
    filter.statuses.forEach((status) =>
      chips.push({
        key: `status-${status}`,
        label: statusLabel(status),
        remove: () => setFilter({ ...filter, statuses: filter.statuses.filter((value) => value !== status) }),
      }),
    );
    filter.issueLevels.forEach((level) =>
      chips.push({
        key: `level-${level}`,
        label: level === "blocking" ? S.library.filterBlocking : level === "ignored" ? S.library.filterIgnored : S.library.filterSuggestion,
        remove: () => setFilter({ ...filter, issueLevels: filter.issueLevels.filter((value) => value !== level) }),
      }),
    );
    filter.orientations.forEach((orientation) =>
      chips.push({
        key: `orientation-${orientation}`,
        label:
          orientation === "landscape"
            ? S.library.orientationLandscape
            : orientation === "portrait"
              ? S.library.orientationPortrait
              : S.library.orientationSquare,
        remove: () => setFilter({ ...filter, orientations: filter.orientations.filter((value) => value !== orientation) }),
      }),
    );
    filter.collectionIds.forEach((id) => {
      const collection = collections.find((item) => item.id === id);
      chips.push({
        key: `collection-${id}`,
        label: collection?.name || "集合",
        remove: () => setFilter({ ...filter, collectionIds: filter.collectionIds.filter((value) => value !== id) }),
      });
    });
    if (filter.split) {
      chips.push({
        key: "split",
        label: filter.split === "train" ? "训练" : filter.split === "val" ? "验证" : "未分配",
        remove: () => setFilter({ ...filter, split: null }),
      });
    }
    if (filter.duplicateOnly) {
      chips.push({ key: "duplicate", label: S.library.filterDuplicate, remove: () => setFilter({ ...filter, duplicateOnly: false }) });
    }
    if (filter.favoriteOnly) {
      chips.push({ key: "favorite", label: S.library.filterFavorites, remove: () => setFilter({ ...filter, favoriteOnly: false }) });
    }
    if (filter.hasDraft) {
      chips.push({ key: "draft", label: S.library.filterDraft, remove: () => setFilter({ ...filter, hasDraft: false }) });
    }
    if (filter.recycledOnly) {
      chips.push({ key: "recycled", label: "回收区", remove: () => setFilter({ ...filter, recycledOnly: false }) });
    }
    if (filter.minShortEdge) {
      chips.push({ key: "minEdge", label: `短边 ≥ ${filter.minShortEdge}`, remove: () => setFilter({ ...filter, minShortEdge: null }) });
    }
    if (filter.maxShortEdge) {
      chips.push({ key: "maxEdge", label: `短边 ≤ ${filter.maxShortEdge}`, remove: () => setFilter({ ...filter, maxShortEdge: null }) });
    }
    return chips;
  }, [filter, collections, setFilter]);

  const beginInspectorResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.min(420, Math.max(280, startWidth + (startX - moveEvent.clientX)));
      setInspectorWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      void updateSettings({ inspectorWidth: widthRef.current });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  };

  const showEmpty = !loading && total === 0;
  const hasFilter = filterCount > 0;

  return (
    <div className="page" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div className="library-page" style={{ ["--inspector-w" as any]: `${inspectorWidth}px` }}>
        <div className="library-head">
          <div>
            <h1 className="page-title">{S.library.title}</h1>
            <div className="head-count">
              {filterCount > 0 || filter.query.trim() ? (
                <>
                  <span>找到</span>
                  <strong>{formatNumber(total)}</strong>
                  <span>张 · 共 {formatNumber(project.counts.valid)} 张</span>
                </>
              ) : (
                <>
                  <strong>{formatNumber(project.counts.valid)}</strong>
                  <span>张图片</span>
                </>
              )}
            </div>
          </div>
          <div className="library-actions">
            <IconButton
              icon="panel-right"
              label={inspectorOpen ? S.library.sidebarCollapse : S.library.sidebarExpand}
              active={inspectorOpen}
              onClick={() => setInspectorOpen((value) => !value)}
            />
            <button
              type="button"
              className="btn subtle"
              onClick={() => setDedupeOpen(true)}
              title={duplicateCount > 0 ? `${duplicateCount} 张疑似重复` : "按内容去重"}
            >
              <Icon name="copy" />
              去重
              {duplicateCount > 0 ? <span className="count warning">{duplicateCount}</span> : null}
            </button>
            <button type="button" className="btn primary" onClick={() => { setImportPaths([]); setImportOpen(true); }}>
              <Icon name="import" />
              {S.library.import}
            </button>
          </div>
        </div>

        <div className="library-toolbar">
          <div className="search-box">
            <Icon name="search" className="sm" />
            <input
              ref={searchRef}
              id="library-search"
              className="input"
              placeholder={S.library.searchPlaceholder}
              value={searchInput}
              onChange={(event) => changeSearch(event.target.value)}
              aria-label={S.library.searchPlaceholder}
            />
            {searchInput ? (
              <button type="button" className="search-clear" aria-label={S.common.clear} onClick={clearSearch}>
                <Icon name="x" className="sm" />
              </button>
            ) : (
              <span className="search-hint">
                <span className="kbd">Ctrl F</span>
              </span>
            )}
          </div>

          <Dropdown
            width={520}
            renderTrigger={(toggle, open) => (
              <button
                type="button"
                className={classNames("btn", filterCount > 0 ? "secondary" : "subtle")}
                onClick={() => nowOpenFilter(toggle)}
                aria-expanded={open}
              >
                <Icon name="filter" />
                {S.library.filter}
                {filterCount > 0 ? <span className="count info">{filterCount}</span> : null}
              </button>
            )}
          >
            {(close) => (
              <div className="stack" style={{ gap: 14, padding: 10 }}>
                <div className="filter-grid">
                  <div className="filter-section">
                    <div className="filter-title">{S.library.filterStatus}</div>
                    <div className="row-wrap">
                      {(["pending", "approved", "review", "excluded"] as ReviewStatus[]).map((status) => (
                        <button
                          key={status}
                          type="button"
                          className={classNames("chip", filterDraft.statuses.includes(status) && "active")}
                          onClick={() =>
                            setFilterDraft({
                              ...filterDraft,
                              statuses: filterDraft.statuses.includes(status)
                                ? filterDraft.statuses.filter((value) => value !== status)
                                : [...filterDraft.statuses, status],
                            })
                          }
                        >
                          {statusLabel(status)}
                        </button>
                      ))}
                    </div>
                    <div className="filter-title" style={{ marginTop: 8 }}>{S.library.filterIssue}</div>
                    <div className="row-wrap">
                      {(["blocking", "suggestion", "ignored"] as const).map((level) => (
                        <button
                          key={level}
                          type="button"
                          className={classNames("chip", filterDraft.issueLevels.includes(level) && "active")}
                          onClick={() =>
                            setFilterDraft({
                              ...filterDraft,
                              issueLevels: filterDraft.issueLevels.includes(level)
                                ? filterDraft.issueLevels.filter((value) => value !== level)
                                : [...filterDraft.issueLevels, level],
                            })
                          }
                        >
                          {level === "blocking" ? S.library.filterBlocking : level === "suggestion" ? S.library.filterSuggestion : S.library.filterIgnored}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="filter-section">
                    <div className="filter-title">{S.library.filterOrientation}</div>
                    <div className="row-wrap">
                      {(["landscape", "portrait", "square"] as const).map((orientation) => (
                        <button
                          key={orientation}
                          type="button"
                          className={classNames("chip", filterDraft.orientations.includes(orientation) && "active")}
                          onClick={() =>
                            setFilterDraft({
                              ...filterDraft,
                              orientations: filterDraft.orientations.includes(orientation)
                                ? filterDraft.orientations.filter((value) => value !== orientation)
                                : [...filterDraft.orientations, orientation],
                            })
                          }
                        >
                          {orientation === "landscape" ? S.library.orientationLandscape : orientation === "portrait" ? S.library.orientationPortrait : S.library.orientationSquare}
                        </button>
                      ))}
                    </div>
                    <div className="filter-title" style={{ marginTop: 8 }}>{S.library.filterSize}</div>
                    <div className="row" style={{ gap: 6 }}>
                      <input
                        className="input number"
                        type="number"
                        min={1}
                        placeholder={S.library.minEdge}
                        value={filterDraft.minShortEdge ?? ""}
                        onChange={(event) =>
                          setFilterDraft({
                            ...filterDraft,
                            minShortEdge: event.target.value ? Number(event.target.value) : null,
                          })
                        }
                        style={{ minHeight: 38 }}
                      />
                      <span className="faint">—</span>
                      <input
                        className="input number"
                        type="number"
                        min={1}
                        placeholder={S.library.maxEdge}
                        value={filterDraft.maxShortEdge ?? ""}
                        onChange={(event) =>
                          setFilterDraft({
                            ...filterDraft,
                            maxShortEdge: event.target.value ? Number(event.target.value) : null,
                          })
                        }
                        style={{ minHeight: 38 }}
                      />
                    </div>
                  </div>

                  <div className="filter-section">
                    <div className="filter-title">{S.library.filterCollection}</div>
                    <Select
                      value={filterDraft.collectionIds[0] || ""}
                      onChange={(value) =>
                        setFilterDraft({ ...filterDraft, collectionIds: value ? [value] : [] })
                      }
                      ariaLabel={S.library.filterCollection}
                      options={[
                        { value: "", label: S.library.filterAny },
                        ...collections.map((collection) => ({
                          value: collection.id,
                          label: collection.name,
                          hint: collection.count,
                        })),
                      ]}
                    />
                    <div className="filter-title" style={{ marginTop: 8 }}>{S.library.filterSplit}</div>
                    <Select
                      value={filterDraft.split || ""}
                      onChange={(value) =>
                        setFilterDraft({
                          ...filterDraft,
                          split: (value || null) as AssetFilter["split"],
                        })
                      }
                      ariaLabel={S.library.filterSplit}
                      options={[
                        { value: "", label: S.library.filterAny },
                        { value: "train", label: S.library.splitTrain },
                        { value: "val", label: S.library.splitVal },
                        { value: "unassigned", label: S.library.splitUnassigned },
                      ]}
                    />
                  </div>

                  <div className="filter-section">
                    <Toggle
                      checked={filterDraft.duplicateOnly}
                      onChange={(value) => setFilterDraft({ ...filterDraft, duplicateOnly: value })}
                      label={S.library.filterDuplicate}
                    />
                    <Toggle
                      checked={filterDraft.favoriteOnly}
                      onChange={(value) => setFilterDraft({ ...filterDraft, favoriteOnly: value })}
                      label={S.library.filterFavorites}
                    />
                    <Toggle
                      checked={filterDraft.hasDraft}
                      onChange={(value) => setFilterDraft({ ...filterDraft, hasDraft: value })}
                      label={S.library.filterDraft}
                    />
                    <Toggle
                      checked={filterDraft.recycledOnly}
                      onChange={(value) => setFilterDraft({ ...filterDraft, recycledOnly: value })}
                      label="回收区"
                    />
                  </div>
                </div>
                <div className="row" style={{ justifyContent: "space-between", borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                  <button type="button" className="btn ghost sm" onClick={resetFilterDraft}>
                    {S.library.resetFilters}
                  </button>
                  <div className="row" style={{ gap: 9 }}>
                    <button
                      type="button"
                      className="btn subtle"
                      onClick={() => {
                        close();
                        setFilterDraft(filter);
                        setCollectionPrompt("smart");
                      }}
                    >
                      {S.library.saveSmartCollection}
                    </button>
                    <button type="button" className="btn primary" onClick={() => applyFilterDraft(close)}>
                      {S.library.applyFilters}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Dropdown>

          <Dropdown
            width={260}
            renderTrigger={(toggle) => (
              <button type="button" className="btn subtle" onClick={toggle}>
                <Icon name="folder" />
                {S.library.collections}
                <Icon name="chevron-down" className="sm" />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuLabel>{S.library.collections}</MenuLabel>
                <MenuItem
                  icon="image"
                  onClick={() => {
                    close();
                    setFilter({ ...filter, collectionIds: [] });
                  }}
                  hint={filter.collectionIds.length === 0 ? "✓" : undefined}
                >
                  {S.library.allCollections}
                </MenuItem>
                <MenuItem
                  icon="star"
                  onClick={() => {
                    close();
                    setFilter({ ...filter, favoriteOnly: true, collectionIds: [], statuses: [], issueLevels: [], split: null });
                  }}
                >
                  {S.library.smartFavorites}
                </MenuItem>
                <MenuItem
                  icon="alert"
                  onClick={() => {
                    close();
                    setFilter({ ...filter, favoriteOnly: false, collectionIds: [], statuses: ["review"], issueLevels: [], split: null });
                  }}
                >
                  {S.library.smartReview}
                </MenuItem>
                <MenuItem
                  icon="clock"
                  onClick={() => {
                    close();
                    setFilter({ ...filter, favoriteOnly: false, collectionIds: [] });
                    setSort({ field: "date", direction: "desc" });
                  }}
                >
                  {S.library.smartRecent}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon="trash"
                  onClick={() => {
                    close();
                    setFilter({ ...emptyFilter(), recycledOnly: true });
                  }}
                  hint={filter.recycledOnly ? "✓" : undefined}
                >
                  回收区
                </MenuItem>
                {collections.length > 0 ? <MenuSeparator /> : null}
                {collections.map((collection) => (
                  <MenuItem
                    key={collection.id}
                    icon="folder"
                    hint={collection.count}
                    onClick={() => {
                      close();
                      setFilter({ ...filter, collectionIds: [collection.id], favoriteOnly: false });
                    }}
                  >
                    {collection.name}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  icon="plus"
                  onClick={() => {
                    close();
                    setCollectionPrompt("new");
                  }}
                >
                  新建集合…
                </MenuItem>
                {collections.length > 0 ? <MenuSeparator /> : null}
                {collections.map((collection) => (
                  <MenuItem
                    key={`delete-${collection.id}`}
                    icon="trash"
                    danger
                    onClick={() => {
                      close();
                      setDeleteCollection(collection);
                    }}
                  >
                    删除「{collection.name}」
                  </MenuItem>
                ))}
              </>
            )}
          </Dropdown>

          <div className="toolbar-divider" />

          <Select
            className="sort-select"
            ariaLabel={S.library.sort}
            value={`${sort.field}:${sort.direction}`}
            onChange={(value) => {
              const [field, direction] = value.split(":");
              setSort({ field: field as AssetSort["field"], direction: direction as AssetSort["direction"] });
              if (["exposure", "colorfulness", "contrast", "saturation"].includes(field)) {
                void ensureMetrics();
              }
            }}
            options={[
              { value: "import:asc", label: S.library.sortImport },
              { value: "name:asc", label: `${S.library.sortName} A–Z` },
              { value: "name:desc", label: `${S.library.sortName} Z–A` },
              { value: "edge:desc", label: `${S.library.sortEdge} ↓` },
              { value: "edge:asc", label: `${S.library.sortEdge} ↑` },
              { value: "status:asc", label: S.library.sortStatus },
              { value: "date:desc", label: S.library.smartRecent },
              { value: "width:desc", label: "宽度 ↓" },
              { value: "width:asc", label: "宽度 ↑" },
              { value: "height:desc", label: "高度 ↓" },
              { value: "height:asc", label: "高度 ↑" },
              { value: "ratio:desc", label: "宽高比 ↓" },
              { value: "ratio:asc", label: "宽高比 ↑" },
              { value: "exposure:desc", label: "曝光度 ↓" },
              { value: "exposure:asc", label: "曝光度 ↑" },
              { value: "colorfulness:desc", label: "颜色丰富度 ↓" },
              { value: "colorfulness:asc", label: "颜色丰富度 ↑" },
              { value: "contrast:desc", label: "对比度 ↓" },
              { value: "contrast:asc", label: "对比度 ↑" },
              { value: "saturation:desc", label: "饱和度 ↓" },
              { value: "saturation:asc", label: "饱和度 ↑" },
            ]}
          />

          <Segmented
            compact
            value={view}
            onChange={(value) => setView(value as LibraryView)}
            options={[
              { value: "grid", label: "", icon: "grid" },
              { value: "list", label: "", icon: "list" },
            ]}
            ariaLabel={S.library.view}
          />
        </div>

        {activeFilterChips.length > 0 ? (
          <div className="active-filters">
            {activeFilterChips.map((chip) => (
              <span className="chip active" key={chip.key}>
                {chip.label}
                <button type="button" className="x" aria-label={`移除 ${chip.label}`} onClick={chip.remove}>
                  <Icon name="x" className="sm" />
                </button>
              </span>
            ))}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setFilter(emptyFilter());
                setSearchInput("");
              }}
            >
              {S.common.clearAll}
            </button>
          </div>
        ) : null}

        <div className="library-body">
          <div className="asset-area">
            <div
              className="asset-scroll"
              ref={scrollerRef}
              tabIndex={0}
              role="listbox"
              aria-multiselectable="true"
              aria-label={S.library.title}
              onScroll={(event) => {
                const target = event.currentTarget;
                setScrollTop(target.scrollTop);
                if (target.scrollTop + target.clientHeight > target.scrollHeight - 600) {
                  void loadMore();
                }
              }}
              onKeyDown={handleGridKeyDown}
            >
              {loading ? (
                <div
                  className="asset-row"
                  style={{ position: "static", display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: GAP }}
                >
                  {Array.from({ length: Math.max(6, columns * 2) }).map((_, index) => (
                    <div key={index} className="asset-card">
                      <div className="skeleton" style={{ aspectRatio: "1" }} />
                      <div className="skeleton" style={{ height: 12, width: "70%" }} />
                      <div className="skeleton" style={{ height: 10, width: "45%" }} />
                    </div>
                  ))}
                </div>
              ) : error ? (
                <EmptyState
                  icon="alert"
                  title={S.errors.generic}
                  body={error}
                  actions={
                    <button type="button" className="btn primary" onClick={() => void loadFirst()}>
                      {S.common.retry}
                    </button>
                  }
                />
              ) : showEmpty ? (
                hasFilter || filter.query ? (
                  <EmptyState
                    icon="search"
                    title={S.library.noResults}
                    body={S.library.noResultsBody}
                    actions={
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => {
                          setFilter(emptyFilter());
                          setSearchInput("");
                        }}
                      >
                        {S.common.clearAll}
                      </button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon="image"
                    title={S.library.emptyTitle}
                    body={S.library.emptyBody}
                    actions={
                      <button type="button" className="btn primary" onClick={() => setImportOpen(true)}>
                        <Icon name="import" />
                        {S.library.emptyImport}
                      </button>
                    }
                  />
                )
              ) : view === "grid" && masonry ? (
                <div className="grid-sizer masonry-sizer" style={{ height: masonry.total }}>
                  {masonry.columns.map((indices, column) => {
                    const tops = masonry.tops[column];
                    const start = Math.max(
                      0,
                      lowerBound(tops, scrollTop - MASONRY_OVERSCAN - masonry.maxHeight),
                    );
                    const end = Math.min(
                      indices.length,
                      lowerBound(tops, scrollTop + viewportHeight + MASONRY_OVERSCAN) + 1,
                    );
                    if (end <= start) return null;
                    return (
                      <div
                        className="masonry-col"
                        key={column}
                        style={{ left: column * (cardWidth + GAP), width: cardWidth }}
                      >
                        {indices.slice(start, end).map((itemIndex, offset) => {
                          const asset = items[itemIndex];
                          if (!asset) return null;
                          return (
                            <div
                              className="masonry-item"
                              key={asset.id}
                              style={{ top: tops[start + offset] }}
                            >
                              <AssetCard
                                asset={asset}
                                selected={selectionSet.has(asset.id)}
                                focused={focusedId === asset.id}
                                onClick={(event) => handleCardClick(asset, event)}
                                onToggle={() => toggleSelected(asset.id)}
                                onOpen={() => void openAsset(asset.id)}
                                onDragSelect={(value, event) =>
                                  startDragSelect(asset.id, value, event.clientX, event.clientY)
                                }
                                onDragEnter={() => dragSelectEnter(asset.id)}
                              />
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                  {loadingMore ? (
                    <div
                      className="loading-line library-grid-loading"
                      style={{ position: "absolute", bottom: 8, left: 0, right: 0, justifyContent: "center" }}
                    >
                      <Spinner /> {S.library.loadingMore}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="grid-sizer" style={{ height: rows * rowHeight }}>
                  {Array.from({ length: Math.max(0, endRow - startRow) }).map((_, rowOffset) => {
                    const index = startRow + rowOffset;
                    const asset = items[index];
                    if (!asset) return null;
                    return (
                      <div
                        className="asset-row"
                        key={asset.id}
                        style={{ top: index * rowHeight, height: rowHeight, gap: 0 }}
                      >
                        <AssetListRow
                          asset={asset}
                          selected={selectionSet.has(asset.id)}
                          focused={focusedId === asset.id}
                          onClick={(event) => handleCardClick(asset, event)}
                          onToggle={() => toggleSelected(asset.id)}
                          onOpen={() => void openAsset(asset.id)}
                        />
                      </div>
                    );
                  })}
                  {loadingMore ? (
                    <div className="loading-line" style={{ position: "absolute", bottom: 8, left: 0, right: 0, justifyContent: "center" }}>
                      <Spinner /> {S.library.loadingMore}
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {selection.length > 0 ? (
              <div
                className={classNames("selection-bar", inspectorOpen && "shift")}
                role="region"
                aria-label={S.library.selectedCount(selection.length)}
              >
                <div className="selection-count">
                  <strong>{S.library.selectedCount(selection.length)}</strong>
                  {hiddenSelected > 0 ? <span>{S.library.hiddenSelected(hiddenSelected)}</span> : null}
                </div>
                <div className="selection-actions">
                  <button
                    type="button"
                    className="btn subtle"
                    onClick={() => void toggleSelectAll()}
                    title={S.library.selectAll}
                  >
                    <Icon name="check-circle" className="sm" />
                    <span>{total > 0 && selection.length >= total ? "取消全选" : "全选"}</span>
                  </button>
                  <Dropdown
                    width={240}
                    align="end"
                    renderTrigger={(toggle) => (
                      <button type="button" className="btn subtle" onClick={toggle}>
                        <Icon name="folder" className="sm" />
                        <span>{S.library.addToCollection}</span>
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        {collections.map((collection) => (
                          <MenuItem
                            key={collection.id}
                            icon="folder"
                            hint={collection.count}
                            onClick={() => {
                              close();
                              void quickBatch({ kind: "addToCollection", collection: collection.id });
                            }}
                          >
                            {collection.name}
                          </MenuItem>
                        ))}
                        <MenuSeparator />
                        <MenuItem icon="plus" onClick={() => { close(); setCollectionPrompt("new"); }}>
                          新建集合并加入
                        </MenuItem>
                      </>
                    )}
                  </Dropdown>
                  <button type="button" className="btn secondary" onClick={() => setBatchOpen(true)}>
                    <Icon name="tag" className="sm" />
                    <span>{S.library.batchEdit}</span>
                  </button>
                  {!filter.recycledOnly ? (
                    <button
                      type="button"
                      className="btn subtle"
                      onClick={() => void recycleSelection()}
                      title="将选中图片移至回收区，可撤销"
                    >
                      <Icon name="trash" className="sm" />
                      <span>回收</span>
                    </button>
                  ) : null}
                  <Dropdown
                    width={240}
                    align="end"
                    renderTrigger={(toggle) => (
                      <button type="button" className="btn subtle" onClick={toggle}>
                        <Icon name="check-circle" className="sm" />
                        <span>{S.library.review}</span>
                        <Icon name="chevron-down" className="sm" />
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        <MenuItem
                          icon="check"
                          onClick={() => {
                            close();
                            void quickBatch({ kind: "setStatus", status: "approved" });
                          }}
                        >
                          标记已通过
                        </MenuItem>
                        <MenuItem
                          icon="alert"
                          onClick={() => {
                            close();
                            void quickBatch({ kind: "setStatus", status: "review" });
                          }}
                        >
                          标记需复核
                        </MenuItem>
                        <MenuItem
                          icon="x"
                          danger
                          onClick={() => {
                            close();
                            setExcludeTargets(selection);
                          }}
                        >
                          排除所选
                        </MenuItem>
                        <MenuItem
                          icon="restore"
                          onClick={() => {
                            close();
                            void quickBatch({ kind: "setStatus", status: "pending" });
                          }}
                        >
                          恢复为待审核
                        </MenuItem>
                      </>
                    )}
                  </Dropdown>
                  <Dropdown
                    width={220}
                    align="end"
                    renderTrigger={(toggle) => (
                      <IconButton icon="more" label={S.library.batchMore} onClick={toggle} />
                    )}
                  >
                    {(close) => (
                      <>
                        <MenuLabel>{S.library.filterSplit}</MenuLabel>
                        <MenuItem icon="lock" onClick={() => { close(); void quickBatch({ kind: "setSplit", split: "train" }); }}>
                          锁定训练
                        </MenuItem>
                        <MenuItem icon="lock" onClick={() => { close(); void quickBatch({ kind: "setSplit", split: "val" }); }}>
                          锁定验证
                        </MenuItem>
                        <MenuItem icon="circle" onClick={() => { close(); void quickBatch({ kind: "setSplit", split: null }); }}>
                          取消用途
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem icon="check-circle" onClick={() => { close(); void quickBatch({ kind: "lowercase" }); }}>
                          统一小写
                        </MenuItem>
                        <MenuItem icon="broom" onClick={() => { close(); void quickBatch({ kind: "cleanShort", maxLen: 2 }); }}>
                          清理短标签
                        </MenuItem>
                      </>
                    )}
                  </Dropdown>
                  <IconButton icon="x" label={S.library.clearSelection} onClick={clearSelection} />
                </div>
              </div>
            ) : null}
          </div>

          {inspectorOpen ? (
            <>
              <div className="inspector-backdrop" onClick={() => setInspectorOpen(false)} />
              <Inspector
                open={inspectorOpen}
                width={inspectorWidth}
                assetIds={selection}
                focusedId={focusedId}
                summaries={summaryMap}
                hiddenSelected={hiddenSelected}
                onClose={() => setInspectorOpen(false)}
                onResizeStart={beginInspectorResize}
                onOpenWorkbench={(id) => void openAsset(id)}
                onOpenBatch={() => setBatchOpen(true)}
                onQuickBatch={(op) => void quickBatch(op)}
                onExclude={(ids) => setExcludeTargets(ids)}
              />
            </>
          ) : null}
        </div>
      </div>

      {dragOver ? (
        <div className="drag-overlay">
          <div className="drop-icon">
            <Icon name="import" size={30} />
          </div>
          <h3>{S.library.dropTitle}</h3>
          <p>{S.library.dropBody}</p>
        </div>
      ) : null}

      <ImportDialog
        open={importOpen}
        initialPaths={importPaths}
        onClose={() => {
          setImportOpen(false);
          setImportPaths([]);
        }}
      />
      <BatchDialog open={batchOpen} onClose={() => setBatchOpen(false)} assetNames={assetNames} />
      <DedupeDialog
        open={dedupeOpen}
        onClose={() => setDedupeOpen(false)}
        onChanged={() => {
          bumpRefresh();
          void loadFirst();
        }}
      />

      <PromptDialog
        open={excludeTargets !== null}
        title={S.workbench.excludeTitle}
        body={S.workbench.excludeBody}
        label={S.workbench.excludeReason}
        placeholder={S.workbench.excludeReasonPlaceholder}
        danger
        confirmLabel={S.workbench.excludeConfirm}
        onSubmit={(value) => void excludeWithReason(value)}
        onClose={() => setExcludeTargets(null)}
      />

      <PromptDialog
        open={collectionPrompt !== null}
        title={collectionPrompt === "smart" ? S.library.saveSmartCollection : "新建集合"}
        body={
          collectionPrompt === "smart"
            ? "将当前筛选与排序保存为动态集合，集合内容随素材变化自动计算。"
            : "创建一个手动集合；若当前有选中图片，会一并加入。"
        }
        label={S.library.smartCollectionName}
        required
        confirmLabel={S.common.add}
        onSubmit={(value) => void createCollection(value)}
        onClose={() => setCollectionPrompt(null)}
      />

      <ConfirmDialog
        open={deleteCollection !== null}
        title="删除集合？"
        body={`将移除集合「${deleteCollection?.name || ""}」及其归属关系，不会删除图片。`}
        confirmLabel="删除集合"
        danger
        onClose={() => setDeleteCollection(null)}
        onConfirm={() => void deleteCollectionNow()}
      />
    </div>
  );
}

function AssetCard({
  asset,
  width,
  selected,
  focused,
  onClick,
  onToggle,
  onOpen,
  onDragSelect,
  onDragEnter,
}: {
  asset: AssetSummary;
  width?: number;
  selected: boolean;
  focused: boolean;
  onClick: (event: React.MouseEvent) => void;
  onToggle: () => void;
  onOpen: () => void;
  onDragSelect: (value: boolean, event: React.PointerEvent<HTMLButtonElement>) => void;
  onDragEnter: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const badges: { label: string; tone: "danger" | "warning" | "info" | "neutral" }[] = [];
  if (asset.missing) badges.push({ label: "失联", tone: "danger" });
  if (asset.issueBlocking > 0) badges.push({ label: `阻塞 ${asset.issueBlocking}`, tone: "danger" });
  if (asset.issueSuggestion > 0) badges.push({ label: `建议 ${asset.issueSuggestion}`, tone: "warning" });
  if (asset.hasDraft) badges.push({ label: "草稿", tone: "info" });
  if (asset.splitLock === "val") badges.push({ label: "验证", tone: "neutral" });
  return (
    <div
      role="option"
      aria-selected={selected}
      className={classNames("asset-card", selected && "selected", focused && "focused")}
      style={width ? { width } : undefined}
      data-asset-id={asset.id}
      onClick={onClick}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onOpen();
        }
      }}
      tabIndex={focused ? 0 : -1}
      title={`${asset.name}\n${asset.width}×${asset.height}\n双击打开工作台`}
      onPointerEnter={onDragEnter}
    >
      <div
        className="thumb-box checker"
        style={{ aspectRatio: `${asset.width} / ${asset.height}` }}
      >
        {!failed ? (
          <img
            src={gridThumbUrl(asset)}
            alt={asset.name}
            loading="lazy"
            draggable={false}
            className={classNames("thumb-img", !loaded && "loading")}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : null}
        {failed ? (
          <div className="thumb-placeholder">
            <span className="ph-icon">
              <Icon name={asset.missing ? "alert" : "image"} size={18} />
            </span>
            <span>{asset.missing ? "源文件失联" : "缩略图不可用"}</span>
          </div>
        ) : null}
        <button
          type="button"
          className={classNames("card-check", selected && "checked")}
          aria-label={selected ? "取消选择" : "选择图片"}
          aria-pressed={selected}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            onDragSelect(!selected, event);
          }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              onToggle();
            }
          }}
        >
          {selected ? <Icon name="check" size={15} /> : null}
        </button>
        {asset.favorite ? (
          <span className="card-favorite" title="已收藏">
            <Icon name="star" size={15} style={{ fill: "currentColor" }} />
          </span>
        ) : null}
        <div className="card-badges">
          {badges.slice(0, 2).map((badge) => (
            <span key={badge.label} className={classNames("badge", badge.tone)}>
              {badge.label}
            </span>
          ))}
        </div>
      </div>
      <div className="card-caption">
        <div className="row" style={{ gap: 5 }}>
          <span className={classNames("status-dot", asset.status)} title={statusLabel(asset.status)} />
          <span className="card-name" title={asset.name}>
            {asset.name}
          </span>
        </div>
        <div className="card-meta">
          <span>
            {asset.width}×{asset.height}
          </span>
          <span className="sep">·</span>
          <span>{formatBytes(asset.bytes)}</span>
          {asset.outWidth !== asset.width || asset.outHeight !== asset.height ? (
            <>
              <span className="sep">·</span>
              <span>
                → {asset.outWidth}×{asset.outHeight}
              </span>
            </>
          ) : null}
        </div>
        <div
          className="card-caption-text"
          style={!asset.hasCaption ? { color: "var(--warning)" } : undefined}
          title={asset.captionPreview || asset.captionText}
        >
          {asset.hasCaption ? asset.captionPreview || asset.captionText : "缺少标注"}
        </div>
      </div>
    </div>
  );
}

function AssetListRow({
  asset,
  selected,
  focused,
  onClick,
  onToggle,
  onOpen,
}: {
  asset: AssetSummary;
  selected: boolean;
  focused: boolean;
  onClick: (event: React.MouseEvent) => void;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      role="option"
      aria-selected={selected}
      className={classNames("asset-list-row", selected && "selected")}
      style={focused ? { boxShadow: "0 0 0 1px var(--primary) inset" } : undefined}
      onClick={onClick}
      onDoubleClick={onOpen}
      tabIndex={focused ? 0 : -1}
    >
      <button
        type="button"
        className={classNames("card-check", "static", selected && "checked")}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        aria-label={selected ? "取消选择" : "选择图片"}
        aria-pressed={selected}
      >
        {selected ? <Icon name="check" size={14} /> : null}
      </button>
      <span className="list-thumb checker">
        {failed ? <Icon name="image" className="sm" style={{ margin: 14, color: "var(--faint)" }} /> : (
          <img src={lowThumbUrl(asset)} alt="" loading="lazy" onError={() => setFailed(true)} />
        )}
      </span>
      <div className="list-main">
        <div className="list-title">
          {asset.name}
          {asset.favorite ? <Icon name="star" className="sm" style={{ color: "var(--warning)", marginLeft: 4, display: "inline", verticalAlign: "-2px" }} /> : null}
        </div>
        <div className="list-caption" style={!asset.hasCaption ? { color: "var(--warning)" } : undefined}>
          {asset.hasCaption ? asset.captionPreview || asset.captionText : "缺少标注"}
        </div>
      </div>
      <div className="list-col">
        {asset.width}×{asset.height}
      </div>
      <div className="list-col">{formatBytes(asset.bytes)}</div>
      <div className="list-col status">
        <Badge tone={statusTone(asset.status)}>{statusLabel(asset.status)}</Badge>
      </div>
      <div className="list-col" style={{ width: 70 }}>
        {asset.splitLock === "train" ? "训练" : asset.splitLock === "val" ? "验证" : "—"}
      </div>
      <div className="list-col" style={{ width: 100, textAlign: "right" }}>
        {asset.issueBlocking > 0 ? <Badge tone="danger">{asset.issueBlocking}</Badge> : null}{" "}
        {asset.issueSuggestion > 0 ? <Badge tone="warning">{asset.issueSuggestion}</Badge> : null}
      </div>
    </div>
  );
}
