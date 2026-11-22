import { useCallback, useEffect, useMemo, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type {
  DuplicateGroupView,
  IssueRow,
  QualityIssues,
  QualityOverview,
  QualitySummary,
} from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { S } from "../../lib/strings";
import {
  classNames,
  formatDate,
  formatNumber,
  statusLabel,
  statusTone,
  thumbUrlRaw,
  prettyPath,
} from "../../lib/utils";
import { Icon } from "../../components/Icon";
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  IconButton,
  PromptDialog,
  Segmented,
  Spinner,
} from "../../components/ui";

type Severity = "blocking" | "suggestion" | "ignored";
type ViewTab = "issues" | "duplicates" | "overview";

export function QualityPage({ active }: { active: boolean }) {
  const { project, notify, bumpRefresh, refreshToken, openWorkbench, navigateToLibrary } = useProject();
  const [summary, setSummary] = useState<QualitySummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [severity, setSeverity] = useState<Severity>("blocking");
  const [viewTab, setViewTab] = useState<ViewTab>("issues");
  const [splitScope, setSplitScope] = useState<"" | "train" | "val">("");
  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  const [issues, setIssues] = useState<QualityIssues | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateGroupView[] | null>(null);
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const [duplicateSelection, setDuplicateSelection] = useState<Set<string>>(new Set());
  const [overview, setOverview] = useState<QualityOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [ignoreTarget, setIgnoreTarget] = useState<IssueRow | null>(null);
  const [dismissTarget, setDismissTarget] = useState<DuplicateGroupView | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    setError(null);
    try {
      const result = await api.qualitySummary();
      setSummary(result);
    } catch (error) {
      setError(normalizeError(error).message);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void loadSummary();
  }, [active, refreshToken, loadSummary]);

  const severityRules = useMemo(() => {
    if (!summary) return [];
    return summary.rules.filter((rule) => {
      if (severity === "ignored") return rule.ignored > 0;
      if (rule.level !== severity) return false;
      return rule.count - rule.ignored > 0;
    });
  }, [summary, severity]);

  useEffect(() => {
    if (viewTab !== "issues") return;
    if (severityRules.length === 0) {
      setSelectedRule(null);
      setIssues(null);
      return;
    }
    if (!selectedRule || !severityRules.some((rule) => rule.rule === selectedRule)) {
      setSelectedRule(severityRules[0].rule);
    }
  }, [severityRules, selectedRule, viewTab]);

  const loadIssues = useCallback(async () => {
    if (!selectedRule) {
      setIssues(null);
      return;
    }
    setIssuesLoading(true);
    try {
      const result = await api.qualityIssues(
        selectedRule,
        severity === "ignored",
        splitScope || null,
      );
      setIssues({
        ...result,
        rows: severity === "ignored" ? result.rows.filter((row) => row.ignored) : result.rows,
      });
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
      setIssues(null);
    } finally {
      setIssuesLoading(false);
    }
  }, [selectedRule, severity, splitScope, notify]);

  useEffect(() => {
    if (active && viewTab === "issues") void loadIssues();
  }, [active, viewTab, selectedRule, severity, splitScope, refreshToken, loadIssues]);

  const loadDuplicates = useCallback(async () => {
    setDuplicatesLoading(true);
    try {
      setDuplicates(await api.qualityDuplicates());
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    } finally {
      setDuplicatesLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (active && viewTab === "duplicates") void loadDuplicates();
  }, [active, viewTab, refreshToken, loadDuplicates]);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      setOverview(await api.qualityOverview());
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    } finally {
      setOverviewLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (active && viewTab === "overview") void loadOverview();
  }, [active, viewTab, refreshToken, loadOverview]);

  const rescan = async () => {
    setRescanning(true);
    try {
      const result = await api.runQuality();
      setSummary(result.summary);
      bumpRefresh();
      notify({
        tone: "success",
        title: S.quality.title,
        message: S.quality.scanSummary(result.summary.blocking, result.summary.suggestions),
      });
      await loadSummary();
      if (viewTab === "duplicates") await loadDuplicates();
      if (viewTab === "overview") await loadOverview();
    } catch (error) {
      notify({ tone: "danger", title: S.quality.scanFailed, message: normalizeError(error).message });
    } finally {
      setRescanning(false);
    }
  };

  const ignore = async (reason: string) => {
    if (!ignoreTarget) return;
    try {
      await api.ignoreIssue(ignoreTarget.id, reason);
      setIgnoreTarget(null);
      await loadSummary();
      await loadIssues();
      notify({ tone: "success", message: S.quality.ignoreSaved });
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  const unignore = async (row: IssueRow) => {
    try {
      await api.unignoreIssue(row.id);
      await loadSummary();
      await loadIssues();
      notify({ message: S.quality.unignored });
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  const runDuplicateAction = async (
    group: DuplicateGroupView,
    action: "keep" | "excludeOthers" | "notDuplicate" | "excludeSelected",
    options?: { assetIds?: string[]; keptAssetId?: string | null },
  ) => {
    try {
      await api.duplicateAction({
        groupId: group.id,
        action,
        assetIds: options?.assetIds,
        keptAssetId: options?.keptAssetId ?? group.keptAssetId,
      });
      await loadDuplicates();
      await loadSummary();
      setDuplicateSelection(new Set());
      bumpRefresh();
      notify({
        tone: "success",
        message:
          action === "notDuplicate"
            ? "已认定并非重复，后续不再提示"
            : action === "excludeOthers"
              ? "已保留所选图片并排除其余"
              : action === "excludeSelected"
                ? "已排除所选图片"
                : "已确认保留图片",
        actionLabel: action === "excludeOthers" || action === "excludeSelected" ? S.common.undo : undefined,
        onAction:
          action === "excludeOthers" || action === "excludeSelected"
            ? async () => {
                try {
                  await api.undo();
                  bumpRefresh();
                  await loadDuplicates();
                  await loadSummary();
                  notify({ message: "已撤销" });
                } catch (error) {
                  notify({ tone: "danger", message: normalizeError(error).message });
                }
              }
            : undefined,
      });
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  };

  const openIssueAsset = (assetId: string, rows: IssueRow[]) => {
    openWorkbench(assetId, {
      sequence: rows.map((row) => row.assetId),
      label: S.workbench.sequenceProblems,
    });
  };

  const maxBucket = (items: { count: number }[]) =>
    Math.max(1, ...items.map((item) => item.count));

  const scannedLabel = summary?.scannedAt
    ? `${S.quality.scannedAt}：${formatDate(summary.scannedAt)}`
    : S.quality.neverScanned;

  return (
    <div className="page">
      <div className="quality-page">
        <div className="quality-head">
          <div>
            <h1 className="page-title">{S.quality.title}</h1>
            <div className="scan-time">
              <Icon name="clock" className="sm" />
              {scannedLabel}
              {summary ? (
                <span className="mono" style={{ marginLeft: 6 }}>
                  · {formatNumber(project.counts.valid)} 有效素材
                </span>
              ) : null}
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn subtle" onClick={() => void loadSummary()} disabled={summaryLoading}>
              <Icon name="refresh" />
              {S.common.refresh}
            </button>
            <button type="button" className="btn primary" onClick={() => void rescan()} disabled={rescanning}>
              {rescanning ? <Spinner /> : <Icon name="shield" />}
              {rescanning ? S.quality.rescanning : S.quality.rescan}
            </button>
          </div>
        </div>

        {summary?.stale ? <div className="notice warning"><Icon name="alert" className="sm" />{S.quality.staleBanner}</div> : null}
        {error ? <div className="notice danger"><Icon name="alert" className="sm" />{error}</div> : null}

        <div className="quality-tabs">
          <div className="severity-tabs" role="tablist" aria-label="质检级别">
            {(
              [
                ["blocking", S.quality.blocking, summary?.blocking || 0],
                ["suggestion", S.quality.suggestions, summary?.suggestions || 0],
                ["ignored", S.quality.ignored, summary?.ignoredTotal || 0],
              ] as [Severity, string, number][]
            ).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                className={classNames("severity-tab", value, severity === value && "active")}
                onClick={() => setSeverity(value)}
                aria-pressed={severity === value}
              >
                {label}
                <span className="count">{count}</span>
              </button>
            ))}
          </div>
          <select
            className="select"
            style={{ width: 130, minHeight: 40, marginLeft: "auto" }}
            value={splitScope}
            onChange={(event) => setSplitScope(event.target.value as "" | "train" | "val")}
            aria-label={S.quality.splitFilter}
          >
            <option value="">{S.quality.scopeAll}</option>
            <option value="train">{S.quality.scopeTrain}</option>
            <option value="val">{S.quality.scopeVal}</option>
          </select>
          <Segmented
            value={viewTab}
            onChange={(value) => setViewTab(value as ViewTab)}
            options={[
              { value: "issues", label: S.quality.tabIssues, icon: "alert" },
              { value: "duplicates", label: S.quality.tabDuplicates, icon: "copy" },
              { value: "overview", label: S.quality.tabOverview, icon: "chart" },
            ]}
            compact
          />
        </div>

        {viewTab === "issues" ? (
          summaryLoading && !summary ? (
            <div className="loading-line"><Spinner size="lg" /> {S.quality.rescanning}</div>
          ) : severityRules.length === 0 ? (
            <EmptyState
              icon={severity === "blocking" ? "check-circle" : "search"}
              title={
                severity === "blocking"
                  ? "没有阻塞项"
                  : severity === "suggestion"
                    ? "没有待处理建议"
                    : "没有已忽略项"
              }
              body={
                summary?.scannedAt
                  ? "可以继续编辑素材，或重新检查已变化的项目。"
                  : "尚未扫描质检。点击「重新检查」生成问题列表与数据概况。"
              }
              actions={
                !summary?.scannedAt ? (
                  <button type="button" className="btn primary" onClick={() => void rescan()} disabled={rescanning}>
                    {rescanning ? <Spinner /> : <Icon name="shield" />}
                    {S.quality.rescan}
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="quality-layout">
              <div className="rule-list" role="list" aria-label="问题类型">
                {severityRules.map((rule) => (
                  <button
                    key={rule.rule}
                    type="button"
                    role="listitem"
                    className={classNames("rule-item", selectedRule === rule.rule && "active")}
                    onClick={() => setSelectedRule(rule.rule)}
                  >
                    <span className={classNames("rule-dot", rule.level)} />
                    <span className="rule-main">
                      <span className="rule-title">{rule.title}</span>
                      <span className="rule-desc">{rule.description}</span>
                    </span>
                    <span className="count">{rule.ignored > 0 ? `${rule.count - rule.ignored} / ${rule.count}` : rule.count}</span>
                  </button>
                ))}
              </div>
              <div className="quality-content">
                {issuesLoading ? (
                  <div className="loading-line"><Spinner /> 正在载入问题图片…</div>
                ) : issues ? (
                  <div className="issue-detail">
                    <div className="issue-detail-head">
                      <div>
                        <h3>{issues.title}</h3>
                        <p>{issues.description}</p>
                      </div>
                      <div className="issue-detail-actions">
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => navigateToLibrary({ issueRules: [issues.rule], issueLevels: [] })}
                        >
                          <Icon name="filter" className="sm" />
                          在筛选结果中查看
                        </button>
                        {issues.rows.length > 0 ? (
                          <button
                            type="button"
                            className="btn subtle sm"
                            onClick={() => openIssueAsset(issues.rows[0].assetId, issues.rows)}
                          >
                            <Icon name="workbench" className="sm" />
                            {S.quality.locate}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {issues.level === "blocking" ? (
                      <div className="notice danger" style={{ marginBottom: 10 }}>
                        <Icon name="lock" className="sm" />
                        {S.quality.blockingHint}
                      </div>
                    ) : null}
                    {issues.rows.length === 0 ? (
                      <EmptyState
                        icon="check-circle"
                        title={S.quality.noIssues}
                        body={splitScope ? "当前用途范围内没有此问题的图片。" : undefined}
                      />
                    ) : (
                      <div className="issue-rows">
                        {issues.rows.map((row) => (
                          <div className="issue-row" key={row.id}>
                            <div className="issue-thumb">
                              <img src={thumbUrlRaw(row.assetId, row.thumbVersion)} alt="" loading="lazy" />
                            </div>
                            <div className="issue-main">
                              <div className="issue-name">{row.assetName}</div>
                              <div className="issue-msg">{row.message}</div>
                              <div className="evidence">
                                {Object.entries(row.evidence || {})
                                  .filter(([, value]) => value !== null && value !== undefined && typeof value !== "object")
                                  .slice(0, 5)
                                  .map(([key, value]) => (
                                    <span key={key}>
                                      {key}: {String(value)}
                                    </span>
                                  ))}
                              </div>
                              {row.ignored ? (
                                <div className="tiny" style={{ color: "var(--faint)", marginTop: 3 }}>
                                  {S.quality.ignoredReason}：{row.ignoreReason || "—"}
                                </div>
                              ) : null}
                            </div>
                            <div className="issue-actions">
                              <IconButton
                                icon="workbench"
                                label={S.quality.openWorkbench}
                                size="sm"
                                onClick={() => openIssueAsset(row.assetId, issues.rows)}
                              />
                              {issues.level === "blocking" ? null : row.ignored ? (
                                <button type="button" className="btn ghost sm" onClick={() => void unignore(row)}>
                                  {S.quality.unignore}
                                </button>
                              ) : (
                                <button type="button" className="btn ghost sm" onClick={() => setIgnoreTarget(row)}>
                                  {S.quality.ignore}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          )
        ) : null}

        {viewTab === "duplicates" ? (
          duplicatesLoading && duplicates === null ? (
            <div className="loading-line"><Spinner size="lg" /> 正在载入重复组…</div>
          ) : !duplicates || duplicates.length === 0 ? (
            <EmptyState icon="copy" title={S.quality.noDuplicates} body="精确重复与感知近似重复会按组展示，并可在导出时保持一致分割。" />
          ) : (
            <div className="dup-grid">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 className="section-title">{S.quality.duplicateTitle}</h2>
                <span className="hint">{duplicates.length} 组 · {S.quality.duplicateHint}</span>
              </div>
              {duplicates.map((group) => (
                <div className="dup-group" key={group.id}>
                  <div className="dup-head">
                    <Badge tone={group.kind === "exact" ? "info" : "warning"}>
                      {group.kind === "exact" ? S.quality.duplicateExact : S.quality.duplicateNear}
                    </Badge>
                    {group.confirmed ? <Badge tone="success">{S.quality.confirmGroup}</Badge> : null}
                    <span className="hint">{group.members.length} 张</span>
                    <div className="spacer" />
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setDismissTarget(group)}
                    >
                      {S.quality.notDuplicate}
                    </button>
                    <button
                      type="button"
                      className="btn subtle sm"
                      onClick={() => void runDuplicateAction(group, "keep", { keptAssetId: group.keptAssetId })}
                    >
                      {S.quality.keepThis}
                    </button>
                    <button
                      type="button"
                      className="btn primary sm"
                      onClick={() => void runDuplicateAction(group, "excludeOthers", { keptAssetId: group.keptAssetId })}
                    >
                      {S.quality.excludeOthers}
                    </button>
                  </div>
                  <div className="dup-members">
                    {group.members.map((member) => (
                      <div
                        className={classNames("dup-member", member.keepRecommended && "kept")}
                        key={member.assetId}
                      >
                        <div className="dup-thumb checker">
                          <img src={thumbUrlRaw(member.assetId, member.thumbVersion)} alt="" loading="lazy" />
                        </div>
                        <div className="row" style={{ gap: 6 }}>
                          <input
                            type="checkbox"
                            aria-label={`选择 ${member.name}`}
                            checked={duplicateSelection.has(member.assetId)}
                            onChange={(event) => {
                              setDuplicateSelection((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(member.assetId);
                                else next.delete(member.assetId);
                                return next;
                              });
                            }}
                          />
                          <span className="dup-name" title={member.name}>{member.name}</span>
                          {member.keepRecommended ? <Badge tone="info">{S.quality.keepRecommended}</Badge> : null}
                        </div>
                        <div className="dup-meta">
                          <span className="mono">
                            {member.width}×{member.height}
                          </span>
                          <span>·</span>
                          <span>{member.format}</span>
                          <span>·</span>
                          <span>{statusLabel(member.status)}</span>
                        </div>
                        <div className="dup-meta">
                          {group.kind === "near" && member.distance !== null ? (
                            <span>
                              {S.quality.duplicateDistance} {member.distance}
                            </span>
                          ) : null}
                          <span>{member.captionPreview || "缺少标注"}</span>
                        </div>
                        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() =>
                              void runDuplicateAction(group, "keep", { keptAssetId: member.assetId })
                            }
                          >
                            <Icon name="check" className="sm" />
                            {S.quality.keepThis}
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() =>
                              openWorkbench(member.assetId, {
                                sequence: group.members.map((item) => item.assetId),
                                label: "重复组顺序",
                              })
                            }
                          >
                            <Icon name="workbench" className="sm" />
                            {S.quality.openWorkbench}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {duplicateSelection.size > 0 ? (
                    <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        className="btn danger sm"
                        onClick={() =>
                          void runDuplicateAction(group, "excludeSelected", {
                            assetIds: Array.from(duplicateSelection),
                          })
                        }
                      >
                        {S.quality.excludeSelected}（{duplicateSelection.size}）
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )
        ) : null}

        {viewTab === "overview" ? (
          overviewLoading && !overview ? (
            <div className="loading-line"><Spinner size="lg" /> 正在计算数据概况…</div>
          ) : overview ? (
            <div className="overview-grid">
              <div className="overview-card full">
                <div className="stat-row">
                  <div className="stat">
                    <div className="stat-label">{S.quality.valid}</div>
                    <div className="stat-value">{formatNumber(overview.valid)}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">{S.quality.approved}</div>
                    <div className="stat-value">{formatNumber(overview.approved)}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">{S.quality.withCaption}</div>
                    <div className="stat-value">{formatNumber(overview.withCaption)}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">{S.quality.excluded}</div>
                    <div className="stat-value">{formatNumber(overview.excluded)}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">{S.quality.duplicateAssets}</div>
                    <div className="stat-value">{formatNumber(overview.duplicateAssets)}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">{S.quality.captionCoverage}</div>
                    <div className="stat-value">
                      {overview.valid > 0 ? `${Math.round((overview.withCaption / overview.valid) * 100)}%` : "—"}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">{S.quality.total}</div>
                    <div className="stat-value">{formatNumber(overview.total)}</div>
                  </div>
                </div>
              </div>
              <div className="overview-card">
                <h3><Icon name="image" className="sm" />{S.quality.sizeDistribution}</h3>
                <div className="dist-bars">
                  {overview.sizeBuckets.map((bucket) => (
                    <div className="bar-row" key={bucket.label}>
                      <span className="bar-label">{bucket.label}</span>
                      <span className="bar-track">
                        <span
                          className="bar-fill"
                          style={{ width: `${(bucket.count / maxBucket(overview.sizeBuckets)) * 100}%` }}
                        />
                      </span>
                      <span className="bar-value">{bucket.count}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="overview-card">
                <h3><Icon name="split" className="sm" />{S.quality.orientation}</h3>
                <div className="dist-bars">
                  {overview.orientation.map((bucket) => (
                    <div className="bar-row" key={bucket.label}>
                      <span className="bar-label">{bucket.label}</span>
                      <span className="bar-track">
                        <span
                          className="bar-fill"
                          style={{ width: `${(bucket.count / maxBucket(overview.orientation)) * 100}%` }}
                        />
                      </span>
                      <span className="bar-value">{bucket.count}</span>
                    </div>
                  ))}
                </div>
                <h3 style={{ marginTop: 16 }}><Icon name="layers" className="sm" />{S.quality.splitCounts}</h3>
                <div className="dist-bars">
                  {overview.splitCounts.map((bucket) => (
                    <div className="bar-row" key={bucket.label}>
                      <span className="bar-label">{bucket.label}</span>
                      <span className="bar-track">
                        <span
                          className="bar-fill"
                          style={{ width: `${(bucket.count / maxBucket(overview.splitCounts)) * 100}%` }}
                        />
                      </span>
                      <span className="bar-value">{bucket.count}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="overview-card wide">
                <h3><Icon name="grid" className="sm" />{S.quality.buckets}</h3>
                <div className="dist-bars">
                  {overview.bucketRows.length === 0 ? <span className="hint">暂无数据</span> : null}
                  {overview.bucketRows.map((bucket) => (
                    <div className="bar-row" key={bucket.label}>
                      <span className="bar-label">{bucket.label}</span>
                      <span className="bar-track">
                        <span
                          className="bar-fill"
                          style={{ width: `${(bucket.count / maxBucket(overview.bucketRows)) * 100}%` }}
                        />
                      </span>
                      <span className="bar-value">{bucket.count}</span>
                    </div>
                  ))}
                </div>
                <div className="overview-note">{S.quality.bucketsNote}</div>
              </div>
              <div className="overview-card wide">
                <h3><Icon name="tag" className="sm" />{S.quality.topTags}</h3>
                <div className="tag-cloud">
                  {overview.topTags.map((tag) => (
                    <button
                      key={tag.tag}
                      type="button"
                      className="chip"
                      onClick={() => navigateToLibrary({ query: `tag:${tag.tag}`, issueLevels: [], issueRules: [] })}
                      title={S.quality.clickToFilter}
                    >
                      {tag.tag}
                      <span className="count">{tag.count}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="overview-card full">
                <h3><Icon name="folder" className="sm" />{S.quality.sources}</h3>
                <div className="dist-bars">
                  {overview.sources.map((source) => (
                    <div className="bar-row" key={source.label}>
                      <span className="bar-label" style={{ width: 180 }} title={prettyPath(source.label)}>{prettyPath(source.label)}</span>
                      <span className="bar-track">
                        <span
                          className="bar-fill"
                          style={{ width: `${(source.count / maxBucket(overview.sources)) * 100}%` }}
                        />
                      </span>
                      <span className="bar-value">{source.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null
        ) : null}
      </div>

      <PromptDialog
        open={ignoreTarget !== null}
        title={S.quality.ignoreTitle}
        body={S.quality.ignoreBody}
        label={S.quality.ignoreReason}
        placeholder={S.quality.ignoreReasonPlaceholder}
        required
        confirmLabel={S.quality.ignore}
        onSubmit={(value) => void ignore(value)}
        onClose={() => setIgnoreTarget(null)}
      />

      <ConfirmDialog
        open={dismissTarget !== null}
        title={S.quality.notDuplicate}
        body={`确认「${dismissTarget?.members[0]?.name || ""}」所在的重复组并非重复？该组后续不再提示。`}
        confirmLabel={S.quality.notDuplicate}
        onClose={() => setDismissTarget(null)}
        onConfirm={() => {
          const group = dismissTarget;
          setDismissTarget(null);
          if (group) void runDuplicateAction(group, "notDuplicate");
        }}
      />
    </div>
  );
}
