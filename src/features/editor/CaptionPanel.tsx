import { useEffect, useMemo, useRef, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { CaptionMode, ModelInfo, PromptLibraryEntry } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { S } from "../../lib/strings";
import { classNames, normalizeKey, normalizeTagList, splitCaption } from "../../lib/utils";
import {
  invalidatePromptLibrary,
  loadPromptLibrary,
  lookupPromptCategory,
  lookupPromptTranslation,
  normalizePromptKey,
  PROMPT_LIBRARY_UPDATED_EVENT,
  type PromptLibrary,
} from "../../lib/promptDictionary";
import { Icon } from "../../components/Icon";
import { modelKindLabel } from "../../lib/modelDescriptions";
import { Dropdown, MenuItem, MenuLabel, Notice, Segmented, Select, Spinner } from "../../components/ui";

export type CaptionSaveState = "idle" | "saving" | "saved" | "error" | "dirty";
type PhraseView = "sort" | "group";

interface Props {
  assetId: string;
  mode: CaptionMode;
  tags: string[];
  text: string;
  finalText: string;
  stats: { charCount: number; tagCount: number; tokenEstimate: number | null; tokenizerNote: string };
  saveState: CaptionSaveState;
  triggerWord: string;
  triggerDisabled: boolean;
  aiModels: ModelInfo[];
  aiModelIds: string[];
  aiModelsLoading: boolean;
  aiBusy: boolean;
  aiNote: string | null;
  underscoreTargets: number;
  underscoreBusy: boolean;
  onExpandUnderscores: (keepOriginal: boolean) => void;
  onAiModelsChange: (value: string[]) => void;
  onAiTag: () => void;
  onChange: (patch: { mode?: CaptionMode; tags?: string[]; text?: string }) => void;
  onToggleTrigger: (disabled: boolean) => void;
  onSaveNow: () => void;
}

/**
 * 短语标签与自然语言描述始终并列显示：
 * 短语写入 tags，自然语言写入 text，导出时合并为同一段标注。
 */
export function CaptionPanel({
  assetId,
  tags,
  text,
  finalText,
  stats,
  saveState,
  triggerWord,
  triggerDisabled,
  aiModels,
  aiModelIds,
  aiModelsLoading,
  aiBusy,
  aiNote,
  underscoreTargets,
  underscoreBusy,
  onExpandUnderscores,
  onAiModelsChange,
  onAiTag,
  onChange,
  onToggleTrigger,
  onSaveNow,
}: Props) {
  const { project, notify } = useProject();
  const [tagInput, setTagInput] = useState("");
  const [selectedTag, setSelectedTag] = useState(-1);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [completionIndex, setCompletionIndex] = useState(-1);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [library, setLibrary] = useState<PromptLibrary>({
    entries: [],
    dictionary: new Map(),
    categoryOf: new Map(),
    categories: [],
  });
  const [phraseView, setPhraseView] = useState<PhraseView>(() => {
    try {
      return localStorage.getItem("yoyoku.caption-view") === "group" ? "group" : "sort";
    } catch {
      return "sort";
    }
  });
  const [tagOrder, setTagOrder] = useState<string[]>(tags);
  const [disabledTags, setDisabledTags] = useState<string[]>([]);
  const [tagStateLoaded, setTagStateLoaded] = useState(false);
  const [dragTag, setDragTag] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ tag: string; after: boolean } | null>(null);
  const dragStateRef = useRef<{ tag: string; startX: number; startY: number; active: boolean } | null>(null);
  const dropTargetRef = useRef<{ tag: string; after: boolean } | null>(null);
  const [machineTranslations, setMachineTranslations] = useState<Record<string, string>>({});
  const [translating, setTranslating] = useState(false);
  const [translateInput, setTranslateInput] = useState("");
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateResult, setTranslateResult] = useState<{ source: string; text: string; to: "zh" | "en" } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tagsRef = useRef(tags);
  const tagOrderRef = useRef(tagOrder);
  const disabledRef = useRef(disabledTags);
  const stateLoadedRef = useRef(false);
  tagsRef.current = tags;
  tagOrderRef.current = tagOrder;
  disabledRef.current = disabledTags;

  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      invalidatePromptLibrary();
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
    setSelectedTag(-1);
    setTagInput("");
    setCompletionOpen(false);
    setCompletionIndex(-1);
    setTranslateResult(null);
    setDragTag(null);
    setDropTarget(null);
    dragStateRef.current = null;
    dropTargetRef.current = null;
    setTagStateLoaded(false);
    stateLoadedRef.current = false;
    const currentTags = tagsRef.current;
    setTagOrder(currentTags);
    setDisabledTags([]);
    let cancelled = false;
    api
      .captionTagStateGet(assetId)
      .then((state) => {
        if (cancelled) return;
        const enabled = new Set(tagsRef.current);
        const disabled = state.disabled.filter((tag) => !enabled.has(tag));
        const allowed = new Set([...tagsRef.current, ...disabled]);
        const order = state.order.filter((tag) => allowed.has(tag));
        for (const tag of tagsRef.current) if (!order.includes(tag)) order.push(tag);
        for (const tag of disabled) if (!order.includes(tag)) order.push(tag);
        setTagOrder(order);
        setDisabledTags(disabled);
        stateLoadedRef.current = true;
        setTagStateLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        stateLoadedRef.current = true;
        setTagStateLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  // 外部新增标签（AI 打标、批量打标、撤销）后，把新标签并入完整顺序。
  useEffect(() => {
    setTagOrder((current) => {
      const enabled = new Set(tags);
      const allowed = new Set([...tags, ...disabledRef.current]);
      const next = current.filter((tag) => allowed.has(tag));
      let changed = next.length !== current.length;
      for (const tag of tags) {
        if (!next.includes(tag)) {
          next.push(tag);
          changed = true;
        }
      }
      if (next.some((tag) => !enabled.has(tag) && !disabledRef.current.includes(tag))) changed = true;
      return changed ? next : current;
    });
    setDisabledTags((current) => {
      const next = current.filter((tag) => !tags.includes(tag));
      return next.length === current.length ? current : next;
    });
  }, [tags]);

  const persistTagState = (order: string[], disabled: string[]) => {
    if (!stateLoadedRef.current) return;
    void api.captionTagStateSet(assetId, { order, disabled }).catch(() => undefined);
  };

  // 指针拖拽排序：全局监听比 HTML5 drag 或芯片内 pointermove 更可靠，
  // 快速划过其他芯片、触控和自动化输入都能持续收到移动事件。
  useEffect(() => {
    const clear = () => {
      dragStateRef.current = null;
      dropTargetRef.current = null;
      setDragTag(null);
      setDropTarget(null);
    };
    const move = (event: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      if (!state.active) {
        if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 4) return;
        state.active = true;
        setDragTag(state.tag);
      }
      const element = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-tag]");
      const targetTag = element?.dataset.tag;
      if (!targetTag || targetTag === state.tag) {
        if (dropTargetRef.current) {
          dropTargetRef.current = null;
          setDropTarget(null);
        }
        return;
      }
      const rect = element!.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      if (
        dropTargetRef.current?.tag !== targetTag ||
        dropTargetRef.current.after !== after
      ) {
        dropTargetRef.current = { tag: targetTag, after };
        setDropTarget({ tag: targetTag, after });
      }
    };
    const up = () => {
      const state = dragStateRef.current;
      dragStateRef.current = null;
      if (!state?.active) return;
      const target = dropTargetRef.current;
      dropTargetRef.current = null;
      setDragTag(null);
      setDropTarget(null);
      if (!target || target.tag === state.tag) return;
      const fromIndex = tags.indexOf(state.tag);
      const targetIndex = tags.indexOf(target.tag);
      if (fromIndex < 0 || targetIndex < 0) return;
      let insertion = targetIndex + (target.after ? 1 : 0);
      if (fromIndex < insertion) insertion -= 1;
      reorderTag(fromIndex, insertion);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("blur", clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags]);

  const changePhraseView = (next: PhraseView) => {
    setPhraseView(next);
    dragStateRef.current = null;
    dropTargetRef.current = null;
    setDragTag(null);
    setDropTarget(null);
    try {
      localStorage.setItem("yoyoku.caption-view", next);
    } catch {
      // ignore
    }
  };

  const addTags = (values: string[]) => {
    if (values.length === 0) return;
    onChange({ tags: normalizeTagList([...tags, ...values]) });
  };

  const triggerKey = normalizeKey(triggerWord);

  const looksLikeSentence = (value: string) =>
    value.trim().split(/\s+/).length > 8 || /[.!?。！？]/.test(value);

  const removeTagValue = (tag: string) => {
    const nextOrder = tagOrderRef.current.filter((item) => item !== tag);
    const nextDisabled = disabledRef.current.filter((item) => item !== tag);
    setTagOrder(nextOrder);
    setDisabledTags(nextDisabled);
    persistTagState(nextOrder, nextDisabled);
    if (tags.includes(tag)) onChange({ tags: tags.filter((item) => item !== tag) });
    setSelectedTag(-1);
  };

  const removeTag = (index: number) => removeTagValue(tags[index]);

  const removePhrase = (index: number) => {
    if (index >= tags.length) onChange({ text: "" });
    else removeTag(index);
    setSelectedTag(-1);
  };

  // 排序视图里的拖拽只在已启用标签之间调整文件顺序；停用项不写入文件。
  const applyTagOrder = (nextTags: string[]) => {
    const base = tagOrderRef.current.length > 0 ? tagOrderRef.current : tags;
    const enabled = new Set(nextTags);
    let cursor = 0;
    const nextOrder = base.map((tag) => (enabled.has(tag) ? nextTags[cursor++] ?? tag : tag));
    for (const tag of nextTags) if (!nextOrder.includes(tag)) nextOrder.push(tag);
    const nextDisabled = disabledRef.current.filter((tag) => !enabled.has(tag));
    setTagOrder(nextOrder);
    setDisabledTags(nextDisabled);
    persistTagState(nextOrder, nextDisabled);
    onChange({ tags: nextTags });
  };

  const moveSelected = (direction: -1 | 1) => {
    if (tags.length === 0) return;
    const index = selectedTag >= 0 ? selectedTag : tags.length - 1;
    if (index >= tags.length) return;
    const target = index + direction;
    if (target < 0 || target >= tags.length) return;
    const next = [...tags];
    [next[index], next[target]] = [next[target], next[index]];
    applyTagOrder(next);
    setSelectedTag(target);
  };

  const reorderTag = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= tags.length) return;
    const next = [...tags];
    const [moved] = next.splice(fromIndex, 1);
    const insertion = Math.max(0, Math.min(next.length, toIndex));
    next.splice(insertion, 0, moved);
    applyTagOrder(next);
    setSelectedTag(insertion);
  };

  const enableTags = (values: string[]) => {
    const names = new Set(values);
    const current = new Set(tags);
    const base = tagOrderRef.current;
    const orderedExisting = base.filter((tag) => current.has(tag));
    // 完整顺序与当前文件顺序一致时，按原位置恢复；否则只追加，
    // 避免分组视图的状态覆盖用户手工排好的顺序。
    const sameOrder = orderedExisting.join("\u0000") === tags.join("\u0000");
    let nextTags: string[];
    if (sameOrder) {
      nextTags = base.filter((tag) => current.has(tag) || names.has(tag));
      for (const tag of tags) if (!nextTags.includes(tag)) nextTags.push(tag);
    } else {
      nextTags = [...tags];
      for (const tag of values) if (!nextTags.includes(tag)) nextTags.push(tag);
    }
    const nextDisabled = disabledRef.current.filter((tag) => !names.has(tag));
    setDisabledTags(nextDisabled);
    persistTagState(base, nextDisabled);
    onChange({ tags: nextTags });
  };

  const setGroupEnabled = (groupTags: string[], enabled: boolean) => {
    if (enabled) {
      enableTags(groupTags);
      return;
    }
    const names = new Set(groupTags);
    const nextDisabled = Array.from(new Set([...disabledRef.current, ...groupTags]));
    setDisabledTags(nextDisabled);
    persistTagState(tagOrderRef.current, nextDisabled);
    onChange({ tags: tags.filter((tag) => !names.has(tag)) });
  };

  const categoryRank = useMemo(() => {
    const rank = new Map<string, number>();
    library.categories.forEach((category, index) => rank.set(category, index));
    return rank;
  }, [library.categories]);

  const rankOfTag = (tag: string) => {
    const category = lookupPromptCategory(library, tag);
    return categoryRank.get(category) ?? (category === "未分类" ? 10_000 : 9_999);
  };

  const sortTagsByGroup = () => {
    if (tags.length === 0) {
      notify({ message: "当前没有可排序的短语" });
      return;
    }
    const indexed = tags.map((tag, index) => ({ tag, index }));
    indexed.sort((a, b) => rankOfTag(a.tag) - rankOfTag(b.tag) || a.index - b.index);
    const nextTags = indexed.map((item) => item.tag);
    const base = tagOrderRef.current.length > 0 ? tagOrderRef.current : tags;
    const baseIndex = new Map(base.map((tag, index) => [tag, index]));
    const nextOrder = [...base].sort(
      (a, b) =>
        rankOfTag(a) - rankOfTag(b) ||
        (baseIndex.get(a) ?? 0) - (baseIndex.get(b) ?? 0),
    );
    setTagOrder(nextOrder);
    persistTagState(nextOrder, disabledRef.current);
    onChange({ tags: nextTags });
    notify({
      tone: "success",
      message: `已按提示词分类重排 ${nextTags.length} 条短语`,
    });
  };

  const parseInput = (value: string): string[] => {
    // 自然语言句子保持为一条短语；短标签仍支持逗号批量输入。
    const parts = splitCaption(value);
    const sentenceLike =
      /[.!?。！？]/.test(value) ||
      value.trim().split(/\s+/).length > 8 ||
      parts.some((part) => part.split(/\s+/).length > 4) ||
      (/[㐀-鿿]/.test(value) && /[,，]/.test(value));
    return sentenceLike ? [value.trim()].filter(Boolean) : parts;
  };

  const commitInput = () => {
    const values = parseInput(tagInput);
    if (values.length > 0) addTags(values);
    setTagInput("");
  };

  const saveLabel =
    saveState === "saving"
      ? S.common.saving
      : saveState === "error"
        ? S.common.saveFailed
        : saveState === "dirty"
          ? S.caption.unsaved
          : S.common.saved;

  // 自然语言描述也作为一条短语显示，与标签一起翻译。
  const phrases = useMemo(
    () => [...tags, ...(text.trim() ? [text.trim()] : [])],
    [tags, text],
  );

  const dictionary = library.dictionary;

  const phraseGroups = useMemo(() => {
    const enabled = new Set(tags);
    const disabled = new Set(disabledTags);
    const groups = new Map<string, { tag: string; disabled: boolean }[]>();
    const seen = new Set<string>();
    const push = (tag: string) => {
      if (!tag || seen.has(tag)) return;
      const isDisabled = disabled.has(tag);
      if (!enabled.has(tag) && !isDisabled) return;
      seen.add(tag);
      const category = lookupPromptCategory(library, tag);
      const items = groups.get(category) ?? [];
      items.push({ tag, disabled: isDisabled });
      groups.set(category, items);
    };
    const base = tagOrder.length > 0 ? tagOrder : tags;
    for (const tag of base) push(tag);
    for (const tag of tags) push(tag);
    for (const tag of disabledTags) push(tag);
    return Array.from(groups.entries())
      .sort(
        (a, b) =>
          rankOfTag(a[0]) - rankOfTag(b[0]) || a[0].localeCompare(b[0], "zh-CN"),
      )
      .map(([category, items]) => ({
        category,
        items,
        enabledCount: items.filter((item) => !item.disabled).length,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagOrder, tags, disabledTags, library, categoryRank]);

  const completionQuery = tagInput.trim();
  const completions = useMemo<PromptLibraryEntry[]>(() => {
    if (!completionQuery) return [];
    const query = normalizePromptKey(completionQuery);
    const existing = new Set(
      [...phrases, ...disabledTags].map((phrase) => normalizePromptKey(phrase)),
    );
    const scored: { entry: PromptLibraryEntry; score: number }[] = [];
    for (const entry of library.entries) {
      if (categoryFilter && entry.category !== categoryFilter) continue;
      const key = normalizePromptKey(entry.english);
      if (!key || existing.has(key)) continue;
      let score = -1;
      if (key === query) score = 0;
      else if (key.startsWith(query)) score = 1;
      else if (key.includes(query)) score = 2;
      else if (entry.chinese.includes(completionQuery)) score = 3;
      if (score >= 0) scored.push({ entry, score });
    }
    scored.sort(
      (a, b) =>
        a.score - b.score ||
        a.entry.english.length - b.entry.english.length ||
        a.entry.english.localeCompare(b.entry.english),
    );
    return scored.slice(0, 10).map((item) => item.entry);
  }, [completionQuery, categoryFilter, library.entries, phrases, disabledTags]);

  useEffect(() => {
    setCompletionIndex(-1);
  }, [completionQuery, categoryFilter]);

  const applyCompletion = (entry: PromptLibraryEntry, add: boolean) => {
    setTagInput(add ? "" : entry.english);
    setCompletionOpen(false);
    setCompletionIndex(-1);
    if (add) addTags([entry.english]);
    inputRef.current?.focus();
  };

  useEffect(() => {
    const missing = phrases.filter(
      (phrase) =>
        /[A-Za-z]/.test(phrase) && !/[㐀-鿿]/.test(phrase) && !tagTranslation(phrase),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .translationCacheGet(missing.slice(0, 200), "zh")
        .then((items) => {
          if (cancelled || items.length === 0) return;
          setMachineTranslations((current) => {
            const next = { ...current };
            for (const item of items) {
              if (item.translated) next[normalizePromptKey(item.source)] = item.translated;
            }
            return next;
          });
        })
        .catch(() => undefined);
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phrases, dictionary]);

  const tagTranslation = (tag: string): string =>
    lookupPromptTranslation(dictionary, tag) || machineTranslations[normalizePromptKey(tag)] || "";

  const translatableTokens = useMemo(() => {
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const raw of phrases) {
      const token = raw.trim();
      if (!token || seen.has(token) || tagTranslation(token)) continue;
      if (!/[A-Za-z]/.test(token) || /[㐀-鿿]/.test(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
    return tokens;
  }, [phrases, dictionary, machineTranslations]);

  const translateTags = async () => {
    if (translatableTokens.length === 0) {
      notify({ message: "没有可翻译的短语" });
      return;
    }
    setTranslating(true);
    try {
      const result = await api.translateTexts(translatableTokens, "zh");
      setMachineTranslations((current) => {
        const next = { ...current };
        translatableTokens.forEach((tag, index) => {
          const translation = result.translations[index];
          if (translation) next[normalizePromptKey(tag)] = translation;
        });
        return next;
      });
      notify({
        tone: "success",
        message: `已翻译 ${Math.min(result.translations.length, translatableTokens.length)} 条短语`,
      });
    } catch (error) {
      notify({ tone: "danger", title: "短语翻译失败", message: normalizeError(error).message });
    } finally {
      setTranslating(false);
    }
  };

  const translatePrompt = async () => {
    const source = translateInput.trim();
    if (!source || translateBusy) return;
    const to: "zh" | "en" = /[㐀-鿿]/.test(source) ? "en" : "zh";
    setTranslateBusy(true);
    try {
      const result = await api.translateTexts([source], to);
      setTranslateResult({ source, text: result.translations[0] || "", to });
    } catch (error) {
      notify({ tone: "danger", title: "提示词翻译失败", message: normalizeError(error).message });
    } finally {
      setTranslateBusy(false);
    }
  };

  const canExpandUnderscores = underscoreTargets > 0 || tags.some((tag) => /[^_]_+[^_]/.test(tag));

  const addTranslatedPrompt = () => {
    if (!translateResult?.text || translateResult.to !== "en") return;
    addTags([translateResult.text]);
    notify({ tone: "success", message: "已加入标注内容" });
    setTranslateInput("");
    setTranslateResult(null);
  };

  const renderTagChip = (tag: string, index: number, disabled = false) => {
    const selected = !disabled && index >= 0 && selectedTag === index;
    const isTrigger = !disabled && triggerKey && normalizeKey(tag) === triggerKey;
    const dropped = dropTarget?.tag === tag;
    return (
      <span
        key={`${tag}-${disabled ? "off" : "on"}`}
        data-tag={tag}
        data-tag-index={index}
        className={classNames(
          "tag",
          looksLikeSentence(tag) && "sentence",
          selected && "selected",
          isTrigger && "trigger",
          disabled && "disabled",
          !disabled && phraseView === "sort" && "sortable",
          dragTag === tag && "dragging",
          dropped && dropTarget?.after && "drop-after",
          dropped && !dropTarget?.after && "drop-before",
        )}
        onPointerDown={(event) => {
          if (disabled || phraseView !== "sort" || event.button !== 0) return;
          if ((event.target as HTMLElement).closest(".tag-remove")) return;
          dragStateRef.current = {
            tag,
            startX: event.clientX,
            startY: event.clientY,
            active: false,
          };
        }}
        onClick={() => {
          if (disabled) enableTags([tag]);
          else setSelectedTag(index);
        }}
        title={
          disabled
            ? "已停用，不写入标注文件；点击启用"
            : phraseView === "sort"
              ? "拖动调整顺序；点击选中；Backspace 删除，Alt + 左右方向键移动"
              : "点击选中；停用后不写入标注文件"
        }
      >
        {!disabled && phraseView === "sort" ? <Icon name="move" className="sm tag-drag-handle" /> : null}
        <span className="tag-text">
          <span>{tag}</span>
          {tagTranslation(tag) ? <span className="tag-zh">{tagTranslation(tag)}</span> : null}
          {disabled ? <span className="tag-state">已停用</span> : null}
        </span>
        <button
          type="button"
          className="tag-remove"
          aria-label={`移除 ${tag}`}
          onClick={(event) => {
            event.stopPropagation();
            removeTagValue(tag);
          }}
        >
          <Icon name="x" className="sm" />
        </button>
      </span>
    );
  };

  const renderDescriptionChip = () => {
    if (!text.trim()) return null;
    const index = tags.length;
    return (
      <span
        key="__description"
        className={classNames(
          "tag",
          "sentence",
          selectedTag === index && "selected",
        )}
        onClick={() => setSelectedTag(index)}
        title="自然语言描述会作为一条短语参与翻译与导出"
      >
        <span className="tag-text">
          <span>{text.trim()}</span>
          {tagTranslation(text.trim()) ? <span className="tag-zh">{tagTranslation(text.trim())}</span> : null}
        </span>
        <button
          type="button"
          className="tag-remove"
          aria-label="移除自然语言描述"
          onClick={(event) => {
            event.stopPropagation();
            onChange({ text: "" });
            setSelectedTag(-1);
          }}
        >
          <Icon name="x" className="sm" />
        </button>
      </span>
    );
  };

  const selectedAiModels = aiModels.filter((item) => aiModelIds.includes(item.id));
  const aiModelSummary = aiModelsLoading
    ? "正在读取模型…"
    : aiModels.length === 0
      ? "未找到模型"
      : selectedAiModels.length === 0
        ? "选择模型"
        : selectedAiModels.length === 1
          ? selectedAiModels[0].name
          : `${selectedAiModels.length} 个模型 · 并集`;
  const aiModelTitle = selectedAiModels.length
    ? selectedAiModels.map((item) => item.name).join(" + ")
    : "选择 AI 打标模型（可多选，结果取并集）";

  return (
    <div className="caption-editor">
      <div className="form-block" style={{ borderBottom: "none", paddingBottom: 0 }}>
        <div className="form-block-head">
          <Icon name="tag" className="sm" />
          <h4>标注内容</h4>
          <div className="spacer" />
          <span className={classNames("save-state", saveState === "error" && "error", saveState === "saved" && "saved")}>
            {saveState === "saving" ? <Spinner /> : <Icon name={saveState === "error" ? "alert" : "check"} className="sm" />}
            {saveLabel}
          </span>
          <button type="button" className="btn ghost sm" onClick={onSaveNow} disabled={saveState === "saving"}>
            {S.caption.saveNow}
          </button>
        </div>
        {triggerWord ? (
          <p className="hint" style={{ marginTop: 6 }}>
            导出触发词 · {triggerWord}
          </p>
        ) : null}
        <div className="caption-ai-row">
          <span className="caption-ai-label">
            <Icon name="sparkles" className="sm" />
            AI 打标
          </span>
          <div className="caption-ai-model-picker">
            <Dropdown
              width={320}
              align="start"
              renderTrigger={(toggle, open) => (
                <button
                  type="button"
                  className="btn subtle sm caption-ai-model-trigger"
                  onClick={toggle}
                  disabled={aiBusy || aiModelsLoading || aiModels.length === 0}
                  title={aiModelTitle}
                  aria-label="AI 打标模型（可多选，结果取并集）"
                  aria-haspopup="menu"
                  aria-expanded={open}
                >
                  <span className="caption-ai-model-text">{aiModelSummary}</span>
                  <Icon name="chevron-down" className="sm" />
                </button>
              )}
            >
            {(close) => (
              <>
                <MenuLabel>AI 打标模型（可多选，结果取并集）</MenuLabel>
                <div className="caption-ai-model-options">
                  {aiModels.map((item) => {
                    const checked = aiModelIds.includes(item.id);
                    return (
                      <label
                        key={item.id}
                        className={classNames(
                          "caption-ai-model-option",
                          checked && "selected",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            onAiModelsChange(
                              checked
                                ? aiModelIds.filter((id) => id !== item.id)
                                : [...aiModelIds, item.id],
                            )
                          }
                        />
                        <span className="grow">
                          <span className="caption-ai-model-option-name">{item.name}</span>
                          <span className="caption-ai-model-option-meta">
                            {modelKindLabel(item)} · {item.version}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="caption-ai-model-foot">
                  <span className="hint">已选 {selectedAiModels.length} 个</span>
                  <button type="button" className="btn ghost sm" onClick={close}>
                    完成
                  </button>
                </div>
              </>
            )}
            </Dropdown>
          </div>
          <button
            type="button"
            className="btn secondary sm"
            onClick={onAiTag}
            disabled={aiBusy || aiModelsLoading || selectedAiModels.length === 0 || aiModels.length === 0}
            title={
              selectedAiModels.length > 1
                ? `依次运行 ${selectedAiModels.length} 个模型并合并标签并集，重复项自动剔除`
                : "用所选模型为当前图片补充短语，重复项自动剔除"
            }
          >
            {aiBusy ? <Spinner /> : null}
            {aiBusy ? "打标中" : "补充短语"}
          </button>
        </div>
        {aiNote ? (
          <div className="caption-ai-note">
            <Icon name="check" className="sm" />
            {aiNote}
          </div>
        ) : null}
      </div>

      <section className="caption-field">
        <div className="caption-field-head">
          <span className="caption-field-title">短语</span>
          <div className="row" style={{ gap: 8 }}>
            <Select
              className="phrase-category-select"
              value={categoryFilter}
              onChange={setCategoryFilter}
              ariaLabel="按提示词库主分类筛选补全建议"
              title="按提示词库主分类筛选补全建议"
              options={[
                { value: "", label: "全部分类" },
                ...library.categories.map((category) => ({ value: category, label: category })),
              ]}
            />
            <span className="caption-stats">
              {phrases.length} 条
              {disabledTags.length > 0 ? ` · ${disabledTags.length} 停用` : ""}
            </span>
          </div>
        </div>
        <div className="phrase-add-wrap">
          <div className="phrase-add-row">
            <input
              ref={inputRef}
              className="input phrase-add-input"
              value={tagInput}
              placeholder="手动添加提示词或自然语言句子，按 Enter 添加"
              onChange={(event) => {
                setTagInput(event.target.value);
                setCompletionOpen(true);
                setCompletionIndex(-1);
              }}
              onFocus={() => {
                if (tagInput.trim()) setCompletionOpen(true);
              }}
              onBlur={() => {
                window.setTimeout(() => setCompletionOpen(false), 120);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if ((event.key === "ArrowDown" || event.key === "ArrowUp") && completions.length > 0) {
                  event.preventDefault();
                  setCompletionOpen(true);
                  setCompletionIndex((current) => {
                    if (event.key === "ArrowDown") return current < 0 ? 0 : (current + 1) % completions.length;
                    return current <= 0 ? completions.length - 1 : current - 1;
                  });
                  return;
                }
                if (event.key === "Tab" && completions.length > 0) {
                  event.preventDefault();
                  const entry = completions[completionIndex >= 0 ? completionIndex : 0];
                  if (entry) applyCompletion(entry, false);
                  return;
                }
                if (event.key === "Escape") {
                  setCompletionOpen(false);
                  setCompletionIndex(-1);
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (completionOpen && completionIndex >= 0 && completions[completionIndex]) {
                    applyCompletion(completions[completionIndex], true);
                  } else {
                    commitInput();
                  }
                  setCompletionOpen(false);
                  setCompletionIndex(-1);
                } else if (event.key === "Backspace" && tagInput === "" && phrases.length > 0) {
                  event.preventDefault();
                  removePhrase(selectedTag >= 0 ? selectedTag : phrases.length - 1);
                } else if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                  event.preventDefault();
                  moveSelected(event.key === "ArrowLeft" ? -1 : 1);
                }
              }}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text");
                if (/[,，\n]/.test(pasted)) {
                  event.preventDefault();
                  addTags(parseInput(pasted));
                  setTagInput("");
                  setCompletionOpen(false);
                }
              }}
            />
            <button
              type="button"
              className="btn secondary sm"
              onClick={() => {
                commitInput();
                setCompletionOpen(false);
              }}
              disabled={!tagInput.trim()}
            >
              <Icon name="plus" className="sm" />
              添加
            </button>
          </div>
          {completionOpen && completionQuery && completions.length > 0 ? (
            <div className="phrase-completions">
              {completions.map((entry, index) => (
                <button
                  type="button"
                  key={`${entry.key}-${index}`}
                  className={classNames("phrase-completion", index === completionIndex && "active")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyCompletion(entry, true)}
                >
                  <span className="phrase-completion-main">
                    <span>{entry.english}</span>
                    <span className="tag-zh">{entry.chinese}</span>
                  </span>
                  <span className="phrase-completion-category">{entry.category}</span>
                </button>
              ))}
              <div className="phrase-completion-hint">↑↓ 选择 · Tab 补全 · Enter 添加</div>
            </div>
          ) : null}
        </div>
        <div className="phrase-view-bar">
          <Segmented
            value={phraseView}
            options={[
              { value: "sort", label: "排序视图", icon: "sort" },
              { value: "group", label: "分组视图", icon: "grid" },
            ]}
            onChange={changePhraseView}
            compact
            ariaLabel="短语显示视图"
          />
          <div className="spacer" />
          {phraseView === "group" ? (
            <button
              type="button"
              className="btn ghost sm"
              onClick={sortTagsByGroup}
              disabled={tags.length === 0}
              title="按提示词库主分类重排标签，并写入标注文件顺序"
            >
              <Icon name="sort" className="sm" />
              按分组排序
            </button>
          ) : (
            <span className="hint">
              {disabledTags.length > 0
                ? `有 ${disabledTags.length} 条已停用，切换到分组视图启用`
                : "拖动短语调整文件顺序"}
            </span>
          )}
        </div>
        {phraseView === "sort" ? (
          <div
            className="tag-input-wrap"
            onClick={(event) => {
              if (event.target === event.currentTarget) inputRef.current?.focus();
            }}
          >
            {tags.map((tag, index) => renderTagChip(tag, index))}
            {renderDescriptionChip()}
            {phrases.length === 0 ? (
              <span className="hint">还没有短语，先在上方添加，或使用 AI 打标。</span>
            ) : null}
          </div>
        ) : (
          <div className="phrase-groups">
            {phraseGroups.map((group) => {
              const allEnabled = group.enabledCount === group.items.length;
              return (
                <section className="phrase-group" key={group.category}>
                  <header className="phrase-group-head">
                    <span className="phrase-group-title">{group.category}</span>
                    <span className="phrase-group-count">{group.items.length}</span>
                    <div className="spacer" />
                    <label
                      className={classNames("phrase-group-switch", !group.enabledCount && "off")}
                      title={
                        allEnabled
                          ? "停用本组：保留在编辑器中，但不写入标注文件"
                          : "一键启用本组全部提示词"
                      }
                    >
                      <input
                        type="checkbox"
                        checked={allEnabled}
                        disabled={!tagStateLoaded}
                        onChange={(event) =>
                          setGroupEnabled(
                            group.items.map((item) => item.tag),
                            event.target.checked,
                          )
                        }
                      />
                      <span>{group.enabledCount === 0 ? "已停用" : "启用本组"}</span>
                    </label>
                  </header>
                  <div className="tag-input-wrap">
                    {group.items.map((item) =>
                      renderTagChip(item.tag, tags.indexOf(item.tag), item.disabled),
                    )}
                  </div>
                </section>
              );
            })}
            {text.trim() ? (
              <section className="phrase-group">
                <header className="phrase-group-head">
                  <span className="phrase-group-title">自然语言</span>
                  <span className="phrase-group-count">1</span>
                </header>
                <div className="tag-input-wrap">{renderDescriptionChip()}</div>
              </section>
            ) : null}
            {phraseGroups.length === 0 && !text.trim() ? (
              <span className="hint">还没有短语，先在上方添加，或使用 AI 打标。</span>
            ) : null}
          </div>
        )}
        <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span className="hint">Enter 添加短语</span>
          <div className="row" style={{ gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
            <Dropdown
              width={280}
              align="end"
              renderTrigger={(toggle) => (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={toggle}
                  disabled={!canExpandUnderscores || underscoreBusy}
                  title={canExpandUnderscores ? "下划线标签扩展" : "当前没有含内侧下划线的标签"}
                >
                  {underscoreBusy ? <Spinner /> : <Icon name="copy" className="sm" />}
                  标签扩展{underscoreTargets > 0 ? ` · 已选 ${underscoreTargets} 张` : ""}
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>
                    {underscoreTargets > 0 ? `已选 ${underscoreTargets} 张` : "当前图片"} · 保留首尾下划线
                  </MenuLabel>
                  <MenuItem
                    icon="refresh"
                    onClick={() => {
                      onExpandUnderscores(false);
                      close();
                    }}
                  >
                    下划线转为空格
                  </MenuItem>
                  <MenuItem
                    icon="copy"
                    onClick={() => {
                      onExpandUnderscores(true);
                      close();
                    }}
                  >
                    复制空格版本（保留原标签）
                  </MenuItem>
                </>
              )}
            </Dropdown>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void translateTags()}
              disabled={translating || translatableTokens.length === 0}
              title="为缺少中文对照的短语调用翻译服务（包含自然语言）"
            >
              {translating ? <Spinner /> : <Icon name="sparkles" className="sm" />}
              翻译短语
            </button>
          </div>
        </div>
        <div className="prompt-translate">
          <div className="prompt-translate-row">
            <input
              className="input"
              value={translateInput}
              placeholder="输入中文或英文提示词，自动判断翻译方向"
              onChange={(event) => setTranslateInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                  void translatePrompt();
                }
              }}
            />
            <button
              type="button"
              className="btn subtle sm"
              onClick={() => void translatePrompt()}
              disabled={!translateInput.trim() || translateBusy}
            >
              {translateBusy ? <Spinner /> : <Icon name="sparkles" className="sm" />}
              翻译
            </button>
          </div>
          {translateResult ? (
            <div className="prompt-translate-result">
              <span className="tiny faint">{translateResult.to === "en" ? "中 → 英" : "英 → 中"}</span>
              <span className="grow">{translateResult.text || "（无结果）"}</span>
              {translateResult.to === "en" && translateResult.text ? (
                <button type="button" className="btn ghost sm" onClick={addTranslatedPrompt}>
                  加入短语
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {phrases.length === 0 ? <Notice tone="warning">{S.caption.emptyWarning}</Notice> : null}

      <div className="form-block">
        <div className="form-block-head">
          <Icon name="sparkles" className="sm" />
          <h4>{S.caption.triggerPreview}</h4>
        </div>
        <div className="caption-final">
          <div className="final-label">
            <Icon name="file" className="sm" />
            最终导出文本
          </div>
          {finalText || <span className="faint">（空）</span>}
        </div>
        <div className="caption-stats">
          <span>{stats.charCount} 字符</span>
          <span>{stats.tagCount} 标签</span>
          <span title={stats.tokenizerNote}>
            {stats.tokenEstimate === null ? "未计算" : `${stats.tokenEstimate} token（估算）`}
          </span>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={triggerDisabled}
            onChange={(event) => onToggleTrigger(event.target.checked)}
          />
          {S.caption.triggerDisabled}
        </label>
      </div>
    </div>
  );
}
