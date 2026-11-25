import { useEffect, useMemo, useRef, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { BatchOp, BatchPreview, ReviewStatus } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { S } from "../../lib/strings";
import { Icon } from "../../components/Icon";
import { Field, Modal, Notice, Select, Spinner } from "../../components/ui";

type OpKind =
  | "addTags"
  | "extractTags"
  | "regexRemoveTags"
  | "regexReplaceTags"
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
  { value: "extractTags", label: "从文件名添加标签" },
  { value: "regexReplaceTags", label: "正则替换标签" },
  { value: "regexRemoveTags", label: "正则删除标签" },
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
  hiddenSelected,
}: {
  open: boolean;
  onClose: () => void;
  assetNames: Record<string, string>;
  hiddenSelected: number;
}) {
  const { selection, focusedId, collections, notify, bumpRefresh, reloadCollections } = useProject();
  const [kind, setKind] = useState<OpKind>("addTags");
  const [tagsText, setTagsText] = useState("");
  const [extractSyntax, setExtractSyntax] = useState<"template" | "regex">("template");
  const [filenamePattern, setFilenamePattern] = useState("");
  const [tagTemplates, setTagTemplates] = useState("");
  const [tagPattern, setTagPattern] = useState("");
  const [replacement, setReplacement] = useState("");
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
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setPreview(null);
      setError(null);
      setSource(focusedId || selection[0] || "");
      const manual = collections.filter((item) => item.kind !== "query");
      if (!manual.some((item) => item.id === collection)) setCollection(manual[0]?.id ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && preview && window.matchMedia("(max-width: 639.98px)").matches) {
      const panel = previewRef.current;
      const body = panel?.closest<HTMLElement>(".modal-body");
      if (panel && body) {
        body.scrollTop += panel.getBoundingClientRect().top - body.getBoundingClientRect().top;
      }
    }
  }, [open, preview]);

  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPreview(null);
    setError(null);
  };

  const buildOp = (): BatchOp | null => {
    setError(null);
    switch (kind) {
      case "extractTags": {
        const templates = tagTemplates.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (!filenamePattern.trim() || templates.length === 0) {
          setError("请填写文件名匹配规则和标签模板");
          return null;
        }
        return { kind, syntax: extractSyntax, pattern: filenamePattern, templates };
      }
      case "regexRemoveTags":
      case "regexReplaceTags":
        if (!tagPattern) {
          setError("请输入要匹配的标签正则");
          return null;
        }
        return kind === "regexReplaceTags" ? { kind, pattern: tagPattern, replacement } : { kind, pattern: tagPattern };
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
    setPreview(null);
    setBusy(true);
    try {
      const result = await api.batchPreview({ assetIds: selection, op });
      setPreview(result);
    } catch (error) {
      setPreview(null);
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
            const undone = await api.undo(result.historySeq);
            bumpRefresh();
            notify({ message: undone ? `已撤销：${undone.label}` : "没有可撤销的操作" });
          } catch (error) {
            notify({ tone: "danger", message: normalizeError(error).message });
          }
        },
      });
    } catch (error) {
      setPreview(null);
      setError(normalizeError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const sourceOptions = useMemo(
    () =>
      open && kind === "copyCaption" ? selection.map((id) => ({
        id,
        name: assetNames[id] || id.slice(0, 8),
      })) : [],
    [open, kind, selection, assetNames],
  );

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={S.library.batchEdit}
      subtitle={`已选 ${selection.length} 张图片${hiddenSelected ? `，含 ${hiddenSelected} 张被筛选隐藏` : ""}`}
      width="wide"
      closeOnBackdrop={!busy}
      footer={
        <>
          <div className="left hint">应用后可撤销</div>
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
        <fieldset className="stack batch-fields" disabled={busy}>
          <Field label="操作">
            <Select ariaLabel="批量操作" options={OP_LABELS} value={kind}
              onChange={(value) => change(setKind)(value as OpKind)} />
          </Field>

          {kind === "extractTags" ? (
            <>
              <div className="row-wrap batch-pattern-controls">
                <Select ariaLabel="文件名匹配方式" value={extractSyntax}
                  options={[{ value: "template", label: "文件名模板" }, { value: "regex", label: "原生正则" }]}
                  onChange={(value) => change(setExtractSyntax)(value === "regex" ? "regex" : "template")} />
                <button type="button" className="btn ghost sm" onClick={() => {
                  change(setFilenamePattern)(extractSyntax === "template"
                    ? "[{{artist: str}}] {{id: int}}.png"
                    : String.raw`^\[(?P<artist>[^\]]+)\] (?P<id>[0-9]+)\.png$`);
                  change(setTagTemplates)("artist: {{artist}}\nid: {{id}}");
                }}>
                  填入示例
                </button>
              </div>
              <Field label="匹配文件名" hint={extractSyntax === "template" ? "匹配完整文件名，含扩展名。str 匹配文字，int 匹配数字并保留前导零。" : "用 (?P<名称>…) 命名捕获组，或用普通括号按顺序捕获。"}>
                <input className="input batch-pattern" aria-label="文件名匹配规则" spellCheck={false} value={filenamePattern} onChange={(event) => change(setFilenamePattern)(event.target.value)} placeholder={extractSyntax === "template" ? "[{{artist: str}}] {{id: int}}.png" : "^(.+)\\.png$"} />
              </Field>
              <Field label="标签模板" hint="每行一个标签。用 {{artist}} 或 {{1}} 引用提取结果。">
                <textarea className="textarea batch-pattern" rows={3} aria-label="标签模板" spellCheck={false} value={tagTemplates} onChange={(event) => change(setTagTemplates)(event.target.value)} placeholder="artist: {{artist}}" />
              </Field>
            </>
          ) : null}

          {kind === "regexRemoveTags" || kind === "regexReplaceTags" ? (
            <>
              <Field label="标签正则" hint={kind === "regexRemoveTags" ? "移除匹配的整个标签。用 (?i) 忽略大小写。" : "逐个标签替换匹配片段。用 (?i) 忽略大小写。"}>
                <input className="input batch-pattern" aria-label="标签正则" spellCheck={false} value={tagPattern} onChange={(event) => change(setTagPattern)(event.target.value)} placeholder="^artist: (.+)$" />
              </Field>
              {kind === "regexReplaceTags" ? (
                <Field label="替换为" hint="用 {{1}} 或 {{名称}} 引用捕获组。留空会移除匹配片段。">
                  <input className="input batch-pattern" aria-label="替换为" spellCheck={false} value={replacement} onChange={(event) => change(setReplacement)(event.target.value)} placeholder="by {{1}}" />
                </Field>
              ) : null}
            </>
          ) : null}

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
                {!collections.some((item) => item.kind !== "query") ? <option value="">暂无集合</option> : null}
                {collections.filter((item) => item.kind !== "query").map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}（{item.count}）
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {error ? <Notice tone="danger"><span className="gallery-pattern-error">{error}</span></Notice> : null}
        </fieldset>

        <div ref={previewRef} className="stack" style={{ gap: 10, minWidth: 0 }} aria-live="polite">
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
                    {diff.tagChanges ? (
                      <ul className="batch-tag-diff">
                        {diff.tagChanges.removed.map((tag) => <li key={`removed-${tag}`}><del>− {tag}</del></li>)}
                        {diff.tagChanges.added.map((tag) => <li key={`added-${tag}`}>+ {tag}</li>)}
                      </ul>
                    ) : (
                      <>
                        <div className="tiny faint" style={{ textDecoration: "line-through", marginTop: 2, overflowWrap: "anywhere" }}>
                          {diff.before || "（空）"}
                        </div>
                        <div className="tiny" style={{ marginTop: 2, overflowWrap: "anywhere" }}>
                          {diff.after || "（空）"}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {preview.skipped.length > 0 ? (
                <details>
                  <summary className="tiny faint" style={{ cursor: "pointer" }}>
                    跳过 {preview.skippedCount} 张{preview.skippedCount > preview.skipped.length ? `（显示前 ${preview.skipped.length} 张）` : ""}
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
              点击「预览变更」查看改动
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
