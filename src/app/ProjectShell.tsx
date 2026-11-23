import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useRoot } from "./AppProvider";
import { ProjectProvider, type LibraryView } from "./ProjectContext";
import type { AssetFilter, AssetSort, CollectionInfo, JobInfo } from "../lib/types";
import { api, normalizeError } from "../lib/api";
import { classNames, emptyFilter } from "../lib/utils";
import { S } from "../lib/strings";
import { Icon, type IconName } from "../components/Icon";
import { Badge, ConfirmDialog, Dropdown, IconButton, MenuItem, MenuLabel, MenuSeparator } from "../components/ui";
import { WindowControls } from "../components/WindowControls";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { JobsDrawer } from "./JobsDrawer";
import { LibraryPage } from "../features/library/LibraryPage";
import { WorkbenchPage } from "../features/editor/WorkbenchPage";
import { CropBoardPage } from "../features/editor/CropBoardPage";
import {
  readCropMode,
  writeCropMode,
  type CropMode,
} from "../features/editor/CropModeSwitch";
import { QualityPage } from "../features/quality/QualityPage";
import { ExportPage } from "../features/export/ExportPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { PromptLibraryPage } from "../features/prompts/PromptLibraryPage";

const NAV: { id: string; label: string; icon: IconName }[] = [
  { id: "library", label: S.nav.library, icon: "import" },
  { id: "crop", label: S.nav.crop, icon: "crop" },
  { id: "tag", label: S.nav.tag, icon: "tag" },
  { id: "export", label: S.nav.export, icon: "export" },
];

const TERMINAL = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);

interface StoredSession {
  page?: string;
  workbenchId?: string | null;
  filter?: AssetFilter;
  sort?: AssetSort;
  view?: LibraryView;
}

function loadSession(projectId: string): StoredSession {
  try {
    const raw = localStorage.getItem(`yoyoku.session.${projectId}`);
    if (raw) return JSON.parse(raw) as StoredSession;
  } catch {
    // ignore
  }
  return {};
}

export function ProjectShell() {
  const root = useRoot();
  const project = root.project!;
  const { settings, updateSettings, appInfo, refreshProject, closeProject, notify, adoptProject } = root;

  const stored = useRef<StoredSession>(loadSession(project.id)).current;
  const storedPage = stored.page === "workbench" ? "crop" : stored.page;
  const initialPage =
    storedPage && ["library", "crop", "tag", "quality", "export", "settings", "prompts"].includes(storedPage)
      ? storedPage
      : "library";
  const [page, setPage] = useState<string>(initialPage);
  const initialCropMode = useRef<CropMode>(readCropMode()).current;
  const [cropMode, setCropModeState] = useState<CropMode>(initialCropMode);
  // 单图裁剪页沿用原工作台；首次进入后再挂载，切回瀑布流时保持挂载以便草稿落盘。
  const [cropWorkbenchReady, setCropWorkbenchReady] = useState(initialCropMode === "single");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("yoyoku.sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [visited, setVisited] = useState<Set<string>>(() => new Set([initialPage]));
  const [selection, setSelectionState] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<AssetFilter>(stored.filter || emptyFilter());
  const [sort, setSort] = useState<AssetSort>(stored.sort || { field: "import", direction: "asc" });
  const [view, setView] = useState<LibraryView>(stored.view || "grid");
  const [sequence, setSequenceState] = useState<string[]>(
    stored.workbenchId ? [stored.workbenchId] : [],
  );
  const [sequenceLabel, setSequenceLabel] = useState<string>(S.workbench.sequenceLibrary);
  const [workbenchId, setWorkbenchId] = useState<string | null>(stored.workbenchId || null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [importSignal, setImportSignal] = useState(0);
  const [searchSignal, setSearchSignal] = useState(0);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [busyClose, setBusyClose] = useState(false);

  const selectionSet = useMemo(() => new Set(selection), [selection]);
  const runningJobs = jobs.filter((job) => ["running", "queued", "paused"].includes(job.status));
  useEffect(() => {
    try {
      localStorage.setItem("yoyoku.sidebar-collapsed", sidebarCollapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }, [sidebarCollapsed]);

  const navigate = useCallback((next: string) => {
    setPage(next);
    setVisited((current) => {
      if (current.has(next)) return current;
      const updated = new Set(current);
      updated.add(next);
      return updated;
    });
  }, []);

  const setCropMode = useCallback((next: CropMode) => {
    setCropModeState(next);
    writeCropMode(next);
    if (next === "single") setCropWorkbenchReady(true);
  }, []);

  const setSelection = useCallback((ids: string[]) => {
    setSelectionState(Array.from(new Set(ids)));
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectionState((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }, []);

  const clearSelection = useCallback(() => setSelectionState([]), []);

  const setSequence = useCallback((ids: string[], label?: string) => {
    setSequenceState(ids);
    if (label) setSequenceLabel(label);
  }, []);

  const openWorkbench = useCallback(
    (id: string, options?: { sequence?: string[]; label?: string }) => {
      if (options?.sequence && options.sequence.length > 0) {
        setSequenceState(options.sequence);
        setSequenceLabel(options.label || S.workbench.sequenceLibrary);
        if (!options.sequence.includes(id)) {
          setSequenceState([id, ...options.sequence]);
        }
      } else {
        setSequenceState((current) => (current.includes(id) ? current : [id, ...current]));
      }
      setWorkbenchId(id);
      setFocusedId(id);
      navigate(page === "tag" ? "tag" : "crop");
    },
    [navigate, page],
  );

  // 单图裁剪模式首次进入时没有当前图片，自动打开筛选范围第一张，避免空白工作台。
  useEffect(() => {
    if (page !== "crop" || cropMode !== "single" || workbenchId) return;
    let cancelled = false;
    api
      .assetIds(filter)
      .then((ids) => {
        if (!cancelled && ids[0]) openWorkbench(ids[0]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [page, cropMode, workbenchId, filter, openWorkbench]);

  const goToStep = useCallback(
    async (target: string) => {
      if (target === "tag" && !workbenchId) {
        try {
          const ids = await api.assetIds(filter);
          if (ids.length > 0) {
            setSequenceState(ids);
            setSequenceLabel(S.workbench.sequenceLibrary);
            setWorkbenchId(ids[0]);
            setFocusedId(ids[0]);
          }
        } catch {
          // ignore
        }
      }
      navigate(target);
    },
    [workbenchId, filter, navigate],
  );

  const bumpRefresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
    void refreshProject();
  }, [refreshProject]);

  const reloadCollections = useCallback(async () => {
    try {
      setCollections(await api.listCollections());
    } catch {
      // ignore
    }
  }, []);

  const reloadJobs = useCallback(async () => {
    try {
      setJobs(await api.jobs());
    } catch {
      // ignore
    }
  }, []);

  const requestImport = useCallback(() => {
    navigate("library");
    setImportSignal((value) => value + 1);
  }, [navigate]);

  const requestSearch = useCallback(() => {
    navigate("library");
    window.setTimeout(() => setSearchSignal((value) => value + 1), 30);
  }, [navigate]);

  const navigateToLibrary = useCallback(
    (patch?: Partial<AssetFilter>) => {
      if (patch) setFilter((current) => ({ ...current, ...patch }));
      navigate("library");
    },
    [navigate],
  );

  useEffect(() => {
    void reloadCollections();
    void reloadJobs();
  }, [reloadCollections, reloadJobs]);

  useEffect(() => {
    try {
      localStorage.setItem(
        `yoyoku.session.${project.id}`,
        JSON.stringify({ page, workbenchId, filter, sort, view } satisfies StoredSession),
      );
    } catch {
      // ignore
    }
  }, [project.id, page, workbenchId, filter, sort, view]);

  // Jobs + asset change events
  const refreshTimer = useRef<number | undefined>(undefined);
  const statusRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    const scheduleRefresh = () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        bumpRefresh();
        void reloadCollections();
        void reloadJobs();
      }, 380);
    };

    const onTerminal = async (job: JobInfo) => {
      bumpRefresh();
      await reloadCollections();
      if (job.kind === "import") {
        const result = job.result || {};
        const success = Number(result.success || 0);
        const skipped = Number(result.skipped || 0);
        const failed = Number(result.failed || 0);
        if (job.status === "failed") {
          notify({
            tone: "danger",
            title: S.jobs.importSuccess,
            message: job.error?.message || "导入失败",
          });
        } else {
          notify({
            tone: failed > 0 ? "danger" : "success",
            title: S.jobs.importSuccess,
            message: S.jobs.importSummary(success, skipped, failed),
          });
        }
      } else if (job.kind === "export") {
        if (job.status === "failed") {
          notify({
            tone: "danger",
            title: S.jobs.exportSuccess,
            message: job.error?.message || "导出失败",
          });
        } else {
          const path = String(job.result?.outputPath || "");
          const total = Number(job.result?.counts?.total || job.total || 0);
          notify({
            tone: "success",
            title: S.jobs.exportSuccess,
            message: path || S.jobs.exportSummary(total),
          });
        }
      }
    };

    const setup = async () => {
      try {
        const initial = await api.jobs();
        if (disposed) return;
        setJobs(initial);
        statusRef.current = new Map(initial.map((job) => [job.id, job.status]));
      } catch {
        // ignore
      }
      const jobUnlisten = await listen<JobInfo>("job:update", (event) => {
        const job = event.payload;
        setJobs((current) => {
          const next = current.filter((item) => item.id !== job.id);
          return [job, ...next].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        });
        const previous = statusRef.current.get(job.id);
        statusRef.current.set(job.id, job.status);
        if (previous && previous !== job.status && TERMINAL.has(job.status) && !TERMINAL.has(previous)) {
          void onTerminal(job);
        } else if (!previous && TERMINAL.has(job.status) && job.status !== "cancelled") {
          // 应用重启后发现的任务完成状态不重复提示
        }
      });
      unlisteners.push(jobUnlisten);
      const assetsUnlisten = await listen("assets:changed", () => scheduleRefresh());
      unlisteners.push(assetsUnlisten);
    };
    void setup();

    return () => {
      disposed = true;
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [project.id, bumpRefresh, reloadCollections, reloadJobs, notify]);

  const undo = useCallback(async () => {
    try {
      const result = await api.undo();
      if (result) {
        bumpRefresh();
        window.dispatchEvent(new CustomEvent("yoyoku:undo-applied"));
        notify({
          title: S.common.undo,
          message: result.label,
          actionLabel: S.common.redo,
          onAction: () => void redoRef.current?.(),
        });
      } else {
        notify({ message: "没有可撤销的操作" });
      }
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  }, [bumpRefresh, notify]);

  const redo = useCallback(async () => {
    try {
      const result = await api.redo();
      if (result) {
        bumpRefresh();
        window.dispatchEvent(new CustomEvent("yoyoku:undo-applied"));
        notify({
          title: S.common.redo,
          message: result.label,
          actionLabel: S.common.undo,
          onAction: () => void undoRef.current?.(),
        });
      } else {
        notify({ message: "没有可重做的操作" });
      }
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  }, [bumpRefresh, notify]);

  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  undoRef.current = undo;
  redoRef.current = redo;

  // Keyboard dispatch
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target as HTMLElement | null;
      const editable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const mod = event.ctrlKey || event.metaKey;
      if (!mod && event.key === "Escape") {
        if (paletteOpen) {
          setPaletteOpen(false);
          event.preventDefault();
        } else if (jobsOpen) {
          setJobsOpen(false);
          event.preventDefault();
        }
        return;
      }
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (key === "f") {
        event.preventDefault();
        requestSearch();
        return;
      }
      if (key === "o") {
        event.preventDefault();
        void openOtherProject();
        return;
      }
      if (key === "i" && !editable) {
        event.preventDefault();
        requestImport();
        return;
      }
      if (key === "s") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("yoyoku:save"));
        return;
      }
      if (key === "z" && !editable) {
        event.preventDefault();
        if (event.shiftKey) void redo();
        else void undo();
        return;
      }
      if (key === "y" && !editable) {
        event.preventDefault();
        void redo();
        return;
      }
      if (key === "a" && !editable && page === "library") {
        event.preventDefault();
        void api
          .assetIds(filter)
          .then((ids) => setSelection(ids))
          .catch((error) =>
            notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message }),
          );
        return;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [paletteOpen, jobsOpen, page, filter, notify, requestImport, requestSearch, redo, undo]);

  const runQuality = useCallback(async () => {
    notify({ message: S.quality.rescanning });
    try {
      const result = await api.runQuality();
      bumpRefresh();
      notify({
        tone: "success",
        title: S.quality.title,
        message: S.quality.scanSummary(result.summary.blocking, result.summary.suggestions),
      });
    } catch (error) {
      notify({ tone: "danger", title: S.quality.scanFailed, message: normalizeError(error).message });
    }
  }, [bumpRefresh, notify]);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      { id: "nav-library", label: S.palette.goLibrary, icon: "import", run: () => void goToStep("library") },
      { id: "nav-crop", label: S.palette.goCrop, icon: "crop", run: () => void goToStep("crop") },
      { id: "nav-tag", label: S.palette.goTag, icon: "tag", run: () => void goToStep("tag") },
      { id: "nav-quality", label: S.palette.goQuality, icon: "quality", run: () => navigate("quality") },
      { id: "nav-prompts", label: S.nav.prompts, icon: "library", run: () => navigate("prompts") },
      { id: "nav-export", label: S.palette.goExport, icon: "export", run: () => navigate("export") },
      { id: "nav-settings", label: S.palette.goSettings, icon: "settings", run: () => navigate("settings") },
      { id: "import", label: S.palette.import, icon: "import", hint: "Ctrl+I", run: requestImport },
      { id: "quality-run", label: S.palette.rescan, icon: "refresh", run: runQuality },
      { id: "undo", label: S.palette.undo, icon: "undo", hint: "Ctrl+Z", run: undo },
      { id: "redo", label: S.palette.redo, icon: "redo", hint: "Ctrl+Shift+Z", run: redo },
      {
        id: "theme",
        label: S.palette.toggleTheme,
        icon: "sun",
        run: () => {
          const next = (document.documentElement.dataset.theme === "dark" ? "light" : "dark") as
            | "light"
            | "dark";
          void updateSettings({ theme: next });
        },
      },
      {
        id: "inspector",
        label: S.palette.toggleInspector,
        icon: "panel-right",
        run: () => {
        window.dispatchEvent(new CustomEvent("yoyoku:toggle-inspector"));
      },
      },
      {
        id: "tasks",
        label: S.palette.tasks,
        icon: "tasks",
        run: () => setJobsOpen(true),
      },
      {
        id: "project-folder",
        label: S.settings.openProjectDir,
        icon: "folder-open",
        run: () => void api.revealProject().catch(() => undefined),
      },
      {
        id: "close-project",
        label: S.palette.closeProject,
        icon: "back",
        run: () => requestClose(),
      },
    ],
    [navigate, goToStep, requestImport, runQuality, undo, redo, updateSettings],
  );

  const flushAndClose = useCallback(() => {
    window.dispatchEvent(new CustomEvent("yoyoku:save"));
    window.setTimeout(() => {
      void closeProject();
    }, 220);
  }, [closeProject]);

  const requestClose = useCallback(() => {
    if (runningJobs.length > 0) {
      setCloseConfirm(true);
    } else {
      flushAndClose();
    }
  }, [runningJobs.length, flushAndClose]);

  const openOtherProject = useCallback(async () => {
    const path = await api.pickFolder("打开项目");
    if (!path) return;
    try {
      const info = await api.openProject(path);
      adoptProject(info);
    } catch (error) {
      notify({ tone: "danger", title: S.projects.openErrorTitle, message: normalizeError(error).message });
    }
  }, [adoptProject, notify]);

  const projectModel = project.model === "sd15" ? "SD 1.5" : project.model === "sdxl" ? "SDXL" : project.model;

  const contextValue = useMemo(
    () => ({
      project,
      appInfo,
      settings,
      updateSettings,
      refreshProject,
      closeProject,
      page,
      navigate,
      selection,
      selectionSet,
      setSelection,
      toggleSelected,
      clearSelection,
      focusedId,
      setFocusedId,
      filter,
      setFilter,
      sort,
      setSort,
      view,
      setView,
      sequence,
      sequenceLabel,
      setSequence,
      workbenchId,
      openWorkbench,
      refreshToken,
      bumpRefresh,
      collections,
      reloadCollections,
      jobs,
      reloadJobs,
      jobsOpen,
      setJobsOpen,
      paletteOpen,
      setPaletteOpen,
      importSignal,
      requestImport,
      searchSignal,
      requestSearch,
      navigateToLibrary,
      notify,
    }),
    [
      project,
      appInfo,
      settings,
      updateSettings,
      refreshProject,
      closeProject,
      page,
      navigate,
      selection,
      selectionSet,
      setSelection,
      toggleSelected,
      clearSelection,
      focusedId,
      filter,
      sort,
      view,
      sequence,
      sequenceLabel,
      setSequence,
      workbenchId,
      openWorkbench,
      refreshToken,
      bumpRefresh,
      collections,
      reloadCollections,
      jobs,
      reloadJobs,
      jobsOpen,
      paletteOpen,
      importSignal,
      requestImport,
      searchSignal,
      requestSearch,
      navigateToLibrary,
      notify,
    ],
  );

  return (
    <ProjectProvider value={contextValue}>
      <div className={classNames("app-shell", sidebarCollapsed && "sidebar-collapsed")}>
        <header className="topbar" data-tauri-drag-region>
          <div className="topbar-left" data-tauri-drag-region="deep">
            <IconButton icon="back" label={S.nav.back} onClick={requestClose} />
            <div className="brand" aria-label={S.app.name}>
              <span className="brand-word">Yoyoku</span>
            </div>
            <span className="topbar-sep" />
            <Dropdown
              width={260}
              align="start"
              renderTrigger={(toggle) => (
                <button type="button" className="project-chip" onClick={toggle} aria-haspopup="menu">
                  <Icon name="layers" className="sm" />
                  <span className="name">{project.name}</span>
                  <Badge tone="info">{projectModel}</Badge>
                  <Icon name="chevron-down" className="sm" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>{project.name}</MenuLabel>
                  <div className="hint" style={{ padding: "0 10px 8px", fontFamily: "var(--font-mono)" }}>
                    {project.root}
                  </div>
                  <MenuItem
                    icon="settings"
                    onClick={() => {
                      close();
                      navigate("settings");
                    }}
                  >
                    {S.nav.settings}
                  </MenuItem>
                  <MenuItem
                    icon="folder-open"
                    onClick={() => {
                      close();
                      void api.revealProject().catch((error) =>
                        notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message }),
                      );
                    }}
                  >
                    {S.settings.openProjectDir}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon="back" onClick={() => { close(); requestClose(); }}>
                    {S.common.closeProject}
                  </MenuItem>
                </>
              )}
            </Dropdown>
          </div>
          <div className="topbar-actions">
            {!appInfo?.workerReady && appInfo?.workerError ? (
              <span className="badge danger" title={appInfo.workerError}>
                <Icon name="alert" className="sm" />
                运行时
              </span>
            ) : null}
            <button
              type="button"
              className="btn icon task-button"
              aria-label={S.nav.tasks}
              title={S.nav.tasks}
              onClick={() => setJobsOpen(true)}
            >
              <Icon name="tasks" />
              {runningJobs.length > 0 ? (
                <span className="task-dot running" />
              ) : jobs.length > 0 ? (
                <span className="task-dot" style={{ background: "var(--success)" }} />
              ) : null}
            </button>
            <button
              type="button"
              className={`btn icon ${page === "prompts" ? "active" : ""}`}
              aria-label={S.nav.prompts}
              title={S.nav.prompts}
              onClick={() => navigate("prompts")}
            >
              <Icon name="library" />
            </button>
            <button
              type="button"
              className={`btn icon ${page === "quality" ? "active" : ""}`}
              aria-label={S.nav.quality}
              title={S.nav.quality}
              onClick={() => navigate("quality")}
            >
              <Icon name="quality" />
            </button>
            <button
              type="button"
              className={`btn icon ${page === "settings" ? "active" : ""}`}
              aria-label={S.nav.settings}
              title={S.nav.settings}
              onClick={() => navigate("settings")}
            >
              <Icon name="settings" />
            </button>
            <span className="topbar-controls-sep" />
            <WindowControls />
          </div>
        </header>

        <div className="app-body">
          <aside className="sidebar" aria-label="主导航">
            <div className="sidebar-head">
              <button
                type="button"
                className="sidebar-toggle"
                onClick={() => setSidebarCollapsed((value) => !value)}
                title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
                aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
              >
                <Icon name={sidebarCollapsed ? "chevron-right" : "chevron-left"} className="sm" />
              </button>
            </div>
            <nav className="sidebar-nav">
              {NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item ${page === item.id ? "active" : ""}`}
                  onClick={() => void goToStep(item.id)}
                  aria-current={page === item.id ? "page" : undefined}
                  title={item.label}
                >
                  <Icon name={item.icon} />
                  <span className="nav-label">{item.label}</span>
                  {item.id === "library" && project.counts.valid > 0 ? (
                    <span className="count nav-badge">{project.counts.valid}</span>
                  ) : null}
                </button>
              ))}
              <div className="nav-utility-sep" />
              <button
                type="button"
                className={`nav-item nav-utility ${page === "quality" ? "active" : ""}`}
                onClick={() => navigate("quality")}
                aria-current={page === "quality" ? "page" : undefined}
                title={S.nav.quality}
              >
                <Icon name="quality" />
                <span className="nav-label">{S.nav.quality}</span>
              </button>
              <button
                type="button"
                className={`nav-item nav-utility ${page === "prompts" ? "active" : ""}`}
                onClick={() => navigate("prompts")}
                aria-current={page === "prompts" ? "page" : undefined}
                title={S.nav.prompts}
              >
                <Icon name="library" />
                <span className="nav-label">{S.nav.prompts}</span>
              </button>
            </nav>
            <div className="sidebar-foot">
              <div className="sidebar-hint">
                {project.triggerWord ? (
                  <>
                    触发词
                    <br />
                    <strong style={{ color: "var(--ink)" }}>{project.triggerWord}</strong>
                  </>
                ) : (
                  <>本地优先。源文件只读，编辑写入项目副本。</>
                )}
              </div>
            </div>
          </aside>

          <main className="main-area">
            <div className="page-stack">
              <div className="page-host" hidden={page !== "library"}>
                <LibraryPage active={page === "library"} />
              </div>
              <div className="page-host" hidden={page !== "crop" || cropMode !== "masonry"}>
                {visited.has("crop") ? (
                  <CropBoardPage
                    active={page === "crop" && cropMode === "masonry"}
                    mode={cropMode}
                    onModeChange={setCropMode}
                  />
                ) : null}
              </div>
              <div className="page-host" hidden={page !== "crop" || cropMode !== "single"}>
                {visited.has("crop") && cropWorkbenchReady ? (
                  <WorkbenchPage
                    active={page === "crop" && cropMode === "single"}
                    workspace="crop"
                    cropMode={cropMode}
                    onCropModeChange={setCropMode}
                  />
                ) : null}
              </div>
              <div className="page-host" hidden={page !== "tag"}>
                {visited.has("tag") ? <WorkbenchPage active={page === "tag"} workspace="tag" /> : null}
              </div>
              <div className="page-host" hidden={page !== "quality"}>
                {visited.has("quality") ? <QualityPage active={page === "quality"} /> : null}
              </div>
              <div className="page-host" hidden={page !== "prompts"}>
                {visited.has("prompts") ? (
                  <PromptLibraryPage active={page === "prompts"} />
                ) : null}
              </div>
              <div className="page-host" hidden={page !== "export"}>
                {visited.has("export") ? <ExportPage active={page === "export"} /> : null}
              </div>
              <div className="page-host" hidden={page !== "settings"}>
                {visited.has("settings") ? <SettingsPage active={page === "settings"} /> : null}
              </div>
            </div>
          </main>
        </div>

        <nav className="bottom-nav" aria-label="底部导航">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`bottom-nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => void goToStep(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <JobsDrawer />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
        <ConfirmDialog
          open={closeConfirm}
          title={S.common.closeProject}
          body={
            <div className="stack">
              <p>当前有 {runningJobs.length} 个未完成的任务。返回项目列表不会取消这些任务，完成后的结果仍会写入项目。</p>
              <p>建议先在任务中心等待完成，或在关闭后重新打开项目查看结果。</p>
            </div>
          }
          confirmLabel={S.common.closeProject}
          busy={busyClose}
          onClose={() => setCloseConfirm(false)}
          onConfirm={() => {
            setBusyClose(true);
            flushAndClose();
            setBusyClose(false);
          }}
        />
      </div>
    </ProjectProvider>
  );
}
