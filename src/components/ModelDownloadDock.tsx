import { useRoot } from "../app/AppProvider";
import { formatBytes } from "../lib/utils";
import { Icon } from "./Icon";

/** 全局后台模型下载指示器：切换页面或关闭设置弹窗后仍然可见。 */
export function ModelDownloadDock() {
  const { modelDownloads, dismissModelDownload } = useRoot();
  if (modelDownloads.length === 0) return null;
  return (
    <aside className="model-download-dock" aria-live="polite" aria-label="后台模型下载">
      <div className="model-download-dock-head">
        <Icon name="download" className="sm" />
        <strong>模型后台下载</strong>
        <span className="tiny faint">{modelDownloads.length}</span>
      </div>
      {modelDownloads.map((task) => (
        <div className="model-download-dock-item" key={task.modelId}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
            <span className="model-download-dock-name" title={task.name}>
              {task.name}
            </span>
            <button
              type="button"
              className="btn ghost sm"
              aria-label={`移除 ${task.name} 下载状态`}
              title="关闭"
              onClick={() => dismissModelDownload(task.modelId)}
            >
              <Icon name="x" className="sm" />
            </button>
          </div>
          {task.status === "running" ? (
            <>
              <div className="tiny faint model-download-dock-file">{task.file || "连接中…"}</div>
              <div className="download-bar" style={{ marginTop: 6 }}>
                <span style={{ width: `${Math.max(1, Math.min(100, task.percent || 0))}%` }} />
              </div>
              <div className="tiny mono faint" style={{ marginTop: 4 }}>
                {task.total > 0
                  ? `${task.percent.toFixed(1)}% · ${formatBytes(task.downloaded)} / ${formatBytes(task.total)}`
                  : formatBytes(task.downloaded)}
              </div>
            </>
          ) : task.status === "done" ? (
            <div className="tiny" style={{ color: "var(--success)", marginTop: 4 }}>
              下载完成 · {formatBytes(task.downloaded)}
            </div>
          ) : (
            <div className="tiny" style={{ color: "var(--danger)", marginTop: 4 }}>
              {task.error || "下载失败"}
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}
