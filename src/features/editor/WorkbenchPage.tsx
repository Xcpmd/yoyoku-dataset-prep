import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type {
  AssetDetail,
  AssetPatch,
  AssetSummary,
  CaptionMode,
  CaptionSaveResult,
  ModelInfo,
  ReviewStatus,
  TransformPlan,
  TransformPreview,
} from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { useRoot } from "../../app/AppProvider";
import { S } from "../../lib/strings";
import { modelDescription, modelKindLabel } from "../../lib/modelDescriptions";
import {
  captionStatsLocal,
  classNames,
  computeGeometry,
  finalizeCaptionLocal,
  formatBytes,
  isEditableElement,
  normalizeKey,
  normalizeTagList,
  thumbUrlRaw,
} from "../../lib/utils";
import { Icon } from "../../components/Icon";
import {
  Badge,
  EmptyState,
  IconButton,
  Modal,
  Notice,
  PromptDialog,
  Spinner,
} from "../../components/ui";
import { CanvasStage, type CanvasBackground, type CanvasMode } from "./CanvasStage";
import { CropPanel } from "./CropPanel";
import { CaptionPanel, type CaptionSaveState } from "./CaptionPanel";
import { InfoPanel } from "./InfoPanel";
import { CropModeSwitch, type CropMode } from "./CropModeSwitch";

type Tab = "crop" | "caption" | "info";
type MobileSection = "image" | "crop" | "caption";

export function WorkbenchPage({
  active,
  workspace = "crop",
  cropMode,
  onCropModeChange,
}: {
  active: boolean;
  workspace?: "crop" | "tag";
  cropMode?: CropMode;
  onCropModeChange?: (mode: CropMode) => void;
}) {
  const {
    project,
    workbenchId,
    sequence,
    sequenceLabel,
    setSequence,
    openWorkbench,
    filter,
    notify,
    bumpRefresh,
    refreshToken,
    navigate,
    setJobsOpen,
  } = useProject();
  const { modelRevision } = useRoot();

  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [plan, setPlan] = useState<TransformPlan | null>(null);
  const [appliedPlan, setAppliedPlan] = useState<TransformPlan | null>(null);
  const [planDirty, setPlanDirty] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [preview, setPreview] = useState<TransformPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [mode, setMode] = useState<CanvasMode>("edit");
  const [background, setBackground] = useState<CanvasBackground>("checker");
  const [activeTab, setActiveTab] = useState<Tab>(workspace === "tag" ? "caption" : "crop");
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth >= 960);
  const [mobileSection, setMobileSection] = useState<MobileSection>("image");
  const [cropSelection, setCropSelection] = useState<string[]>([]);
  const [linked, setLinked] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [tagSelection, setTagSelection] = useState<string[]>([]);
  const [tagBatchOpen, setTagBatchOpen] = useState(false);
  const [tagModels, setTagModels] = useState<ModelInfo[]>([]);
  const [tagModelsLoading, setTagModelsLoading] = useState(false);
  const [tagModel, setTagModel] = useState("");
  const [tagBatchRunning, setTagBatchRunning] = useState(false);
  const [aiTagging, setAiTagging] = useState(false);
  const [tagBatchProgress, setTagBatchProgress] = useState<{ done: number; total: number } | null>(null);

  const [captionMode, setCaptionMode] = useState<CaptionMode>("tags");
  const [tags, setTags] = useState<string[]>([]);
  const [captionText, setCaptionText] = useState("");
  const [captionDirty, setCaptionDirty] = useState(false);
  const [captionSaveState, setCaptionSaveState] = useState<CaptionSaveState>("saved");
  const [captionPreview, setCaptionPreview] = useState<CaptionSaveResult | null>(null);
  const [captionPreviewState, setCaptionPreviewState] = useState<{
    finalText: string;
    stats: { charCount: number; tagCount: number; tokenEstimate: number | null; tokenizerNote: string };
  } | null>(null);

  const [applying, setApplying] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [pendingReview, setPendingReview] = useState<{
    status: ReviewStatus;
    reason?: string;
    next: boolean;
  } | null>(null);
  const [filmSummaries, setFilmSummaries] = useState<Record<string, AssetSummary>>({});
  const [filmWindow, setFilmWindow] = useState({ start: 0, end: 0 });

  const hydratedRef = useRef(false);
  const skipFlushRef = useRef(false);
  const assetIdRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const planRef = useRef<TransformPlan | null>(null);
  const appliedRef = useRef<TransformPlan | null>(null);
  const planDirtyRef = useRef(false);
  const captionRef = useRef({ mode: "tags" as CaptionMode, tags: [] as string[], text: "", dirty: false });
  const captionSaveRef = useRef<CaptionSaveState>("saved");
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const filmRef = useRef<HTMLDivElement>(null);
  const loadNonceRef = useRef(0);
  const railDragRef = useRef<boolean | null>(null);

  assetIdRef.current = detail?.summary.id || workbenchId;
  planRef.current = plan;
  appliedRef.current = appliedPlan;
  planDirtyRef.current = planDirty;
  captionRef.current = { mode: captionMode, tags, text: captionText, dirty: captionDirty };
  captionSaveRef.current = captionSaveState;

  const triggerWord = project.triggerWord;
  const currentId = detail?.summary.id || workbenchId;
  const currentIndex = currentId ? sequence.indexOf(currentId) : -1;
  const geometry = useMemo(
    () => (plan && detail ? computeGeometry(plan, detail.normWidth, detail.normHeight) : null),
    [plan, detail],
  );
  const linkedTargets = useMemo(() => {
    const ids = currentId ? [currentId, ...cropSelection] : cropSelection;
    return Array.from(new Set(ids)).filter(Boolean);
  }, [currentId, cropSelection]);
  const railSelection = workspace === "crop" ? cropSelection : tagSelection;
  const railAllSelected =
    sequence.length > 0 && sequence.every((id) => railSelection.includes(id));
  const selectRailAll = () => {
    const next = [...sequence];
    if (workspace === "crop") setCropSelection(next);
    else setTagSelection(next);
  };
  const clearRailSelection = () => {
    if (workspace === "crop") setCropSelection([]);
    else setTagSelection([]);
  };
  const setRailValue = (id: string, value: boolean) => {
    const update = (current: string[]) =>
      value
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((item) => item !== id);
    if (workspace === "crop") setCropSelection(update);
    else setTagSelection(update);
  };
  const startRailDrag = (id: string, value: boolean) => {
    railDragRef.current = value;
    setRailValue(id, value);
  };
  const railDragEnter = (id: string) => {
    if (railDragRef.current !== null) setRailValue(id, railDragRef.current);
  };
  useEffect(() => {
    const end = () => {
      railDragRef.current = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("mouseup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);
  useEffect(() => {
    railDragRef.current = null;
  }, [active, workspace]);

  const reloadDetail = useCallback((skipFlush = false) => {
    if (skipFlush) skipFlushRef.current = true;
    setLoadNonce((value) => value + 1);
  }, []);

  const hydrate = useCallback((data: AssetDetail) => {
    setDetail(data);
    const working = data.transform.draft || data.transform.plan;
    setPlan(working);
    setAppliedPlan(data.transform.plan);
    const dirty = JSON.stringify(working) !== JSON.stringify(data.transform.plan);
    setPlanDirty(dirty);
    setDraftSavedAt(data.transform.draft ? data.transform.createdAt : null);
    setPreview(null);
    setPreviewError(null);
    setAspect(null);
    setMode("edit");
    const hydratedTags = data.caption.tags;
    const hydratedText = data.caption.text;
    const duplicateLegacyText =
      hydratedTags.length > 0 &&
      hydratedText.trim().length > 0 &&
      normalizeKey(hydratedText) === normalizeKey(hydratedTags.join(", "));
    const hydratedMode: CaptionMode =
      hydratedTags.length > 0
        ? hydratedText.trim().length > 0 && !duplicateLegacyText
          ? "mixed"
          : "tags"
        : hydratedText.trim().length > 0
          ? "nl"
          : "tags";
    setCaptionMode(hydratedMode);
    setTags(hydratedTags);
    setCaptionText(duplicateLegacyText || hydratedTags.length > 0 && hydratedText.trim().length === 0 ? "" : hydratedText);
    setCaptionDirty(false);
    setCaptionSaveState("saved");
    setCaptionPreview(null);
    setCaptionPreviewState({
      finalText: data.caption.finalText,
      stats: {
        charCount: data.caption.charCount,
        tagCount: data.caption.tagCount,
        tokenEstimate: data.caption.tokenEstimate,
        tokenizerNote: data.caption.tokenizerNote,
      },
    });
    revisionRef.current = data.summary.revision;
    hydratedRef.current = true;
  }, []);

  // Load asset, flushing previous edits first
  useEffect(() => {
    if (!workbenchId) {
      setDetail(null);
      setPlan(null);
      setAppliedPlan(null);
      setLoading(false);
      hydratedRef.current = false;
      return;
    }
    let cancelled = false;
    const run = async () => {
      if (hydratedRef.current && !skipFlushRef.current) {
        await flushRef.current();
      }
      skipFlushRef.current = false;
      if (cancelled) return;
      hydratedRef.current = false;
      setLoading(true);
      setLoadError(null);
      try {
        const data = await api.getAsset(workbenchId);
        if (cancelled) return;
        hydrate(data);
      } catch (error) {
        if (!cancelled) {
          setDetail(null);
          setLoadError(normalizeError(error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbenchId, loadNonce, hydrate]);

  // Flush when leaving workbench
  useEffect(() => {
    if (!active) {
      void flushRef.current();
    }
  }, [active]);

  const saveCaptionNow = useCallback(async (): Promise<boolean> => {
    const current = captionRef.current;
    const id = assetIdRef.current;
    if (!id || !current.dirty) return true;
    const expected = revisionRef.current;
    setCaptionSaveState("saving");
    captionSaveRef.current = "saving";
    const captured = { ...current, tags: [...current.tags] };
    try {
      const result = await api.saveCaption({
        assetId: id,
        mode: captured.mode,
        tags: captured.tags,
        text: captured.text,
        expectedRevision: expected,
      });
      if (assetIdRef.current !== id) return true;
      revisionRef.current = result.assetRevision;
      const same =
        captionRef.current.mode === captured.mode &&
        captionRef.current.text === captured.text &&
        captionRef.current.tags.join("\u0000") === captured.tags.join("\u0000");
      if (same) {
        captionRef.current = { ...captionRef.current, dirty: false };
        setCaptionDirty(false);
        setCaptionSaveState("saved");
        captionSaveRef.current = "saved";
      } else {
        setCaptionSaveState("dirty");
        captionSaveRef.current = "dirty";
      }
      setDetail((previous) => {
        if (!previous || previous.summary.id !== id) return previous;
        return {
          ...previous,
          summary: {
            ...previous.summary,
            revision: result.assetRevision,
            hasCaption: Boolean(result.finalText.trim()),
            status: result.reviewReset ? "pending" : previous.summary.status,
            tags: captured.tags,
            captionMode: captured.mode,
            captionPreview: captured.mode === "tags" ? captured.tags.slice(0, 8).join(", ") : captured.text.slice(0, 96),
          },
          caption: {
            ...previous.caption,
            revisionId: result.revisionId,
            mode: captured.mode,
            tags: captured.tags,
            text: captured.text,
            finalText: result.finalText,
            charCount: result.stats.charCount,
            tagCount: result.stats.tagCount,
            tokenEstimate: result.stats.tokenEstimate,
          },
        };
      });
      if (same) {
        setCaptionPreviewState({
          finalText: result.finalText,
          stats: result.stats,
        });
      }
      if (result.reviewReset) {
        notify({ tone: "warning", title: S.caption.title, message: S.workbench.reviewReset });
      }
      bumpRefresh();
      return true;
    } catch (error) {
      if (assetIdRef.current === id) {
        setCaptionSaveState("error");
        captionSaveRef.current = "error";
        notify({
          tone: "danger",
          title: S.common.saveFailed,
          message: normalizeError(error).message,
        });
      }
      return false;
    }
  }, [bumpRefresh, notify]);

  const saveDraftNow = useCallback(async () => {
    const id = assetIdRef.current;
    const currentPlan = planRef.current;
    if (!id || !currentPlan || !planDirtyRef.current) return;
    try {
      const result = await api.saveDraft(id, currentPlan);
      if (assetIdRef.current !== id) return;
      setDraftSavedAt(result.savedAt);
      setDetail((previous) => {
        if (!previous || previous.summary.id !== id) return previous;
        return {
          ...previous,
          summary: { ...previous.summary, hasDraft: true },
          transform: {
            ...previous.transform,
            draft: currentPlan,
            draftRevisionId: result.draftRevisionId,
          },
        };
      });
      bumpRefresh();
    } catch (error) {
      notify({ tone: "danger", title: "裁剪草稿保存失败", message: normalizeError(error).message });
    }
  }, [bumpRefresh, notify]);

  const discardDraft = useCallback(async () => {
    const id = assetIdRef.current;
    if (!id || !appliedRef.current) return;
    try {
      await api.clearDraft(id);
      const applied = appliedRef.current;
      setPlan(applied);
      planDirtyRef.current = false;
      setPlanDirty(false);
      setDraftSavedAt(null);
      setDetail((previous) =>
        previous
          ? {
              ...previous,
              summary: { ...previous.summary, hasDraft: false },
              transform: { ...previous.transform, draft: null, draftRevisionId: null },
            }
          : previous,
      );
      bumpRefresh();
      notify({ message: "已放弃裁剪草稿" });
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  }, [bumpRefresh, notify]);

  const flushAll = useCallback(async () => {
    await saveCaptionNow();
    await saveDraftNow();
  }, [saveCaptionNow, saveDraftNow]);
  flushRef.current = flushAll;

  // Draft autosave
  useEffect(() => {
    if (!plan || !detail || !hydratedRef.current) return;
    if (!planDirty) {
      if (detail.transform.draftRevisionId) {
        void api
          .clearDraft(detail.summary.id)
          .then(() => {
            setDraftSavedAt(null);
            setDetail((previous) =>
              previous
                ? {
                    ...previous,
                    summary: { ...previous.summary, hasDraft: false },
                    transform: { ...previous.transform, draft: null, draftRevisionId: null },
                  }
                : previous,
            );
          })
          .catch(() => undefined);
      }
      return;
    }
    const timer = window.setTimeout(() => void saveDraftNow(), 650);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, planDirty, detail?.summary.id]);

  useEffect(() => {
    if (!active || !workbenchId || workspace !== "crop") return;
    setCropSelection((current) => (current.includes(workbenchId) ? current : [...current, workbenchId]));
  }, [active, workbenchId, workspace]);

  useEffect(() => {
    setActiveTab(workspace === "tag" ? "caption" : "crop");
    setSideOpen(true);
    setMobileSection(workspace === "tag" ? "caption" : "image");
  }, [workspace]);

  const wasActiveRef = useRef(active);
  useEffect(() => {
    if (active && !wasActiveRef.current && workspace === "crop") {
      setActiveTab("crop");
      setSideOpen(true);
      setMobileSection("image");
      // 瀑布流可能刚改过同一张图片，重新载入当前版本，避免用旧 revision 保存。
      reloadDetail(true);
    }
    wasActiveRef.current = active;
  }, [active, workspace, reloadDetail]);

  useEffect(() => {
    if (linked && linkedTargets.length < 2) setLinked(false);
  }, [linked, linkedTargets.length]);

  // Caption autosave
  useEffect(() => {
    if (!captionDirty || !hydratedRef.current) return;
    const timer = window.setTimeout(() => void saveCaptionNow(), 520);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captionMode, tags, captionText, captionDirty]);

  // Preview caption via shared final function
  useEffect(() => {
    if (!detail || !hydratedRef.current) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.previewCaption({
          mode: captionMode,
          tags,
          text: captionText,
          triggerDisabled: detail.summary.triggerDisabled,
        });
        if (!cancelled) setCaptionPreviewState({ finalText: result.finalText, stats: result.stats });
      } catch {
        // fallback below
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captionMode, tags, captionText, detail?.summary.triggerDisabled, detail?.summary.id]);

  // Transform preview
  useEffect(() => {
    if (!detail || !plan || !hydratedRef.current) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const id = detail.summary.id;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.transformPreview(id, plan, 1400);
        if (!cancelled && assetIdRef.current === id) setPreview(result);
      } catch (error) {
        if (!cancelled) setPreviewError(normalizeError(error).message);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 320);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, detail?.summary.id]);

  // 应用重启后恢复完整浏览序列
  useEffect(() => {
    if (!active || !workbenchId || sequence.length > 1) return;
    let cancelled = false;
    api
      .assetIds(filter)
      .then((ids) => {
        if (cancelled) return;
        if (ids.length > 1 && ids.includes(workbenchId)) {
          setSequence(ids, S.workbench.sequenceLibrary);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workbenchId]);

  // Filmstrip summaries window
  useEffect(() => {
    if (sequence.length === 0) {
      setFilmSummaries({});
      setFilmWindow({ start: 0, end: 0 });
      return;
    }
    const index = currentId ? sequence.indexOf(currentId) : 0;
    const start = sequence.length > 400 ? Math.max(0, index - 120) : 0;
    const end = sequence.length > 400 ? Math.min(sequence.length, start + 240) : sequence.length;
    setFilmWindow({ start, end });
    const ids = sequence.slice(start, end);
    if (currentId && !ids.includes(currentId)) ids.push(currentId);
    let cancelled = false;
    api
      .assetSummaries(ids)
      .then((list) => {
        if (cancelled) return;
        const map: Record<string, AssetSummary> = {};
        list.forEach((summary) => {
          map[summary.id] = summary;
        });
        setFilmSummaries(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequence, currentId, refreshToken]);

  useEffect(() => {
    const element = filmRef.current?.querySelector<HTMLElement>(`[data-film-id="${currentId}"]`);
    element?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [currentId, filmWindow.start, filmWindow.end]);

  // Keyboard navigation
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (isEditableElement(event.target)) return;
      if (pendingReview || excludeOpen) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        void goRelative(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        void goRelative(1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        void requestReview("approved", undefined, true);
      }
    };
    document.addEventListener("keydown", handler);
    const saveListener = () => {
      void saveCaptionNow();
      void saveDraftNow();
    };
    window.addEventListener("yoyoku:save", saveListener);
    const undoListener = () => reloadDetail(true);
    window.addEventListener("yoyoku:undo-applied", undoListener);
    return () => {
      document.removeEventListener("keydown", handler);
      window.removeEventListener("yoyoku:save", saveListener);
      window.removeEventListener("yoyoku:undo-applied", undoListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, currentId, pendingReview, excludeOpen, sequence, filmSummaries]);

  const updatePlan = useCallback((next: TransformPlan) => {
    setPlan(next);
    const dirty = JSON.stringify(next) !== JSON.stringify(appliedRef.current);
    planDirtyRef.current = dirty;
    setPlanDirty(dirty);
  }, []);

  const updateCaption = (patch: { mode?: CaptionMode; tags?: string[]; text?: string }) => {
    const nextText = patch.text !== undefined ? patch.text : captionText;
    const nextTags = patch.tags !== undefined ? patch.tags : tags;
    const hasTags = nextTags.some((tag) => tag.trim().length > 0);
    let nextMode: CaptionMode = patch.mode !== undefined ? patch.mode : captionMode;
    if (patch.mode === undefined) {
      if (nextText.trim() && hasTags) nextMode = "mixed";
      else if (nextText.trim()) nextMode = patch.tags !== undefined ? "mixed" : captionMode === "mixed" ? "mixed" : "nl";
      else nextMode = "tags";
    }
    if (nextMode !== captionMode) setCaptionMode(nextMode);
    if (patch.tags !== undefined) setTags(patch.tags);
    if (patch.text !== undefined) setCaptionText(patch.text);
    setCaptionDirty(true);
    setCaptionSaveState("dirty");
  };

  const rotate = (clockwise: boolean) => {
    if (!plan) return;
    const crop = clockwise
      ? { x: 1 - (plan.crop.y + plan.crop.h), y: plan.crop.x, w: plan.crop.h, h: plan.crop.w }
      : { x: plan.crop.y, y: 1 - (plan.crop.x + plan.crop.w), w: plan.crop.h, h: plan.crop.w };
    updatePlan({
      ...plan,
      rotation: (plan.rotation + (clockwise ? 90 : 270)) % 360,
      crop,
    });
    setAspect(null);
  };

  const flip = (horizontal: boolean) => {
    if (!plan) return;
    const crop = horizontal
      ? { ...plan.crop, x: 1 - (plan.crop.x + plan.crop.w) }
      : { ...plan.crop, y: 1 - (plan.crop.y + plan.crop.h) };
    updatePlan({
      ...plan,
      flipH: horizontal ? !plan.flipH : plan.flipH,
      flipV: horizontal ? plan.flipV : !plan.flipV,
      crop,
    });
  };

  const centerCrop = () => {
    if (!plan) return;
    updatePlan({
      ...plan,
      crop: { ...plan.crop, x: (1 - plan.crop.w) / 2, y: (1 - plan.crop.h) / 2 },
    });
  };

  const resetCrop = () => {
    if (!plan) return;
    updatePlan({ ...plan, crop: { x: 0, y: 0, w: 1, h: 1 } });
  };

  const applyPlanBatch = async (targets: string[]): Promise<boolean> => {
    if (!detail || !plan || targets.length === 0) return false;
    setApplying(true);
    setBatchProgress({ done: 0, total: targets.length });
    try {
      const captionOk = await saveCaptionNow();
      if (!captionOk) return false;
      const summaries = await api.assetSummaries(targets);
      const revisions = new Map(summaries.map((item) => [item.id, item.revision]));
      if (detail) revisions.set(detail.summary.id, revisionRef.current);
      let applied = 0;
      const failures: string[] = [];
      for (const id of targets) {
        const expected = revisions.get(id);
        if (typeof expected !== "number") {
          failures.push("图片已不存在");
          setBatchProgress((current) => ({ done: (current?.done || 0) + 1, total: targets.length }));
          continue;
        }
        try {
          await api.transformSave(id, plan, expected);
          applied += 1;
        } catch (error) {
          const normalized = normalizeError(error);
          failures.push(`${summaries.find((item) => item.id === id)?.name || id.slice(0, 8)}：${normalized.message}`);
        }
        setBatchProgress((current) => ({ done: (current?.done || 0) + 1, total: targets.length }));
      }
      if (applied > 0) {
        bumpRefresh();
        reloadDetail(true);
      }
      notify({
        tone: failures.length > 0 ? "warning" : "success",
        title: linked ? "联动裁剪已应用" : "裁剪已应用",
        message: `已同步 ${applied} 张${failures.length > 0 ? `，${failures.length} 张失败：${failures[0]}` : ""}`,
        actionLabel: applied > 0 ? "撤销本次同步" : undefined,
        onAction:
          applied > 0
            ? async () => {
                try {
                  for (let index = 0; index < applied; index += 1) {
                    await api.undo();
                  }
                  bumpRefresh();
                  reloadDetail(true);
                  notify({ message: "已撤销本次联动裁剪" });
                } catch (error) {
                  notify({ tone: "danger", message: normalizeError(error).message });
                }
              }
            : undefined,
      });
      return applied > 0;
    } catch (error) {
      notify({ tone: "danger", title: S.common.saveFailed, message: normalizeError(error).message });
      return false;
    } finally {
      setApplying(false);
      setBatchProgress(null);
    }
  };

  const applyPlan = async (): Promise<boolean> => {
    if (workspace === "crop" && linked && linkedTargets.length > 1) {
      return applyPlanBatch(linkedTargets);
    }
    if (!detail || !plan) return false;
    setApplying(true);
    try {
      const captionOk = await saveCaptionNow();
      if (!captionOk) return false;
      const id = detail.summary.id;
      const result = await api.transformSave(id, plan, revisionRef.current);
      if (assetIdRef.current !== id) return false;
      revisionRef.current = result.assetRevision;
      setAppliedPlan(plan);
      appliedRef.current = plan;
      planDirtyRef.current = false;
      setPlanDirty(false);
      setDraftSavedAt(null);
      setDetail((previous) =>
        previous
          ? {
              ...previous,
              summary: {
                ...previous.summary,
                revision: result.assetRevision,
                outWidth: result.geometry.outWidth,
                outHeight: result.geometry.outHeight,
                cropRatio: result.geometry.cropRatio,
                padRatio: result.geometry.padRatio,
                scaleRatio: result.geometry.scaleRatio,
                thumbVersion: result.thumbVersion,
                hasDraft: false,
                status: result.reviewReset ? "pending" : previous.summary.status,
              },
              transform: {
                ...previous.transform,
                revisionId: result.revisionId,
                plan,
                draft: null,
                draftRevisionId: null,
                createdAt: new Date().toISOString(),
              },
            }
          : previous,
      );
      bumpRefresh();
      notify({
        tone: "success",
        title: S.workbench.cropApplied,
        message: `${result.geometry.outWidth}×${result.geometry.outHeight}`,
        actionLabel: S.common.undo,
        onAction: async () => {
          try {
            await api.undo();
            bumpRefresh();
            reloadDetail(true);
            notify({ message: "已撤销裁剪配方" });
          } catch (error) {
            notify({ tone: "danger", message: normalizeError(error).message });
          }
        },
      });
      if (result.reviewReset) {
        notify({ tone: "warning", message: S.workbench.reviewReset });
      }
      if (result.warning) {
        notify({ tone: "warning", message: result.warning });
      }
      return true;
    } catch (error) {
      notify({ tone: "danger", title: S.common.saveFailed, message: normalizeError(error).message });
      return false;
    } finally {
      setApplying(false);
    }
  };

  const loadAvailableModels = useCallback(async (): Promise<ModelInfo[]> => {
    const list = await api.models();
    const available = list
      .filter(
        (item) =>
          item.status === "available" &&
          (item.kind === "wd14-tagger" || item.kind === "caption"),
      )
      .sort((a, b) => {
        const rank = (kind: string) => (kind === "caption" ? 0 : 1);
        return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name);
      });
    setTagModels(available);
    const preferred = available.find((item) => item.kind === "wd14-tagger") || available[0];
    setTagModel((current) =>
      current && available.some((item) => item.id === current)
        ? current
        : preferred?.id || "",
    );
    return available;
  }, []);

  useEffect(() => {
    if (!active || workspace !== "tag") return;
    let cancelled = false;
    setTagModelsLoading(true);
    loadAvailableModels()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setTagModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, workspace, modelRevision, loadAvailableModels]);

  const phraseKey = (value: string) =>
    normalizeKey(value).replace(/[.!?。！？]/g, " ").replace(/\s+/g, " ").trim();

  const splitSentencePhrases = (text: string) =>
    text
      .replace(/([.!?。！？])\s*/g, "$1\n")
      .split(/\n+/)
      .map((sentence) => sentence.replace(/[.!?。！？]+$/g, "").trim())
      .filter(Boolean);

  const augmentCaptionWithModel = async (assetId: string, modelId: string) => {
    const detail = await api.getAsset(assetId);
    const suggestion = await api.generateSuggestion({
      assetId,
      model: modelId,
      threshold: 0.35,
      characterThreshold: 0.85,
    });
    const incoming = [...suggestion.tags];
    if (suggestion.text.trim()) incoming.push(...splitSentencePhrases(suggestion.text));

    const existingText = detail.caption.text.trim();
    const existingTextKey = phraseKey(existingText);
    const seen = new Set(detail.caption.tags.map(phraseKey));
    const addedPhrases: string[] = [];
    for (const raw of incoming) {
      const phrase = raw.trim();
      const key = phraseKey(phrase);
      if (!key || seen.has(key) || (existingTextKey && existingTextKey.includes(key))) continue;
      seen.add(key);
      addedPhrases.push(phrase);
    }
    if (addedPhrases.length === 0) {
      return { added: 0, saved: 0 };
    }
    const merged = normalizeTagList([...detail.caption.tags, ...addedPhrases]);
    const mode: CaptionMode =
      merged.length > 0 && existingText ? "mixed" : merged.length > 0 ? "tags" : existingText ? "nl" : "tags";
    await api.saveCaption({
      assetId,
      mode,
      tags: merged,
      text: existingText,
      expectedRevision: detail.summary.revision,
      source: "suggestion",
    });
    return { added: addedPhrases.length, saved: 1 };
  };

  const openTagBatch = async () => {
    setTagBatchOpen(true);
    setTagModelsLoading(true);
    try {
      await loadAvailableModels();
    } catch (error) {
      notify({
        tone: "danger",
        title: "读取本地模型失败",
        message: normalizeError(error).message,
      });
    } finally {
      setTagModelsLoading(false);
    }
  };

  const runAiTagCurrent = async () => {
    if (!currentId || !tagModel || aiTagging) return;
    setAiTagging(true);
    try {
      const result = await augmentCaptionWithModel(currentId, tagModel);
      if (result.saved > 0) {
        bumpRefresh();
        reloadDetail(true);
      }
      notify({
        tone: "success",
        title: "AI 打标完成",
        message:
          result.added > 0
            ? `新增 ${result.added} 条短语`
            : "模型没有产生新的短语（重复项已剔除）",
      });
    } catch (error) {
      notify({ tone: "danger", title: "AI 打标失败", message: normalizeError(error).message });
    } finally {
      setAiTagging(false);
    }
  };

  const runTagBatch = async () => {
    const targets = Array.from(new Set(tagSelection.filter(Boolean)));
    if (!tagModel || targets.length === 0) return;
    const captionOk = await saveCaptionNow();
    if (!captionOk) return;
    setTagBatchOpen(false);
    setTagBatchRunning(true);
    setTagBatchProgress({ done: 0, total: targets.length });
    let saved = 0;
    const failures: string[] = [];
    try {
      const summaries = await api.assetSummaries(targets);
      const byId = new Map(summaries.map((item) => [item.id, item]));
      for (const id of targets) {
        const summary = byId.get(id);
        if (!summary) {
          failures.push(`${id.slice(0, 8)}：图片已不存在`);
          setTagBatchProgress((current) => ({ done: (current?.done || 0) + 1, total: targets.length }));
          continue;
        }
        try {
          const result = await augmentCaptionWithModel(id, tagModel);
          saved += result.saved;
        } catch (error) {
          failures.push(`${summary.name}：${normalizeError(error).message}`);
        }
        setTagBatchProgress((current) => ({ done: (current?.done || 0) + 1, total: targets.length }));
      }
      if (saved > 0) {
        bumpRefresh();
        if (currentId && targets.includes(currentId)) reloadDetail(true);
      }
      notify({
        tone: failures.length > 0 ? "warning" : "success",
        title: "批量打标完成",
        message:
          saved > 0
            ? `已为 ${saved} 张补充标注${failures.length > 0 ? `，${failures.length} 张失败：${failures[0]}` : ""}`
            : `没有新增短语${failures.length > 0 ? `，${failures.length} 张失败：${failures[0]}` : ""}`,
        actionLabel: saved > 0 ? "撤销本批打标" : undefined,
        onAction:
          saved > 0
            ? async () => {
                try {
                  for (let index = 0; index < saved; index += 1) {
                    await api.undo();
                  }
                  bumpRefresh();
                  reloadDetail(true);
                  notify({ message: "已撤销本批打标" });
                } catch (error) {
                  notify({ tone: "danger", message: normalizeError(error).message });
                }
              }
            : undefined,
      });
    } catch (error) {
      notify({ tone: "danger", title: "批量打标失败", message: normalizeError(error).message });
    } finally {
      setTagBatchRunning(false);
      setTagBatchProgress(null);
    }
  };

  const performReview = async (status: ReviewStatus, reason: string | undefined, next: boolean) => {
    if (!detail) return;
    setReviewBusy(true);
    try {
      const captionOk = await saveCaptionNow();
      if (!captionOk) return;
      const result = await api.updateAsset(detail.summary.id, { status, excludedReason: reason });
      revisionRef.current = result.asset.revision;
      setDetail((previous) => (previous ? { ...previous, summary: result.asset } : previous));
      bumpRefresh();
      notify({
        tone: status === "excluded" ? "warning" : "success",
        title:
          status === "approved"
            ? "已通过"
            : status === "review"
              ? "已标记需复核"
              : status === "excluded"
                ? "已排除"
                : "已重置为待审核",
        message: detail.summary.name,
      });
      if (next) {
        const moved = goRelative(1);
        if (!moved) notify({ message: "已是最后一张" });
      }
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    } finally {
      setReviewBusy(false);
    }
  };

  const requestReview = async (status: ReviewStatus, reason: string | undefined, next: boolean) => {
    if (!detail) return;
    if (planDirty) {
      setPendingReview({ status, reason, next });
      return;
    }
    await performReview(status, reason, next);
  };

  const goRelative = (direction: 1 | -1): boolean => {
    if (!currentId || sequence.length === 0) return false;
    let index = sequence.indexOf(currentId);
    if (index < 0) index = 0;
    for (let next = index + direction; next >= 0 && next < sequence.length; next += direction) {
      const id = sequence[next];
      const summary = filmSummaries[id];
      if (summary?.status === "excluded") continue;
      openWorkbench(id);
      return true;
    }
    return false;
  };

  const handlePatch = async (patch: AssetPatch, label: string) => {
    if (!detail) return;
    setReviewBusy(true);
    try {
      const captionOk = await saveCaptionNow();
      if (!captionOk) return;
      const result = await api.updateAsset(detail.summary.id, patch);
      revisionRef.current = result.asset.revision;
      setDetail((previous) => (previous ? { ...previous, summary: result.asset } : previous));
      bumpRefresh();
      notify({
        tone: "success",
        message: label,
        actionLabel: S.common.undo,
        onAction: async () => {
          try {
            await api.undo();
            bumpRefresh();
            reloadDetail(true);
            notify({ message: "已撤销" });
          } catch (error) {
            notify({ tone: "danger", message: normalizeError(error).message });
          }
        },
      });
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    } finally {
      setReviewBusy(false);
    }
  };

  const toggleTrigger = async (disabled: boolean) => {
    if (!detail) return;
    const captionOk = await saveCaptionNow();
    if (!captionOk) return;
    try {
      const result = await api.updateAsset(detail.summary.id, { triggerDisabled: disabled });
      revisionRef.current = result.asset.revision;
      setDetail((previous) => (previous ? { ...previous, summary: result.asset } : previous));
      bumpRefresh();
      notify({ message: disabled ? "本图不再添加触发词" : "已恢复触发词" });
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  const relink = async (root: string | null) => {
    if (!root) {
      notify({ tone: "danger", message: "该图片没有可重新定位的来源根目录，请从备份恢复或重新导入。" });
      return;
    }
    const folder = await api.pickFolder("选择来源文件夹的新位置");
    if (!folder) return;
    try {
      const result = await api.relinkRoot(root, folder);
      bumpRefresh();
      reloadDetail(true);
      notify({
        tone: result.missing.length > 0 ? "danger" : "success",
        message: `已重新连接 ${result.relinked} 张图片${result.missing.length ? `，仍缺 ${result.missing.length} 张` : ""}`,
      });
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  const reveal = async () => {
    if (!detail) return;
    try {
      await api.assetReveal(detail.summary.id);
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  const refreshSequence = async () => {
    try {
      const ids = await api.assetIds(filter);
      const next = currentId && !ids.includes(currentId) ? [currentId, ...ids] : ids;
      setSequence(next, S.workbench.sequenceLibrary);
      notify({ message: `浏览序列已刷新（${next.length} 张）` });
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  const openSide = (tab: Tab) => {
    setActiveTab(tab);
    setSideOpen(true);
    if (tab === "caption") setMobileSection("caption");
    else if (tab === "crop") setMobileSection("crop");
    else setMobileSection("crop");
  };

  const selectMobile = (section: MobileSection) => {
    setMobileSection(section);
    if (section === "image") {
      setSideOpen(false);
    } else {
      setSideOpen(true);
      setActiveTab(section === "caption" ? "caption" : "crop");
    }
  };

  const localFinal = finalizeCaptionLocal(
    captionMode,
    tags,
    captionText,
    triggerWord,
    project.triggerMode,
    detail?.summary.triggerDisabled || false,
  );
  const localStats = captionStatsLocal(captionMode, tags, captionText);
  const finalText = captionPreviewState?.finalText ?? localFinal;
  const baseStats = captionPreviewState?.stats ?? localStats;
  const stats =
    captionMode !== "nl"
      ? {
          ...baseStats,
          charCount: [...finalText].length,
          tagCount: tags.filter((tag) => tag.trim()).length,
        }
      : baseStats;

  // 打标页只关心标注是否落盘；遗留的裁剪草稿不应显示成“未保存”。
  const headerDirty = workspace === "crop" ? planDirty || captionDirty : captionDirty;
  const headerSaveState =
    applying || captionSaveState === "saving"
      ? "saving"
      : captionSaveState === "error"
        ? "error"
        : headerDirty
          ? "dirty"
          : "saved";
  const headerSaveLabel =
    headerSaveState === "saving"
      ? S.common.saving
      : headerSaveState === "error"
        ? S.common.saveFailed
        : headerSaveState === "dirty"
          ? "未保存"
          : S.common.saved;

  const filmItems = sequence.slice(filmWindow.start, filmWindow.end);
  const canPrev = Boolean(currentIndex > 0);
  const canNext = Boolean(currentIndex >= 0 && currentIndex < sequence.length - 1);

  if (!workbenchId) {
    return (
      <div className="page">
        <EmptyState
          icon="workbench"
          title={S.workbench.noImage}
          body={S.workbench.noImageBody}
          actions={
            <>
              <button type="button" className="btn primary" onClick={() => navigate("library")}>
                {S.workbench.openLibrary}
              </button>
              {sequence.length > 0 ? (
                <button type="button" className="btn subtle" onClick={() => openWorkbench(sequence[0])}>
                  打开序列第一张
                </button>
              ) : null}
            </>
          }
        />
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="workbench">
        <div className="wb-head">
          <div className="wb-title">
            <Spinner /> <span className="small muted">正在载入图片…</span>
          </div>
        </div>
        <div className="wb-body">
          <div className="wb-canvas-wrap">
            <div className="skeleton" style={{ height: 48, margin: 12 }} />
            <div className="skeleton" style={{ flex: 1, margin: 12 }} />
          </div>
          <div className="wb-side">
            <div className="wb-panel">
              <div className="stack">
                <div className="skeleton" style={{ height: 120 }} />
                <div className="skeleton" style={{ height: 240 }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loadError || !detail || !plan || !geometry) {
    return (
      <div className="page">
        <EmptyState
          icon="alert"
          title={S.errors.generic}
          body={loadError || S.workbench.noImageBody}
          actions={
            <>
              <button type="button" className="btn primary" onClick={() => reloadDetail(true)}>
                {S.common.retry}
              </button>
              <button type="button" className="btn subtle" onClick={() => navigate("library")}>
                {S.workbench.openLibrary}
              </button>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="workbench">
      <div className="wb-head">
        <div className="wb-title">
          <IconButton
            icon="chevron-left"
            label={S.workbench.prev}
            onClick={() => goRelative(-1)}
            disabled={!canPrev}
            size="sm"
          />
          <div style={{ minWidth: 0 }}>
            <div className="wb-step-label">{workspace === "tag" ? "03 · 打标" : "02 · 裁剪"}</div>
            <div className="file" title={detail.summary.name}>
              {detail.summary.name}
            </div>
            <div className="position">
              {currentIndex >= 0 ? `${currentIndex + 1} / ${sequence.length}` : "单张"} · {sequenceLabel}
            </div>
          </div>
          <IconButton
            icon="chevron-right"
            label={S.workbench.next}
            onClick={() => goRelative(1)}
            disabled={!canNext}
            size="sm"
          />
          <Badge
            tone={
              detail.summary.status === "approved"
                ? "success"
                : detail.summary.status === "review"
                  ? "warning"
                  : detail.summary.status === "excluded"
                    ? "danger"
                    : "neutral"
            }
            dot
          >
            {detail.summary.status === "approved"
              ? S.status.approved
              : detail.summary.status === "review"
                ? S.status.review
                : detail.summary.status === "excluded"
                  ? S.status.excluded
                  : S.status.pending}
          </Badge>
          {workspace === "crop" && planDirty ? <Badge tone="warning">裁剪草稿</Badge> : null}
          {detail.missing ? <Badge tone="danger">源文件失联</Badge> : null}
        </div>
        <div className="wb-actions">
          {workspace === "crop" && cropMode && onCropModeChange ? (
            <div className="wb-crop-mode">
              <CropModeSwitch mode={cropMode} onChange={onCropModeChange} />
            </div>
          ) : null}
          <span
            className={classNames(
              "save-state",
              headerSaveState === "error" && "error",
              headerSaveState === "saved" && "saved",
            )}
          >
            {headerSaveState === "saving" ? <Spinner /> : <Icon name={headerSaveState === "error" ? "alert" : "check"} className="sm" />}
            {headerSaveLabel}
          </span>
          {workspace === "crop" ? (
            <IconButton icon="crop" label={S.workbench.tabs.crop} active={sideOpen && activeTab === "crop"} onClick={() => openSide("crop")} />
          ) : (
            <IconButton icon="tag" label={S.workbench.tabs.caption} active={sideOpen && activeTab === "caption"} onClick={() => openSide("caption")} />
          )}
          <IconButton icon="info" label={S.workbench.tabs.info} active={sideOpen && activeTab === "info"} onClick={() => openSide("info")} />
          <IconButton icon="refresh" label={S.workbench.refreshSequence} onClick={() => void refreshSequence()} />
          <IconButton icon="tasks" label={S.nav.tasks} onClick={() => setJobsOpen(true)} />
        </div>
      </div>

      <div className="wb-mobile-tabs">
        <button type="button" className={mobileSection === "image" ? "active" : ""} onClick={() => selectMobile("image")}>
          图片
        </button>
        <button type="button" className={mobileSection === "crop" ? "active" : ""} onClick={() => selectMobile("crop")}>
          {workspace === "tag" ? "打标" : "裁剪"}
        </button>
        {workspace === "tag" ? (
          <button type="button" className={mobileSection === "caption" ? "active" : ""} onClick={() => selectMobile("caption")}>
            标注
          </button>
        ) : null}
      </div>

      <div className="wb-body">
        <aside className="wb-asset-rail" aria-label="全部图片">
          <div className="wb-rail-head">
            <div className="wb-rail-heading">
              <span>全部图片</span>
              <span className="tiny faint">{sequence.length}</span>
            </div>
            <span className="tiny faint">
              {railSelection.length > 0
                ? `${railSelection.length} 已选`
                : `${currentIndex >= 0 ? currentIndex + 1 : "—"} / ${sequence.length}`}
            </span>
            <div className="wb-rail-actions">
              <button
                type="button"
                className="btn ghost sm"
                onClick={selectRailAll}
                disabled={sequence.length === 0 || railAllSelected}
              >
                全选
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={clearRailSelection}
                disabled={railSelection.length === 0}
              >
                清空
              </button>
            </div>
          </div>
          <div className="wb-rail-list" ref={filmRef}>
            {filmItems.map((id, index) => {
              const summary = filmSummaries[id];
              const checked = railSelection.includes(id);
              return (
                <div
                  key={id}
                  className={classNames(
                    "wb-rail-item",
                    id === currentId && "active",
                    checked && "checked",
                    summary?.status === "excluded" && "excluded",
                  )}
                  onPointerEnter={() => railDragEnter(id)}
                >
                  <button
                    type="button"
                    className={classNames("wb-rail-check", checked && "checked")}
                    aria-label={`选择 ${summary?.name || id}`}
                    aria-pressed={checked}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      event.stopPropagation();
                      startRailDrag(id, !checked);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === " " || event.key === "Enter") {
                        event.preventDefault();
                        setRailValue(id, !checked);
                      }
                    }}
                  >
                    {checked ? <Icon name="check" className="sm" /> : null}
                  </button>
                  <button type="button" className="wb-rail-main" onClick={() => openWorkbench(id)} title={summary?.name || id}>
                    <span className="wb-rail-thumb">
                      {summary ? <img src={thumbUrlRaw(summary.id, summary.thumbVersion)} alt="" loading="lazy" /> : null}
                      <span className="wb-rail-index">{filmWindow.start + index + 1}</span>
                    </span>
                    <span className="wb-rail-meta">
                      <span className="wb-rail-name">{summary?.name || id.slice(0, 8)}</span>
                      <span className="wb-rail-sub">
                        {summary ? `${summary.outWidth}×${summary.outHeight}` : "载入中…"}
                        {summary?.hasCaption ? " · 已标注" : ""}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </aside>
        <div className={classNames("wb-canvas-wrap", sideOpen && mobileSection !== "image" && "mobile-hidden")}>
          {workspace === "crop" ? (
            <div className="crop-batch-bar">
              <span className="crop-batch-count"><strong>{linkedTargets.length}</strong> 张</span>
              <button
                type="button"
                className={classNames("btn sm", linked ? "secondary" : "subtle")}
                onClick={() => setLinked((value) => !value)}
                disabled={linkedTargets.length < 2}
                title={linkedTargets.length < 2 ? "至少勾选两张图片后启用" : "应用裁剪时同步到所有选中图片"}
              >
                <Icon name="link" className="sm" />
                {linked ? "联动已开启" : "联动调整"}
              </button>
              <span className="hint">
                {linked ? "应用时会同步到全部选中图片" : "只应用当前图片；勾选多张可联动"}
              </span>
              <div className="spacer" />
              {batchProgress ? <span className="tiny mono">{batchProgress.done}/{batchProgress.total}</span> : null}
            </div>
          ) : (
            <>
              <div className="crop-batch-bar tag-batch-bar">
                <span className="crop-batch-count"><strong>{tagSelection.length}</strong> 张</span>
                <div className="tag-ai-controls">
                  <select
                    className="select tag-model-select"
                    value={tagModel}
                    onChange={(event) => setTagModel(event.target.value)}
                    disabled={tagModelsLoading || tagModels.length === 0 || tagBatchRunning || aiTagging}
                    title={tagModels.find((item) => item.id === tagModel)?.name || "选择 AI 打标模型"}
                  >
                    {tagModels.length === 0 ? (
                      <option value="">{tagModelsLoading ? "正在读取模型…" : "未找到模型"}</option>
                    ) : (
                      tagModels.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                          {item.kind === "caption" ? "（自然语言）" : ""}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    type="button"
                    className="btn secondary sm"
                    onClick={() => void runAiTagCurrent()}
                    disabled={!currentId || !tagModel || aiTagging || tagBatchRunning}
                    title="用所选模型为当前图片补充短语，重复项自动剔除"
                  >
                    {aiTagging ? <Spinner /> : <Icon name="sparkles" className="sm" />}
                    AI 打标
                  </button>
                </div>
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={() => void openTagBatch()}
                  disabled={tagSelection.length === 0 || tagBatchRunning || aiTagging}
                >
                  {tagBatchRunning ? <Spinner /> : <Icon name="sparkles" className="sm" />}
                  批量打标
                </button>
                <span className="hint">AI 打标当前图片；批量处理选中的 {tagSelection.length} 张</span>
                <div className="spacer" />
                {tagBatchProgress ? (
                  <span className="tiny mono">{tagBatchProgress.done}/{tagBatchProgress.total}</span>
                ) : null}
              </div>
              {tagBatchProgress ? (
                <div
                  className="tag-batch-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={tagBatchProgress.total}
                  aria-valuenow={tagBatchProgress.done}
                >
                  <span
                    style={{
                      width: `${Math.round((tagBatchProgress.done / Math.max(1, tagBatchProgress.total)) * 100)}%`,
                    }}
                  />
                </div>
              ) : null}
            </>
          )}
          <CanvasStage
            asset={detail}
            plan={plan}
            previewUrl={preview?.previewUrl || null}
            previewLoading={previewLoading}
            aspect={aspect}
            mode={mode}
            setMode={setMode}
            background={background}
            setBackground={setBackground}
            onChangeCrop={(crop) => updatePlan({ ...plan, crop })}
            active={active}
            croppable={workspace === "crop"}
          />
        </div>

        {sideOpen ? (
          <div className={classNames("wb-side", mobileSection === "image" && "mobile-hidden")}>
            <div className="wb-tabs">
              {(
                (workspace === "tag"
                  ? [
                      ["caption", S.workbench.tabs.caption, "tag"],
                      ["info", S.workbench.tabs.info, "info"],
                    ]
                  : [
                      ["crop", S.workbench.tabs.crop, "crop"],
                      ["info", S.workbench.tabs.info, "info"],
                    ]) as [Tab, string, "crop" | "tag" | "info"][]
              ).map(([tab, label, icon]) => (
                <button
                  key={tab}
                  type="button"
                  className={activeTab === tab ? "active" : ""}
                  onClick={() => setActiveTab(tab)}
                >
                  <Icon name={icon} className="sm" />
                  {label}
                </button>
              ))}
              <IconButton icon="x" label="收起面板" size="sm" onClick={() => setSideOpen(false)} />
            </div>
            <div className="wb-panel">
              {activeTab === "crop" ? (
                <CropPanel
                  plan={plan}
                  geometry={geometry}
                  aspect={aspect}
                  normWidth={detail.normWidth}
                  normHeight={detail.normHeight}
                  previewUrl={preview?.previewUrl || null}
                  previewLoading={previewLoading}
                  previewError={previewError}
                  dirty={planDirty}
                  draftSavedAt={draftSavedAt}
                  applying={applying}
                  onChange={updatePlan}
                  onAspect={setAspect}
                  onRotate={rotate}
                  onFlip={flip}
                  onCenter={centerCrop}
                  onResetCrop={resetCrop}
                  onApply={() => void applyPlan()}
                  onDiscard={() => void discardDraft()}
                />
              ) : activeTab === "caption" ? (
                <CaptionPanel
                  assetId={detail.summary.id}
                  mode={captionMode}
                  tags={tags}
                  text={captionText}
                  finalText={finalText}
                  stats={stats}
                  saveState={captionSaveState}
                  triggerWord={triggerWord}
                  triggerDisabled={detail.summary.triggerDisabled}
                  onChange={updateCaption}
                  onToggleTrigger={(disabled) => void toggleTrigger(disabled)}
                  onSaveNow={() => void saveCaptionNow()}
                />
              ) : (
                <InfoPanel detail={detail} onPatch={(patch, label) => void handlePatch(patch, label)} onRelink={(root) => void relink(root)} />
              )}
            </div>
          </div>
        ) : null}
      </div>

      <div className="wb-reviewbar">
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => navigate(workspace === "tag" ? "crop" : "library")}
        >
          <Icon name="back" className="sm" />
          <span className="label">{workspace === "tag" ? "返回裁剪" : "返回导入"}</span>
        </button>
        <button type="button" className="btn subtle sm" onClick={reveal}>
          <Icon name="folder-open" className="sm" />
          <span className="label">定位源文件</span>
        </button>
        <div className="spacer" />
        {workspace === "crop" ? (
          <>
            <span className="hint wb-review-hint">
              {linked && linkedTargets.length > 1
                ? `联动已选中 ${linkedTargets.length} 张，应用时同步裁剪`
                : "单张裁剪；勾选素材列表后可使用联动"}
            </span>
            <button
              type="button"
              className="btn subtle"
              onClick={() => void applyPlan()}
              disabled={applying || !planDirty}
            >
              {applying ? <Spinner /> : <Icon name="crop" />}
              {linked && linkedTargets.length > 1 ? `应用到选中 ${linkedTargets.length} 张` : "应用裁剪"}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={applying}
              onClick={() => {
                void (async () => {
                  if (planDirty) {
                    const applied = await applyPlan();
                    if (!applied) return;
                  }
                  navigate("tag");
                })();
              }}
            >
              {applying ? <Spinner /> : <Icon name="arrow-right" />}
              保存并进入打标
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn subtle" onClick={() => void requestReview("review", undefined, false)} disabled={reviewBusy}>
              {S.workbench.markReview}
            </button>
            <button type="button" className="btn danger" onClick={() => setExcludeOpen(true)} disabled={reviewBusy}>
              {S.workbench.exclude}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void requestReview("approved", undefined, true)}
              disabled={reviewBusy}
            >
              {reviewBusy ? <Spinner /> : <Icon name="check" />}
              {S.workbench.passNext}
            </button>
          </>
        )}
      </div>

      <PromptDialog
        open={excludeOpen}
        title={S.workbench.excludeTitle}
        body={S.workbench.excludeBody}
        label={S.workbench.excludeReason}
        placeholder={S.workbench.excludeReasonPlaceholder}
        danger
        confirmLabel={S.workbench.excludeConfirm}
        onSubmit={(value) => {
          setExcludeOpen(false);
          void requestReview("excluded", value, true);
        }}
        onClose={() => setExcludeOpen(false)}
      />

      <Modal
        open={pendingReview !== null}
        onClose={() => setPendingReview(null)}
        title={S.workbench.drafts}
        subtitle="当前裁剪配方尚未应用，审核会关联已确认的版本。"
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setPendingReview(null)}>
              {S.common.cancel}
            </button>
            <button
              type="button"
              className="btn subtle"
              onClick={() => {
                const pending = pendingReview;
                setPendingReview(null);
                void (async () => {
                  await discardDraft();
                  if (pending) await performReview(pending.status, pending.reason, pending.next);
                })();
              }}
            >
              {S.workbench.discardDraft}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={applying}
              onClick={() => {
                const pending = pendingReview;
                setPendingReview(null);
                void (async () => {
                  const applied = await applyPlan();
                  if (applied && pending) {
                    await performReview(pending.status, pending.reason, pending.next);
                  }
                })();
              }}
            >
              {applying ? <Spinner /> : null}
              {S.workbench.applyDraft}
            </button>
          </>
        }
      >
        <Notice tone="warning">{S.workbench.draftSaved}</Notice>
        <p className="hint" style={{ marginTop: 8 }}>
          应用后会生成新的处理配方版本；放弃则恢复最近确认的裁剪。
        </p>
      </Modal>

      <Modal
        open={tagBatchOpen}
        onClose={() => {
          if (!tagBatchRunning) setTagBatchOpen(false);
        }}
        title="批量一键打标"
        subtitle={`为选中的 ${tagSelection.length} 张图片生成并追加短语标签或自然语言描述。`}
        width="wide"
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setTagBatchOpen(false)}>
              {S.common.cancel}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!tagModel || tagSelection.length === 0}
              onClick={() => void runTagBatch()}
            >
              <Icon name="sparkles" />
              开始打标
            </button>
          </>
        }
      >
        {tagModelsLoading ? (
          <div className="tag-model-loading">
            <Spinner /> 正在读取本地 WD14 模型…
          </div>
        ) : tagModels.length === 0 ? (
          <Notice tone="warning">
            未找到可用的 WD14 标签模型。请先在设置中下载或指定模型目录；Florence-2 权重可单独下载，但当前批量打标使用 WD14。
          </Notice>
        ) : (
          <div className="model-download-list">
            {tagModels.map((item) => (
              <label
                key={item.id}
                className={classNames("model-download-row", tagModel === item.id && "selected")}
              >
                <input
                  type="radio"
                  name="tag-batch-model"
                  value={item.id}
                  checked={tagModel === item.id}
                  onChange={() => setTagModel(item.id)}
                />
                <span className="grow">
                  <span className="model-download-name">{item.name}</span>
                  <span className="model-download-meta">
                    {modelKindLabel(item)} · {item.version} · {formatBytes(item.sizeBytes)} ·{" "}
                    {item.device}
                  </span>
                  <span className="model-download-note">{modelDescription(item)}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        <Notice tone="info">
          WD14 生成短语标签，Florence-2 生成自然语言描述并按句拆成多条短语；建议会追加到现有标注并剔除重复项，图片不会上传。Florence-2 需要 Python 安装 torch、transformers、einops，并可在设置中指定该 Python 路径。
        </Notice>
      </Modal>
    </div>
  );
}
