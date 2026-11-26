import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { PromptLibraryEntry, TagTotalEntry, TagTotalsResult } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import {
  loadPromptLibrary,
  lookupPromptTranslation,
  normalizePromptKey,
  PROMPT_LIBRARY_UPDATED_EVENT,
  type PromptLibrary,
} from "../../lib/promptDictionary";
import { classNames } from "../../lib/utils";
import { Icon } from "../../components/Icon";
import { Notice, Select, Spinner } from "../../components/ui";

type BulkAction = "add" | "remove" | "rename";
type StatusScope = "stats" | "library";
interface Status {
  text: string;
  tone?: "danger";
  scope: StatusScope;
}
type LibMenu = { entry: PromptLibraryEntry; x: number; y: number };

interface Props {
  active: boolean;
  currentId: string | null;
  selectedIds: string[];
  refreshToken: number;
  onAddToCurrent: (tags: string[]) => Promise<"added" | "exists" | "failed">;
  beforeBulk: () => Promise<boolean>;
  onAfterBulk: () => void;
}

const EMPTY_LIBRARY: PromptLibrary = {
  entries: [],
  dictionary: new Map(),
  categoryOf: new Map(),
  categories: [],
};

function readLibraryOpen(): boolean {
  try {
    const stored = localStorage.getItem("yoyoku.tag-library-open");
    if (stored !== null) return stored === "1";
  } catch {
    // ignore
  }
  return window.innerWidth >= 1680;
}

/**
 * 打标页右侧的辅助栏：
 * - 统计：范围内每条短语出现的图片数，支持行内重命名 / 清空删除 / 末尾追加。
 * - 词库：紧凑只读列表，点击弹出添加菜单，也可拖到画布或已选计数上。
 * 常规操作不弹确认框，结果以内联状态呈现，保持操作连贯。
 */
export function TagAssist({
  active,
  currentId,
  selectedIds,
  refreshToken,
  onAddToCurrent,
  beforeBulk,
  onAfterBulk,
}: Props) {
  const { project } = useProject();
  const [library, setLibrary] = useState<PromptLibrary>(EMPTY_LIBRARY);
  const [libraryOpen, setLibraryOpen] = useState(readLibraryOpen);
  const [assistTab, setAssistTab] = useState<"stats" | "library">("stats");
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [totals, setTotals] = useState<TagTotalsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [localRevision, setLocalRevision] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [query, setQuery] = useState("");
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftValue, setDraftValue] = useState("");
  const [libQuery, setLibQuery] = useState("");
  const [libCategory, setLibCategory] = useState("");
  const [menu, setMenu] = useState<LibMenu | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [currentBusy, setCurrentBusy] = useState(false);
  const [dragEntry, setDragEntry] = useState<PromptLibraryEntry | null>(null);
  const [dragPos, setDragPos] = useState({ x: 0, y: 0 });
  const [dropTarget, setDropTarget] = useState<"current" | "selection" | null>(null);

  const bulkBusyRef = useRef(false);
  const editRef = useRef<{ tag: string; value: string } | null>(null);
  const draftRef = useRef<{ value: string } | null>(null);
  const draftRowRef = useRef<HTMLDivElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const statsListRef = useRef<HTMLDivElement>(null);
  const libListRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    entry: PromptLibraryEntry;
    startX: number;
    startY: number;
    active: boolean;
    rect: DOMRect;
  } | null>(null);
  const dropTargetRef = useRef<"current" | "selection" | null>(null);
  const dropElRef = useRef<HTMLElement | null>(null);

  const scopeKey = useMemo(() => selectedIds.join("\u0000"), [selectedIds]);
  const scoped = selectedIds.length > 0;
  // 默认 1440 窗口放不下「素材栏 + 标注 + 两列辅助」，收成一列用页签切换。
  const compact = viewportWidth < 1760;

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("yoyoku.tag-library-open", libraryOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [libraryOpen]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 3600);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    statsListRef.current?.scrollTo({ top: 0 });
  }, [scopeKey]);

  useEffect(() => {
    libListRef.current?.scrollTo({ top: 0 });
  }, [libQuery, libCategory, assistTab, libraryOpen]);

  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      loadPromptLibrary(project.id)
        .then((next) => {
          if (!cancelled) setLibrary(next);
        })
        .catch(() => undefined);
    };
    reload();
    window.addEventListener(PROMPT_LIBRARY_UPDATED_EVENT, reload);
    return () => {
      cancelled = true;
      window.removeEventListener(PROMPT_LIBRARY_UPDATED_EVENT, reload);
    };
  }, [project.id]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .captionTagTotals(selectedIds)
      .then((result) => {
        if (!cancelled) setTotals(result);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(normalizeError(error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, scopeKey, refreshToken, localRevision]);

  const totalByKey = useMemo(() => {
    const map = new Map<string, TagTotalEntry>();
    for (const entry of totals?.tags ?? []) map.set(normalizePromptKey(entry.tag), entry);
    return map;
  }, [totals]);

  const targetCount = totals?.targetAssets ?? 0;

  const missingCount = useCallback(
    (tag: string) => {
      const existing = totalByKey.get(normalizePromptKey(tag));
      return Math.max(0, targetCount - (existing?.count ?? 0));
    },
    [totalByKey, targetCount],
  );

  const zhOf = useCallback(
    (tag: string) => lookupPromptTranslation(library.dictionary, tag) || "",
    [library.dictionary],
  );

  const filteredTotals = useMemo(() => {
    if (!totals) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return totals.tags.slice(0, 300);
    return totals.tags
      .filter((entry) => {
        if (entry.tag.toLowerCase().includes(needle)) return true;
        return zhOf(entry.tag).includes(query.trim());
      })
      .slice(0, 300);
  }, [totals, query, zhOf]);

  const orderedEntries = useMemo(() => {
    const rank = new Map(library.categories.map((category, index) => [category, index]));
    return [...library.entries].sort((a, b) => {
      const diff =
        (rank.get(a.category) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.category) ?? Number.MAX_SAFE_INTEGER);
      return diff || a.english.localeCompare(b.english, "en");
    });
  }, [library.entries, library.categories]);

  const libraryResults = useMemo(() => {
    const needle = libQuery.trim().toLowerCase();
    let list = orderedEntries;
    if (libCategory) list = list.filter((entry) => entry.category === libCategory);
    if (!needle) return list;
    const matches = list.filter(
      (entry) =>
        entry.english.toLowerCase().includes(needle) ||
        entry.chinese.includes(libQuery.trim()) ||
        entry.category.toLowerCase().includes(needle),
    );
    const rank = (entry: PromptLibraryEntry) => {
      const english = entry.english.toLowerCase();
      if (english === needle) return 0;
      if (english.startsWith(needle)) return 1;
      if (english.includes(needle)) return 2;
      return 3;
    };
    return matches.sort((a, b) => rank(a) - rank(b) || a.english.localeCompare(b.english, "en"));
  }, [orderedEntries, libQuery, libCategory]);

  const shownLibrary = libraryResults.slice(0, 240);

  const report = useCallback((text: string, scope: StatusScope, tone?: "danger") => {
    setStatus({ text, scope, tone });
  }, []);

  const runBulk = useCallback(
    async (
      action: BulkAction,
      options: { assetIds: string[]; from?: string; to?: string; tags?: string[] },
      scope: StatusScope,
    ) => {
      if (bulkBusyRef.current) return;
      bulkBusyRef.current = true;
      setBulkBusy(true);
      try {
        const flushed = await beforeBulk();
        if (!flushed) return;
        const result = await api.captionTagBulk({
          assetIds: options.assetIds,
          action,
          from: options.from ?? "",
          to: options.to ?? "",
          tags: options.tags ?? [],
        });
        if (result.changedAssets === 0) {
          report(action === "add" ? "已全部包含" : "没有可更新的图片", scope);
        } else {
          report(
            action === "add"
              ? `已添加至 ${result.changedAssets} 张`
              : action === "remove"
                ? `已删除 ${result.changedAssets} 张`
                : `已重命名 ${result.changedAssets} 张`,
            scope,
          );
        }
        setLocalRevision((value) => value + 1);
        onAfterBulk();
      } catch (error) {
        report(normalizeError(error).message, scope, "danger");
      } finally {
        bulkBusyRef.current = false;
        setBulkBusy(false);
      }
    },
    [beforeBulk, onAfterBulk, report],
  );

  const startDraft = () => {
    if (bulkBusyRef.current) return;
    if (draftOpen) {
      draftInputRef.current?.focus();
      return;
    }
    if (!totals || targetCount === 0) return;
    setQuery("");
    setEditingTag(null);
    editRef.current = null;
    setDraftOpen(true);
    setDraftValue("");
    draftRef.current = { value: "" };
    window.requestAnimationFrame(() => {
      draftRowRef.current?.scrollIntoView({ block: "nearest" });
      draftInputRef.current?.focus();
    });
  };

  const startEdit = (entry: TagTotalEntry) => {
    if (bulkBusyRef.current) return;
    setDraftOpen(false);
    draftRef.current = null;
    setDraftValue("");
    if (query && !filteredTotals.some((item) => item.tag === entry.tag)) setQuery("");
    setEditingTag(entry.tag);
    setEditValue(entry.tag);
    editRef.current = { tag: entry.tag, value: entry.tag };
  };

  const settleEdit = (commit: boolean) => {
    const current = editRef.current;
    editRef.current = null;
    setEditingTag(null);
    setEditValue("");
    if (!current || !commit) return;
    const next = current.value.trim();
    if (!next) {
      // 空文本不执行删除；删除只走编辑行里的显式按钮。
      report("标签不能为空，已保留原值", "stats");
      return;
    }
    if (next !== current.tag) {
      void runBulk("rename", { assetIds: selectedIds, from: current.tag, to: next }, "stats");
    }
  };

  const deleteEditing = (tag: string) => {
    editRef.current = null;
    setEditingTag(null);
    setEditValue("");
    void runBulk("remove", { assetIds: selectedIds, tags: [tag] }, "stats");
  };

  const settleDraft = (commit: boolean) => {
    const current = draftRef.current;
    draftRef.current = null;
    setDraftOpen(false);
    setDraftValue("");
    if (!current || !commit) return;
    const value = current.value.trim();
    if (!value) return;
    if (missingCount(value) === 0) {
      report("已全部包含", "stats");
      return;
    }
    void runBulk("add", { assetIds: selectedIds, tags: [value] }, "stats");
  };

  const addEntryToCurrent = useCallback(
    async (entry: PromptLibraryEntry) => {
      if (!currentId || currentBusy) return;
      setCurrentBusy(true);
      try {
        const result = await onAddToCurrent([entry.english]);
        if (result === "added") {
          report("已加入当前图片", "library");
          setLocalRevision((value) => value + 1);
        } else if (result === "exists") {
          report("当前图片已包含", "library");
        }
      } catch (error) {
        report(normalizeError(error).message, "library", "danger");
      } finally {
        setCurrentBusy(false);
      }
    },
    [currentBusy, currentId, onAddToCurrent, report],
  );

  const addEntryTo = (entry: PromptLibraryEntry, scope: "current" | "selection" | "all") => {
    setMenu(null);
    if (scope === "current") {
      void addEntryToCurrent(entry);
      return;
    }
    const assetIds = scope === "all" ? [] : selectedIds;
    if (scope === "selection" && assetIds.length === 0) return;
    void runBulk("add", { assetIds, tags: [entry.english] }, "library");
  };

  const openMenu = (entry: PromptLibraryEntry, rect: DOMRect) => {
    const width = 188;
    const height = 152;
    // 优先放在列表左侧，避免贴到屏幕右缘之外。
    let x = rect.left - width - 8;
    if (x < 8) x = Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8));
    const y = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8));
    setMenu({ entry, x, y });
  };

  // 点击菜单以外区域 / Esc / 滚动时关闭菜单。
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointer = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".tag-lib-menu")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(".tag-lib-menu button:not([disabled])")
        ?.focus();
    });
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  // 词库行：轻点弹出菜单，拖动则投放到画布（当前图片）或已选计数（批量）。
  useEffect(() => {
    const clearHover = () => {
      dropElRef.current?.classList.remove("tag-drop-hover");
      dropElRef.current = null;
    };
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
        drag.active = true;
        document.body.classList.add("tag-lib-dragging");
        setDragEntry(drag.entry);
      }
      setDragPos({ x: event.clientX, y: event.clientY });
      const element =
        document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-tag-drop]") ??
        null;
      if (element !== dropElRef.current) {
        clearHover();
        dropElRef.current = element;
        element?.classList.add("tag-drop-hover");
      }
      const kind =
        element?.dataset.tagDrop === "selection"
          ? "selection"
          : element?.dataset.tagDrop === "current"
            ? "current"
            : null;
      dropTargetRef.current = kind;
      setDropTarget(kind);
    };
    const finish = (cancelled: boolean) => {
      const drag = dragRef.current;
      dragRef.current = null;
      clearHover();
      document.body.classList.remove("tag-lib-dragging");
      setDragEntry(null);
      setDropTarget(null);
      const target = dropTargetRef.current;
      dropTargetRef.current = null;
      if (!drag) return;
      if (drag.active) {
        if (cancelled) return;
        if (target === "current") void addEntryToCurrent(drag.entry);
        else if (target === "selection" && selectedIds.length > 0) {
          void runBulk("add", { assetIds: selectedIds, tags: [drag.entry.english] }, "library");
        }
        return;
      }
      if (!cancelled) openMenu(drag.entry, drag.rect);
    };
    const up = () => finish(false);
    const cancel = () => finish(true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      clearHover();
      document.body.classList.remove("tag-lib-dragging");
    };
  }, [addEntryToCurrent, runBulk, selectedIds]);

  const beginDrag = (event: React.PointerEvent, entry: PromptLibraryEntry) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".tag-lib-menu")) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = {
      entry,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      rect,
    };
    dropTargetRef.current = null;
  };

  const scopeLabel = scoped ? `已选 ${selectedIds.length}` : `全部 ${targetCount.toLocaleString("zh-CN")}`;
  const libraryVisible = compact ? assistTab === "library" : libraryOpen;

  const statsSection = (
    <section className="wb-stats" aria-label="提示词统计">
      <div className="wb-stats-head">
        {!compact ? <span className="wb-assist-title">统计</span> : null}
        <span className="wb-scope">{scopeLabel}</span>
        <button
          type="button"
          className="wb-add"
          onClick={startDraft}
          disabled={!totals || targetCount === 0 || bulkBusy}
          title="在末尾添加提示词"
          aria-label="添加提示词"
        >
          <Icon name="plus" className="sm" />
        </button>
      </div>
      <div className="stat-filter">
        <Icon name="search" className="sm" />
        <input
          className="input"
          value={query}
          placeholder="筛选"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button type="button" className="stat-filter-clear" onClick={() => setQuery("")} title="清空筛选">
            <Icon name="x" className="sm" />
          </button>
        ) : null}
      </div>
      {loadError ? (
        <div className="wb-assist-notice">
          <Notice tone="danger" icon="alert">
            {loadError}
          </Notice>
        </div>
      ) : null}
      <div className="stat-list" ref={statsListRef} onScroll={() => setMenu(null)}>
        {!totals ? (
          loading ? (
            <div className="wb-assist-empty">
              <Spinner />
            </div>
          ) : null
        ) : totals.tags.length === 0 ? (
          <div className="wb-assist-empty">暂无短语</div>
        ) : filteredTotals.length === 0 && !draftOpen ? (
          <div className="wb-assist-empty">没有匹配项</div>
        ) : (
          filteredTotals.map((entry) => {
            const zh = zhOf(entry.tag);
            if (editingTag === entry.tag) {
              return (
                <div className="stat-row editing" key={entry.tag}>
                  <input
                    className="stat-input"
                    autoFocus
                    value={editValue}
                    spellCheck={false}
                    onChange={(event) => {
                      setEditValue(event.target.value);
                      if (editRef.current) editRef.current.value = event.target.value;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        settleEdit(true);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        settleEdit(false);
                      }
                    }}
                    onBlur={() => settleEdit(true)}
                  />
                  <span className="tiny faint stat-edit-scope" title="仅修改包含此提示词的图片">
                    {entry.count} 张含此词
                  </span>
                  <button
                    type="button"
                    className="stat-delete"
                    title={`从 ${scopeLabel} 删除「${entry.tag}」`}
                    aria-label={`删除标签 ${entry.tag}`}
                    disabled={bulkBusy}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => deleteEditing(entry.tag)}
                  >
                    <Icon name="trash" className="sm" />
                  </button>
                </div>
              );
            }
            return (
              <div className="stat-row" key={entry.tag}>
                <button
                  type="button"
                  className="stat-name"
                  onClick={() => startEdit(entry)}
                  title={`编辑 ${entry.tag}`}
                  disabled={bulkBusy}
                >
                  <span className="stat-en">{entry.tag}</span>
                  {zh ? <span className="stat-zh">{zh}</span> : null}
                </button>
                <span className="stat-count" title="包含该提示词的图片数">
                  {entry.count}
                </span>
                <button
                  type="button"
                  className="stat-edit"
                  onClick={() => startEdit(entry)}
                  title="编辑标签"
                  aria-label={`编辑 ${entry.tag}`}
                  disabled={bulkBusy}
                >
                  <Icon name="edit" className="sm" />
                </button>
              </div>
            );
          })
        )}
        {draftOpen ? (
          <div className="stat-row editing" ref={draftRowRef}>
            <input
              ref={draftInputRef}
              className="stat-input"
              autoFocus
              placeholder="新提示词"
              value={draftValue}
              spellCheck={false}
              onChange={(event) => {
                setDraftValue(event.target.value);
                if (draftRef.current) draftRef.current.value = event.target.value;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  settleDraft(true);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  settleDraft(false);
                }
              }}
              onBlur={() => settleDraft(true)}
            />
          </div>
        ) : null}
      </div>
      <div className="wb-assist-foot">
        <span>
          {loading
            ? "统计中"
            : totals
              ? filteredTotals.length < totals.tags.length
                ? `${filteredTotals.length}/${totals.tags.length.toLocaleString("zh-CN")}${totals.truncated ? "+" : ""} 条`
                : `${totals.tags.length.toLocaleString("zh-CN")}${totals.truncated ? "+" : ""} 条`
              : "—"}
        </span>
        {status?.scope === "stats" || (status?.scope === "library" && !libraryVisible) ? (
          <span
            className={classNames("wb-status", status.tone === "danger" && "danger")}
            title={status.text}
          >
            {status.text}
          </span>
        ) : null}
      </div>
    </section>
  );

  const librarySection = (
    <section className="wb-library-col" aria-label="提示词库">
      {!compact ? (
        <button
          type="button"
          className="wb-lib-head"
          onClick={() => setLibraryOpen((value) => !value)}
          aria-expanded={libraryOpen}
          title="收起词库"
        >
          <Icon name="library" className="sm" />
          <span className="wb-lib-title">提示词库</span>
          <span className="wb-lib-count">{library.entries.length.toLocaleString("zh-CN")}</span>
        </button>
      ) : null}
      <div className="wb-lib-tools">
        <div className="search-box wb-lib-search">
          <Icon name="search" className="sm" />
          <input
            className="input"
            value={libQuery}
            placeholder="搜索"
            onChange={(event) => setLibQuery(event.target.value)}
          />
          {libQuery ? (
            <button type="button" className="wb-lib-clear" onClick={() => setLibQuery("")} title="清空">
              <Icon name="x" className="sm" />
            </button>
          ) : null}
        </div>
        <Select
          className="wb-lib-cat"
          value={libCategory}
          onChange={setLibCategory}
          ariaLabel="按分类筛选"
          options={[
            { value: "", label: "全部" },
            ...library.categories.map((category) => ({ value: category, label: category })),
          ]}
        />
      </div>
      <div className="wb-lib-list" ref={libListRef} onScroll={() => setMenu(null)}>
        {shownLibrary.length === 0 ? (
          <div className="wb-assist-empty">
            {library.entries.length === 0 ? "词库为空" : "没有匹配项"}
          </div>
        ) : (
          shownLibrary.map((entry) => {
            const existing = totalByKey.get(normalizePromptKey(entry.english));
            const full = targetCount > 0 && (existing?.count ?? 0) >= targetCount;
            return (
              <div
                className="lib-row"
                key={entry.key}
                role="button"
                tabIndex={0}
                aria-label={`${entry.english} ${entry.chinese}`}
                title={`${entry.english} · ${entry.chinese} · ${entry.category}`}
                onPointerDown={(event) => beginDrag(event, entry)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openMenu(entry, rect);
                  }
                }}
              >
                <span className="lib-en">{entry.english}</span>
                <span className="lib-zh">{entry.chinese}</span>
                {existing ? (
                  <span className={classNames("lib-count", full && "full")}>
                    {full ? "✓" : existing.count}
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      <div className="wb-assist-foot">
        <span>
          {shownLibrary.length < libraryResults.length
            ? `${shownLibrary.length}/${libraryResults.length.toLocaleString("zh-CN")} 条`
            : `${libraryResults.length.toLocaleString("zh-CN")} 条`}
        </span>
        {status?.scope === "library" && libraryVisible ? (
          <span
            className={classNames("wb-status", status.tone === "danger" && "danger")}
            title={status.text}
          >
            {status.text}
          </span>
        ) : null}
      </div>
    </section>
  );

  return (
    <>
      {compact ? (
        <div className="wb-assist compact">
          <div className="wb-assist-tabs" role="tablist" aria-label="打标辅助">
            <button
              type="button"
              role="tab"
              aria-selected={assistTab === "stats"}
              className={assistTab === "stats" ? "active" : ""}
              onClick={() => setAssistTab("stats")}
            >
              统计
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={assistTab === "library"}
              className={assistTab === "library" ? "active" : ""}
              onClick={() => setAssistTab("library")}
            >
              词库
            </button>
          </div>
          {assistTab === "stats" ? statsSection : librarySection}
        </div>
      ) : (
        <div className="wb-assist">
          {statsSection}
          <div className={classNames("wb-library-shell", !libraryOpen && "closed")}>
            {libraryOpen ? (
              librarySection
            ) : (
              <button
                type="button"
                className="wb-library-rail"
                onClick={() => setLibraryOpen(true)}
                title="展开提示词库"
                aria-label="展开提示词库"
              >
                <Icon name="library" className="sm" />
                <span>词库</span>
              </button>
            )}
          </div>
        </div>
      )}

      {menu ? (
        <div
          className="tag-lib-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="tag-lib-menu-head">
            <span className="en">{menu.entry.english}</span>
            <span className="zh">{menu.entry.chinese}</span>
            <span className="cat">{menu.entry.category}</span>
          </div>
          <button
            type="button"
            disabled={!currentId}
            onClick={() => addEntryTo(menu.entry, "current")}
          >
            添加至当前图片
          </button>
          <button
            type="button"
            disabled={!scoped}
            onClick={() => addEntryTo(menu.entry, "selection")}
          >
            添加至选中图片{scoped ? ` · ${selectedIds.length}` : ""}
          </button>
          <button
            type="button"
            disabled={targetCount === 0}
            onClick={() => addEntryTo(menu.entry, "all")}
          >
            添加至所有图片
          </button>
        </div>
      ) : null}

      {dragEntry ? (
        <div className="tag-lib-ghost" style={{ left: dragPos.x + 12, top: dragPos.y + 12 }}>
          <span>{dragEntry.english}</span>
          {dropTarget === "current" ? <em>当前图片</em> : null}
          {dropTarget === "selection" ? <em>选中 {selectedIds.length} 张</em> : null}
        </div>
      ) : null}
    </>
  );
}
