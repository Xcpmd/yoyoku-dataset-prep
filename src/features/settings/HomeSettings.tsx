import { useCallback, useEffect, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { ModelCatalogEntry, ModelInfo } from "../../lib/types";
import { useRoot } from "../../app/AppProvider";
import { S } from "../../lib/strings";
import { classNames, formatBytes } from "../../lib/utils";
import { Icon } from "../../components/Icon";
import { Badge, Field, Modal, Notice, Segmented, Spinner, Toggle } from "../../components/ui";
import { VisionSettings } from "./VisionSettings";

export function HomeSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, updateSettings, appInfo, notify, pingWorker, startModelDownload, modelRevision } = useRoot();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [pythonPath, setPythonPath] = useState(settings.pythonPath || "");
  const [modelsDir, setModelsDir] = useState(settings.modelsDir || "");
  const [translateAppId, setTranslateAppId] = useState(settings.baiduTranslateAppId || "");
  const [translateKey, setTranslateKey] = useState(settings.baiduTranslateKey || "");
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadId, setDownloadId] = useState("");
  const [testing, setTesting] = useState(false);

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
    if (!open) return;
    setPythonPath(settings.pythonPath || "");
    setModelsDir(settings.modelsDir || "");
    setTranslateAppId(settings.baiduTranslateAppId || "");
    setTranslateKey(settings.baiduTranslateKey || "");
    void loadModels();
  }, [open, settings.pythonPath, settings.modelsDir, settings.baiduTranslateAppId, settings.baiduTranslateKey, loadModels]);

  useEffect(() => {
    if (open && modelRevision > 0) void loadModels();
  }, [open, modelRevision, loadModels]);

  const saveRuntime = async () => {
    await updateSettings({
      pythonPath: pythonPath.trim() || null,
      modelsDir: modelsDir.trim() || null,
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

  const startDownload = () => {
    if (!downloadId) return;
    const entry = catalog.find((item) => item.id === downloadId);
    startModelDownload(downloadId, entry?.name || downloadId);
    setDownloadOpen(false);
  };

  const testWorker = async () => {
    setTesting(true);
    const ok = await pingWorker();
    setTesting(false);
    notify({
      tone: ok ? "success" : "danger",
      title: ok ? S.settings.workerOk : S.settings.workerFail,
      message: ok ? appInfo?.workerPython || "运行时正常" : appInfo?.workerError || "运行时不可用",
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="应用设置"
      width="wide"
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          完成
        </button>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
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
          {[
            [S.settings.reduceTransparency, "reduceTransparency", settings.reduceTransparency],
            [S.settings.reduceMotion, "reduceMotion", settings.reduceMotion],
            [S.settings.highContrast, "highContrast", settings.highContrast],
            [S.settings.largeText, "largeText", settings.largeText],
          ].map(([label, key, value]) => (
            <div className="settings-row" key={String(key)}>
              <div className="settings-label">{String(label)}</div>
              <div className="settings-control" style={{ maxWidth: 90 }}>
                <Toggle
                  checked={Boolean(value)}
                  onChange={(next) => void updateSettings({ [String(key)]: next })}
                  label=""
                />
              </div>
            </div>
          ))}
        </section>

        <section className="settings-card">
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

        <VisionSettings active={open} />
        <section className="settings-card">
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <h3><Icon name="sparkles" />{S.settings.localModels}</h3>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn secondary sm" onClick={() => setDownloadOpen((value) => !value)}>
                <Icon name="download" className="sm" />
                下载模型
              </button>
              <button type="button" className="btn ghost sm" onClick={() => void loadModels()} disabled={modelsLoading}>
                {modelsLoading ? <Spinner /> : <Icon name="refresh" className="sm" />}
                {S.common.refresh}
              </button>
              <button
                type="button"
                className="btn subtle sm"
                onClick={() =>
                  void api.openModelsDir().catch((error) =>
                    notify({ tone: "danger", message: normalizeError(error).message }),
                  )
                }
              >
                <Icon name="folder-open" className="sm" />
                {S.settings.openModelDir}
              </button>
            </div>
          </div>
          <p className="hint">
            本地模型只在本机运行，不上传图片。下载将继续，可在右下角查看进度。
          </p>
          {modelError ? <Notice tone="danger">{modelError}</Notice> : null}
          {downloadOpen ? (
            <div className="stack" style={{ gap: 10 }}>
              <div className="model-download-list">
                {catalog.map((entry) => (
                  <label
                    key={entry.id}
                    className={classNames("model-download-row", downloadId === entry.id && "selected")}
                  >
                    <input
                      type="radio"
                      name="home-model-download"
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
              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="btn ghost" onClick={() => setDownloadOpen(false)}>
                  {S.common.cancel}
                </button>
                <button type="button" className="btn primary" onClick={startDownload} disabled={!downloadId}>
                  <Icon name="download" />
                  转入后台下载
                </button>
              </div>
            </div>
          ) : null}
          {models.length === 0 && !modelsLoading ? (
            <Notice tone="warning">未找到本地模型。可在下方指定模型目录，或使用「下载模型」获取。</Notice>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {models.map((item) => (
                <div className="row" key={item.id} style={{ justifyContent: "space-between", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{item.name}</div>
                    <div className="hint">
                      {item.kind === "wd14-tagger" ? "短语标签" : "自然语言描述"} · {item.version} ·{" "}
                      {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : "未安装"}
                    </div>
                  </div>
                  <Badge tone={item.status === "available" ? "success" : "warning"}>
                    {item.status === "available" ? "可用" : "未安装"}
                  </Badge>
                </div>
              ))}
            </div>
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
                <button type="button" className="btn subtle" onClick={() => void saveRuntime()}>
                  <Icon name="save" />
                </button>
              </div>
            </Field>
          </div>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <span className="hint">
              运行时：{appInfo?.workerPython || "—"} · {appInfo?.workerReady ? "可用" : "未就绪"}
            </span>
            <button type="button" className="btn subtle sm" onClick={() => void testWorker()} disabled={testing}>
              {testing ? <Spinner /> : <Icon name="play" className="sm" />}
              测试运行时
            </button>
          </div>
        </section>

        <section className="settings-card">
          <h3><Icon name="settings" />应用信息</h3>
          <div className="settings-row">
            <div className="settings-label">版本</div>
            <div className="settings-control mono">{appInfo?.version || "—"}</div>
          </div>
          <div className="settings-row">
            <div className="settings-label">应用数据目录</div>
            <div className="settings-control mono" style={{ overflowWrap: "anywhere", fontSize: 11 }}>
              {appInfo?.dataDir || "—"}
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
}
