import { useEffect, useState } from "react";
import type { AssetDetail, AssetPatch } from "../../lib/types";
import { S } from "../../lib/strings";
import { classNames, formatBytes, formatDate, formatPercent, prettyPath, splitLabel } from "../../lib/utils";
import { Icon } from "../../components/Icon";
import { Badge, Notice } from "../../components/ui";

export function InfoPanel({
  detail,
  onPatch,
  onRelink,
}: {
  detail: AssetDetail;
  onPatch: (patch: AssetPatch, label: string) => void;
  onRelink: (root: string | null) => void;
}) {
  const [note, setNote] = useState(detail.summary.note);
  useEffect(() => {
    setNote(detail.summary.note);
  }, [detail.summary.id, detail.summary.note]);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="form-block">
        <div className="form-block-head">
          <Icon name="info" className="sm" />
          <h4>{S.workbench.tabs.info}</h4>
          <div className="spacer" />
          <Badge tone={detail.summary.status === "approved" ? "success" : detail.summary.status === "excluded" ? "danger" : detail.summary.status === "review" ? "warning" : "neutral"}>
            {detail.summary.status === "approved"
              ? S.status.approved
              : detail.summary.status === "excluded"
                ? S.status.excluded
                : detail.summary.status === "review"
                  ? S.status.review
                  : S.status.pending}
          </Badge>
        </div>
        <div className="info-row">
          <span className="k">文件名</span>
          <span className="v">{detail.summary.name}</span>
        </div>
        <div className="info-row">
          <span className="k">格式</span>
          <span className="v">
            {detail.summary.format} · {detail.hasAlpha ? "含透明通道" : "无透明通道"}
          </span>
        </div>
        <div className="info-row">
          <span className="k">原始尺寸</span>
          <span className="v mono">
            {detail.normWidth}×{detail.normHeight} · {formatBytes(detail.filesize)}
          </span>
        </div>
        <div className="info-row">
          <span className="k">计划输出</span>
          <span className="v mono">
            {detail.summary.outWidth}×{detail.summary.outHeight}
          </span>
        </div>
        <div className="info-row">
          <span className="k">裁掉 / 补边</span>
          <span className="v">
            {formatPercent(detail.summary.cropRatio)} / {formatPercent(detail.summary.padRatio)}
          </span>
        </div>
        <div className="info-row">
          <span className="k">内容指纹</span>
          <span className="v mono tiny">{detail.sha256.slice(0, 20)}…</span>
        </div>
        <div className="info-row">
          <span className="k">感知哈希</span>
          <span className="v mono tiny">{detail.phash || "未计算"}</span>
        </div>
        <div className="info-row">
          <span className="k">清晰度方差</span>
          <span className="v mono tiny">{detail.blurScore === null ? "—" : detail.blurScore.toFixed(1)}</span>
        </div>
        <div className="info-row">
          <span className="k">曝光比例</span>
          <span className="v mono tiny">
            暗 {detail.darkRatio === null ? "—" : formatPercent(detail.darkRatio)} · 亮{" "}
            {detail.brightRatio === null ? "—" : formatPercent(detail.brightRatio)}
          </span>
        </div>
        <div className="info-row">
          <span className="k">导入时间</span>
          <span className="v">{formatDate(detail.importedAt)}</span>
        </div>
        <div className="info-row">
          <span className="k">来源目录</span>
          <span className="v mono tiny">{detail.sourceRoot ? prettyPath(detail.sourceRoot) : "受管理原件"}</span>
        </div>
        <details>
          <summary className="group-title" style={{ cursor: "pointer" }}>
            完整路径
          </summary>
          <div className="path-block" style={{ marginTop: 6 }}>{prettyPath(detail.sourcePath)}</div>
        </details>
        {detail.missing ? (
          <Notice tone="danger">
            <div className="row-wrap">
              <span className="grow">源文件已失联，导出会被阻塞。</span>
              <button type="button" className="btn sm subtle" onClick={() => onRelink(detail.sourceRoot)}>
                <Icon name="link" className="sm" />
                {S.inspector.relink}
              </button>
            </div>
          </Notice>
        ) : null}
        {detail.excludedReason ? (
          <Notice tone="warning">排除原因：{detail.excludedReason}</Notice>
        ) : null}
      </div>

      <div className="form-block">
        <div className="form-block-head">
          <Icon name="layers" className="sm" />
          <h4>用途与触发词</h4>
        </div>
        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
          <span className="small muted">训练 / 验证</span>
          <select
            className="select"
            style={{ width: 140, minHeight: 36 }}
            value={detail.summary.splitLock || ""}
            onChange={(event) =>
              onPatch(
                { splitLock: event.target.value as "" | "train" | "val" },
                `已更新用途：${splitLabel(event.target.value || null)}`,
              )
            }
          >
            <option value="">未分配</option>
            <option value="train">锁定训练</option>
            <option value="val">锁定验证</option>
          </select>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={detail.summary.triggerDisabled}
            onChange={(event) =>
              onPatch(
                { triggerDisabled: event.target.checked },
                event.target.checked ? "本图不添加触发词" : "恢复触发词",
              )
            }
          />
          {S.inspector.triggerDisabled}
        </label>
        <button
          type="button"
          className={classNames("btn", detail.summary.favorite ? "secondary" : "subtle")}
          onClick={() => onPatch({ favorite: !detail.summary.favorite }, detail.summary.favorite ? "已取消收藏" : "已收藏")}
        >
          <Icon name="star" style={detail.summary.favorite ? { fill: "var(--warning)", color: "var(--warning)" } : undefined} />
          {detail.summary.favorite ? "已收藏" : "收藏此图"}
        </button>
      </div>

      <div className="form-block">
        <div className="form-block-head">
          <Icon name="folder" className="sm" />
          <h4>集合</h4>
        </div>
        {detail.collections.length === 0 ? (
          <span className="hint">不属于任何集合</span>
        ) : (
          <div className="row-wrap">
            {detail.collections.map((collection) => (
              <span key={collection.id} className="chip">
                <Icon name="folder" className="sm" />
                {collection.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="form-block">
        <div className="form-block-head">
          <Icon name="alert" className="sm" />
          <h4>{S.inspector.issues}</h4>
          <Badge tone={detail.issues.length ? "warning" : "success"}>{detail.issues.length}</Badge>
        </div>
        {detail.issues.length === 0 ? (
          <span className="hint">{S.inspector.noIssues}</span>
        ) : (
          <div className="stack" style={{ gap: 5 }}>
            {detail.issues.map((issue) => (
              <div key={issue.id} className={classNames("issue-line", issue.level)}>
                <Icon name={issue.level === "blocking" ? "alert" : "info"} className="sm" style={{ marginTop: 1 }} />
                <span className="issue-msg">{issue.message}</span>
                {issue.ignored ? <Badge tone="neutral">{S.quality.ignored}</Badge> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="form-block">
        <div className="form-block-head">
          <Icon name="file" className="sm" />
          <h4>备注</h4>
        </div>
        <textarea
          className="textarea"
          style={{ minHeight: 78 }}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => {
            if (note !== detail.summary.note) onPatch({ note }, "备注已保存");
          }}
          placeholder={S.inspector.notesPlaceholder}
        />
      </div>

      <div className="form-block" style={{ borderBottom: 0, paddingBottom: 0 }}>
        <div className="form-block-head">
          <Icon name="history" className="sm" />
          <h4>{S.inspector.history}</h4>
        </div>
        {detail.history.length === 0 ? (
          <span className="hint">暂无修改记录</span>
        ) : (
          <div className="history-list">
            {detail.history.slice(0, 12).map((entry) => (
              <div className="history-row" key={entry.seq}>
                <Icon name={entry.undone ? "undo" : "edit"} className="sm" />
                <span className="truncate">{entry.label}</span>
                <span className="time">
                  {new Date(entry.createdAt).toLocaleString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
