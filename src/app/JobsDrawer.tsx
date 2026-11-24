import { useState } from "react";
import { api, normalizeError } from "../lib/api";
import type { JobInfo } from "../lib/types";
import { useProject } from "./ProjectContext";
import { Badge, IconButton, Progress, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { classNames, formatRelative } from "../lib/utils";
import { S } from "../lib/strings";

function kindLabel(kind: string): string {
  if (kind === "import") return "导入";
  if (kind === "export") return "导出";
  if (kind === "metrics") return "指标";
  return kind;
}

function statusTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "running" || status === "queued") return "info";
  if (status === "completed") return "success";
  if (status === "completed_with_errors") return "warning";
  if (status === "failed") return "danger";
  if (status === "paused") return "warning";
  return "neutral";
}

function jobErrors(job: JobInfo): { path: string; message: string }[] {
  const resultErrors = job.result?.errors;
  if (Array.isArray(resultErrors)) {
    return resultErrors
      .filter((item) => item && typeof item === "object")
      .map((item: any) => ({ path: item.path || item.itemId || "", message: item.message || "" }));
  }
  if (job.error) {
    return [{ path: "", message: job.error.message || "任务失败" }];
  }
  return [];
}

export function JobsDrawer() {
  const { jobs, jobsOpen, setJobsOpen, reloadJobs, notify, refreshProject, bumpRefresh, navigate } = useProject();
  const [busy, setBusy] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);

  if (!jobsOpen) return null;

  const activeJobs = jobs.filter((job) => ["running", "queued", "paused"].includes(job.status));
  const finishedJobs = jobs.filter((job) => !["running", "queued", "paused"].includes(job.status));

  const runAction = async (action: () => Promise<unknown>, message?: string) => {
    setBusy(action.name || "action");
    try {
      await action();
      await reloadJobs();
      await refreshProject();
      bumpRefresh();
      if (message) notify({ tone: "success", message });
    } catch (error) {
      notify({ tone: "danger", title: "任务操作失败", message: normalizeError(error).message });
    } finally {
      setBusy(null);
    }
  };

  const renderJob = (job: JobInfo) => {
    const errors = jobErrors(job);
    const isActive = ["running", "queued", "paused"].includes(job.status);
    const percent = job.total > 0 ? job.done / job.total : job.progress;
    const canRetry = job.status === "failed" || job.status === "completed_with_errors";
    return (
      <div className={classNames("job-item", job.status)} key={job.id}>
        <div className="job-top">
          <div className="job-main grow">
            <div className="job-title">{job.title}</div>
            <div className="job-meta">
              <span>{kindLabel(job.kind)}</span>
              <span>·</span>
              <span>{formatRelative(job.updatedAt)}</span>
              {job.total > 0 ? (
                <span className="mono">
                  {job.done}/{job.total}
                </span>
              ) : job.phase ? (
                <span>{job.phase}</span>
              ) : null}
              {job.failed > 0 ? <span style={{ color: "var(--danger)" }}>失败 {job.failed}</span> : null}
            </div>
          </div>
          <Badge tone={statusTone(job.status)} dot>
            {job.status === "running"
              ? "运行中"
              : job.status === "queued"
                ? "排队中"
                : job.status === "paused"
                  ? "待恢复"
                  : job.status === "completed"
                    ? "已完成"
                    : job.status === "completed_with_errors"
                      ? "部分失败"
                      : job.status === "failed"
                        ? "失败"
                        : "已取消"}
          </Badge>
        </div>
        {isActive ? (
          <>
            <Progress value={percent} danger={job.failed > 0} />
            <div className="job-meta">
              <span>{job.phase || "处理中"}</span>
              {/* 分数进度仅在已知总数时展示 */}
              {job.total > 0 ? <span>{Math.round(percent * 100)}%</span> : null}
            </div>
          </>
        ) : null}
        <div className="job-actions">
          {job.status === "running" ? (
            <button
              type="button"
              className="btn subtle sm"
              disabled={busy !== null}
              onClick={() => void runAction(() => api.pauseJob(job.id), "任务已暂停")}
            >
              <Icon name="pause" className="sm" />
              暂停
            </button>
          ) : null}
          {job.status === "paused" ? (
            <button
              type="button"
              className="btn subtle sm"
              disabled={busy !== null}
              onClick={() =>
                void runAction(async () => {
                  const result = await api.resumeJob(job.id);
                  if (result) {
                    notify({ tone: "success", message: `已重新启动导入任务（${result.total} 张）` });
                  }
                }, "任务已继续")
              }
            >
              {busy ? <Spinner /> : <Icon name="play" className="sm" />}
              继续
            </button>
          ) : null}
          {isActive ? (
            <button
              type="button"
              className="btn subtle sm"
              disabled={busy !== null}
              onClick={() => void runAction(() => api.cancelJob(job.id), "任务已取消")}
            >
              <Icon name="stop" className="sm" />
              取消
            </button>
          ) : null}
          {canRetry && job.kind === "import" ? (
            <button
              type="button"
              className="btn secondary sm"
              disabled={busy !== null}
              onClick={() =>
                void runAction(async () => {
                  const result = await api.retryImport(job.id);
                  notify({ tone: "success", message: `正在重试导入（${result.total} 张）` });
                })
              }
            >
              <Icon name="refresh" className="sm" />
              重试
            </button>
          ) : null}
          {canRetry && job.kind === "export" ? (
            <button
              type="button"
              className="btn secondary sm"
              disabled={busy !== null}
              onClick={() =>
                void runAction(async () => {
                  await api.retryFailed(job.id);
                  notify({ tone: "success", message: "正在重新执行导出任务" });
                })
              }
            >
              <Icon name="refresh" className="sm" />
              重试
            </button>
          ) : null}
          {job.kind === "export" && job.result?.outputPath ? (
            <button
              type="button"
              className="btn subtle sm"
              onClick={() => navigate("export")}
            >
              <Icon name="export" className="sm" />
              导出页
            </button>
          ) : null}
          {errors.length > 0 ||
          (Array.isArray(job.result?.conflicts) && job.result.conflicts.length > 0) ||
          (Array.isArray(job.result?.duplicates) && job.result.duplicates.length > 0) ||
          job.result?.scanSkipped ? (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setDetailFor(detailFor === job.id ? null : job.id)}
            >
              <Icon name="file" className="sm" />
              查看详情
            </button>
          ) : null}
        </div>
        {detailFor === job.id ? (
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            {job.kind === "import" && job.result ? (
              <div className="job-error" style={{ background: "var(--surface-subtle)", color: "var(--muted)" }}>
                成功 {Number(job.result.success || 0)} · 跳过 {Number(job.result.skipped || 0)} · 失败{" "}
                {Number(job.result.failed || 0)}
                {job.result.scanSkipped
                  ? ` · 扫描阶段跳过 ${Number(job.result.scanSkipped.errors || 0) + Number(job.result.scanSkipped.animated || 0) + Number(job.result.scanSkipped.unsupported || 0) + Number(job.result.scanSkipped.oversized || 0)} 项`
                  : ""}
              </div>
            ) : null}
            {Array.isArray(job.result?.conflicts) && job.result.conflicts.length > 0 ? (
              <div className="stack" style={{ gap: 3 }}>
                <span className="tiny" style={{ fontWeight: 600 }}>标注冲突（{job.result.conflicts.length}）</span>
                {job.result.conflicts.slice(0, 20).map((conflict: string, index: number) => (
                  <div className="job-error" key={index}>{conflict}</div>
                ))}
              </div>
            ) : null}
            {Array.isArray(job.result?.duplicates) && job.result.duplicates.length > 0 ? (
              <div className="stack" style={{ gap: 3 }}>
                <span className="tiny" style={{ fontWeight: 600 }}>跳过的精确重复（{job.result.duplicates.length}）</span>
                {job.result.duplicates.slice(0, 20).map((duplicate: string, index: number) => (
                  <div className="tiny" style={{ color: "var(--faint)" }} key={index}>{duplicate}</div>
                ))}
              </div>
            ) : null}
            {errors.slice(0, 20).map((error, index) => (
              <div className="job-error" key={index}>
                {error.path ? <div className="mono" style={{ fontSize: 10 }}>{error.path}</div> : null}
                {error.message}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="jobs-backdrop" onMouseDown={() => setJobsOpen(false)} />
      <aside className="jobs-drawer" role="dialog" aria-label={S.jobs.title}>
        <div className="jobs-head">
          <Icon name="tasks" />
          <h3>{S.jobs.title}</h3>
          <span className="count">{activeJobs.length}</span>
          <IconButton icon="x" label={S.jobs.closePanel} onClick={() => setJobsOpen(false)} />
        </div>
        <div className="jobs-body">
          {jobs.length === 0 ? (
            <div className="empty" style={{ padding: "36px 16px" }}>
              <div className="empty-icon">
                <Icon name="tasks" size={26} />
              </div>
              <h3>{S.jobs.empty}</h3>
              <p>{S.jobs.emptyBody}</p>
            </div>
          ) : (
            <>
              {activeJobs.length > 0 ? (
                <>
                  <div className="job-group-label">{S.jobs.running}</div>
                  {activeJobs.map(renderJob)}
                </>
              ) : null}
              {finishedJobs.length > 0 ? (
                <>
                  <div className="job-group-label">{S.jobs.completed}</div>
                  {finishedJobs.map(renderJob)}
                </>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
