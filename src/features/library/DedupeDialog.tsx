import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { api, normalizeError } from "../../lib/api";
import type { DedupeGroup, DedupeMember, DedupeRecycled, DedupeScan } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { classNames, displayUrl, formatBytes, formatDate, sourceThumbUrl } from "../../lib/utils";
import { Icon } from "../../components/Icon";
import { EmptyState, Modal, Spinner } from "../../components/ui";

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function DedupeDialog({ open, onClose, onChanged }: Props) {
  const { project } = useProject();
  const defaultThreshold = useMemo(() => {
    const value = project.settings.thresholds?.duplicateDistance ?? 8;
    return Math.min(16, Math.max(1, Math.round(value)));
  }, [project.settings.thresholds?.duplicateDistance]);

  const [threshold, setThreshold] = useState(defaultThreshold);
  const [scan, setScan] = useState<DedupeScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keeps, setKeeps] = useState<Record<string, string>>({});
  const [recycled, setRecycled] = useState<DedupeRecycled[] | null>(null);
  const [tab, setTab] = useState<"groups" | "recycle">("groups");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<DedupeMember | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<boolean | null>(null);
  const keepsRef = useRef<Record<string, string>>({});
  keepsRef.current = keeps;
  const seq = useRef(0);
  const openRef = useRef(false);
  openRef.current = open;

  const groups = scan?.groups ?? [];
  const duplicateCount = useMemo(
    () => groups.reduce((sum, group) => sum + Math.max(0, group.members.length - 1), 0),
    [groups],
  );

  const runScan = useCallback(async (value: number) => {
    const seqId = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.dedupeScan(value);
      if (seqId !== seq.current || !openRef.current) return;
      setScan(result);
      const next = new Set<string>();
      const nextKeeps: Record<string, string> = {};
      for (const group of result.groups) {
        const keep = group.members.find((member) => member.keepRecommended) || group.members[0];
        if (keep) nextKeeps[group.id] = keep.assetId;
        for (const member of group.members) {
          if (member.assetId !== keep?.assetId) next.add(member.assetId);
        }
      }
      setKeeps(nextKeeps);
      setSelected(next);
    } catch (error) {
      if (seqId === seq.current) setError(normalizeError(error).message);
    } finally {
      if (seqId === seq.current) setLoading(false);
    }
  }, []);

  const loadRecycled = useCallback(async () => {
    try {
      const list = await api.dedupeRecycled();
      if (openRef.current) setRecycled(list);
    } catch {
      // 回收区读取失败不阻塞去重主流程
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab("groups");
    setStatus(null);
    setError(null);
    setScan(null);
    setSelected(new Set());
    setKeeps({});
    setExpanded(new Set());
    setPreview(null);
    setThreshold(defaultThreshold);
    void loadRecycled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void runScan(threshold), 180);
    return () => window.clearTimeout(timer);
  }, [open, threshold, runScan]);

  useEffect(() => {
    if (!preview) return;
    setPreviewReady(false);
  }, [preview]);

  const setMemberSelected = (assetId: string, value: boolean) => {
    setSelected((current) => {
      if (value === current.has(assetId)) return current;
      const next = new Set(current);
      if (value) next.add(assetId);
      else next.delete(assetId);
      return next;
    });
  };

  const toggleMember = (group: DedupeGroup, assetId: string) => {
    if (keeps[group.id] === assetId) return;
    setMemberSelected(assetId, !selected.has(assetId));
  };

  const chooseKeep = (group: DedupeGroup, assetId: string) => {
    const previous = keeps[group.id];
    if (previous === assetId) return;
    setKeeps({ ...keeps, [group.id]: assetId });
    setSelected((current) => {
      const next = new Set(current);
      if (previous) next.add(previous);
      next.delete(assetId);
      return next;
    });
  };

  const beginDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    group: DedupeGroup,
    member: DedupeMember,
  ) => {
    if (event.button !== 0 || keeps[group.id] === member.assetId) return;
    event.preventDefault();
    event.stopPropagation();
    const value = !selected.has(member.assetId);
    dragRef.current = value;
    setDragging(true);
    setMemberSelected(member.assetId, value);
    const move = (moveEvent: PointerEvent) => {
      if (dragRef.current === null) return;
      const target = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>("[data-dedupe-asset]");
      if (!target) return;
      const assetId = target.dataset.dedupeAsset;
      const groupId = target.dataset.dedupeGroup;
      if (!assetId || !groupId || keepsRef.current[groupId] === assetId) return;
      setMemberSelected(assetId, dragRef.current);
    };
    const finish = () => {
      dragRef.current = null;
      setDragging(false);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  const dragEnter = (group: DedupeGroup, member: DedupeMember) => {
    if (dragRef.current === null || keeps[group.id] === member.assetId) return;
    setMemberSelected(member.assetId, dragRef.current);
  };

  const applyRecycle = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await api.dedupeRecycle(ids);
      onChanged();
      await runScan(threshold);
      await loadRecycled();
      setStatus(`已将 ${result.moved} 张图片移至回收区`);
    } catch (error) {
      setError(normalizeError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (ids: string[]) => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await api.dedupeRestore(ids);
      onChanged();
      await runScan(threshold);
      await loadRecycled();
      setStatus(`已恢复 ${result.restored} 张图片`);
    } catch (error) {
      setError(normalizeError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="xwide"
      title="图片去重"
      subtitle="按图片内容查找高度相似的图片。每组默认保留一张，可改选保留项；其余勾选后移入回收区，随时可以恢复。"
      footer={
        <>
          <span className="hint">
            {tab === "recycle"
              ? `回收区 ${Math.max(recycled?.length ?? 0, scan?.recycled ?? 0)} 张`
              : selected.size > 0
                ? `已勾选 ${selected.size} 张待回收`
                : "勾选需要移入回收区的图片"}
          </span>
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={tab !== "groups" || selected.size === 0 || busy || loading}
            onClick={() => void applyRecycle()}
          >
            {busy ? <Spinner /> : <Icon name="trash" />}
            移至回收区{selected.size > 0 ? `（${selected.size}）` : ""}
          </button>
        </>
      }
    >
      <div className="dedupe">
        <div className="dedupe-bar">
          <div className="dedupe-threshold">
            <span className="dedupe-threshold-label">相似阈值</span>
            <input
              type="range"
              min={1}
              max={16}
              step={1}
              value={threshold}
              aria-label="相似阈值"
              onChange={(event) => {
                setStatus(null);
                setThreshold(Number(event.target.value));
              }}
            />
            <input
              className="input number dedupe-threshold-input"
              type="number"
              min={1}
              max={16}
              value={threshold}
              aria-label="相似阈值"
              onChange={(event) => {
                const next = Math.min(16, Math.max(1, Number(event.target.value) || 1));
                setStatus(null);
                setThreshold(next);
              }}
            />
            <span className="hint">数值越大越宽松</span>
          </div>
          <div className="dedupe-tabs" role="tablist" aria-label="去重视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "groups"}
              className={tab === "groups" ? "active" : ""}
              onClick={() => setTab("groups")}
            >
              重复组{scan ? ` ${groups.length}` : ""}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "recycle"}
              className={tab === "recycle" ? "active" : ""}
              onClick={() => {
                setTab("recycle");
                void loadRecycled();
              }}
            >
              回收区{recycled || scan ? ` ${Math.max(recycled?.length ?? 0, scan?.recycled ?? 0)}` : ""}
            </button>
          </div>
        </div>

        {status ? (
          <div className="dedupe-status" role="status">
            <Icon name="check-circle" className="sm" />
            {status}
          </div>
        ) : null}
        {error ? (
          <div className="dedupe-status error" role="alert">
            <Icon name="alert" className="sm" />
            {error}
          </div>
        ) : null}

        {tab === "groups" ? (
          loading && !scan ? (
            <div className="dedupe-loading">
              <Spinner size="lg" /> 正在比对图片内容…
            </div>
          ) : groups.length === 0 ? (
            <EmptyState
              icon="copy"
              title={scan ? "没有发现相似图片" : "正在准备扫描"}
              body={
                scan
                  ? `已扫描 ${scan.scanned} 张图片；当前阈值下没有需要处理的重复组。`
                  : "扫描完成后会在这里列出相似组。"
              }
            />
          ) : (
            <>
              <div className="dedupe-summary">
                <span>
                  <strong>{groups.length}</strong> 组 · <strong>{duplicateCount}</strong> 张可回收
                </span>
                <span className="hint">点击图片放大比对 · 拖动回收勾选框可连续多选</span>
              </div>
              <div className={classNames("dedupe-groups", loading && "is-loading", dragging && "is-dragging")}>
                {groups.map((group) => {
                  const keep = group.members.find((member) => member.assetId === keeps[group.id]);
                  return (
                    <section className="dedupe-group" key={group.id}>
                      <header className="dedupe-group-head">
                        <span className={classNames("dedupe-kind", group.kind)}>
                          {group.kind === "exact" ? "完全相同" : "内容相似"}
                        </span>
                        <span className="hint dedupe-group-note">
                          {group.members.length} 张 · 保留「{keep?.name || "—"}」
                        </span>
                      </header>
                      <div className="dedupe-members">
                        {(expanded.has(group.id) ? group.members : group.members.slice(0, 40)).map((member) => {
                          const isKeep = keeps[group.id] === member.assetId;
                          const checked = !isKeep && selected.has(member.assetId);
                          return (
                            <div
                              key={member.assetId}
                              className={classNames(
                                "dedupe-member",
                                isKeep && "keep",
                                checked && "checked",
                              )}
                              data-dedupe-asset={member.assetId}
                              data-dedupe-group={group.id}
                              onPointerEnter={() => dragEnter(group, member)}
                            >
                              <button
                                type="button"
                                className="dedupe-thumb"
                                onClick={() => setPreview(member)}
                                title="点击放大查看"
                                aria-label={`放大查看 ${member.name}`}
                              >
                                <img
                                  src={sourceThumbUrl({
                                    id: member.assetId,
                                    displayVersion: member.displayVersion,
                                  })}
                                  alt=""
                                  loading="lazy"
                                />
                              </button>
                              <div className="dedupe-member-main">
                                <span className="dedupe-name" title={member.name}>
                                  {member.name}
                                </span>
                                <span className="dedupe-sub">
                                  {group.kind === "near" && member.distance !== null
                                    ? `距离 ${member.distance} · `
                                    : ""}
                                  {member.width}×{member.height} · {formatBytes(member.bytes)}
                                </span>
                              </div>
                              <div className="dedupe-member-actions">
                                <button
                                  type="button"
                                  className={classNames("dedupe-keep-btn", isKeep && "active")}
                                  aria-pressed={isKeep}
                                  onClick={() => chooseKeep(group, member.assetId)}
                                  title="设为此组保留图片"
                                >
                                  <span className="dot" />
                                  保留
                                </button>
                                {!isKeep ? (
                                  <button
                                    type="button"
                                    className={classNames("dedupe-pick", checked && "checked")}
                                    aria-pressed={checked}
                                    aria-label={`${checked ? "取消回收" : "移入回收区"} ${member.name}`}
                                    onPointerDown={(event) => beginDrag(event, group, member)}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (event.detail === 0) toggleMember(group, member.assetId);
                                    }}
                                    title="移入回收区；按住拖动可连续选择"
                                  >
                                    {checked ? <Icon name="check" className="sm" /> : null}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {group.members.length > 40 ? (
                        <button
                          type="button"
                          className="btn ghost sm dedupe-more"
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(group.id)) next.delete(group.id);
                              else next.add(group.id);
                              return next;
                            })
                          }
                        >
                          {expanded.has(group.id)
                            ? "收起"
                            : `展开全部 ${group.members.length} 张`}
                        </button>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            </>
          )
        ) : recycled && recycled.length > 0 ? (
          <div className="dedupe-recycle">
            <div className="dedupe-summary">
              <span>
                回收区共 <strong>{recycled.length}</strong> 张
              </span>
              <div className="spacer" />
              <button
                type="button"
                className="btn ghost sm"
                disabled={busy}
                onClick={() => void restore(recycled.map((item) => item.assetId))}
              >
                全部恢复
              </button>
            </div>
            {recycled.map((item) => (
              <div className="dedupe-recycle-row" key={item.assetId}>
                <span className="dedupe-thumb small">
                  <img
                    src={sourceThumbUrl({
                      id: item.assetId,
                      displayVersion: item.displayVersion,
                    })}
                    alt=""
                    loading="lazy"
                  />
                </span>
                <div className="dedupe-member-main">
                  <span className="dedupe-name" title={item.name}>
                    {item.name}
                  </span>
                  <span className="dedupe-sub">
                    {item.width}×{item.height} · {formatBytes(item.bytes)} · {formatDate(item.recycledAt)}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn subtle sm"
                  disabled={busy}
                  onClick={() => void restore([item.assetId])}
                >
                  恢复
                </button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="trash"
            title="回收区是空的"
            body="在重复组中把相似图片移入回收区后，会在这里集中显示并可随时恢复。"
          />
        )}
      </div>

      {open && preview
        ? createPortal(
            <div
              className="dedupe-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`查看 ${preview.name}`}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setPreview(null);
              }}
            >
              <div className="dedupe-lightbox-inner" onPointerDown={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="dedupe-lightbox-close"
                  onClick={() => setPreview(null)}
                  aria-label="关闭预览"
                  autoFocus
                >
                  <Icon name="x" />
                </button>
                {!previewReady ? (
                  <div className="dedupe-lightbox-loading">
                    <Spinner size="lg" />
                  </div>
                ) : null}
                <img
                  src={displayUrl(preview.assetId, preview.displayVersion)}
                  alt={preview.name}
                  onLoad={() => setPreviewReady(true)}
                  onError={() => setPreviewReady(true)}
                />
                <div className="dedupe-lightbox-bar">
                  <span className="name">{preview.name}</span>
                  <span>
                    {preview.width}×{preview.height} · {formatBytes(preview.bytes)}
                  </span>
                  {preview.distance !== null ? <span>距离 {preview.distance}</span> : null}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </Modal>
  );
}
