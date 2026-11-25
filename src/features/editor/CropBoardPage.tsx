import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { AssetSummary, CollectionInfo, TransformPlan } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { classNames, formatNumber, projectBaseResolution, snapSize64 } from "../../lib/utils";
import { Icon } from "../../components/Icon";
import { Badge, Notice, Spinner } from "../../components/ui";
import { DatasetFilterBar } from "../library/DatasetFilterBar";
import { InlineCropCard } from "./InlineCropCard";
import { CropModeSwitch, type CropMode } from "./CropModeSwitch";

const UNGROUPED = "__ungrouped__";
const LOAD_CHUNK = 200;
/** 超过该数量的分组默认折叠，只显示组名、数量与目标尺寸。 */
const GROUP_COLLAPSE_THRESHOLD = 48;

type TargetMap = Record<string, { width: string; height: string }>;
type PlanMap = Record<string, { plan: TransformPlan; revision: number }>;

export function CropBoardPage({
  active,
  mode,
  onModeChange,
}: {
  active: boolean;
  mode: CropMode;
  onModeChange: (mode: CropMode) => void;
}) {
  const {
    project,
    filter,
    collections,
    reloadCollections,
    workbenchId,
    openWorkbench,
    navigate,
    notify,
    bumpRefresh,
    refreshToken,
    jobs,
    reloadJobs,
    setJobsOpen,
  } = useProject();
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [plans, setPlans] = useState<PlanMap>({});
  const [members, setMembers] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [linked, setLinked] = useState(false);
  const [targets, setTargets] = useState<TargetMap>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [applyingGroup, setApplyingGroup] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const lastWorkbenchRef = useRef<string | null>(null);
  const loadSeq = useRef(0);
  /** 记录已加载的筛选与刷新代际，页面来回切换时不重复清空并重载瀑布流。 */
  const loadedKeyRef = useRef<string | null>(null);
  const loadedTokenRef = useRef(-1);
  /** 每张图片串行保存，连续拖动只保留最后一个待保存方案，避免旧响应覆盖新裁剪。 */
  const commitQueues = useRef(new Map<string, { running: boolean; latest: TransformPlan | null }>());
  /** 保存用版本号，独立于 plans 状态，避免中间保存结果触发卡片视图回跳。 */
  const revisionsRef = useRef<Record<string, number>>({});

  const base = snapSize64(projectBaseResolution(project), 1024);
  const groups = useMemo(() => collections.filter((collection) => collection.kind !== "query"), [collections]);
  const cropJobActive = jobs.some(
    (job) => job.kind === "crop" && ["running", "queued", "paused"].includes(job.status),
  );
  const pendingSaves = savingIds.size > 0;
  const applyBusy = applyingGroup !== null || cropJobActive || pendingSaves;

  const updateSummary = useCallback((id: string, updates: Partial<AssetSummary>) => {
    setAssets((current) => current.map((asset) => (asset.id === id ? { ...asset, ...updates } : asset)));
  }, []);

  useEffect(() => {
    const next = { ...revisionsRef.current };
    for (const [id, info] of Object.entries(plans)) next[id] = info.revision;
    revisionsRef.current = next;
  }, [plans]);

  const loadAssets = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const ids = Array.from(new Set(await api.assetIds(filter)));
      if (seq !== loadSeq.current) return;
      const matching = new Set(ids);
      setSelection((current) => current.filter((id) => matching.has(id)));
      setAssets([]);
      setPlans({});
      // 分批载入并立即呈现，首批 200 张不再等待整库摘要与配方。
      for (let index = 0; index < ids.length; index += LOAD_CHUNK) {
        const chunk = ids.slice(index, index + LOAD_CHUNK);
        const [summaries, chunkPlans] = await Promise.all([
          api.assetSummaries(chunk),
          api.assetTransformPlans(chunk),
        ]);
        if (seq !== loadSeq.current) return;
        setAssets((current) => [...current, ...summaries]);
        setPlans((current) => {
          const next = { ...current };
          for (const info of chunkPlans) next[info.assetId] = { plan: info.plan, revision: info.revision };
          return next;
        });
      }
    } catch (loadError) {
      if (seq !== loadSeq.current) return;
      setError(normalizeError(loadError).message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    if (!active) return;
    const key = JSON.stringify(filter);
    // 没有新的保存/裁切/筛选变化时，保留现有卡片与图片 DOM，避免来回切页重新加载。
    if (!error && loadedKeyRef.current === key && loadedTokenRef.current === refreshToken) {
      return;
    }
    if (loadedKeyRef.current !== key) {
      setAssets([]);
      setPlans({});
      setSelection([]);
    }
    loadedKeyRef.current = key;
    loadedTokenRef.current = refreshToken;
    void loadAssets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAssets, refreshToken, active]);

  useEffect(() => {
    if (!active) return;
    void reloadCollections();
  }, [reloadCollections, active]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    Promise.all(
      groups.map(async (collection) => [collection.id, await api.collectionIds(collection.id)] as const),
    )
      .then((entries) => {
        if (!cancelled) setMembers(Object.fromEntries(entries));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [groups, refreshToken, active]);

  useEffect(() => {
    setTargets((current) => {
      const next = { ...current };
      for (const collection of groups) {
        if (!next[collection.id]) {
          next[collection.id] = {
            width: String(snapSize64(collection.targetWidth, base)),
            height: String(snapSize64(collection.targetHeight, base)),
          };
        }
      }
      if (!next[UNGROUPED]) next[UNGROUPED] = { width: String(base), height: String(base) };
      return next;
    });
  }, [groups, base]);

  // 大图库下逐资产扫描所有分组成员会变成 O(n²)，改为一次建立归属索引。
  const memberGroup = useMemo(() => {
    const map = new Map<string, CollectionInfo>();
    for (const collection of groups) {
      for (const id of members[collection.id] || []) {
        if (!map.has(id)) map.set(id, collection);
      }
    }
    return map;
  }, [groups, members]);

  const assetGroup = useCallback(
    (assetId: string): CollectionInfo | null => memberGroup.get(assetId) || null,
    [memberGroup],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, AssetSummary[]>();
    for (const asset of assets) {
      const group = assetGroup(asset.id);
      const key = group?.id || UNGROUPED;
      const list = map.get(key) || [];
      list.push(asset);
      map.set(key, list);
    }
    const sections: { key: string; name: string; collection: CollectionInfo | null; assets: AssetSummary[] }[] = groups
      .map((collection) => ({ key: collection.id, name: collection.name, collection, assets: map.get(collection.id) || [] }))
      .filter((section) => section.assets.length > 0);
    const ungrouped = map.get(UNGROUPED) || [];
    if (ungrouped.length > 0) sections.push({ key: UNGROUPED, name: "未分组", collection: null, assets: ungrouped });
    return sections;
  }, [assets, groups, members, assetGroup]);

  // 初次加载完成后为每个分组确定折叠状态；之后尊重用户的展开/收起选择。
  useEffect(() => {
    if (loading) return;
    setExpandedGroups((current) => {
      let changed = false;
      const next = { ...current };
      for (const section of grouped) {
        if (next[section.key] !== undefined) continue;
        next[section.key] = section.assets.length <= GROUP_COLLAPSE_THRESHOLD;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [loading, grouped]);

  const targetFor = (groupId: string | null) => {
    const target = targets[groupId || UNGROUPED] || { width: String(base), height: String(base) };
    const width = snapSize64(Number.parseInt(target.width, 10), base);
    const height = snapSize64(Number.parseInt(target.height, 10), base);
    return { width, height };
  };

  useEffect(() => {
    if (!active || !workbenchId || lastWorkbenchRef.current === workbenchId || !assets.some((asset) => asset.id === workbenchId)) return;
    lastWorkbenchRef.current = workbenchId;
    setSelection((current) => (current.includes(workbenchId) ? current : [...current, workbenchId]));
  }, [active, workbenchId, assets]);

  // 从工作台进入的图片若位于折叠组，自动展开该组，保证当前卡片可见。
  useEffect(() => {
    if (!workbenchId) return;
    const key = memberGroup.get(workbenchId)?.id || UNGROUPED;
    setExpandedGroups((current) => (current[key] ? current : { ...current, [key]: true }));
  }, [workbenchId, memberGroup]);

  const saveTarget = async (groupId: string) => {
    if (!groupId || groupId === UNGROUPED) return;
    const target = targetFor(groupId);
    try {
      await api.updateCollection({ id: groupId, targetWidth: target.width, targetHeight: target.height });
      await reloadCollections();
      notify({ tone: "success", message: `分组目标尺寸已设为 ${target.width}×${target.height}` });
    } catch (saveError) {
      notify({ tone: "danger", message: normalizeError(saveError).message });
    }
  };

  const applyTargetToGroup = async (section: { key: string; name: string; assets: AssetSummary[] }) => {
    if (applyingGroup || cropJobActive) return;
    if (section.key === UNGROUPED && groups.some((group) => !Array.isArray(members[group.id]))) {
      notify({ message: "正在载入分组信息，请稍后再应用" });
      return;
    }
    const target = targetFor(section.key);
    setApplyingGroup(section.key);
    try {
      if (section.key !== UNGROUPED) {
        await api.updateCollection({ id: section.key, targetWidth: target.width, targetHeight: target.height });
        await reloadCollections();
      }
      // 折叠或尚未载入完的成员也要按同一方案处理，这里解析完整目标集合。
      const groupedIds = new Set(Object.values(members).flat());
      const targetIds =
        section.key === UNGROUPED
          ? Array.from(new Set(await api.assetIds(filter))).filter((id) => !groupedIds.has(id))
          : await api.collectionIds(section.key);
      if (targetIds.length === 0) {
        notify({ message: "该分组没有可裁切的图片" });
        return;
      }
      const started = await api.cropApplyBatch({
        assetIds: targetIds,
        width: target.width,
        height: target.height,
        collectionId: section.key === UNGROUPED ? null : section.key,
        title: `裁切 ${section.name} · ${target.width}×${target.height}`,
      });
      await reloadJobs();
      notify({
        tone: "success",
        message: `已开始裁切 ${started.total} 张，进度见任务列表`,
        actionLabel: "查看任务",
        onAction: () => setJobsOpen(true),
      });
    } catch (applyError) {
      const normalized = normalizeError(applyError);
      if (normalized.code === "NO_CHANGED_IMAGES") {
        notify({ message: normalized.message });
        return;
      }
      notify({
        tone: "danger",
        title: "批量裁切失败",
        message: normalized.message,
      });
    } finally {
      setApplyingGroup(null);
    }
  };

  /** 把同一个裁剪方案同步到同组其他选中图片（两种模式共用）。 */
  const applyLinkedPlan = async (sourceId: string, plan: TransformPlan) => {
    if (!linked) return 0;
    const groupId = assetGroup(sourceId)?.id || null;
    const targetIds = selection.filter(
      (id) => id !== sourceId && (assetGroup(id)?.id || null) === groupId,
    );
    if (targetIds.length === 0) return 0;
    let applied = 0;
    const failures: string[] = [];
    for (const targetId of targetIds) {
      const targetName = assets.find((asset) => asset.id === targetId)?.name || targetId;
      let targetInfo: PlanMap[string] | undefined = plans[targetId];
      if (!targetInfo) {
        try {
          targetInfo = (await planInfoFor(targetId)) ?? undefined;
        } catch {
          targetInfo = undefined;
        }
      }
      if (!targetInfo) {
        failures.push(`${targetName}：无法读取裁剪配方`);
        continue;
      }
      setSavingIds((current) => new Set(current).add(targetId));
      try {
        const linkedResult = await savePlan(targetId, plan, targetInfo.revision);
        setPlans((current) => ({ ...current, [targetId]: { plan, revision: linkedResult.assetRevision } }));
        updateSummary(targetId, {
          revision: linkedResult.assetRevision,
          thumbVersion: linkedResult.thumbVersion,
          outWidth: linkedResult.geometry.outWidth,
          outHeight: linkedResult.geometry.outHeight,
        });
        applied += 1;
      } catch (linkError) {
        failures.push(`${targetName}：${normalizeError(linkError).message}`);
      } finally {
        setSavingIds((current) => {
          const next = new Set(current);
          next.delete(targetId);
          return next;
        });
      }
    }
    if (failures.length > 0) {
      notify({
        tone: "warning",
        title: "部分联动保存失败",
        message: failures.slice(0, 3).join("；"),
      });
    }
    return applied;
  };

  /** 从后端读取单张图片的当前配方。 */
  const fetchPlanInfo = async (id: string) => {
    const infos = await api.assetTransformPlans([id]);
    const info = infos[0];
    if (!info) return null;
    setPlans((current) => ({ ...current, [id]: { plan: info.plan, revision: info.revision } }));
    updateSummary(id, { revision: info.revision });
    return { plan: info.plan, revision: info.revision };
  };

  /** 读取单张图片的当前配方；渐进加载尚未覆盖时按需补取。 */
  const planInfoFor = async (id: string) => {
    const existing = plans[id];
    if (existing) return existing;
    return fetchPlanInfo(id);
  };

  /** 版本冲突时刷新配方版本并重试一次，避免其他页面刚改过导致应用失败。 */
  const savePlan = async (id: string, plan: TransformPlan, revision: number) => {
    try {
      return await api.transformSave(id, plan, revision);
    } catch (error) {
      if (normalizeError(error).code === "REVISION_CONFLICT") {
        const fresh = await fetchPlanInfo(id);
        if (fresh) return await api.transformSave(id, plan, fresh.revision);
      }
      throw error;
    }
  };

  /** 读取保存所需版本号；不经过 plans 状态，避免刷新版本时把卡片视图拉回旧方案。 */
  const readPlanRevision = async (id: string): Promise<number | null> => {
    if (revisionsRef.current[id] !== undefined) return revisionsRef.current[id];
    const existing = plans[id];
    if (existing) {
      revisionsRef.current[id] = existing.revision;
      return existing.revision;
    }
    try {
      const infos = await api.assetTransformPlans([id]);
      const info = infos[0];
      if (!info) return null;
      revisionsRef.current[id] = info.revision;
      setPlans((current) => ({ ...current, [id]: { plan: info.plan, revision: info.revision } }));
      updateSummary(id, { revision: info.revision });
      return info.revision;
    } catch {
      return null;
    }
  };

  const saveWithRevision = async (id: string, plan: TransformPlan, revision: number) => {
    try {
      return await api.transformSave(id, plan, revision);
    } catch (saveError) {
      if (normalizeError(saveError).code === "REVISION_CONFLICT") {
        const infos = await api.assetTransformPlans([id]);
        const info = infos[0];
        if (info) return await api.transformSave(id, plan, info.revision);
      }
      throw saveError;
    }
  };

  const runCommitQueue = (asset: AssetSummary) => {
    const queue = commitQueues.current.get(asset.id);
    if (!queue || queue.running) return;
    queue.running = true;
    setSavingIds((current) => new Set(current).add(asset.id));
    void (async () => {
      while (queue.latest) {
        const nextPlan = queue.latest;
        queue.latest = null;
        try {
          const revision = await readPlanRevision(asset.id);
          if (revision === null) {
            notify({
              tone: "danger",
              title: "裁剪保存失败",
              message: "无法读取该图片的裁剪配方，请刷新页面后重试。",
            });
            continue;
          }
          const result = await saveWithRevision(asset.id, nextPlan, revision);
          revisionsRef.current[asset.id] = result.assetRevision;
          // 仍有更新的方案在排队时不发布中间结果，卡片保持用户刚拖到的画面。
          if (!queue.latest) {
            setPlans((current) => ({
              ...current,
              [asset.id]: { plan: nextPlan, revision: result.assetRevision },
            }));
            updateSummary(asset.id, {
              revision: result.assetRevision,
              thumbVersion: result.thumbVersion,
              outWidth: result.geometry.outWidth,
              outHeight: result.geometry.outHeight,
            });
            await applyLinkedPlan(asset.id, nextPlan);
          }
        } catch (saveError) {
          notify({
            tone: "danger",
            title: "裁剪保存失败",
            message: normalizeError(saveError).message,
          });
        }
      }
      queue.running = false;
      setSavingIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
      // 收尾与入队之间可能存在竞态，再检查一次。
      if (queue.latest) runCommitQueue(asset);
    })();
  };

  const commitCard = (asset: AssetSummary, plan: TransformPlan) => {
    let queue = commitQueues.current.get(asset.id);
    if (!queue) {
      queue = { running: false, latest: null };
      commitQueues.current.set(asset.id, queue);
    }
    queue.latest = plan;
    runCommitQueue(asset);
  };

  const maxGroupSelection = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of selection) {
      const key = assetGroup(id)?.id || UNGROUPED;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Math.max(0, ...counts.values());
  }, [selection, assetGroup]);

  const allSelected = assets.length > 0 && selection.length === assets.length;
  const toggleAll = () => setSelection(allSelected ? [] : assets.map((asset) => asset.id));
  const toggleSelected = (id: string, checked: boolean) =>
    setSelection((current) =>
      checked ? Array.from(new Set([...current, id])) : current.filter((item) => item !== id),
    );

  const changeMode = (next: CropMode) => {
    if (next === "single") {
      const first = selection[0] || (assets.some((asset) => asset.id === workbenchId) ? workbenchId : assets[0]?.id);
      if (first) openWorkbench(first);
    }
    onModeChange(next);
  };

  return (
    <div className="crop-board-page">
      <div className="crop-board-head">
        <div>
          <h1 className="page-title">裁剪</h1>
          <div className="page-subtitle">
            {formatNumber(assets.length)} 张有效素材 · {groups.length} 个分组 · 每个分组共享目标尺寸
          </div>
        </div>
        <div className="spacer" />
        <div className="crop-board-head-actions">
          <CropModeSwitch mode={mode} onChange={changeMode} />
          <button
            type="button"
            className="btn primary crop-board-next"
            disabled={assets.length === 0}
            onClick={() => {
              const first = selection[0] || (assets.some((asset) => asset.id === workbenchId) ? workbenchId : assets[0]?.id);
              if (first) openWorkbench(first);
              navigate("tag");
            }}
          >
            进入打标
            <Icon name="arrow-right" />
          </button>
        </div>
      </div>

      {active ? <DatasetFilterBar className="crop-board-filter" /> : null}

      <div className="crop-board-toolbar">
        <span className={classNames("badge", selection.length > 0 ? "info" : "neutral")}>
          {selection.length} 已选
        </span>
        <button type="button" className="btn subtle sm" onClick={toggleAll}>
          {allSelected ? "清空选择" : "全选"}
        </button>
        <button
          type="button"
          className={classNames("btn sm", linked ? "secondary" : "subtle")}
          onClick={() => setLinked((value) => !value)}
          disabled={maxGroupSelection < 2}
          title={maxGroupSelection < 2 ? "同一分组至少选择两张图片" : "调整同组一张图片时同步到其他选中图片"}
        >
          <Icon name="link" className="sm" />
          {linked ? "联动已开启" : "联动编辑"}
        </button>
        <span className="hint">
          {maxGroupSelection < 2
            ? "先选同组至少 2 张"
            : linked
              ? `联动同组 ${maxGroupSelection} 张`
              : `已选 ${maxGroupSelection} 张 · 拖动移动 / 滚轮缩放`}
        </span>
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {loading && assets.length === 0 ? (
        <div className="crop-board-loading"><Spinner size="lg" /> 正在载入素材…</div>
      ) : null}

      <div className="crop-board-groups">
        {grouped.map((section) => {
          const target = targetFor(section.collection?.id || null);
          const collapsible = section.assets.length > GROUP_COLLAPSE_THRESHOLD;
          // 加载期间保持展开以便渐进呈现；加载完成后按数量初始化一次折叠状态。
          const expanded = expandedGroups[section.key] ?? true;
          const showToggle = collapsible || !expanded;
          return (
            <section className="crop-board-group" key={section.key}>
              <div className="crop-board-group-head">
                <div className="crop-board-group-title">
                  <Icon name={section.collection ? "layers" : "image"} className="sm" />
                  <strong>{section.name}</strong>
                  <Badge tone="neutral">{section.assets.length}</Badge>
                  {showToggle ? (
                    <button
                      type="button"
                      className="btn subtle sm"
                      onClick={() =>
                        setExpandedGroups((current) => ({ ...current, [section.key]: !expanded }))
                      }
                    >
                      {expanded ? "收起" : `展开 ${section.assets.length} 张`}
                    </button>
                  ) : null}
                </div>
                <div className="crop-board-target">
                  <span className="tiny faint">目标尺寸</span>
                  <input
                    className="input number"
                    type="number"
                    min={64}
                    max={8192}
                    step={64}
                    value={targets[section.key]?.width || String(target.width)}
                    onChange={(event) =>
                      setTargets((current) => ({
                        ...current,
                        [section.key]: { ...(current[section.key] || target), width: event.target.value },
                      }))
                    }
                    onBlur={(event) => {
                      const value = snapSize64(Number(event.target.value), target.width);
                      setTargets((current) => ({
                        ...current,
                        [section.key]: {
                          ...(current[section.key] || target),
                          width: String(value),
                        },
                      }));
                    }}
                  />
                  <span className="tiny faint">×</span>
                  <input
                    className="input number"
                    type="number"
                    min={64}
                    max={8192}
                    step={64}
                    value={targets[section.key]?.height || String(target.height)}
                    onChange={(event) =>
                      setTargets((current) => ({
                        ...current,
                        [section.key]: { ...(current[section.key] || target), height: event.target.value },
                      }))
                    }
                    onBlur={(event) => {
                      const value = snapSize64(Number(event.target.value), target.height);
                      setTargets((current) => ({
                        ...current,
                        [section.key]: {
                          ...(current[section.key] || target),
                          height: String(value),
                        },
                      }));
                    }}
                  />
                  {section.collection ? (
                    <>
                      <button type="button" className="btn subtle sm" onClick={() => void saveTarget(section.key)}>
                        保存尺寸
                      </button>
                      <button
                        type="button"
                        className="btn secondary sm"
                        disabled={applyBusy}
                        title={
                          applyingGroup !== null || cropJobActive
                            ? "裁切任务进行中，请在任务列表查看进度"
                            : pendingSaves
                              ? "图片正在保存，请等待出现“已保存”后再应用"
                              : "按目标尺寸裁切该分组，进度显示在任务列表"
                        }
                        onClick={() => void applyTargetToGroup(section)}
                      >
                        {applyingGroup === section.key ? <Spinner /> : null}
                        应用尺寸到分组
                      </button>
                    </>
                  ) : (
                    <span className="tiny faint">默认尺寸（不保存）</span>
                  )}
                </div>
              </div>
              {expanded ? (
                <div className="crop-masonry">
                  {section.assets.map((asset) => (
                    <InlineCropCard
                      key={`${asset.id}-${target.width}x${target.height}`}
                      asset={asset}
                      plan={plans[asset.id]?.plan || ({} as TransformPlan)}
                      targetWidth={target.width}
                      targetHeight={target.height}
                      selected={selection.includes(asset.id)}
                      saving={savingIds.has(asset.id)}
                      onToggle={(checked) => toggleSelected(asset.id, checked)}
                      onCommit={(plan) => void commitCard(asset, plan)}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
        {!loading && assets.length === 0 ? <Notice tone="info">当前筛选范围没有可裁剪的图片。</Notice> : null}
      </div>
    </div>
  );
}
