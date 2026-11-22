import { useEffect, useMemo, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { BatchOp, BatchPreview, ReviewStatus } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { S } from "../../lib/strings";
import { Icon } from "../../components/Icon";
import { Badge, Field, Modal, Notice, Spinner } from "../../components/ui";

type OpKind =
  | "addTags"
  | "removeTags"
  | "replaceTag"
  | "moveToFront"
  | "copyCaption"
  | "lowercase"
  | "underscores"
  | "cleanShort"
  | "setStatus"
  | "setSplit"
  | "addToCollection"
  | "removeFromCollection";

const OP_LABELS: { value: OpKind; label: string }[] = [
  { value: "addTags", label: "添加标签" },
  { value: "removeTags", label: "删除标签" },
  { value: "replaceTag", label: "精确替换标签" },
  { value: "moveToFront", label: "移动到首位" },
  { value: "copyCaption", label: "复制标注" },
  { value: "lowercase", label: "统一小写" },
  { value: "underscores", label: "空格转下划线" },
  { value: "cleanShort", label: "清理短标签" },
  { value: "setStatus", label: "更改审核状态" },
  { value: "setSplit", label: "分配训练/验证" },
  { value: "addToCollection", label: "加入集合" },
  { value: "removeFromCollection", label: "从集合移除" },
];

function splitTags(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function BatchDialog({
  open,
  onClose,
  assetNames,
}: {
  open: boolean;
  onClose: () => void;
  assetNames: Record<string, string>;
}) {
  const { selection, focusedId, collections, notify, bumpRefresh, reloadCollections } = useProject();
  const [kind, setKind] = useState<OpKind>("addTags");
  const [tagsText, setTagsText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tag, setTag] = useState("");
  const [maxLen, setMaxLen] = useState(2);
  const [status, setStatus] = useState<ReviewStatus>("approved");
  const [reason, setReason] = useState("");
  const [split, setSplit] = useState<"" | "train" | "val">("train");
  const [collection, setCollection] = useState("");
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPreview(null);
      setError(null);
      setSource(focusedId || selection[0] || "");
      if (!collection && collections.length > 0) setCollection(collections[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const change = (setter: (value: any) => void) => (value: any) => {
    setter(value);
    setPreview(null);
  };

  const buildOp = (): BatchOp | null => {
    setError(null);
    switch (kind) {
      case "addTags": {
        const tags = splitTags(tagsText);
        if (tags.length === 0) {
          setError("请输入至少一个标签");
          return null;
        }
        return { kind, tags };
      }
      case "removeTags": {
        const tags = splitTags(tagsText);
        if (tags.length === 0) {
          setError("请输入至少一个标签");
          return null;
        }
        return { kind, tags };
      }
      case "replaceTag":
        if (!from.trim()) {
          setError("请填写要替换的标签");
          return null;
        }
        return { kind, from: from.trim(), to: to.trim() };
      case "moveToFront":
        if (!tag.trim()) {
          setError("请填写要移动到首位的标签");
          return null;
        }
        return { kind, tag: tag.trim() };
      case "copyCaption":
        if (!source) {
          setError("请选择作为标注来源的图片");
          return null;
        }
        return { kind, source };
      case "lowercase":
      case "underscores":
        return { kind } as BatchOp;
      case "cleanShort":
        return { kind, maxLen: Math.max(0, Math.round(maxLen)) };
      case "setStatus":
        return { kind, status, reason: reason.trim() || undefined };
      case "setSplit":
        return { kind, split: split === "" ? null : split };
      case "addToCollection":
      case "removeFromCollection":
        if (!collection) {
          setError("请选择集合");
          return null;
        }
        return { kind, collection };
      default:
        return null;
    }
  };

  const previewChanges = async () => {
    const op = buildOp();
    if (!op) return;
    setBusy(true);
    try {
      const result = await api.batchPreview({ assetIds: selection, op });
      setPreview(result);
    } catch (error) {
      setError(normalizeError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api.batchApply(preview.previewId);
      bumpRefresh();
      await reloadCollections();
      onClose();
      notify({
        tone: "success",
        title: result.label,
        message: `已更新 ${result.applied} 张图片`,
        actionLabel: S.common.undo,
        onAction: async () => {
          try {
            const undone = await api.undo();
            bumpRefresh();
            notify({ message: undone ? `已撤销：${undone.label}` : "没有可撤销的操作" });
          } catch (error) {
            notify({ tone: "danger", message: normalizeError(error).message });
          }
        },
      });
    } catch (error) {
      setError(normalizeError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const sourceOptions = useMemo(
    () =>
      selection.map((id) => ({
        id,
        name: assetNames[id] || id.slice(0, 8),
      })),
    [selection, assetNames],
  );

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={S.library.batchEdit}
      subtitle={`作用范围：已选 ${selection.length} 张图片`}
      width="wide"
      closeOnBackdrop={!busy}
      footer={
        <>
          <div className="left hint">预览会重新校验图片修订号；应用后可撤销。</div>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {S.common.cancel}
          </button>
          <button type="button" className="btn subtle" onClick={() => void previewChanges()} disabled={busy}>
            {busy ? <Spinner /> : <Icon name="eye" />}
            预览变更
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void apply()}
            disabled={!preview || busy || preview.count === 0}
          >
            {busy ? <Spinner /> : <Icon name="check" />}
            应用 {preview ? `(${preview.count})` : ""}
          </button>
        </>
      }
    >
      <div className="batch-grid">
        <div className="stack" style={{ gap: 14 }}>
          <Field label="操作">
            <select className="select" value={kind} onChange={(event) => change(setKind)(event.target.value as OpKind)}>
              {OP_LABELS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>

          {kind === "addTags" || kind === "removeTags" ? (
            <Field label="标签" hint="用逗号或换行分隔多个标签。">
              <textarea
                className="textarea"
                style={{ minHeight: 80 }}
                value={tagsText}
                onChange={(event) => change(setTagsText)(event.target.value)}
                placeholder="tag_one, tag_two"
              />
            </Field>
          ) : null}

          {kind === "replaceTag" ? (
            <div className="grid-2">
              <Field label="原标签">
                <input className="input" value={from} onChange={(event) => change(setFrom)(event.target.value)} />
              </Field>
              <Field label="替换为" hint="留空表示删除">
                <input className="input" value={to} onChange={(event) => change(setTo)(event.target.value)} />
              </Field>
            </div>
          ) : null}

          {kind === "moveToFront" ? (
            <Field label="标签">
              <input className="input" value={tag} onChange={(event) => change(setTag)(event.target.value)} />
            </Field>
          ) : null}

          {kind === "copyCaption" ? (
            <Field label="标注来源" hint="来源图片当前版本的标注会复制到所有选中图片。">
              <select className="select" value={source} onChange={(event) => change(setSource)(event.target.value)}>
                {sourceOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {kind === "cleanShort" ? (
            <Field label="保留标签的最小字符数" hint="短于或等于此长度的标签会被移除；触发词与首词受保护。">
              <input
                className="input number"
                type="number"
                min={0}
                max={12}
                value={maxLen}
                onChange={(event) => change(setMaxLen)(Number(event.target.value))}
              />
            </Field>
          ) : null}

          {kind === "setStatus" ? (
            <>
              <Field label="审核状态">
                <select
                  className="select"
                  value={status}
                  onChange={(event) => change(setStatus)(event.target.value as ReviewStatus)}
                >
                  <option value="approved">已通过</option>
                  <option value="review">需复核</option>
                  <option value="excluded">已排除</option>
                  <option value="pending">待审核</option>
                </select>
              </Field>
              {status === "excluded" ? (
                <Field label="排除原因">
                  <input
                    className="input"
                    value={reason}
                    onChange={(event) => change(setReason)(event.target.value)}
                    placeholder="例如：重复素材"
                  />
                </Field>
              ) : null}
            </>
          ) : null}

          {kind === "setSplit" ? (
            <Field label="用途">
              <select
                className="select"
                value={split}
                onChange={(event) => change(setSplit)(event.target.value as "" | "train" | "val")}
              >
                <option value="train">锁定训练</option>
                <option value="val">锁定验证</option>
                <option value="">取消用途</option>
              </select>
            </Field>
          ) : null}

          {kind === "addToCollection" || kind === "removeFromCollection" ? (
            <Field label="集合">
              <select
                className="select"
                value={collection}
                onChange={(event) => change(setCollection)(event.target.value)}
              >
                {collections.length === 0 ? <option value="">暂无集合</option> : null}
                {collections.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}（{item.count}）
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {error ? <Notice tone="danger">{error}</Notice> : null}
        </div>

        <div className="stack" style={{ gap: 10, minWidth: 0 }}>
          <div className="group-title">变更预览</div>
          {preview ? (
            <>
              <div className="well">
                <div className="small" style={{ fontWeight: 600 }}>
                  {preview.summary}
                </div>
                {preview.warnings.map((warning, index) => (
                  <div key={index} className="tiny" style={{ color: "var(--warning)", marginTop: 4 }}>
                    {warning}
                  </div>
                ))}
              </div>
              <div className="stack" style={{ gap: 6, maxHeight: 220, overflow: "auto" }}>
                {preview.diffs.map((diff) => (
                  <div key={diff.assetId} className="well" style={{ padding: 8 }}>
                    <div className="tiny" style={{ fontWeight: 600 }}>
                      {diff.name}
                    </div>
                    <div className="tiny faint" style={{ textDecoration: "line-through", marginTop: 2, overflowWrap: "anywhere" }}>
                      {diff.before || "（空）"}
                    </div>
                    <div className="tiny" style={{ marginTop: 2, overflowWrap: "anywhere" }}>
                      {diff.after || "（空）"}
                    </div>
                  </div>
                ))}
              </div>
              {preview.skipped.length > 0 ? (
                <details>
                  <summary className="tiny faint" style={{ cursor: "pointer" }}>
                    跳过 {preview.skipped.length} 张
                  </summary>
                  <div className="stack" style={{ gap: 2, marginTop: 4 }}>
                    {preview.skipped.map((item) => (
                      <div key={item.assetId} className="tiny faint">
                        {item.name || item.assetId} · {item.reason}
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          ) : (
            <div className="well" style={{ color: "var(--faint)", fontSize: 12.5, padding: 18 }}>
              选择操作并点击「预览变更」，这里会显示变更数量、代表差异与跳过原因。
            </div>
          )}
          <div className="row-wrap">
            <Badge tone="info">已选 {selection.length}</Badge>
            {focusedId ? <Badge>焦点：{assetNames[focusedId] || focusedId.slice(0, 8)}</Badge> : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
