import { useEffect, useMemo, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { ScanPreview, ScanRequest } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { S } from "../../lib/strings";
import { classNames, formatBytes, formatNumber, shortPath } from "../../lib/utils";
import { Icon } from "../../components/Icon";
import { Badge, Field, Modal, Notice, Segmented, Spinner, Toggle } from "../../components/ui";

interface Props {
  open: boolean;
  initialPaths?: string[];
  onClose: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  ok: S.importDialog.statusOk,
  unsupported: S.importDialog.statusUnsupported,
  animated: S.importDialog.statusAnimated,
  oversized: S.importDialog.statusOversized,
  error: S.importDialog.statusError,
};

export function ImportDialog({ open, initialPaths, onClose }: Props) {
  const { project, notify, reloadJobs, setJobsOpen, bumpRefresh, collections, reloadCollections } = useProject();
  const [paths, setPaths] = useState<string[]>([]);
  const [recursive, setRecursive] = useState(true);
  const [mode, setMode] = useState<"copy" | "reference">("copy");
  const [sidecarPriority, setSidecarPriority] = useState<"txt" | "caption">("txt");
  const [duplicatePolicy, setDuplicatePolicy] = useState<"skip" | "keep">("skip");
  const [collectionId, setCollectionId] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [preview, setPreview] = useState<ScanPreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const options: ScanRequest = useMemo(
    () => ({
      paths,
      recursive,
      mode,
      sidecarPriority,
      duplicatePolicy,
      captionConflictPolicy: "keep-external",
      collectionId: collectionId || null,
    }),
    [paths, recursive, mode, sidecarPriority, duplicatePolicy, collectionId],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPreview(null);
    setDirty(false);
    setCollectionId("");
    setNewGroupName("");
    if (initialPaths && initialPaths.length > 0) {
      setPaths(initialPaths);
      void runScan(initialPaths, options);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPaths]);

  const runScan = async (targetPaths: string[], useOptions: ScanRequest) => {
    if (targetPaths.length === 0) return;
    setScanning(true);
    setError(null);
    setPreview(null);
    setDirty(false);
    try {
      const result = await api.scanImport({ ...useOptions, paths: targetPaths });
      setPreview(result);
    } catch (error) {
      setError(normalizeError(error).message);
    } finally {
      setScanning(false);
    }
  };

  const addPaths = (next: string[]) => {
    setPaths((current) => Array.from(new Set([...current, ...next])));
    setPreview(null);
  };

  const chooseFiles = async () => {
    const selected = await api.pickImages("选择图片");
    if (selected.length > 0) {
      addPaths(selected);
      void runScan(Array.from(new Set([...paths, ...selected])), options);
    }
  };

  const chooseFolder = async () => {
    const selected = await api.pickFolder("选择图片文件夹");
    if (selected) {
      const next = Array.from(new Set([...paths, selected]));
      setPaths(next);
      void runScan(next, options);
    }
  };

  const updateOption = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    if (preview) setDirty(true);
  };

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name || creatingGroup) return;
    setCreatingGroup(true);
    try {
      const created = await api.createCollection({ name, kind: "manual" });
      await reloadCollections();
      setCollectionId(created.id);
      setNewGroupName("");
      notify({ tone: "success", message: `已创建分组「${created.name}」` });
    } catch (error) {
      setError(normalizeError(error).message);
    } finally {
      setCreatingGroup(false);
    }
  };

  const start = async () => {
    if (!preview) return;
    setStarting(true);
    setError(null);
    try {
      const result = await api.startImport(preview.id, collectionId || null);
      notify({
        tone: "success",
        title: S.importDialog.title,
        message: `${result.total} 张图片已加入导入队列`,
      });
      await reloadJobs();
      setJobsOpen(true);
      bumpRefresh();
      void reloadCollections();
      onClose();
    } catch (error) {
      setError(normalizeError(error).message);
    } finally {
      setStarting(false);
    }
  };

  const summary = preview?.summary;
  const candidates = summary?.candidates || 0;

  return (
    <Modal
      open={open}
      onClose={() => !starting && !scanning && onClose()}
      title={S.importDialog.title}
      subtitle={S.importDialog.dropBody}
      width="xwide"
      closeOnBackdrop={!scanning && !starting}
      footer={
        <>
          <div className="left hint">{S.importDialog.preserveNote}</div>
          <button type="button" className="btn ghost" onClick={onClose} disabled={starting}>
            {S.common.cancel}
          </button>
          {preview && dirty ? (
            <button
              type="button"
              className="btn subtle"
              onClick={() => void runScan(paths, options)}
              disabled={scanning}
            >
              {scanning ? <Spinner /> : <Icon name="refresh" />}
              {S.importDialog.rescan}
            </button>
          ) : null}
          <button
            type="button"
            className="btn primary"
            onClick={() => void start()}
            disabled={!preview || candidates === 0 || scanning || starting || dirty}
          >
            {starting ? <Spinner /> : <Icon name="import" />}
            {starting ? S.importDialog.starting : S.importDialog.start}
            {preview ? <span style={{ opacity: 0.8 }}>· {candidates}</span> : null}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        {error ? <Notice tone="danger">{error}</Notice> : null}

        <div
          className="well"
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "22px 16px", textAlign: "center" }}
        >
          <div className="row-wrap" style={{ justifyContent: "center" }}>
            <button type="button" className="btn secondary" onClick={() => void chooseFiles()}>
              <Icon name="image" />
              {S.importDialog.chooseFiles}
            </button>
            <button type="button" className="btn secondary" onClick={() => void chooseFolder()}>
              <Icon name="folder-open" />
              {S.importDialog.chooseFolder}
            </button>
          </div>
          <span className="hint">{S.importDialog.dropTitle} · 支持 JPG / PNG / 静态 WebP / BMP / TIFF</span>
        </div>

        {paths.length > 0 ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="group-title">{S.importDialog.sourceRoots}</div>
            <div className="row-wrap">
              {paths.map((path) => (
                <span className="chip" key={path} title={path}>
                  <Icon name="folder" className="sm" />
                  {shortPath(path, 42)}
                  <button
                    type="button"
                    className="x"
                    aria-label="移除路径"
                    onClick={() => {
                      const next = paths.filter((item) => item !== path);
                      setPaths(next);
                      setPreview(null);
                      setDirty(false);
                    }}
                  >
                    <Icon name="x" className="sm" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid-2" style={{ gap: 16 }}>
          <div className="stack" style={{ gap: 12 }}>
            <div className="group-title">{S.importDialog.options}</div>
            <Field
              label="导入分组"
              hint="同一分组的图片在裁剪页共享目标尺寸；也可以稍后在裁剪页调整。"
            >
              <div className="stack" style={{ gap: 8 }}>
                <select
                  className="select"
                  value={collectionId}
                  onChange={(event) => setCollectionId(event.target.value)}
                >
                  <option value="">不分组</option>
                  {collections.filter((item) => item.kind !== "query").map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}（{item.count}）
                      {item.targetWidth && item.targetHeight ? ` · ${item.targetWidth}×${item.targetHeight}` : ""}
                    </option>
                  ))}
                </select>
                <div className="input-row">
                  <input
                    className="input"
                    placeholder="新建分组名称"
                    value={newGroupName}
                    onChange={(event) => setNewGroupName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void createGroup();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn subtle"
                    onClick={() => void createGroup()}
                    disabled={!newGroupName.trim() || creatingGroup}
                  >
                    {creatingGroup ? <Spinner /> : <Icon name="plus" />}
                    新建
                  </button>
                </div>
              </div>
            </Field>
            <Field label={S.importDialog.mode} hint={mode === "copy" ? S.importDialog.copyModeHint : S.importDialog.referenceHint}>
              <Segmented
                value={mode}
                onChange={updateOption(setMode)}
                options={[
                  { value: "copy", label: S.importDialog.copyMode, icon: "copy" },
                  { value: "reference", label: S.importDialog.referenceMode, icon: "link" },
                ]}
              />
            </Field>
            <Field label={S.importDialog.sidecar} hint={S.importDialog.sidecarPriority}>
              <Segmented
                value={sidecarPriority}
                onChange={updateOption(setSidecarPriority)}
                options={[
                  { value: "txt", label: S.importDialog.sidecarTxt },
                  { value: "caption", label: S.importDialog.sidecarCaption },
                ]}
              />
            </Field>
          </div>
          <div className="stack" style={{ gap: 12 }}>
            <div className="group-title">&nbsp;</div>
            <Toggle checked={recursive} onChange={updateOption(setRecursive)} label={S.importDialog.recursive} />
            <Field label={S.importDialog.duplicates}>
              <Segmented
                value={duplicatePolicy}
                onChange={updateOption(setDuplicatePolicy)}
                options={[
                  { value: "skip", label: S.importDialog.duplicateSkip },
                  { value: "keep", label: S.importDialog.duplicateKeep },
                ]}
              />
            </Field>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="hint">扫描与导入分两步，导入任务在后台运行。</span>
              <button
                type="button"
                className="btn sm subtle"
                onClick={() => void runScan(paths, options)}
                disabled={paths.length === 0 || scanning}
              >
                {scanning ? <Spinner /> : <Icon name="search" className="sm" />}
                {preview ? S.importDialog.rescan : S.importDialog.scan}
              </button>
            </div>
          </div>
        </div>

        {scanning ? (
          <div className="loading-line" style={{ padding: "24px 0", justifyContent: "center" }}>
            <Spinner size="lg" />
            {S.importDialog.scanning}
          </div>
        ) : preview && summary ? (
          <div className="stack" style={{ gap: 14 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="section-title">{S.importDialog.summary}</div>
              <span className="hint">{formatNumber(candidates)} 张可导入</span>
            </div>
            <div className="count-strip">
              <div className="count-tile">
                <div className="k">{S.importDialog.candidates}</div>
                <div className="v">{formatNumber(summary.candidates)}</div>
              </div>
              <div className="count-tile">
                <div className="k">{S.importDialog.withSidecar}</div>
                <div className="v">{formatNumber(summary.withSidecar)}</div>
              </div>
              <div className="count-tile">
                <div className="k">{S.importDialog.conflicts}</div>
                <div className="v" style={{ color: summary.conflicts ? "var(--warning)" : undefined }}>
                  {formatNumber(summary.conflicts)}
                </div>
              </div>
              <div className="count-tile">
                <div className="k">{S.importDialog.errors}</div>
                <div className="v" style={{ color: summary.errors ? "var(--danger)" : undefined }}>
                  {formatNumber(summary.errors)}
                </div>
              </div>
              <div className="count-tile">
                <div className="k">{S.importDialog.oversized}</div>
                <div className="v">{formatNumber(summary.oversized)}</div>
              </div>
              <div className="count-tile">
                <div className="k">{S.importDialog.animated}</div>
                <div className="v">{formatNumber(summary.animated)}</div>
              </div>
              <div className="count-tile">
                <div className="k">{S.importDialog.unsupported}</div>
                <div className="v">{formatNumber(summary.unsupported)}</div>
              </div>
              <div className="count-tile">
                <div className="k">{S.importDialog.isolated}</div>
                <div className="v">{formatNumber(summary.isolatedSidecars)}</div>
              </div>
            </div>

            {summary.conflicts > 0 ? (
              <Notice tone="warning">
                发现 {summary.conflicts} 个标注候选冲突。导入后会保留优先选择的标注，并在任务报告中列出冲突文件。
              </Notice>
            ) : null}
            {dirty ? <Notice tone="warning">导入选项已修改，请重新扫描后再开始导入。</Notice> : null}

            <div className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="group-title">{S.importDialog.filesList}</div>
                {preview.entries.length > 12 ? (
                  <button type="button" className="btn ghost sm" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? "收起" : `显示全部 ${preview.entries.length}`}
                  </button>
                ) : null}
              </div>
              <div className="stack" style={{ gap: 4, maxHeight: 300, overflow: "auto" }}>
                {(showAll ? preview.entries : preview.entries.slice(0, 12)).map((entry) => (
                  <div
                    key={entry.path}
                    className="row"
                    style={{
                      padding: "7px 10px",
                      borderRadius: 8,
                      background: "var(--surface-subtle)",
                      alignItems: "flex-start",
                      gap: 10,
                    }}
                  >
                    <Badge
                      tone={
                        entry.status === "ok"
                          ? "success"
                          : entry.status === "unsupported" || entry.status === "error"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {STATUS_LABEL[entry.status] || entry.status}
                    </Badge>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small truncate" style={{ fontWeight: 600 }}>
                        {entry.name}
                      </div>
                      <div className="tiny faint truncate" style={{ fontFamily: "var(--font-mono)" }}>
                        {entry.relPath}
                        {entry.sidecarKind ? ` · 标注 .${entry.sidecarKind}` : ""}
                      </div>
                      {entry.problems.length > 0 ? (
                        <div className="tiny" style={{ color: "var(--danger)", marginTop: 2 }}>
                          {entry.problems.join("；")}
                        </div>
                      ) : null}
                      {entry.sidecarConflicts.length > 0 ? (
                        <div className="tiny" style={{ color: "var(--warning)", marginTop: 2 }}>
                          {entry.sidecarConflicts.join("；")}
                        </div>
                      ) : null}
                    </div>
                    <div className="tiny faint mono" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {entry.width > 0 ? `${entry.width}×${entry.height}` : "—"}
                      <br />
                      {formatBytes(entry.bytes)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {preview.skipped.length > 0 ? (
              <details>
                <summary className="small muted" style={{ cursor: "pointer" }}>
                  {S.importDialog.skippedDirs}（{preview.skipped.length}）
                </summary>
                <div className="stack" style={{ gap: 3, marginTop: 6 }}>
                  {preview.skipped.slice(0, 20).map((item, index) => (
                    <div key={index} className="tiny faint mono">
                      {item.path} · {item.reason}
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : (
          <Notice tone="info">{S.importDialog.nothingSelected}</Notice>
        )}
      </div>
    </Modal>
  );
}
