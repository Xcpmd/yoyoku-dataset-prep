import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib/api";
import type { AppInfo, AppSettings, ModelDownloadProgress, ProjectInfo, RecentProject } from "../lib/types";
import { useToast } from "../components/ui";
import { listen } from "@tauri-apps/api/event";
import { formatBytes } from "../lib/utils";

export interface ModelDownloadTask {
  modelId: string;
  name: string;
  status: "running" | "done" | "error";
  file: string;
  downloaded: number;
  total: number;
  percent: number;
  error?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  density: "comfortable",
  reduceTransparency: false,
  reduceMotion: false,
  smoothZoom: true,
  highContrast: false,
  largeText: false,
  gridCardMin: 168,
  inspectorWidth: 336,
  pythonPath: null,
  modelsDir: null,
  baiduTranslateAppId: null,
  baiduTranslateKey: null,
  imageSlots: 4,
};

interface RootContextValue {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  appInfo: AppInfo | null;
  recents: RecentProject[];
  reloadRecents: () => Promise<void>;
  project: ProjectInfo | null;
  adoptProject: (info: ProjectInfo) => void;
  refreshProject: () => Promise<void>;
  closeProject: () => Promise<void>;
  pingWorker: () => Promise<boolean>;
  ready: boolean;
  bootError: string | null;
  retryBoot: () => void;
  notify: ReturnType<typeof useToast>["push"];
  modelDownloads: ModelDownloadTask[];
  startModelDownload: (modelId: string, name: string) => void;
  dismissModelDownload: (modelId: string) => void;
  modelRevision: number;
}

const RootContext = createContext<RootContextValue | null>(null);

export function useRoot(): RootContextValue {
  const value = useContext(RootContext);
  if (!value) throw new Error("useRoot must be used inside RootProvider");
  return value;
}

function applyTheme(settings: AppSettings) {
  const root = document.documentElement;
  const effective =
    settings.theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : settings.theme;
  root.dataset.theme = effective;
  root.classList.toggle("reduce-transparency", settings.reduceTransparency);
  root.classList.toggle("reduce-motion", settings.reduceMotion);
  root.classList.toggle("high-contrast", settings.highContrast);
  root.classList.toggle("large-text", settings.largeText);
  root.classList.toggle("density-compact", settings.density === "compact");
  root.style.colorScheme = effective;
  try {
    localStorage.setItem("yoyoku-theme", settings.theme);
  } catch {
    // ignore
  }
}

export function RootProvider({ children }: { children: ReactNode }) {
  const { push } = useToast();
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const stored = localStorage.getItem("yoyoku-theme");
      if (stored === "light" || stored === "dark" || stored === "system") {
        return { ...DEFAULT_SETTINGS, theme: stored };
      }
    } catch {
      // ignore
    }
    return DEFAULT_SETTINGS;
  });
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [modelDownloads, setModelDownloads] = useState<ModelDownloadTask[]>([]);
  const [modelRevision, setModelRevision] = useState(0);

  useEffect(() => {
    applyTheme(settings);
  }, [settings]);

  useEffect(() => {
    if (settings.theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyTheme(settings);
    query.addEventListener?.("change", listener);
    return () => query.removeEventListener?.("change", listener);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    setBootError(null);
    (async () => {
      try {
        const [loadedSettings, info, recent] = await Promise.all([
          api.getSettings(),
          api.appInfo(),
          api.recentProjects(),
        ]);
        if (cancelled) return;
        setSettings(loadedSettings);
        setAppInfo(info);
        setRecents(recent);
        setReady(true);
      } catch (error) {
        if (cancelled) return;
        setBootError(error instanceof Error ? error.message : String(error));
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootAttempt]);

  const reloadRecents = useCallback(async () => {
    try {
      setRecents(await api.recentProjects());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<ModelDownloadProgress>("model:download-progress", (event) => {
      const progress = event.payload;
      setModelDownloads((current) =>
        current.map((task) =>
          task.modelId === progress.modelId
            ? {
                ...task,
                file: progress.file,
                downloaded: progress.downloaded,
                total: progress.total,
                percent: progress.percent,
              }
            : task,
        ),
      );
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const startModelDownload = useCallback(
    (modelId: string, name: string) => {
      setModelDownloads((current) => [
        ...current.filter((task) => task.modelId !== modelId),
        { modelId, name, status: "running", file: "", downloaded: 0, total: 0, percent: 0 },
      ]);
      push({ message: `${name} 已转入后台下载` });
      api
        .downloadModel(modelId)
        .then((result) => {
          setModelDownloads((current) =>
            current.map((task) =>
              task.modelId === modelId
                ? { ...task, status: "done", file: "", percent: 100, downloaded: result.bytes, total: result.bytes }
                : task,
            ),
          );
          setModelRevision((value) => value + 1);
          push({
            tone: "success",
            title: "模型下载完成",
            message: `${name} · ${formatBytes(result.bytes)}`,
          });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setModelDownloads((current) =>
            current.map((task) => (task.modelId === modelId ? { ...task, status: "error", error: message } : task)),
          );
          push({ tone: "danger", title: "模型下载失败", message });
        });
    },
    [push],
  );

  const dismissModelDownload = useCallback((modelId: string) => {
    setModelDownloads((current) => current.filter((task) => task.modelId !== modelId));
  }, []);

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const previous = settings;
      const next = { ...settings, ...patch };
      setSettings(next);
      applyTheme(next);
      try {
        const saved = await api.setSettings(next);
        setSettings(saved);
        applyTheme(saved);
      } catch (error) {
        setSettings(previous);
        applyTheme(previous);
        push({
          tone: "danger",
          title: "设置未保存",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [settings, push],
  );

  const adoptProject = useCallback((info: ProjectInfo) => {
    setProject(info);
    setRecents((current) => {
      const existing = current.find((entry) => entry.id === info.id);
      if (existing) {
        return current.map((entry) =>
          entry.id === info.id
            ? { ...entry, name: info.name, path: info.root, model: info.model, imageCount: info.counts.total, missing: false }
            : entry,
        );
      }
      return [
        {
          id: info.id,
          name: info.name,
          model: info.model,
          path: info.root,
          imageCount: info.counts.total,
          lastOpened: new Date().toISOString(),
          pinned: false,
          missing: false,
        },
        ...current,
      ];
    });
    void api.recentProjects().then(setRecents).catch(() => undefined);
  }, []);

  const refreshProject = useCallback(async () => {
    try {
      const info = await api.getProject();
      setProject(info);
    } catch {
      // project may have been closed
    }
  }, []);

  const closeProject = useCallback(async () => {
    try {
      await api.closeProject();
    } catch {
      // ignore
    }
    setProject(null);
    await reloadRecents();
  }, [reloadRecents]);

  const pingWorker = useCallback(async () => {
    try {
      const info = await api.workerPing();
      setAppInfo((current) =>
        current
          ? {
              ...current,
              workerReady: true,
              workerError: null,
              workerPython: `${info.python} · Pillow ${info.pillow}`,
            }
          : current,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAppInfo((current) => (current ? { ...current, workerReady: false, workerError: message } : current));
      return false;
    }
  }, []);

  // 启动后用一次真实 ping 验证解释器与 Pillow，避免未检测时误报就绪。
  useEffect(() => {
    if (!ready) return;
    void pingWorker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const value = useMemo<RootContextValue>(
    () => ({
      settings,
      updateSettings,
      appInfo,
      recents,
      reloadRecents,
      project,
      adoptProject,
      refreshProject,
      closeProject,
      pingWorker,
      ready,
      modelDownloads,
      startModelDownload,
      dismissModelDownload,
      modelRevision,
      bootError,
      retryBoot: () => setBootAttempt((attempt) => attempt + 1),
      notify: push,
    }),
    [
      settings,
      updateSettings,
      appInfo,
      recents,
      reloadRecents,
      project,
      adoptProject,
      refreshProject,
      closeProject,
      pingWorker,
      ready,
      bootError,
      push,
      modelDownloads,
      startModelDownload,
      dismissModelDownload,
      modelRevision,
    ],
  );

  return <RootContext.Provider value={value}>{children}</RootContext.Provider>;
}
