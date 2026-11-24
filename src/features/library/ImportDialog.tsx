import { useEffect, useMemo, useRef, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { ScanPreview, ScanRequest } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { S } from "../../lib/strings";
import { classNames, formatBytes, formatNumber, shortPath } from "../../lib/utils";
import { Icon } from "../../components/Icon";
import { Badge, Field, Modal, Notice, Segmented, Select, Spinner, Toggle } from "../../components/ui";

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

/** 单个文件显示文件名，目录显示压缩后的路径。 */
function sourceLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() || trimmed;
  return /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(base) ? base : shortPath(path, 28);
}

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
  const scanSeq = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;

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
    // 打开或关闭都会让进行中的扫描结果失效。
    scanSeq.current += 1;
    if (!open) return;
    setError(null);
    setPreview(null);
    setDirty(false);
    setScanning(false);
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
    const seq = ++scanSeq.current;
    setScanning(true);
    setError(null);
    setPreview(null);
    setDirty(false);
    try {
      const result = await api.scanImport({ ...useOptions, paths: targetPaths });
      if (seq !== scanSeq.current || !openRef.current) return;
      setPreview(result);
    } catch (error) {
      if (seq !== scanSeq.current || !openRef.current) return;
      setError(normalizeError(error).message);
    } finally {
      if (seq === scanSeq.current) setScanning(false);
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

  /** 会改变扫描结果的选项：修改后必须重新扫描。 */
  const updateScanOption = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    if (scanning) {
      // 扫描中使用旧选项的请求结果不能回填到新选项。
      scanSeq.current += 1;
      setScanning(false);
      setPreview(null);
      setDirty(false);
    } else if (preview) {
      setDirty(true);
    }
  };

  /** 复制方式与重复策略在提交时随任务传入，不需要重新扫描。 */
  const updateImportOption = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
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
      const result = await api.startImport(preview.id, collectionId || null, mode, duplicatePolicy);
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
  const importReady = Boolean(preview) && !dirty && !scanning && candidates > 0;
  const primaryMode = starting
    ? "starting"
    : scanning
      ? "scanning"
      : dirty || (preview && candidates === 0)
        ? "rescan"
        : importReady
          ? "import"
          : "scan";
  const primaryLabel =
    primaryMode === "starting"
      ? S.importDialog.starting
      : primaryMode === "scanning"
        ? S.importDialog.scanning
        : primaryMode === "rescan"
          ? S.importDialog.rescan
          : primaryMode === "import"
            ? `导入 ${candidates} 张`
            : "扫描文件";
  const primaryIcon = primaryMode === "import" ? "import" : primaryMode === "rescan" ? "refresh" : "search";
  const primaryDisabled = Boolean(starting || scanning) || (primaryMode === "scan" && paths.length === 0);
  const runPrimary = () => {
    if (primaryMode === "import") {
      void start();
    } else if (primaryMode !== "scanning" && primaryMode !== "starting") {
      void runScan(paths, options);
    }
  };

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
          <div className="left hint import-foot-note">{S.importDialog.preserveNote}</div>
          <button type="button" className="btn ghost" onClick={onClose} disabled={starting}>
            {S.common.cancel}
          </button>
          {primaryMode === "rescan" ? <span className="tiny faint">需重新扫描</span> : null}
          <button
            type="button"
            className="btn primary import-foot-primary"
            onClick={runPrimary}
            disabled={primaryDisabled}
          >
            {starting || scanning ? <Spinner /> : <Icon name={primaryIcon} />}
            {primaryLabel}
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
          <span className="hint">也可拖入图片或文件夹 · 支持 JPG / PNG / 静态 WebP / BMP / TIFF</span>
        </div>

        {paths.length > 0 ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div className="group-title">{S.importDialog.sourceRoots} · {paths.length} 项</div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  scanSeq.current += 1;
                  setPaths([]);
                  setPreview(null);
                  setDirty(false);
                  setScanning(false);
                }}
              >
                清空
              </button>
            </div>
            <div className="row-wrap source-chips">
              {paths.map((path) => (
                <span className="chip source-chip" key={path} title={path}>
                  <Icon name="folder" className="sm" />
                  <span className="source-chip-name">{sourceLabel(path)}</span>
                  <button
                    type="button"
                    className="x"
                    aria-label="移除路径"
                    onClick={() => {
                      const next = paths.filter((item) => item !== path);
                      scanSeq.current += 1;
                      setScanning(false);
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
            <details className="source-paths">
              <summary className="tiny faint">查看完整路径</summary>
              <div className="stack" style={{ gap: 3, marginTop: 6 }}>
                {paths.map((path) => (
                  <div key={path} className="tiny faint mono truncate" title={path}>
                    {path}
                  </div>
                ))}
              </div>
            </details>
          </div>
        ) : null}

        <div className="grid-2" style={{ gap: 16 }}>
          <div className="stack" style={{ gap: 12 }}>
            <div className="group-title">{S.importDialog.options}</div>
            <Field
              label="导入分组"
              hint="分组可共享裁剪尺寸。"
            >
              <div className="stack" style={{ gap: 8 }}>
                <Select
                  value={collectionId}
                  onChange={setCollectionId}
                  ariaLabel="导入分组"
                  options={[
                    { value: "", label: "不分组" },
                    ...collections
                      .filter((item) => item.kind !== "query")
                      .map((item) => ({
                        value: item.id,
                        label: item.name,
                        hint:
                          item.targetWidth && item.targetHeight
                            ? `${item.targetWidth}×${item.targetHeight}`
                            : item.count,
                      })),
                  ]}
                />
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
                onChange={updateImportOption(setMode)}
                options={[
                  { value: "copy", label: S.importDialog.copyMode, icon: "copy" },
                  { value: "reference", label: S.importDialog.referenceMode, icon: "link" },
                ]}
              />
            </Field>
            <Field label={S.importDialog.sidecar} hint={S.importDialog.sidecarPriority}>
              <Segmented
                value={sidecarPriority}
                onChange={updateScanOption(setSidecarPriority)}
                options={[
                  { value: "txt", label: S.importDialog.sidecarTxt },
                  { value: "caption", label: S.importDialog.sidecarCaption },
                ]}
              />
            </Field>
          </div>
          <div className="stack" style={{ gap: 12 }}>
            <div className="group-title">&nbsp;</div>
            <Toggle checked={recursive} onChange={updateScanOption(setRecursive)} label={S.importDialog.recursive} />
            <Field label={S.importDialog.duplicates}>
              <Segmented
                value={duplicatePolicy}
                onChange={updateImportOption(setDuplicatePolicy)}
                options={[
                  { value: "skip", label: S.importDialog.duplicateSkip },
                  { value: "keep", label: S.importDialog.duplicateKeep },
                ]}
              />
            </Field>
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
                {summary.conflicts} 张图片同时有 .txt 和 .caption，优先使用 .{sidecarPriority}。完整清单见候选文件与导入任务报告。
              </Notice>
            ) : null}
            {dirty ? <Notice tone="warning">包含子目录或标注优先级已修改，请重新扫描后再开始导入。</Notice> : null}

            <div className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="group-title">{S.importDialog.filesList}</div>
                {preview.entries.length > 12 ? (
                  <button type="button" className="btn ghost sm" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? "收起预览" : `展开全部 ${preview.entries.length} 条预览`}
                  </button>
                ) : null}
              </div>
              {summary.truncated > 0 ? (
                <div className="tiny faint">
                  另有 {formatNumber(summary.truncated)} 项未在预览中，完整清单与异常报告会在导入任务中给出。
                </div>
              ) : null}
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
