import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, normalizeError } from "../../lib/api";
import type { AssetDetail, AssetSummary, BatchOp, ReviewStatus } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { S } from "../../lib/strings";
import {
  classNames,
  formatBytes,
  formatDate,
  formatNumber,
  formatPercent,
  prettyPath,
  splitLabel,
  statusLabel,
  statusTone,
  sourceThumbUrl,
} from "../../lib/utils";
import { Icon } from "../../components/Icon";
import {
  Badge,
  Dropdown,
  EmptyState,
  IconButton,
  MenuItem,
  MenuLabel,
  PromptDialog,
  Segmented,
  Spinner,
} from "../../components/ui";

interface Props {
  open: boolean;
  width: number;
  assetIds: string[];
  focusedId: string | null;
  summaries: Record<string, AssetSummary>;
  hiddenSelected: number;
  onClose: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onOpenWorkbench: (id: string) => void;
  onOpenBatch: () => void;
  onQuickBatch: (op: BatchOp) => void;
  onExclude: (ids: string[]) => void;
}

export function Inspector({
  open,
  width,
  assetIds,
  focusedId,
  summaries,
  hiddenSelected,
  onClose,
  onResizeStart,
  onOpenWorkbench,
  onOpenBatch,
  onQuickBatch,
  onExclude,
}: Props) {
  const { refreshToken, bumpRefresh, notify, collections, navigate, setSelection, clearSelection } = useProject();
  const targetId = assetIds.length === 1 ? assetIds[0] : assetIds.length === 0 ? focusedId : null;
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open || !targetId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getAsset(targetId)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setNote(result.summary.note);
      })
      .catch((error) => {
        if (!cancelled) {
          setDetail(null);
          notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetId, open, refreshToken, notify]);

  const update = async (patch: Record<string, unknown>, label: string, undoable = true) => {
    if (!targetId) return;
    setBusy(true);
    try {
      const result = await api.updateAsset(targetId, patch as any);
      setDetail((current) => (current ? { ...current, summary: result.asset } : current));
      bumpRefresh();
      notify({
        tone: "success",
        message: label,
        actionLabel: undoable ? S.common.undo : undefined,
        onAction: undoable
          ? async () => {
              try {
                await api.undo();
                bumpRefresh();
                notify({ message: "已撤销" });
              } catch (error) {
                notify({ tone: "danger", message: normalizeError(error).message });
              }
            }
          : undefined,
      });
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    } finally {
      setBusy(false);
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
      notify({
        tone: result.missing.length > 0 ? "danger" : "success",
        message: `已重新连接 ${result.relinked} 张图片${result.missing.length ? `，仍缺 ${result.missing.length} 张` : ""}`,
      });
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  };

  const reveal = async (id: string) => {
    try {
      await api.assetReveal(id);
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  if (!open) return null;

  const multi = assetIds.length > 1;
  const selectedSummaries = assetIds.map((id) => summaries[id]).filter(Boolean) as AssetSummary[];
  const statusCounts = selectedSummaries.reduce<Record<string, number>>((accumulator, item) => {
    accumulator[item.status] = (accumulator[item.status] || 0) + 1;
    return accumulator;
  }, {});
  const hasExcluded = selectedSummaries.some((item) => item.status === "excluded");

  return (
    <aside
      className="inspector"
      style={{ ["--inspector-w" as any]: `${width}px` }}
      aria-label={S.inspector.title}
    >
      <div
        className="inspector-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整检查器宽度"
        onPointerDown={onResizeStart}
      />
      <div className="inspector-scroll">
        <div className="inspector-head">
          <Icon name="panel-right" className="sm" />
          <h3>{S.inspector.title}</h3>
          <IconButton icon="x" label={S.library.sidebarCollapse} onClick={onClose} size="sm" />
        </div>

        {multi ? (
          <div className="stack" style={{ gap: 14 }}>
            <div className="multi-summary">
              <div className="inspector-title">{S.inspector.multiple(assetIds.length)}</div>
              <p className="hint">{S.inspector.multipleBody}</p>
              {hiddenSelected > 0 ? (
                <Badge tone="warning">{S.library.hiddenSelected(hiddenSelected)}</Badge>
              ) : null}
            </div>
            <div className="inspector-section">
              <div className="group-title">审核状态</div>
              <div className="row-wrap">
                {(["pending", "approved", "review", "excluded"] as ReviewStatus[]).map((status) =>
                  statusCounts[status] ? (
                    <Badge key={status} tone={statusTone(status)}>
                      {statusLabel(status)} {statusCounts[status]}
                    </Badge>
                  ) : null,
                )}
              </div>
            </div>
            <div className="inspector-actions">
              <button type="button" className="btn secondary" onClick={onOpenBatch}>
                <Icon name="tag" className="sm" />
                {S.library.batchEdit}
              </button>
              <button
                type="button"
                className="btn subtle"
                onClick={() => onQuickBatch({ kind: "setStatus", status: "approved" })}
              >
                <Icon name="check" className="sm" />
                全部通过
              </button>
              <button
                type="button"
                className="btn subtle"
                onClick={() => onQuickBatch({ kind: "setStatus", status: "review" })}
              >
                <Icon name="alert" className="sm" />
                标记复核
              </button>
              <button type="button" className="btn subtle danger" onClick={() => onExclude(assetIds)}>
                <Icon name="x" className="sm" />
                {hasExcluded ? "排除所选" : "排除所选"}
              </button>
            </div>
            <div className="inspector-section">
              <div className="group-title">用途</div>
              <div className="row-wrap">
                <button
                  type="button"
                  className="btn sm subtle"
                  onClick={() => onQuickBatch({ kind: "setSplit", split: "train" })}
                >
                  锁定训练
                </button>
                <button
                  type="button"
                  className="btn sm subtle"
                  onClick={() => onQuickBatch({ kind: "setSplit", split: "val" })}
                >
                  锁定验证
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => onQuickBatch({ kind: "setSplit", split: null })}
                >
                  取消用途
                </button>
              </div>
            </div>
            <div className="inspector-section">
              <div className="group-title">集合</div>
              <Dropdown
                width={230}
                renderTrigger={(toggle) => (
                  <button type="button" className="btn subtle wide" onClick={toggle}>
                    <Icon name="folder" className="sm" />
                    {S.library.addToCollection}
                    <Icon name="chevron-down" className="sm" />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <MenuLabel>加入集合</MenuLabel>
                    {collections.length === 0 ? (
                      <div className="hint" style={{ padding: "6px 10px 10px" }}>
                        暂无集合，可在批量操作中新建。
                      </div>
                    ) : (
                      collections.map((collection) => (
                        <MenuItem
                          key={collection.id}
                          icon="folder"
                          hint={collection.count}
                          onClick={() => {
                            close();
                            onQuickBatch({ kind: "addToCollection", collection: collection.id });
                          }}
                        >
                          {collection.name}
                        </MenuItem>
                      ))
                    )}
                  </>
                )}
              </Dropdown>
            </div>
            <button
              type="button"
              className="btn ghost wide"
              onClick={() => {
                clearSelection();
                setSelection([]);
              }}
            >
              {S.library.clearSelection}
            </button>
          </div>
        ) : detail ? (
          <div className="stack" style={{ gap: 14 }}>
            <div
              className="inspector-preview"
              style={{
                aspectRatio: `${detail.summary.width} / ${detail.summary.height}`,
              }}
            >
              <img
                src={sourceThumbUrl(detail.summary)}
                alt={detail.summary.name}
                onDoubleClick={() => onOpenWorkbench(detail.summary.id)}
              />
            </div>
            <div>
              <div className="inspector-title">{detail.summary.name}</div>
              <div className="row-wrap" style={{ marginTop: 6 }}>
                <Badge tone={statusTone(detail.summary.status)} dot>
                  {statusLabel(detail.summary.status)}
                </Badge>
                {detail.missing ? <Badge tone="danger">源文件失联</Badge> : null}
                {detail.summary.hasDraft ? <Badge tone="info">有裁剪草稿</Badge> : null}
                {detail.summary.duplicateGroupId ? <Badge tone="warning">重复组</Badge> : null}
                {detail.issues.some((issue) => issue.level === "blocking" && !issue.ignored) ? (
                  <Badge tone="danger">阻塞项</Badge>
                ) : null}
              </div>
            </div>

            <div className="inspector-actions">
              <button type="button" className="btn primary" onClick={() => onOpenWorkbench(detail.summary.id)}>
                <Icon name="edit" className="sm" />
                {S.inspector.openInWorkbench}
              </button>
              <button type="button" className="btn subtle" onClick={() => void reveal(detail.summary.id)}>
                <Icon name="folder-open" className="sm" />
                {S.inspector.locateSource}
              </button>
              {detail.missing ? (
                <button type="button" className="btn danger" onClick={() => void relink(detail.sourceRoot)}>
                  <Icon name="link" className="sm" />
                  {S.inspector.relink}
                </button>
              ) : null}
            </div>

            <div className="inspector-section">
              <div className="group-title">属性</div>
              <div className="meta-grid">
                <div className="meta-item">
                  <div className="k">原始尺寸</div>
                  <div className="v">
                    {detail.normWidth}×{detail.normHeight}
                  </div>
                </div>
                <div className="meta-item">
                  <div className="k">计划输出</div>
                  <div className="v">
                    {detail.summary.outWidth}×{detail.summary.outHeight}
                  </div>
                </div>
                <div className="meta-item">
                  <div className="k">格式</div>
                  <div className="v">{detail.summary.format}</div>
                </div>
                <div className="meta-item">
                  <div className="k">文件大小</div>
                  <div className="v">{formatBytes(detail.filesize)}</div>
                </div>
                <div className="meta-item">
                  <div className="k">裁掉面积</div>
                  <div className="v">{formatPercent(detail.summary.cropRatio)}</div>
                </div>
                <div className="meta-item">
                  <div className="k">用途</div>
                  <div className="v">{splitLabel(detail.summary.splitLock)}</div>
                </div>
              </div>
            </div>

            <div className="inspector-section">
              <div className="group-title">
                {S.inspector.captionStatus}
                <Badge>{detail.caption.mode === "tags" ? "标签" : "自然语言"}</Badge>
              </div>
              <div className="caption-final" style={{ maxHeight: 130, overflow: "auto" }}>
                {detail.caption.tags.length > 0 && detail.caption.mode === "tags" ? (
                  <div className="tag-list">
                    {detail.caption.tags.slice(0, 24).map((tag) => (
                      <span className="tag" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span>{detail.caption.text || detail.caption.finalText || "（空标注）"}</span>
                )}
              </div>
              <div className="caption-stats">
                <span>{detail.caption.charCount} 字符</span>
                <span>{detail.caption.tagCount} 标签</span>
                <span>token {detail.caption.tokenEstimate ?? "—"}</span>
              </div>
            </div>

            <div className="inspector-section">
              <div className="group-title">
                {S.inspector.issues}
                <Badge tone={detail.issues.length ? "warning" : "success"}>{detail.issues.length}</Badge>
              </div>
              {detail.issues.length === 0 ? (
                <p className="hint">{S.inspector.noIssues}</p>
              ) : (
                <div className="stack" style={{ gap: 4 }}>
                  {detail.issues.slice(0, 8).map((issue) => (
                    <div
                      key={issue.id}
                      className={classNames("issue-line", issue.level, issue.ignored && "ignored")}
                      style={issue.ignored ? { opacity: 0.6 } : undefined}
                    >
                      <Icon name={issue.level === "blocking" ? "alert" : "info"} className="sm" style={{ marginTop: 1 }} />
                      <span className="issue-msg">{issue.message}</span>
                    </div>
                  ))}
                  <button type="button" className="btn ghost sm" onClick={() => navigate("quality")}>
                    打开质检页
                    <Icon name="chevron-right" className="sm" />
                  </button>
                </div>
              )}
            </div>

            <div className="inspector-section">
              <div className="group-title">审核</div>
              <Segmented
                value={detail.summary.status}
                onChange={(value) => {
                  if (value === "excluded") setExcludeOpen(true);
                  else void update({ status: value }, `已标记为${statusLabel(value)}`);
                }}
                options={[
                  { value: "pending", label: "待审核" },
                  { value: "approved", label: "已通过" },
                  { value: "review", label: "需复核" },
                  { value: "excluded", label: "排除" },
                ]}
                compact
              />
              <div className="row" style={{ justifyContent: "space-between" }}>
                <button
                  type="button"
                  className={classNames("btn sm ghost", detail.summary.favorite && "active")}
                  onClick={() => void update({ favorite: !detail.summary.favorite }, detail.summary.favorite ? "已取消收藏" : "已收藏")}
                >
                  <Icon name="star" className="sm" style={detail.summary.favorite ? { fill: "var(--warning)", color: "var(--warning)" } : undefined} />
                  {detail.summary.favorite ? "已收藏" : "收藏"}
                </button>
                <select
                  className="select"
                  style={{ width: 120, minHeight: 36 }}
                  value={detail.summary.splitLock || ""}
                  onChange={(event) => void update({ splitLock: event.target.value }, "已更新用途")}
                >
                  <option value="">未分配</option>
                  <option value="train">锁定训练</option>
                  <option value="val">锁定验证</option>
                </select>
              </div>
              <label className="checkbox" style={{ fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={detail.summary.triggerDisabled}
                  onChange={(event) =>
                    void update({ triggerDisabled: event.target.checked }, event.target.checked ? "本图不添加触发词" : "恢复触发词")
                  }
                />
                {S.inspector.triggerDisabled}
              </label>
            </div>

            <div className="inspector-section">
              <div className="group-title">集合</div>
              {detail.collections.length === 0 ? (
                <p className="hint">不属于任何集合</p>
              ) : (
                <div className="row-wrap">
                  {detail.collections.map((collection) => (
                    <span className="chip" key={collection.id}>
                      <Icon name="folder" className="sm" />
                      {collection.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="inspector-section">
              <div className="group-title">备注</div>
              <textarea
                className="textarea"
                style={{ minHeight: 72 }}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                onBlur={() => {
                  if (note !== detail.summary.note) {
                    void update({ note }, "备注已保存");
                  }
                }}
                placeholder={S.inspector.notesPlaceholder}
              />
            </div>

            <details className="inspector-section">
              <summary className="group-title" style={{ cursor: "pointer" }}>
                {S.inspector.source}
              </summary>
              <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                <div className="path-block">{prettyPath(detail.sourcePath)}</div>
                <div className="hint">
                  SHA-256：<span className="mono">{detail.sha256.slice(0, 16)}…</span>
                </div>
                <div className="hint">导入时间：{formatDate(detail.importedAt)}</div>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => void navigator.clipboard?.writeText(prettyPath(detail.sourcePath))}
                >
                  <Icon name="copy" className="sm" />
                  复制路径
                </button>
              </div>
            </details>

            {detail.history.length > 0 ? (
              <details className="inspector-section">
                <summary className="group-title" style={{ cursor: "pointer" }}>
                  {S.inspector.history}
                </summary>
                <div className="history-list" style={{ marginTop: 6 }}>
                  {detail.history.map((entry) => (
                    <div className="history-row" key={entry.seq}>
                      <Icon name={entry.undone ? "undo" : "edit"} className="sm" />
                      <span className="truncate">{entry.label}</span>
                      <span className="time">{formatRelativeDate(entry.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : loading ? (
          <div className="stack" style={{ gap: 10 }}>
            <div className="skeleton" style={{ height: 220 }} />
            <div className="skeleton" style={{ height: 18, width: "60%" }} />
            <div className="skeleton" style={{ height: 14, width: "80%" }} />
          </div>
        ) : (
          <EmptyState icon="info" title={S.inspector.noSelection} body={S.inspector.noSelectionBody} />
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
          void update({ status: "excluded", excludedReason: value }, "已排除图片");
        }}
        onClose={() => setExcludeOpen(false)}
      />
    </aside>
  );
}

function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
