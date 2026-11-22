import { useMemo, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { ProjectInfo, RecentProject } from "../../lib/types";
import { useRoot } from "../../app/AppProvider";
import { S } from "../../lib/strings";
import { formatNumber, formatRelative, shortPath, classNames } from "../../lib/utils";
import { Icon } from "../../components/Icon";
import {
  Badge,
  ConfirmDialog,
  Dropdown,
  EmptyState,
  Field,
  IconButton,
  MenuItem,
  MenuSeparator,
  Modal,
  Notice,
  Segmented,
  Spinner,
} from "../../components/ui";
import { WindowControls } from "../../components/WindowControls";
import { HomeSettings } from "../settings/HomeSettings";

type Model = "sdxl" | "sd15";
type Template = "character" | "style" | "object" | "custom";

const TEMPLATES: { value: Template; label: string; hint: string }[] = [
  { value: "character", label: S.projects.templateCharacter, hint: "触发词 + 标签" },
  { value: "style", label: S.projects.templateStyle, hint: "风格触发词" },
  { value: "object", label: S.projects.templateObject, hint: "自然语言描述" },
  { value: "custom", label: S.projects.templateCustom, hint: "自行决定" },
];

export function ProjectsPage() {
  const { recents, reloadRecents, adoptProject, notify, appInfo, pingWorker } = useRoot();
  const [search, setSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState(() => {
    try {
      return localStorage.getItem("yoyoku.lastParent") || "";
    } catch {
      return "";
    }
  });
  const [model, setModel] = useState<Model>("sdxl");
  const [template, setTemplate] = useState<Template>("character");
  const [trigger, setTrigger] = useState("");
  const [captionMode, setCaptionMode] = useState<"tags" | "nl">("tags");
  const [busyRecent, setBusyRecent] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RecentProject | null>(null);
  const [checkingWorker, setCheckingWorker] = useState(false);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return recents;
    return recents.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle),
    );
  }, [recents, search]);

  const openProject = async (path: string) => {
    try {
      const info = await api.openProject(path);
      adoptProject(info);
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  };

  const handleCreate = async () => {
    setFormError(null);
    if (!name.trim()) {
      setFormError("请填写项目名称");
      return;
    }
    if (!parent.trim()) {
      setFormError("请选择保存位置");
      return;
    }
    setCreating(true);
    try {
      const info = await api.createProject({
        name: name.trim(),
        parentDir: parent,
        model,
        template,
        triggerWord: trigger.trim(),
        defaultCaptionMode: captionMode,
      });
      try {
        localStorage.setItem("yoyoku.lastParent", parent);
      } catch {
        // ignore
      }
      setCreateOpen(false);
      setName("");
      setTrigger("");
      adoptProject(info);
      notify({ tone: "success", message: `已创建项目「${info.name}」` });
      await reloadRecents();
    } catch (error) {
      setFormError(normalizeError(error).message);
    } finally {
      setCreating(false);
    }
  };

  const handlePickParent = async () => {
    const selected = await api.pickFolder("选择项目保存位置");
    if (selected) setParent(selected);
  };

  const handleOpenDialog = async () => {
    const selected = await api.pickFolder(S.projects.openDialogTitle);
    if (selected) await openProject(selected);
  };

  const handleRecent = async (entry: RecentProject) => {
    if (busyRecent) return;
    setBusyRecent(entry.id);
    try {
      if (entry.missing) {
        await relocate(entry);
        return;
      }
      const info = await api.openRecent(entry.id);
      adoptProject(info);
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === "PROJECT_MISSING") {
        await relocate(entry);
      } else {
        notify({ tone: "danger", title: S.projects.openErrorTitle, message: normalized.message });
      }
    } finally {
      setBusyRecent(null);
    }
  };

  const relocate = async (entry: RecentProject) => {
    const selected = await api.pickFolder(`重新定位「${entry.name}」`);
    if (!selected) return;
    try {
      const info = await api.relocateProject(entry.id, selected);
      adoptProject(info);
      notify({ tone: "success", message: "项目已重新定位" });
      await reloadRecents();
    } catch (error) {
      notify({ tone: "danger", title: S.projects.openErrorTitle, message: normalizeError(error).message });
    }
  };

  const handlePin = async (entry: RecentProject) => {
    try {
      await api.pinRecent(entry.id);
      await reloadRecents();
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    try {
      await api.removeRecent(removeTarget.id);
      setRemoveTarget(null);
      await reloadRecents();
      notify({ message: "已从最近列表移除" });
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  return (
    <div className="projects-page" data-tauri-drag-region>
      <WindowControls floating />
      <div className="projects-hero" data-tauri-drag-region="deep">
        <div className="brand-lockup">
          <img src="/app-icon.png" alt="" className="brand-image" />
          <div>
            <h1>{S.app.name}</h1>
            <p>{S.app.tagline}</p>
          </div>
        </div>
        <div className="projects-actions">
          <button type="button" className="btn primary" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" />
            {S.projects.newProject}
          </button>
          <button type="button" className="btn subtle" onClick={handleOpenDialog}>
            <Icon name="folder-open" />
            {S.projects.openProject}
          </button>
          <button type="button" className="btn subtle" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" />
            设置
          </button>
        </div>
      </div>

      <div className="projects-content stack" style={{ gap: 18 }}>
        {appInfo && !appInfo.workerReady && appInfo.workerError ? (
          <Notice tone="warning" icon="alert">
            <div className="row-wrap">
              <span className="grow">{S.projects.workerMissingBody}</span>
              <button
                type="button"
                className="btn sm subtle"
                disabled={checkingWorker}
                onClick={async () => {
                  setCheckingWorker(true);
                  const ok = await pingWorker();
                  setCheckingWorker(false);
                  notify({
                    tone: ok ? "success" : "danger",
                    title: ok ? "运行时正常" : S.projects.workerMissingTitle,
                    message: ok ? appInfo?.workerPython || "运行时正常" : appInfo?.workerError || "运行时不可用",
                  });
                }}
              >
                {checkingWorker ? <Spinner /> : null}
                {S.projects.checkRuntime}
              </button>
            </div>
          </Notice>
        ) : null}

        <div className="recent-head">
          <h2>{S.projects.title}</h2>
          <span className="count">{filtered.length}</span>
          <div className="projects-search">
            <div className="search-box" style={{ maxWidth: "none" }}>
              <Icon name="search" className="sm" />
              <input
                className="input"
                placeholder={S.projects.searchPlaceholder}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="projects-empty">
            <div className="empty-icon" style={{ display: "grid", placeItems: "center", width: 64, height: 64, borderRadius: 22, background: "var(--surface-subtle)", color: "var(--muted)" }}>
              <Icon name={recents.length === 0 ? "layers" : "search"} size={28} />
            </div>
            <h2>{recents.length === 0 ? S.projects.emptyTitle : S.projects.noResults}</h2>
            <p>{recents.length === 0 ? S.projects.emptyBody : S.projects.searchPlaceholder}</p>
            {recents.length === 0 ? (
              <div className="row-wrap" style={{ justifyContent: "center", marginTop: 8 }}>
                <button type="button" className="btn primary" onClick={() => setCreateOpen(true)}>
                  <Icon name="plus" />
                  {S.projects.newProject}
                </button>
                <button type="button" className="btn subtle" onClick={handleOpenDialog}>
                  <Icon name="folder-open" />
                  {S.projects.openProject}
                </button>

              </div>
            ) : null}
          </div>
        ) : (
          <div className="recent-grid">
            {filtered.map((entry) => (
              <article
                key={entry.id}
                className={classNames("project-card", entry.missing && "missing")}
              >
                <button
                  type="button"
                  className="project-card-main"
                  onClick={() => void handleRecent(entry)}
                  disabled={busyRecent !== null}
                >
                  <span className="project-icon">
                    {busyRecent === entry.id ? <Spinner /> : <Icon name="layers" size={22} />}
                  </span>
                  <div className="grow" style={{ textAlign: "left" }}>
                    <h3>{entry.name}</h3>
                    <div className="project-meta">
                      <Badge tone="info">{entry.model === "sd15" ? "SD 1.5" : entry.model === "sdxl" ? "SDXL" : entry.model}</Badge>
                      <span>{formatNumber(entry.imageCount)} 张图片</span>
                      <span>·</span>
                      <span>{formatRelative(entry.lastOpened)}</span>
                    </div>
                  </div>
                </button>
                <div className="project-card-status">
                  {entry.missing ? (
                    <>
                      <Badge tone="danger" dot>
                        {S.projects.missing}
                      </Badge>
                      <button
                        type="button"
                        className="btn sm secondary"
                        onClick={() => void relocate(entry)}
                      >
                        <Icon name="folder-open" className="sm" />
                        {S.projects.locate}
                      </button>
                    </>
                  ) : (
                    <span className="badge neutral" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
                      {shortPath(entry.path, 52)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className={classNames("project-star", entry.pinned && "pinned")}
                  aria-label={entry.pinned ? S.projects.unpin : S.projects.pin}
                  title={entry.pinned ? S.projects.unpin : S.projects.pin}
                  onClick={() => void handlePin(entry)}
                >
                  <Icon name="star" size={18} style={entry.pinned ? { fill: "currentColor" } : undefined} />
                </button>
                <div className="project-menu-btn">
                  <Dropdown
                    align="end"
                    width={210}
                    renderTrigger={(toggle) => (
                      <IconButton icon="more" label={S.common.more} onClick={toggle} size="sm" />
                    )}
                  >
                    {(close) => (
                      <>
                        <MenuItem
                          icon="folder-open"
                          onClick={() => {
                            close();
                            void api.revealPath(entry.path).catch((error) =>
                              notify({ tone: "danger", message: normalizeError(error).message }),
                            );
                          }}
                        >
                          {S.projects.reveal}
                        </MenuItem>
                        <MenuItem
                          icon="folder"
                          onClick={() => {
                            close();
                            void relocate(entry);
                          }}
                        >
                          {S.projects.locate}
                        </MenuItem>
                        <MenuItem
                          icon={entry.pinned ? "pin" : "pin"}
                          onClick={() => {
                            close();
                            void handlePin(entry);
                          }}
                        >
                          {entry.pinned ? S.projects.unpin : S.projects.pin}
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          icon="trash"
                          danger
                          onClick={() => {
                            close();
                            setRemoveTarget(entry);
                          }}
                        >
                          {S.projects.removeRecent}
                        </MenuItem>
                      </>
                    )}
                  </Dropdown>
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="row" style={{ justifyContent: "space-between", color: "var(--faint)", fontSize: 11, marginTop: 8, flexWrap: "wrap", gap: 8 }}>
          <span>
            {S.app.name} {S.app.version} · 本地优先，不上传图片
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={async () => {
              setCheckingWorker(true);
              const ok = await pingWorker();
              setCheckingWorker(false);
              notify({
                tone: ok ? "success" : "danger",
                title: ok ? S.settings.workerOk : S.settings.workerFail,
                message: ok ? appInfo?.workerPython || "运行时正常" : appInfo?.workerError || "运行时不可用",
              });
            }}
          >
            {checkingWorker ? <Spinner /> : <Icon name="tasks" className="sm" />}
            {S.settings.testWorker}
          </button>
        </div>
      </div>

      <Modal
        open={createOpen}
        onClose={() => !creating && setCreateOpen(false)}
        title={S.projects.createTitle}
        subtitle={S.projects.createBody}
        width="wide"
        closeOnBackdrop={!creating}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              {S.common.cancel}
            </button>
            <button type="button" className="btn primary" onClick={() => void handleCreate()} disabled={creating}>
              {creating ? <Spinner /> : <Icon name="plus" />}
              {creating ? S.projects.creating : S.projects.create}
            </button>
          </>
        }
      >
        <div className="stack" style={{ gap: 16 }}>
          {formError ? <Notice tone="danger">{formError}</Notice> : null}
          <Field label={S.projects.projectName}>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={S.projects.projectNamePlaceholder}
              autoFocus
            />
          </Field>
          <Field label={S.projects.location} hint="项目文件将写入此位置下的同名文件夹。">
            <div className="input-row">
              <input
                className="input mono"
                style={{ fontSize: 12 }}
                value={parent}
                onChange={(event) => setParent(event.target.value)}
                placeholder={S.projects.chooseLocation}
              />
              <button type="button" className="btn subtle" onClick={() => void handlePickParent()}>
                <Icon name="folder-open" />
                {S.projects.chooseLocation}
              </button>
            </div>
          </Field>
          <div className="grid-2" style={{ gap: 16 }}>
            <Field label={S.projects.baseModel}>
              <div className="model-choice">
                <button
                  type="button"
                  className={classNames("choice-tile", model === "sdxl" && "active")}
                  onClick={() => setModel("sdxl")}
                >
                  <strong>SDXL</strong>
                  <span>默认 1024×1024</span>
                </button>
                <button
                  type="button"
                  className={classNames("choice-tile", model === "sd15" && "active")}
                  onClick={() => setModel("sd15")}
                >
                  <strong>SD 1.5</strong>
                  <span>默认 512×512</span>
                </button>
              </div>
            </Field>
            <Field label={S.projects.captionMode}>
              <Segmented
                value={captionMode}
                onChange={(value) => setCaptionMode(value)}
                options={[
                  { value: "tags", label: S.projects.tagsMode },
                  { value: "nl", label: S.projects.nlMode },
                ]}
              />
            </Field>
          </div>
          <Field label={S.projects.template}>
            <div className="template-choice">
              {TEMPLATES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={classNames("choice-tile", template === item.value && "active")}
                  onClick={() => {
                    setTemplate(item.value);
                    setCaptionMode(item.value === "object" ? "nl" : "tags");
                  }}
                >
                  <strong>{item.label}</strong>
                  <span>{item.hint}</span>
                </button>
              ))}
            </div>
          </Field>
          <Field label={S.projects.triggerWord} hint={S.projects.triggerHint}>
            <input
              className="input"
              value={trigger}
              onChange={(event) => setTrigger(event.target.value)}
              placeholder="例如：yoyoku_style"
            />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={removeTarget !== null}
        title={S.projects.removeConfirmTitle}
        body={S.projects.removeConfirmBody}
        confirmLabel={S.projects.removeRecent}
        danger
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void handleRemove()}
      />

      <HomeSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
