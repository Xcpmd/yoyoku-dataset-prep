import { useCallback, useEffect, useMemo, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { AppSettings, ModelCatalogEntry, ModelInfo, StorageStats } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { useRoot } from "../../app/AppProvider";
import { S } from "../../lib/strings";
import {
  classNames,
  copyText,
  formatBytes,
  formatDate,
  formatNumber,
  prettyPath,
} from "../../lib/utils";
import { Icon } from "../../components/Icon";
import {
  Badge,
  ConfirmDialog,
  Field,
  Modal,
  Notice,
  Segmented,
  Select,
  Spinner,
  Toggle,
} from "../../components/ui";
import { RegexGuide } from "./RegexGuide";
import { VisionSettings } from "./VisionSettings";

interface Thresholds {
  lowResolutionRatio: number;
  extremeAspect: number;
  cropRatio: number;
  padRatio: number;
  duplicateDistance: number;
  duplicateWeight: number;
  exposureRatio: number;
  blurEnabled: boolean;
  blurThreshold: number;
  maxCaptionChars: number;
}

const DEFAULT_THRESHOLDS: Thresholds = {
  lowResolutionRatio: 0.5,
  extremeAspect: 3,
  cropRatio: 0.3,
  padRatio: 0.25,
  duplicateDistance: 8,
  duplicateWeight: 0.8,
  exposureRatio: 0.4,
  blurEnabled: false,
  blurThreshold: 60,
  maxCaptionChars: 320,
};

export function SettingsPage({ active }: { active: boolean }) {
  const {
    project,
    settings,
    updateSettings,
    refreshProject,
    appInfo,
    notify,
    closeProject,
    navigate,
  } = useProject();
  const root = useRoot();
  const [projectName, setProjectName] = useState(project.name);
  const [model, setModel] = useState(project.model);
  const [triggerWord, setTriggerWord] = useState(project.triggerWord);
  const [triggerMode, setTriggerMode] = useState(project.triggerMode);
  const [defaultMode, setDefaultMode] = useState<"tags" | "nl" | "mixed">(project.defaultCaptionMode);
  const [thresholds, setThresholds] = useState<Thresholds>({
    ...DEFAULT_THRESHOLDS,
    ...(project.settings.thresholds || {}),
  });
  const [savingProject, setSavingProject] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [pythonPath, setPythonPath] = useState(settings.pythonPath || "");
  const [modelsDir, setModelsDir] = useState(settings.modelsDir || "");
  const [imageSlots, setImageSlots] = useState(settings.imageSlots || 4);
  const [translateAppId, setTranslateAppId] = useState(settings.baiduTranslateAppId || "");
  const [translateKey, setTranslateKey] = useState(settings.baiduTranslateKey || "");
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [portable, setPortable] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupInfo, setBackupInfo] = useState<{ path: string; missing: string[] } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restorePending, setRestorePending] = useState<{ zip: string; target: string } | null>(null);
  const [clearPending, setClearPending] = useState(false);
  const [modelPending, setModelPending] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadId, setDownloadId] = useState("");

  useEffect(() => {
    setProjectName(project.name);
    setModel(project.model);
    setTriggerWord(project.triggerWord);
    setTriggerMode(project.triggerMode);
    setDefaultMode(project.defaultCaptionMode);
    setThresholds({ ...DEFAULT_THRESHOLDS, ...(project.settings.thresholds || {}) });
  }, [project]);

  useEffect(() => {
    setPythonPath(settings.pythonPath || "");
    setModelsDir(settings.modelsDir || "");
    setImageSlots(settings.imageSlots || 4);
    setTranslateAppId(settings.baiduTranslateAppId || "");
    setTranslateKey(settings.baiduTranslateKey || "");
  }, [
    settings.pythonPath,
    settings.modelsDir,
    settings.imageSlots,
    settings.baiduTranslateAppId,
    settings.baiduTranslateKey,
  ]);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    setModelError(null);
    try {
      const [list, entries] = await Promise.all([
        api.models(),
        api.modelCatalog().catch(() => [] as ModelCatalogEntry[]),
      ]);
      setModels(list.filter((item) => item.kind !== "vlm"));
      setCatalog(entries);
      setDownloadId((current) => current || entries.find((entry) => !entry.installed)?.id || entries[0]?.id || "");
    } catch (error) {
      setModelError(normalizeError(error).message);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (root.modelRevision > 0) void loadModels();
  }, [root.modelRevision, loadModels]);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      setStats(await api.storageStats());
    } catch {
      // ignore
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    if (active) void loadStats();
  }, [active, loadStats]);

  const storageTotal = useMemo(() => {
    if (!stats) return 0;
    return (
      stats.originalsBytes +
      stats.cacheBytes +
      stats.stagingBytes +
      stats.exportsBytes +
      stats.databaseBytes
    );
  }, [stats]);

  const saveProject = async (recompute = false) => {
    setSavingProject(true);
    try {
      await api.updateProject({
        name: projectName.trim() || project.name,
        model,
        triggerWord,
        triggerMode,
        defaultCaptionMode: defaultMode,
        settings: {
          thresholds,
          ...(model !== project.model
            ? { resolution: model === "sd15" ? [512, 512] : [1024, 1024] }
            : {}),
        },
        recompute,
      });
      await refreshProject();
      notify({ tone: "success", message: S.settings.projectSaved });
      if (recompute) {
        try {
          const result = await api.runQuality();
          notify({
            tone: "success",
            message: S.quality.scanSummary(result.summary.blocking, result.summary.suggestions),
          });
        } catch {
          // 仅标记为待重算
        }
      }
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    } finally {
      setSavingProject(false);
    }
  };

  const saveRuntimeSettings = async () => {
    await updateSettings({
      pythonPath: pythonPath.trim() || null,
      modelsDir: modelsDir.trim() || null,
      imageSlots: Math.min(8, Math.max(1, Math.round(imageSlots) || 4)),
    });
    notify({ message: S.settings.restartRequired });
    await loadModels();
  };

  const pickModelsDir = async () => {
    const folder = await api.pickFolder("选择模型目录");
    if (folder) setModelsDir(folder);
  };

  const saveTranslateSettings = async () => {
    await updateSettings({
      baiduTranslateAppId: translateAppId.trim() || null,
      baiduTranslateKey: translateKey.trim() || null,
    });
    notify({ message: "提示词翻译设置已保存" });
  };

  const startModelDownload = async () => {
    if (!downloadId) return;
    const entry = catalog.find((item) => item.id === downloadId);
    root.startModelDownload(downloadId, entry?.name || downloadId);
    setDownloadOpen(false);
  };

  const testWorker = async () => {
    setTesting(true);
    const ok = await root.pingWorker();
    setTesting(false);
    notify({
      tone: ok ? "success" : "danger",
      title: ok ? S.settings.workerOk : S.settings.workerFail,
      message: ok ? appInfo?.workerPython || "运行时正常" : appInfo?.workerError || "运行时不可用",
    });
  };

  const clearCache = async () => {
    try {
      const next = await api.clearCache();
      setStats(next);
      setClearPending(false);
      notify({ tone: "success", message: S.settings.cacheCleared });
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  const startBackup = async () => {
    const path = await api.saveZip(`${project.name.replace(/[\\/:*?"<>|]/g, "_")}-backup.zip`);
    if (!path) return;
    setBackupBusy(true);
    setBackupInfo(null);
    try {
      const result = await api.backupProject({ destPath: path, portable });
      setBackupInfo({ path: result.path, missing: result.missing });
      notify({
        tone: result.missing.length > 0 ? "warning" : "success",
        title: S.settings.backupDone,
        message: result.path,
      });
      await loadStats();
    } catch (error) {
      notify({ tone: "danger", title: "备份失败", message: normalizeError(error).message });
    } finally {
      setBackupBusy(false);
    }
  };

  const beginRestore = async () => {
    const zip = await api.pickZip("选择 Yoyoku 备份");
    if (!zip) return;
    const target = await api.pickFolder("选择恢复位置");
    if (!target) return;
    setRestorePending({ zip, target });
  };

  const restore = async () => {
    if (!restorePending) return;
    setRestoreBusy(true);
    try {
      const result = await api.restoreProject(restorePending.zip, restorePending.target);
      setRestorePending(null);
      notify({
        tone: "success",
        title: S.settings.restoreDone,
        message: result.restoredPath,
      });
    } catch (error) {
      notify({ tone: "danger", title: "恢复失败", message: normalizeError(error).message });
    } finally {
      setRestoreBusy(false);
    }
  };

  const diagnostic = async () => {
    const text = [
      `${S.app.name} ${appInfo?.version || ""}`,
      `项目：${project.id} / ${project.name}`,
      `根目录：${project.root}`,
      `模型：${project.model}`,
      `图片：${project.counts.total}`,
      `运行时：${appInfo?.workerPython || "—"}`,
      `运行时错误：${appInfo?.workerError || "无"}`,
      `数据目录：${appInfo?.dataDir || "—"}`,
    ].join("\n");
    const ok = await copyText(text);
    notify({ tone: ok ? "success" : "danger", message: ok ? S.settings.diagnosticCopied : S.errors.clipboard });
  };

  const bar = (label: string, bytes: number, color?: string) => (
    <div className="storage-row" key={label}>
      <div className="storage-top">
        <span>{label}</span>
        <span>{formatBytes(bytes)}</span>
      </div>
      <div className="storage-bar">
        <span
          style={{
            width: `${storageTotal > 0 ? Math.max(1, (bytes / storageTotal) * 100) : 0}%`,
            background: color,
          }}
        />
      </div>
    </div>
  );

  return (
    <div className="page">
      <div className="settings-page">
        <div className="settings-head">
          <div>
            <h1 className="page-title">{S.settings.title}</h1>
            <div className="page-subtitle">
              {project.name} · 项目设置、本地模型与存储诊断
            </div>
          </div>
          <div className="spacer" />
          <button type="button" className="btn subtle" onClick={() => navigate("library")}>
            <Icon name="arrow-left" />
            返回图库
          </button>
        </div>

        <div className="settings-grid">
          <section className="settings-card">
            <h3><Icon name="sun" />{S.settings.appearance}</h3>
            <div className="theme-cards">
              {(
                [
                  ["system", S.settings.themeSystem, "system", "monitor"],
                  ["light", S.settings.themeLight, "light", "sun"],
                  ["dark", S.settings.themeDark, "dark", "moon"],
                ] as const
              ).map(([value, label, swatch, icon]) => (
                <button
                  key={value}
                  type="button"
                  className={classNames("theme-card", settings.theme === value && "active")}
                  onClick={() => void updateSettings({ theme: value })}
                >
                  <span className={`theme-swatch ${swatch}`}>
                    <span className="swatch-page" />
                    <span className="swatch-panel" />
                  </span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <div className="settings-row">
              <div className="settings-label">{S.settings.density}</div>
              <div className="settings-control">
                <Segmented
                  value={settings.density}
                  onChange={(value) => void updateSettings({ density: value as "comfortable" | "compact" })}
                  options={[
                    { value: "comfortable", label: S.settings.comfortable },
                    { value: "compact", label: S.settings.compact },
                  ]}
                  compact
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-label">
                {S.settings.reduceTransparency}
                <small>{S.settings.reduceTransparencyHint}</small>
              </div>
              <div className="settings-control" style={{ maxWidth: 90 }}>
                <Toggle
                  checked={settings.reduceTransparency}
                  onChange={(value) => void updateSettings({ reduceTransparency: value })}
                  label=""
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-label">
                {S.settings.reduceMotion}
                <small>{S.settings.reduceMotionHint}</small>
              </div>
              <div className="settings-control" style={{ maxWidth: 90 }}>
                <Toggle
                  checked={settings.reduceMotion}
                  onChange={(value) => void updateSettings({ reduceMotion: value })}
                  label=""
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-label">
                {S.settings.smoothZoom}
                <small>{S.settings.smoothZoomHint}</small>
              </div>
              <div className="settings-control" style={{ maxWidth: 90 }}>
                <Toggle
                  checked={settings.smoothZoom}
                  onChange={(value) => void updateSettings({ smoothZoom: value })}
                  label=""
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-label">{S.settings.highContrast}</div>
              <div className="settings-control" style={{ maxWidth: 90 }}>
                <Toggle
                  checked={settings.highContrast}
                  onChange={(value) => void updateSettings({ highContrast: value })}
                  label=""
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-label">{S.settings.largeText}</div>
              <div className="settings-control" style={{ maxWidth: 90 }}>
                <Toggle
                  checked={settings.largeText}
                  onChange={(value) => void updateSettings({ largeText: value })}
                  label=""
                />
              </div>
            </div>
            <Field label={`${S.settings.gridCard} · ${settings.gridCardMin}px`}>
              <input
                type="range"
                min={112}
                max={168}
                step={4}
                value={settings.gridCardMin}
                onChange={(event) => void updateSettings({ gridCardMin: Number(event.target.value) })}
              />
            </Field>
            <Field label={`${S.settings.inspectorWidth} · ${settings.inspectorWidth}px`}>
              <input
                type="range"
                min={280}
                max={420}
                step={8}
                value={settings.inspectorWidth}
                onChange={(event) => void updateSettings({ inspectorWidth: Number(event.target.value) })}
              />
            </Field>
          </section>

          <section className="settings-card">
            <h3><Icon name="settings" />{S.settings.project}</h3>
            <Field label={S.settings.projectName}>
              <input className="input" value={projectName} onChange={(event) => setProjectName(event.target.value)} />
            </Field>
            <div className="grid-2">
              <Field label={S.settings.baseModel} hint={`当前 ${formatNumber(project.counts.total)} 张图片；更改模型不会自动重算处理配方。`}>
                <Select
                  value={model}
                  onChange={(next) => {
                    if (project.counts.total > 0 && next !== model) setModelPending(next);
                    else setModel(next);
                  }}
                  ariaLabel={S.settings.baseModel}
                  options={[
                    { value: "sdxl", label: "SDXL（1024 基准）" },
                    { value: "sd15", label: "SD 1.5（512 基准）" },
                    { value: "custom", label: "自定义" },
                  ]}
                />
              </Field>
              <Field label={S.settings.defaultCaptionMode}>
                <Segmented
                  value={defaultMode}
                  onChange={(value) => setDefaultMode(value as "tags" | "nl" | "mixed")}
                  options={[
                    { value: "tags", label: S.settings.tags },
                    { value: "nl", label: S.settings.nl },
                    { value: "mixed", label: "短语 + 自然语言" },
                  ]}
                />
              </Field>
            </div>
            <Field label={S.settings.triggerWord}>
              <input className="input" value={triggerWord} onChange={(event) => setTriggerWord(event.target.value)} />
            </Field>
            <Field label={S.settings.triggerMode}>
              <Select
                value={triggerMode}
                onChange={setTriggerMode}
                ariaLabel={S.settings.triggerMode}
                options={[
                  { value: "first", label: S.settings.triggerFirst },
                  { value: "prefix", label: S.settings.triggerPrefix },
                  { value: "manual", label: S.settings.triggerManual },
                ]}
              />
            </Field>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn subtle" onClick={() => void saveProject(false)} disabled={savingProject}>
                {savingProject ? <Spinner /> : <Icon name="save" />}
                {S.settings.saveProject}
              </button>
              <button type="button" className="btn primary" onClick={() => void saveProject(true)} disabled={savingProject}>
                {savingProject ? <Spinner /> : <Icon name="shield" />}
                {S.settings.recompute}
              </button>
            </div>
          </section>

          <RegexGuide />
          <VisionSettings active={active} />

          <section className="settings-card full">
            <h3><Icon name="shield" />{S.settings.thresholds}</h3>
            <div className="settings-grid" style={{ gap: 12 }}>
              <Field label={`${S.settings.lowResolutionRatio} · ${Math.round(thresholds.lowResolutionRatio * 100)}%`}>
                <input
                  type="range"
                  min={20}
                  max={100}
                  step={5}
                  value={Math.round(thresholds.lowResolutionRatio * 100)}
                  onChange={(event) =>
                    setThresholds({ ...thresholds, lowResolutionRatio: Number(event.target.value) / 100 })
                  }
                />
              </Field>
              <Field label={S.settings.extremeAspect}>
                <input
                  className="input number"
                  type="number"
                  min={1.5}
                  max={10}
                  step={0.1}
                  value={thresholds.extremeAspect}
                  onChange={(event) => setThresholds({ ...thresholds, extremeAspect: Number(event.target.value) })}
                />
              </Field>
              <Field label={`${S.settings.cropRatio} · ${Math.round(thresholds.cropRatio * 100)}%`}>
                <input
                  type="range"
                  min={5}
                  max={90}
                  step={5}
                  value={Math.round(thresholds.cropRatio * 100)}
                  onChange={(event) => setThresholds({ ...thresholds, cropRatio: Number(event.target.value) / 100 })}
                />
              </Field>
              <Field label={`${S.settings.padRatio} · ${Math.round(thresholds.padRatio * 100)}%`}>
                <input
                  type="range"
                  min={5}
                  max={80}
                  step={5}
                  value={Math.round(thresholds.padRatio * 100)}
                  onChange={(event) => setThresholds({ ...thresholds, padRatio: Number(event.target.value) / 100 })}
                />
              </Field>
              <Field label={S.settings.duplicateDistance}>
                <input
                  className="input number"
                  type="number"
                  min={1}
                  max={16}
                  value={thresholds.duplicateDistance}
                  onChange={(event) => setThresholds({ ...thresholds, duplicateDistance: Number(event.target.value) })}
                />
              </Field>
              <Field label={`${S.settings.exposureRatio} · ${Math.round(thresholds.exposureRatio * 100)}%`}>
                <input
                  type="range"
                  min={10}
                  max={90}
                  step={5}
                  value={Math.round(thresholds.exposureRatio * 100)}
                  onChange={(event) => setThresholds({ ...thresholds, exposureRatio: Number(event.target.value) / 100 })}
                />
              </Field>
              <Field label={S.settings.maxCaptionChars}>
                <input
                  className="input number"
                  type="number"
                  min={40}
                  max={2000}
                  value={thresholds.maxCaptionChars}
                  onChange={(event) => setThresholds({ ...thresholds, maxCaptionChars: Number(event.target.value) })}
                />
              </Field>
              <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
                <Toggle
                  checked={thresholds.blurEnabled}
                  onChange={(value) => setThresholds({ ...thresholds, blurEnabled: value })}
                  label={S.settings.blurEnabled}
                />
                <Field label={S.settings.blurThreshold}>
                  <input
                    className="input number"
                    type="number"
                    min={0}
                    step={5}
                    value={thresholds.blurThreshold}
                    onChange={(event) => setThresholds({ ...thresholds, blurThreshold: Number(event.target.value) })}
                  />
                </Field>
              </div>
            </div>
            <span className="hint">{S.settings.recomputeHint}</span>
          </section>

          <section className="settings-card full">
            <h3><Icon name="sparkles" />提示词翻译</h3>
            <p className="hint">
              未配置百度翻译时使用 MyMemory，百度请求失败时也会回退。
            </p>
            <div className="grid-2">
              <Field label="百度翻译 AppID">
                <input
                  className="input mono"
                  value={translateAppId}
                  onChange={(event) => setTranslateAppId(event.target.value)}
                  placeholder="可选"
                />
              </Field>
              <Field label="百度翻译密钥">
                <input
                  className="input mono"
                  type="password"
                  value={translateKey}
                  onChange={(event) => setTranslateKey(event.target.value)}
                  placeholder="可选"
                />
              </Field>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn subtle sm" onClick={() => void saveTranslateSettings()}>
                <Icon name="save" className="sm" />
                保存翻译设置
              </button>
            </div>
          </section>

          <section className="settings-card full">
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <h3><Icon name="sparkles" />{S.settings.localModels}</h3>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn secondary sm" onClick={() => setDownloadOpen(true)}>
                  <Icon name="download" className="sm" />
                  下载模型
                </button>
                <button type="button" className="btn ghost sm" onClick={() => void loadModels()} disabled={modelsLoading}>
                  {modelsLoading ? <Spinner /> : <Icon name="refresh" className="sm" />}
                  {S.common.refresh}
                </button>
                <button type="button" className="btn subtle sm" onClick={() => void api.openModelsDir().catch((error) => notify({ tone: "danger", message: normalizeError(error).message }))}>
                  <Icon name="folder-open" className="sm" />
                  {S.settings.openModelDir}
                </button>
              </div>
            </div>
            <p className="hint">
              本地模型只在本机运行，不上传图片。WD14 适配器从模型目录读取 model.onnx 与 selected_tags.csv。
            </p>
            {modelError ? <Notice tone="danger">{modelError}</Notice> : null}
            {models.length === 0 && !modelsLoading ? (
              <Notice tone="warning">未找到本地模型。可在下方指定模型目录，或把 WD14 ONNX 模型放入默认模型目录。</Notice>
            ) : (
              <table className="model-table">
                <thead>
                  <tr>
                    <th>{S.settings.modelName}</th>
                    <th>{S.settings.modelUse}</th>
                    <th>{S.settings.modelVersion}</th>
                    <th>{S.settings.modelSize}</th>
                    <th>{S.settings.modelDevice}</th>
                    <th>{S.settings.modelStatus}</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{item.name}</div>
                        <div className="mono" style={{ fontSize: 10, color: "var(--faint)", maxWidth: 260, overflowWrap: "anywhere" }}>
                          {item.path}
                        </div>
                      </td>
                      <td>{item.kind === "wd14-tagger" ? "标签建议" : "自然语言描述"}</td>
                      <td>{item.version}</td>
                      <td>{item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : "—"}</td>
                      <td>{item.device}</td>
                      <td>
                        <Badge tone={item.status === "available" ? "success" : "warning"}>
                          {item.status === "available" ? S.settings.modelAvailable : S.settings.modelUnavailable}
                        </Badge>
                        <div className="hint" style={{ marginTop: 4, maxWidth: 240 }}>{item.note}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="grid-2">
              <Field label={S.settings.modelsDir}>
                <div className="input-row">
                  <input
                    className="input mono"
                    style={{ fontSize: 11 }}
                    value={modelsDir}
                    onChange={(event) => setModelsDir(event.target.value)}
                    placeholder="自动检测 wd14Tagger/models"
                  />
                  <button type="button" className="btn subtle" onClick={() => void pickModelsDir()}>
                    <Icon name="folder-open" />
                  </button>
                </div>
              </Field>
              <Field label={S.settings.pythonPath} hint={S.settings.pythonHint}>
                <div className="input-row">
                  <input
                    className="input mono"
                    style={{ fontSize: 11 }}
                    value={pythonPath}
                    onChange={(event) => setPythonPath(event.target.value)}
                    placeholder="自动检测 python"
                  />
                  <button type="button" className="btn subtle" onClick={() => void saveRuntimeSettings()}>
                    <Icon name="save" />
                  </button>
                </div>
              </Field>
              <Field label="图像处理并发" hint="1–8 个本地图像进程；批量导入时提高可加速，过大占用更多内存，重启后生效。">
                <input
                  className="input number"
                  type="number"
                  min={1}
                  max={8}
                  value={imageSlots}
                  onChange={(event) => setImageSlots(Number(event.target.value) || 2)}
                />
              </Field>
            </div>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span className="hint">
                运行时：{appInfo?.workerPython || "—"} · {appInfo?.workerReady ? "可用" : "未就绪"}
                {appInfo?.workerError ? ` · ${appInfo.workerError}` : ""}
              </span>
              <button type="button" className="btn subtle" onClick={() => void testWorker()} disabled={testing}>
                {testing ? <Spinner /> : <Icon name="play" />}
                {S.settings.testWorker}
              </button>
            </div>
          </section>

          <section className="settings-card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3><Icon name="hard-drive" />{S.settings.storage}</h3>
              <button type="button" className="btn ghost sm" onClick={() => void loadStats()} disabled={statsLoading}>
                {statsLoading ? <Spinner /> : <Icon name="refresh" className="sm" />}
              </button>
            </div>
            {stats ? (
              <>
                <div className="path-block">{prettyPath(stats.projectRoot)}</div>
                <div className="storage-bars">
                  {bar(S.settings.originals, stats.originalsBytes)}
                  {bar(S.settings.cache, stats.cacheBytes, "var(--warning)")}
                  {bar(S.settings.exports, stats.exportsBytes, "var(--success)")}
                  {bar(S.settings.staging, stats.stagingBytes, "var(--danger)")}
                  {bar(S.settings.database, stats.databaseBytes, "var(--muted)")}
                </div>
                <div className="meta-grid">
                  <div className="meta-item">
                    <div className="k">{S.settings.assets}</div>
                    <div className="v">{formatNumber(stats.assets)}</div>
                  </div>
                  <div className="meta-item">
                    <div className="k">{S.settings.cacheFiles}</div>
                    <div className="v">{formatNumber(stats.cacheFiles)}</div>
                  </div>
                  <div className="meta-item">
                    <div className="k">{S.settings.thumbnails}</div>
                    <div className="v">{formatBytes(stats.thumbBytes)}</div>
                  </div>
                  <div className="meta-item">
                    <div className="k">{S.settings.display}</div>
                    <div className="v">{formatBytes(stats.displayBytes)}</div>
                  </div>
                </div>
                <div className="row-wrap">
                  <button type="button" className="btn subtle" onClick={() => setClearPending(true)}>
                    <Icon name="broom" />
                    {S.settings.clearCache}
                  </button>
                  <button type="button" className="btn ghost" onClick={() => void api.revealPath(prettyPath(stats.projectRoot))}>
                    <Icon name="folder-open" />
                    {S.settings.openProjectDir}
                  </button>
                </div>
              </>
            ) : (
              <div className="loading-line"><Spinner /> 正在统计存储占用…</div>
            )}
          </section>

          <section className="settings-card">
            <h3><Icon name="database" />{S.settings.backup}</h3>
            <p className="hint">{S.settings.backupBody}</p>
            <Toggle checked={portable} onChange={setPortable} label={S.settings.portable} />
            <div className="row-wrap">
              <button type="button" className="btn primary" onClick={() => void startBackup()} disabled={backupBusy}>
                {backupBusy ? <Spinner /> : <Icon name="archive" />}
                {backupBusy ? S.settings.backingUp : S.settings.backupNow}
              </button>
              <button type="button" className="btn subtle" onClick={() => void beginRestore()} disabled={restoreBusy}>
                {restoreBusy ? <Spinner /> : <Icon name="restore" />}
                {restoreBusy ? S.settings.restoring : S.settings.restore}
              </button>
            </div>
            {backupInfo ? (
              <div className="well">
                <div className="small" style={{ fontWeight: 600 }}>{S.settings.backupDone}</div>
                <div className="path-block" style={{ marginTop: 6 }}>{prettyPath(backupInfo.path)}</div>
                {backupInfo.missing.length > 0 ? (
                  <Notice tone="warning" key="missing">
                    {S.settings.backupMissing}：{backupInfo.missing.slice(0, 8).join("；")}
                    {backupInfo.missing.length > 8 ? ` 等 ${backupInfo.missing.length} 项` : ""}
                  </Notice>
                ) : null}
              </div>
            ) : null}
            <hr className="divider" />
            <div className="group-title">{S.settings.appInfo}</div>
            <div className="info-row">
              <span className="k">{S.settings.version}</span>
              <span className="v mono">{appInfo?.version || "—"}</span>
            </div>
            <div className="info-row">
              <span className="k">{S.settings.dataDir}</span>
              <span className="v mono tiny">{appInfo?.dataDir || "—"}</span>
            </div>
            <div className="row-wrap">
              <button type="button" className="btn ghost sm" onClick={() => void api.workerLogs()}>
                <Icon name="file" className="sm" />
                {S.settings.openLogs}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => void diagnostic()}>
                <Icon name="copy" className="sm" />
                {S.settings.diagnosticReport}
              </button>
            </div>
          </section>

          <section className="settings-card full">
            <h3><Icon name="keyboard" />{S.settings.shortcuts}</h3>
            <p className="hint">{S.settings.shortcutsHint}</p>
            <div className="shortcut-list">
              {[
                [S.settings.shortcutOpen, ["Ctrl", "O"]],
                [S.settings.shortcutImport, ["Ctrl", "I"]],
                [S.settings.shortcutSearch, ["Ctrl", "F"]],
                [S.settings.shortcutSelectAll, ["Ctrl", "A"]],
                [S.settings.shortcutUndo, ["Ctrl", "Z"]],
                [S.settings.shortcutRedo, ["Ctrl", "Shift", "Z"]],
                [S.settings.shortcutPalette, ["Ctrl", "K"]],
                [S.settings.shortcutPass, ["Enter"]],
                [S.settings.shortcutSave, ["Ctrl", "S"]],
              ].map(([label, keys]) => (
                <div className="shortcut-row" key={label as string}>
                  <span>{label}</span>
                  <span className="shortcut-keys">
                    {(keys as string[]).map((key) => (
                      <span className="kbd" key={key}>{key}</span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <p className="hint">{S.settings.shortcutsNote}</p>
          </section>
        </div>
      </div>

      <Modal
        open={downloadOpen}
        onClose={() => setDownloadOpen(false)}
        title="下载本地模型"
        subtitle="从 Hugging Face 下载 WD14 ONNX 标签模型或 Florence-2 base-ft 权重到本机模型目录；图片不会上传。"
        width="wide"
        closeOnBackdrop
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setDownloadOpen(false)}>
              {S.common.cancel}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!downloadId}
              onClick={() => void startModelDownload()}
            >
              <Icon name="download" />
              转入后台下载
            </button>
          </>
        }
      >
        <div className="model-download-list">
          {catalog.map((entry) => (
            <label
              key={entry.id}
              className={classNames("model-download-row", downloadId === entry.id && "selected")}
            >
              <input
                type="radio"
                name="model-download"
                value={entry.id}
                checked={downloadId === entry.id}
                onChange={() => setDownloadId(entry.id)}
              />
              <span className="grow">
                <span className="model-download-name">
                  {entry.name}
                  {entry.installed ? <Badge tone="success">已安装</Badge> : null}
                </span>
                <span className="model-download-meta">
                  {entry.id.startsWith("microsoft--") ? "自然语言描述" : "标签建议"} · {entry.repo} · {entry.approxSize}
                </span>
              </span>
            </label>
          ))}
        </div>
        <Notice tone="info">
          下载将继续，可在右下角查看进度。WD14 用于短语标签，Florence-2 用于自然语言描述；依赖与运行库信息见对应模型详情。
        </Notice>
      </Modal>

      <ConfirmDialog
        open={clearPending}
        title={S.settings.clearCacheTitle}
        body={S.settings.clearCacheBody}
        confirmLabel={S.settings.clearCache}
        danger
        onClose={() => setClearPending(false)}
        onConfirm={() => void clearCache()}
      />

      <ConfirmDialog
        open={restorePending !== null}
        title={S.settings.restore}
        body={`将把备份解包到「${restorePending?.target || ""}」，然后切换到恢复出的项目。当前项目仍保留在磁盘上。`}
        confirmLabel={S.settings.restore}
        busy={restoreBusy}
        onClose={() => setRestorePending(null)}
        onConfirm={() => void restore()}
      />

      <ConfirmDialog
        open={modelPending !== null}
        title="更改基础模型？"
        body={`项目中有 ${formatNumber(project.counts.total)} 张图片。更改模型只影响默认分辨率与新建配方，不会自动重算既有裁剪；已有图片继续按各自记录解析。`}
        confirmLabel="更改模型"
        onClose={() => setModelPending(null)}
        onConfirm={() => {
          if (modelPending) setModel(modelPending);
          setModelPending(null);
        }}
      />
    </div>
  );
}
