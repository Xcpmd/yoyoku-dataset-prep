import { useCallback, useEffect, useMemo, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type {
  ExportConfig,
  ExportPreview,
  ExportRecordInfo,
  SplitSummary,
} from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { S } from "../../lib/strings";
import {
  classNames,
  copyText,
  formatBytes,
  formatDate,
  formatNumber,
  formatPercent,
  prettyPath,
  projectBaseResolution,
  snapSize64,
} from "../../lib/utils";
import { Icon } from "../../components/Icon";
import {
  Badge,
  Dropdown,
  EmptyState,
  Field,
  MenuItem,
  MenuLabel,
  Modal,
  Notice,
  PromptDialog,
  Segmented,
  Spinner,
  Toggle,
} from "../../components/ui";

const STEPS = [S.export.stepper.scope, S.export.stepper.config, S.export.stepper.preflight];

interface Preset {
  name: string;
  config: ExportConfig;
}

/** 按预检问题类型给出可执行的入口文案。 */
function issueActionLabel(code: string, message: string): string {
  const text = `${code} ${message}`;
  if (/标注|caption|tag/i.test(text)) return "补标注";
  if (/裁剪|crop|尺寸|分辨率|upscale/i.test(text)) return "调整裁剪";
  if (/失联|缺失|missing|丢失/i.test(text)) return "定位图片";
  if (/范围|scope/i.test(text)) return "修改导出范围";
  return "处理图片";
}

function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem("yoyoku.exportPresets");
    return raw ? (JSON.parse(raw) as Preset[]) : [];
  } catch {
    return [];
  }
}

export function ExportPage({ active }: { active: boolean }) {
  const {
    project,
    settings,
    collections,
    selection,
    notify,
    navigate,
    jobs,
    reloadJobs,
    setJobsOpen,
    openWorkbench,
    navigateToLibrary,
    bumpRefresh,
  } = useProject();

  const defaults = project.settings.exportDefaults || {};
  const base = projectBaseResolution(project);
  const manualGroups = useMemo(
    () => collections.filter((collection) => collection.kind !== "query"),
    [collections],
  );
  const targetName = (target: string) =>
    target === "kohya"
      ? S.export.targetKohya
      : target === "imagefolder"
        ? S.export.targetImagefolder
        : S.export.targetLoraScript;
  const targetShort = (target: string) =>
    target === "kohya"
      ? "Kohya"
      : target === "imagefolder"
        ? "ImageFolder"
        : "LoRA Script";
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<ExportConfig>(() => ({
    target:
      defaults.target === "imagefolder"
        ? "imagefolder"
        : defaults.target === "lora_script"
          ? "lora_script"
          : "kohya",
    package: defaults.package === "zip" ? "zip" : "folder",
    destDir: null,
    name: null,
    scope: {
      mode: "all",
      collectionId: null,
      assetIds: [],
      restrictApproved: false,
    },
    validation: { enabled: false, mode: "auto", ratio: 0.1, seed: 42 },
    naming: defaults.naming === "original" ? "original" : "index",
    imageFormat: defaults.imageFormat === "jpg" ? "jpg" : "png",
    quality: Number(defaults.quality) || 95,
    captionExtension: defaults.captionExtension === ".caption" ? ".caption" : ".txt",
    size: {
      mode: "perAsset",
      width: null,
      height: null,
      longestEdge: base,
      allowUpscale: false,
      background: "#ffffff",
      fillTransparent: true,
      resample: "lanczos",
    },
    kohya: {
      resolution: [
        Number(project.settings.resolution?.[0]) || base,
        Number(project.settings.resolution?.[1]) || base,
      ],
      enableBucket: defaults.enableBucket !== false,
      bucketNoUpscale: defaults.bucketNoUpscale !== false,
      bucketSteps: Number(defaults.bucketSteps) || 64,
      batchSize: Number(defaults.batchSize) || 1,
      shuffleCaption: false,
      keepTokens: 0,
      subsets: [],
    },
    loraScript: { repeats: {}, ungroupedRepeats: 1 },
  }));
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [records, setRecords] = useState<ExportRecordInfo[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [report, setReport] = useState<ExportRecordInfo | null>(null);
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  const [presetPrompt, setPresetPrompt] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const patchConfig = (updater: (current: ExportConfig) => ExportConfig) => {
    setConfig((current) => updater(current));
    if (preview) {
      setPreview(null);
      setStep((value) => Math.min(value, 1));
    }
    setStartError(null);
    setResult(null);
  };

  const patch = (value: Partial<ExportConfig>) => patchConfig((current) => ({ ...current, ...value }));

  const loadRecords = useCallback(async () => {
    try {
      setRecords(await api.exportRecords());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    if (!jobId) return;
    const job = jobs.find((item) => item.id === jobId);
    if (!job) return;
    if (job.status === "completed" || job.status === "completed_with_errors") {
      setResult(job.result || {});
      setJobId(null);
      setStarting(false);
      void loadRecords();
      bumpRefresh();
      notify({
        tone: "success",
        title: S.export.resultTitle,
        message: job.result?.outputPath ? String(job.result.outputPath) : "导出完成",
      });
    } else if (job.status === "failed") {
      setStartError(job.error?.message || "导出失败");
      setJobId(null);
      setStarting(false);
    } else if (job.status === "cancelled") {
      setStartError("导出任务已取消");
      setJobId(null);
      setStarting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, jobId]);

  const runningJob = jobId ? jobs.find((job) => job.id === jobId) : null;
  const blockingIssues = preview?.issues.filter((issue) => issue.level === "blocking") || [];
  const suggestionIssues = preview?.issues.filter((issue) => issue.level === "suggestion") || [];

  const chooseDestination = async () => {
    const folder = await api.pickFolder("选择导出目标位置");
    if (folder) patch({ destDir: folder });
  };

  const goNext = async () => {
    if (step === 0) {
      if (config.scope.mode === "selection") {
        setConfig((current) => ({
          ...current,
          scope: { ...current.scope, assetIds: selection },
        }));
      }
      setStep(1);
      return;
    }
    if (step === 1) {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const result = await api.exportPreview(config);
        setPreview(result);
        setStep(2);
        setStartError(null);
        setResult(null);
      } catch (error) {
        setPreviewError(normalizeError(error).message);
      } finally {
        setPreviewLoading(false);
      }
    }
  };

  const start = async () => {
    if (!preview) return;
    setStarting(true);
    setStartError(null);
    try {
      const resultStart = await api.exportStart(preview.id);
      setJobId(resultStart.jobId);
      await reloadJobs();
      notify({ message: S.export.exportQueued });
    } catch (error) {
      setStartError(normalizeError(error).message);
      setStarting(false);
    }
  };

  const copyLabel = (target: string) =>
    target === "lora_script" ? S.export.copyPath : S.export.copyEntry;

  const copyEntry = async (record: ExportRecordInfo) => {
    try {
      if (record.target === "kohya") {
        const entry = await api.exportAbsoluteEntry(record.id);
        const copied = await copyText(entry.command);
        notify({
          tone: copied ? "success" : "danger",
          title: S.export.copyEntry,
          message: copied ? entry.command : S.errors.clipboard,
        });
      } else if (record.target === "lora_script") {
        const copied = await copyText(record.outputPath);
        notify({
          tone: copied ? "success" : "danger",
          message: copied ? S.export.pathCopied : S.errors.clipboard,
        });
      } else {
        const command = `accelerate launch train_text_to_image_lora_sdxl.py --train_data_dir "${record.outputPath}/train" --image_column image --caption_column text`;
        const copied = await copyText(command);
        notify({ tone: copied ? "success" : "danger", message: copied ? S.export.commandCopied : S.errors.clipboard });
      }
    } catch (error) {
      notify({ tone: "danger", message: normalizeError(error).message });
    }
  };

  const savePreset = (name: string) => {
    if (!name.trim()) return;
    const next = [...presets.filter((preset) => preset.name !== name.trim()), { name: name.trim(), config }];
    setPresets(next);
    try {
      localStorage.setItem("yoyoku.exportPresets", JSON.stringify(next));
    } catch {
      // ignore
    }
    setPresetPrompt(false);
    notify({ tone: "success", message: S.export.presetSaved });
  };

  const applyPreset = (name: string) => {
    const preset = presets.find((item) => item.name === name);
    if (!preset) return;
    setConfig({
      ...preset.config,
      size: {
        ...preset.config.size,
        fillTransparent: preset.config.size.fillTransparent !== false,
      },
      loraScript: {
        repeats: {},
        ungroupedRepeats: 1,
        ...(preset.config as Partial<ExportConfig>).loraScript,
      },
    });
    setPreview(null);
    setResult(null);
    setStep(0);
    setStartError(null);
    notify({ message: `已加载预设「${preset.name}」` });
  };

  const scopeCounts = preview?.counts || {
    candidates: project.counts.total,
    eligible: project.counts.valid,
    excluded: project.counts.excluded,
    pending: project.counts.pending,
    approved: project.counts.approved,
    train: project.counts.train,
    val: project.counts.val,
    skipped: project.counts.excluded,
  };

  const summarySplit: SplitSummary | null = preview?.split || null;

  const setScopeMode = (mode: ExportConfig["scope"]["mode"]) => {
    patchConfig((current) => ({
      ...current,
      scope: {
        ...current.scope,
        mode,
        collectionId:
          mode === "collection"
            ? current.scope.collectionId || collections[0]?.id || null
            : current.scope.collectionId,
        assetIds: mode === "selection" ? selection : [],
      },
    }));
  };

  const addSubset = (collectionId: string) => {
    const collection = collections.find((item) => item.id === collectionId);
    if (!collection) return;
    patchConfig((current) => ({
      ...current,
      kohya: {
        ...current.kohya,
        subsets: current.kohya.subsets.some((subset) => subset.collectionId === collectionId)
          ? current.kohya.subsets
          : [
              ...current.kohya.subsets,
              {
                collectionId,
                name: collection.name,
                repeats: 1,
                keepTokens: 0,
                shuffle: false,
              },
            ],
      },
    }));
  };

  const removeSubset = (index: number) => {
    patchConfig((current) => ({
      ...current,
      kohya: { ...current.kohya, subsets: current.kohya.subsets.filter((_, position) => position !== index) },
    }));
  };

  const updateSubset = (index: number, patchSubset: Partial<ExportConfig["kohya"]["subsets"][number]>) => {
    patchConfig((current) => ({
      ...current,
      kohya: {
        ...current.kohya,
        subsets: current.kohya.subsets.map((subset, position) =>
          position === index ? { ...subset, ...patchSubset } : subset,
        ),
      },
    }));
  };

  const selectedPreviewFile = preview?.files.find((file) => file.path === selectedFile) || preview?.files[0];

  return (
    <div className="page">
      <div className="export-page">
        <div className="export-head">
          <div>
            <h1 className="page-title">{S.export.title}</h1>
            <div className="page-subtitle">
              {project.name} · {project.model === "sd15" ? "SD 1.5" : "SDXL"} · 默认 {base}×{base} 基准
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn subtle" onClick={() => setHistoryOpen(true)}>
              <Icon name="history" />
              {S.export.history}
              {records.length > 0 ? <span className="count">{records.length}</span> : null}
            </button>
            <button type="button" className="btn ghost" onClick={() => void loadRecords()}>
              <Icon name="refresh" />
              {S.common.refresh}
            </button>
          </div>
        </div>

        <div className="export-stepper" role="tablist" aria-label="导出步骤">
          {STEPS.map((label, index) => (
            <div key={label} style={{ display: "contents" }}>
              {index > 0 ? <span className="step-sep" /> : null}
              <button
                type="button"
                className={classNames("step", step === index && "active", step > index && "done")}
                onClick={() => {
                  if (index < step) setStep(index);
                }}
                aria-current={step === index ? "step" : undefined}
              >
                <span className="step-index">
                  {step > index ? <Icon name="check" className="sm" /> : index + 1}
                </span>
                {label}
              </button>
            </div>
          ))}
          <div className="spacer" />
          <span className="hint" style={{ paddingRight: 8 }}>
            {S.export.confirmFreeze}
          </span>
        </div>

        {previewError ? <Notice tone="danger">{previewError}</Notice> : null}
        {startError ? <Notice tone="danger">{startError}</Notice> : null}

        <div className="export-layout">
          <div className="export-main">
            {step === 0 ? (
              <>
                <section className="export-section">
                  <h3>
                    <Icon name="image" />
                    {S.export.scopeTitle}
                  </h3>
                  <div className="choice-grid">
                    {(
                      [
                        ["all", S.export.scopeAll, "包含待审核图片", "layers"],
                        ["approved", S.export.scopeApproved, "仅审核通过的素材", "check-circle"],
                        ["collection", S.export.scopeCollection, "使用手动或智能集合", "folder"],
                        [
                          "selection",
                          S.export.scopeSelection,
                          selection.length > 0 ? S.export.scopeSelectionCount(selection.length) : "当前没有选中图片",
                          "check",
                        ],
                      ] as const
                    ).map(([mode, label, hint, icon]) => (
                      <button
                        key={mode}
                        type="button"
                        className={classNames("choice-card", config.scope.mode === mode && "active")}
                        onClick={() => setScopeMode(mode)}
                        disabled={mode === "selection" && selection.length === 0}
                      >
                        <span className="choice-icon">
                          <Icon name={icon as any} />
                        </span>
                        <span>
                          <strong>{label}</strong>
                          <span>{hint}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {config.scope.mode === "collection" ? (
                    <Field label={S.export.collection}>
                      <select
                        className="select"
                        value={config.scope.collectionId || ""}
                        onChange={(event) =>
                          patchConfig((current) => ({
                            ...current,
                            scope: { ...current.scope, collectionId: event.target.value || null },
                          }))
                        }
                      >
                        <option value="">{S.export.chooseCollection}</option>
                        {collections.map((collection) => (
                          <option key={collection.id} value={collection.id}>
                            {collection.name}（{collection.count}）
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : null}
                  {config.scope.mode !== "approved" ? (
                    <Toggle
                      checked={config.scope.restrictApproved}
                      onChange={(value) =>
                        patchConfig((current) => ({
                          ...current,
                          scope: { ...current.scope, restrictApproved: value },
                        }))
                      }
                      label={S.export.restrictApproved}
                    />
                  ) : null}
                  <div className="count-strip">
                    <div className="count-tile"><div className="k">{S.export.countsValid}</div><div className="v">{formatNumber(scopeCounts.eligible)}</div></div>
                    <div className="count-tile danger"><div className="k">{S.export.countsExcluded}</div><div className="v">{formatNumber(scopeCounts.excluded)}</div></div>
                    <div className="count-tile"><div className="k">{S.export.countsPending}</div><div className="v">{formatNumber(scopeCounts.pending)}</div></div>
                    <div className="count-tile"><div className="k">{S.export.countsTrain}</div><div className="v">{formatNumber(project.counts.train)}</div></div>
                    <div className="count-tile"><div className="k">{S.export.countsVal}</div><div className="v">{formatNumber(project.counts.val)}</div></div>
                  </div>
                </section>

                {config.target === "lora_script" ? (
                  <section className="export-section">
                    <h3><Icon name="split" />{S.export.validationTitle}</h3>
                    <Notice tone="info">LoRA Script 结构不生成验证集，全部图片按训练分组导出。</Notice>
                  </section>
                ) : (
                <section className="export-section">
                  <h3>
                    <Icon name="split" />
                    {S.export.validationTitle}
                  </h3>
                  <Toggle
                    checked={config.validation.enabled}
                    onChange={(value) =>
                      patchConfig((current) => ({
                        ...current,
                        validation: { ...current.validation, enabled: value },
                      }))
                    }
                    label={S.export.validationEnable}
                  />
                  {config.validation.enabled ? (
                    <>
                      <Segmented
                        value={config.validation.mode}
                        onChange={(value) =>
                          patchConfig((current) => ({
                            ...current,
                            validation: { ...current.validation, mode: value as "auto" | "manual" },
                          }))
                        }
                        options={[
                          { value: "auto", label: S.export.validationAuto },
                          { value: "manual", label: S.export.validationManual },
                        ]}
                      />
                      {config.validation.mode === "auto" ? (
                        <div className="grid-2">
                          <Field
                            label={`${S.export.validationRatio} · ${Math.round(config.validation.ratio * 100)}%`}
                          >
                            <input
                              type="range"
                              min={5}
                              max={50}
                              value={Math.round(config.validation.ratio * 100)}
                              onChange={(event) =>
                                patchConfig((current) => ({
                                  ...current,
                                  validation: {
                                    ...current.validation,
                                    ratio: Number(event.target.value) / 100,
                                  },
                                }))
                              }
                            />
                          </Field>
                          <Field label={S.export.validationSeed}>
                            <input
                              className="input number"
                              type="number"
                              value={config.validation.seed}
                              onChange={(event) =>
                                patchConfig((current) => ({
                                  ...current,
                                  validation: {
                                    ...current.validation,
                                    seed: Number(event.target.value) || 0,
                                  },
                                }))
                              }
                            />
                          </Field>
                        </div>
                      ) : null}
                      <p className="hint">
                        {config.validation.mode === "auto" ? S.export.validationNoteAuto : S.export.validationNoteManual}
                      </p>
                    </>
                  ) : (
                    <p className="hint">{S.export.validationRange}</p>
                  )}
                </section>
                )}
              </>
            ) : null}

            {step === 1 ? (
              <>
                <section className="export-section">
                  <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <h3>
                      <Icon name="export" />
                      {S.export.configTitle}
                    </h3>
                    <div className="row" style={{ gap: 8 }}>
                      {presets.length > 0 ? (
                        <select
                          className="select"
                          style={{ width: 160, minHeight: 36 }}
                          value=""
                          onChange={(event) => {
                            if (event.target.value) applyPreset(event.target.value);
                          }}
                        >
                          <option value="">{S.export.loadPreset}</option>
                          {presets.map((preset) => (
                            <option key={preset.name} value={preset.name}>{preset.name}</option>
                          ))}
                        </select>
                      ) : null}
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => {
                          setPresetName("");
                          setPresetPrompt(true);
                        }}
                      >
                        <Icon name="save" className="sm" />
                        {S.export.savePreset}
                      </button>
                    </div>
                  </div>
                  <div className="choice-grid">
                    <button
                      type="button"
                      className={classNames("choice-card", config.target === "kohya" && "active")}
                      onClick={() => patch({ target: "kohya" })}
                    >
                      <span className="choice-icon"><Icon name="export" /></span>
                      <span><strong>{S.export.targetKohya}</strong><span>{S.export.targetKohyaHint}</span></span>
                    </button>
                    <button
                      type="button"
                      className={classNames("choice-card", config.target === "imagefolder" && "active")}
                      onClick={() => patch({ target: "imagefolder" })}
                    >
                      <span className="choice-icon"><Icon name="database" /></span>
                      <span><strong>{S.export.targetImagefolder}</strong><span>{S.export.targetImagefolderHint}</span></span>
                    </button>
                    <button
                      type="button"
                      className={classNames("choice-card", config.target === "lora_script" && "active")}
                      onClick={() =>
                        patchConfig((current) => ({
                          ...current,
                          target: "lora_script",
                          name: current.name?.trim() ? current.name : project.name,
                          imageFormat: "jpg",
                          validation: { ...current.validation, enabled: false },
                          loraScript: current.loraScript ?? { repeats: {}, ungroupedRepeats: 1 },
                        }))
                      }
                    >
                      <span className="choice-icon"><Icon name="layers" /></span>
                      <span><strong>{S.export.targetLoraScript}</strong><span>{S.export.targetLoraScriptHint}</span></span>
                    </button>
                  </div>
                  <div className="export-form-grid">
                    <Field label={S.export.package}>
                      <Segmented
                        value={config.package}
                        onChange={(value) => patch({ package: value as "folder" | "zip" })}
                        options={[
                          { value: "folder", label: S.export.folder, icon: "folder" },
                          { value: "zip", label: S.export.zip, icon: "archive" },
                        ]}
                      />
                    </Field>
                    <Field
                      label={config.target === "lora_script" ? "LoRA 名称" : S.export.name}
                      hint={
                        config.target === "lora_script"
                          ? "作为导出根目录；每个分组会生成 {单图训练次数}_{组名} 子目录。"
                          : "留空自动生成带时间戳的名称。"
                      }
                    >
                      <input
                        className="input"
                        value={config.name || ""}
                        placeholder={S.export.namePlaceholder}
                        onChange={(event) => patch({ name: event.target.value || null })}
                      />
                    </Field>
                    <Field label={S.export.destination} className="span-2">
                      <div className="input-row">
                        <input
                          className="input mono"
                          style={{ fontSize: 12 }}
                          value={config.destDir || S.export.destinationDefault}
                          readOnly
                        />
                        <button type="button" className="btn subtle" onClick={() => void chooseDestination()}>
                          <Icon name="folder-open" />
                          {S.export.chooseDestination}
                        </button>
                        {config.destDir ? (
                          <button type="button" className="btn ghost" onClick={() => patch({ destDir: null })}>
                            {S.export.resetDestination}
                          </button>
                        ) : null}
                      </div>
                    </Field>
                    <Field label={S.export.naming}>
                      <select className="select" value={config.naming} onChange={(event) => patch({ naming: event.target.value as "index" | "original" })}>
                        <option value="index">{S.export.namingIndex}</option>
                        <option value="original">{S.export.namingOriginal}</option>
                      </select>
                    </Field>
                    <Field label={S.export.imageFormat} hint="PNG 为无损输出；JPEG 为有损、体积更小。">
                      <Segmented
                        value={config.imageFormat}
                        onChange={(value) => patch({ imageFormat: value as "png" | "jpg" })}
                        options={[
                          { value: "png", label: "PNG" },
                          { value: "jpg", label: "JPEG" },
                        ]}
                      />
                    </Field>
                    {config.imageFormat === "jpg" ? (
                      <Field label={`${S.export.quality} · ${config.quality}`}>
                        <input
                          type="range"
                          min={50}
                          max={100}
                          value={config.quality}
                          onChange={(event) => patch({ quality: Number(event.target.value) })}
                        />
                      </Field>
                    ) : null}
                    {config.target === "kohya" ? (
                      <Field label={S.export.captionExtension}>
                        <Segmented
                          value={config.captionExtension}
                          onChange={(value) => patch({ captionExtension: value as ".txt" | ".caption" })}
                          options={[
                            { value: ".txt", label: ".txt" },
                            { value: ".caption", label: ".caption" },
                          ]}
                        />
                      </Field>
                    ) : null}
                    <Field label={S.export.sizePolicy}>
                      <select
                        className="select"
                        value={config.size.mode}
                        onChange={(event) =>
                          patchConfig((current) => ({
                            ...current,
                            size: {
                              ...current.size,
                              mode: event.target.value as ExportConfig["size"]["mode"],
                              width: current.size.width || base,
                              height: current.size.height || base,
                            },
                          }))
                        }
                      >
                        <option value="perAsset">{S.export.sizePerAsset}</option>
                        <option value="preserve">{S.export.sizePreserve}</option>
                        <option value="fitCrop">{S.export.sizeFitCrop}</option>
                        <option value="fitPad">{S.export.sizeFitPad}</option>
                      </select>
                    </Field>
                    <Field label={S.export.background}>
                      <input
                        type="color"
                        value={config.size.background}
                        onChange={(event) =>
                          patchConfig((current) => ({
                            ...current,
                            size: { ...current.size, background: event.target.value },
                          }))
                        }
                        style={{ width: 48, height: 38, border: "1px solid var(--line-strong)", borderRadius: 8, background: "var(--surface)" }}
                      />
                    </Field>
                    <Field
                      label="填充透明背景"
                      hint={
                        config.imageFormat === "jpg"
                          ? "JPEG 没有透明通道，导出时始终填充为白色。"
                          : "导出时将透明像素合成到白色；关闭后 PNG 保留透明通道。"
                      }
                    >
                      <Toggle
                        checked={config.size.fillTransparent || config.imageFormat === "jpg"}
                        disabled={config.imageFormat === "jpg"}
                        onChange={(value) =>
                          patchConfig((current) => ({
                            ...current,
                            size: { ...current.size, fillTransparent: value },
                          }))
                        }
                        label="填充为白色"
                      />
                    </Field>
                    {config.size.mode === "preserve" ? (
                      <>
                        <Field label={S.export.longestEdge}>
                          <input
                            className="input number"
                            type="number"
                            min={64}
                            max={8192}
                            step={64}
                            value={config.size.longestEdge ?? ""}
                            onChange={(event) =>
                              patchConfig((current) => ({
                                ...current,
                                size: {
                                  ...current.size,
                                  longestEdge: event.target.value ? Number(event.target.value) : null,
                                },
                              }))
                            }
                            onBlur={(event) => {
                              if (!event.target.value) return;
                              patchConfig((current) => ({
                                ...current,
                                size: {
                                  ...current.size,
                                  longestEdge: snapSize64(Number(event.target.value), 1024),
                                },
                              }));
                            }}
                          />
                        </Field>
                        <div className="row" style={{ alignItems: "flex-end" }}>
                          <Toggle
                            checked={config.size.allowUpscale}
                            onChange={(value) =>
                              patchConfig((current) => ({ ...current, size: { ...current.size, allowUpscale: value } }))
                            }
                            label={S.export.allowUpscale}
                          />
                        </div>
                      </>
                    ) : null}
                    {config.size.mode === "fitCrop" || config.size.mode === "fitPad" ? (
                      <>
                        <Field label={S.export.targetWidth}>
                          <input
                            className="input number"
                            type="number"
                            min={64}
                            max={8192}
                            step={64}
                            value={config.size.width ?? ""}
                            onChange={(event) =>
                              patchConfig((current) => ({
                                ...current,
                                size: { ...current.size, width: Number(event.target.value) || null },
                              }))
                            }
                            onBlur={(event) => {
                              if (!event.target.value) return;
                              patchConfig((current) => ({
                                ...current,
                                size: { ...current.size, width: snapSize64(Number(event.target.value), 1024) },
                              }));
                            }}
                          />
                        </Field>
                        <Field label={S.export.targetHeight}>
                          <input
                            className="input number"
                            type="number"
                            min={64}
                            max={8192}
                            step={64}
                            value={config.size.height ?? ""}
                            onChange={(event) =>
                              patchConfig((current) => ({
                                ...current,
                                size: { ...current.size, height: Number(event.target.value) || null },
                              }))
                            }
                            onBlur={(event) => {
                              if (!event.target.value) return;
                              patchConfig((current) => ({
                                ...current,
                                size: { ...current.size, height: snapSize64(Number(event.target.value), 1024) },
                              }));
                            }}
                          />
                        </Field>
                        <div className="row" style={{ alignItems: "flex-end" }}>
                          <Toggle
                            checked={config.size.allowUpscale}
                            onChange={(value) =>
                              patchConfig((current) => ({ ...current, size: { ...current.size, allowUpscale: value } }))
                            }
                            label={S.export.allowUpscale}
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                  <p className="hint">{S.export.overwriteHint}</p>
                </section>

                {config.target === "lora_script" ? (
                  <section className="export-section">
                    <h3>
                      <Icon name="layers" />
                      训练分组
                    </h3>
                    <p className="hint">
                      每个分组生成独立子目录「单图训练次数_组名」，图片与同名 .txt 放在其中。
                      同一图片属于多个分组时，按分组名称顺序取第一个。
                    </p>
                    <div className="export-form-grid">
                      {manualGroups.map((group) => {
                        const repeats =
                          config.loraScript.repeats[group.id] ?? 1;
                        return (
                          <Field
                            key={group.id}
                            label={group.name}
                            hint={`${group.count} 张图片`}
                          >
                            <div className="input-row">
                              <input
                                className="input number"
                                type="number"
                                min={1}
                                max={1000}
                                step={1}
                                value={repeats}
                                onChange={(event) => {
                                  const value = Math.max(
                                    1,
                                    Math.min(1000, Math.round(Number(event.target.value) || 1)),
                                  );
                                  patchConfig((current) => ({
                                    ...current,
                                    loraScript: {
                                      ...current.loraScript,
                                      repeats: {
                                        ...current.loraScript.repeats,
                                        [group.id]: value,
                                      },
                                    },
                                  }));
                                }}
                              />
                              <span className="hint">次/张</span>
                            </div>
                          </Field>
                        );
                      })}
                      <Field label="未分组" hint="不属于任何分组的图片">
                        <div className="input-row">
                          <input
                            className="input number"
                            type="number"
                            min={1}
                            max={1000}
                            step={1}
                            value={config.loraScript.ungroupedRepeats}
                            onChange={(event) => {
                              const value = Math.max(
                                1,
                                Math.min(1000, Math.round(Number(event.target.value) || 1)),
                              );
                              patchConfig((current) => ({
                                ...current,
                                loraScript: {
                                  ...current.loraScript,
                                  ungroupedRepeats: value,
                                },
                              }));
                            }}
                          />
                          <span className="hint">次/张</span>
                        </div>
                      </Field>
                    </div>
                    {manualGroups.length === 0 ? (
                      <Notice tone="info">当前项目还没有分组，全部图片会进入「未分组」子集。</Notice>
                    ) : null}
                    <p className="hint">
                      LoRA Script 结构不生成验证集，导出时全部按训练分组处理；标注固定为同名 .txt。
                    </p>
                  </section>
                ) : null}

                {config.target === "kohya" ? (
                  <section className="export-section">
                    <h3>
                      <Icon name="sliders" />
                      {S.export.kohyaAdvanced}
                    </h3>
                    <div className="export-form-grid">
                      <Field label={S.export.resolution}>
                        <div className="row" style={{ gap: 6 }}>
                          <input
                            className="input number"
                            type="number"
                            min={64}
                            value={config.kohya.resolution[0]}
                            onChange={(event) =>
                              patchConfig((current) => ({
                                ...current,
                                kohya: {
                                  ...current.kohya,
                                  resolution: [Number(event.target.value) || 64, current.kohya.resolution[1]],
                                },
                              }))
                            }
                          />
                          <span className="faint">×</span>
                          <input
                            className="input number"
                            type="number"
                            min={64}
                            value={config.kohya.resolution[1]}
                            onChange={(event) =>
                              patchConfig((current) => ({
                                ...current,
                                kohya: {
                                  ...current.kohya,
                                  resolution: [current.kohya.resolution[0], Number(event.target.value) || 64],
                                },
                              }))
                            }
                          />
                        </div>
                      </Field>
                      <Field label={S.export.batchSize}>
                        <input
                          className="input number"
                          type="number"
                          min={1}
                          value={config.kohya.batchSize}
                          onChange={(event) =>
                            patchConfig((current) => ({
                              ...current,
                              kohya: { ...current.kohya, batchSize: Number(event.target.value) || 1 },
                            }))
                          }
                        />
                      </Field>
                      <Field label={S.export.bucketSteps}>
                        <input
                          className="input number"
                          type="number"
                          min={8}
                          step={8}
                          value={config.kohya.bucketSteps}
                          onChange={(event) =>
                            patchConfig((current) => ({
                              ...current,
                              kohya: { ...current.kohya, bucketSteps: Number(event.target.value) || 64 },
                            }))
                          }
                        />
                      </Field>
                      <Field label={S.export.keepTokens}>
                        <input
                          className="input number"
                          type="number"
                          min={0}
                          value={config.kohya.keepTokens}
                          onChange={(event) =>
                            patchConfig((current) => ({
                              ...current,
                              kohya: { ...current.kohya, keepTokens: Math.max(0, Number(event.target.value) || 0) },
                            }))
                          }
                        />
                      </Field>
                    </div>
                    <div className="row-wrap">
                      <Toggle
                        checked={config.kohya.enableBucket}
                        onChange={(value) =>
                          patchConfig((current) => ({ ...current, kohya: { ...current.kohya, enableBucket: value } }))
                        }
                        label={S.export.enableBucket}
                      />
                      <Toggle
                        checked={config.kohya.bucketNoUpscale}
                        onChange={(value) =>
                          patchConfig((current) => ({ ...current, kohya: { ...current.kohya, bucketNoUpscale: value } }))
                        }
                        label={S.export.bucketNoUpscale}
                      />
                      <Toggle
                        checked={config.kohya.shuffleCaption}
                        onChange={(value) =>
                          patchConfig((current) => ({ ...current, kohya: { ...current.kohya, shuffleCaption: value } }))
                        }
                        label={S.export.shuffleCaption}
                      />
                    </div>
                    <p className="hint">{S.export.shuffleHint}</p>
                    <div className="stack" style={{ gap: 8 }}>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <div className="group-title">{S.export.subsets}</div>
                        <Dropdown
                          width={240}
                          align="end"
                          renderTrigger={(toggle) => (
                            <button type="button" className="btn ghost sm" onClick={toggle}>
                              <Icon name="plus" className="sm" />
                              {S.export.subsetAdd}
                            </button>
                          )}
                        >
                          {(close) => (
                            <>
                              <MenuLabel>{S.export.subsets}</MenuLabel>
                              {collections.length === 0 ? (
                                <div className="hint" style={{ padding: "6px 10px 10px" }}>暂无集合</div>
                              ) : (
                                collections.map((collection) => (
                                  <MenuItem
                                    key={collection.id}
                                    icon="folder"
                                    hint={collection.count}
                                    onClick={() => {
                                      addSubset(collection.id);
                                      close();
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
                      {config.kohya.subsets.length === 0 ? (
                        <p className="hint">{S.export.subsetEmpty}</p>
                      ) : (
                        config.kohya.subsets.map((subset, index) => (
                          <div className="subset-row" key={subset.collectionId}>
                            <Field label={S.export.collection}>
                              <select
                                className="select"
                                value={subset.collectionId}
                                onChange={(event) => updateSubset(index, { collectionId: event.target.value })}
                              >
                                {collections.map((collection) => (
                                  <option key={collection.id} value={collection.id}>{collection.name}</option>
                                ))}
                              </select>
                            </Field>
                            <Field label="名称">
                              <input
                                className="input"
                                value={subset.name}
                                onChange={(event) => updateSubset(index, { name: event.target.value })}
                              />
                            </Field>
                            <Field label={S.export.subsetRepeats}>
                              <input
                                className="input number"
                                type="number"
                                min={1}
                                value={subset.repeats}
                                onChange={(event) => updateSubset(index, { repeats: Math.max(1, Number(event.target.value) || 1) })}
                                style={{ width: 80 }}
                              />
                            </Field>
                            <Field label={S.export.keepTokens}>
                              <input
                                className="input number"
                                type="number"
                                min={0}
                                value={subset.keepTokens}
                                onChange={(event) => updateSubset(index, { keepTokens: Math.max(0, Number(event.target.value) || 0) })}
                                style={{ width: 80 }}
                              />
                            </Field>
                            <button
                              type="button"
                              className="btn ghost"
                              aria-label="移除子集"
                              onClick={() => removeSubset(index)}
                            >
                              <Icon name="trash" />
                            </button>
                          </div>
                        ))
                      )}
                      <p className="hint">{S.export.subsetOverlap}</p>
                    </div>
                  </section>
                ) : (
                  <Notice tone="info">{S.export.imagefolderNote}</Notice>
                )}
              </>
            ) : null}

            {step === 2 && !preview && !previewLoading ? (
              <Notice tone="warning">
                配置已修改，需要重新预检后才能导出。
                <button type="button" className="btn sm subtle" onClick={() => setStep(1)}>
                  返回重新预检
                </button>
              </Notice>
            ) : null}

            {step === 2 && preview ? (
              <>
                <section className="export-section">
                  <h3>
                    <Icon name="check-circle" />
                    {S.export.preflightTitle}
                  </h3>
                  <div className="count-strip">
                    <div className="count-tile"><div className="k">{S.export.countsValid}</div><div className="v">{formatNumber(preview.counts.eligible)}</div></div>
                    <div className="count-tile"><div className="k">{S.export.countsTrain}</div><div className="v">{formatNumber(preview.counts.train)}</div></div>
                    <div className="count-tile"><div className="k">{S.export.countsVal}</div><div className="v">{formatNumber(preview.counts.val)}</div></div>
                    <div className="count-tile"><div className="k">{S.export.countsExcluded}</div><div className="v">{formatNumber(preview.counts.excluded)}</div></div>
                    <div className="count-tile"><div className="k">{S.export.estimatedSize}</div><div className="v">{formatBytes(preview.estimatedBytes)}</div></div>
                  </div>
                  <div className="summary-row">
                    <span className="k">{S.export.outputPath}</span>
                    <span className="v mono" style={{ fontSize: 11 }}>{prettyPath(preview.outputPath)}</span>
                  </div>
                  <div className="summary-row">
                    <span className="k">{S.export.splitNote}</span>
                    <span className="v">
                      {preview.split.enabled
                        ? `${preview.split.train} 训练 / ${preview.split.val} 验证（${formatPercent(preview.split.actualRatio, 0)}）`
                        : "仅训练集"}
                    </span>
                  </div>
                  <details className="export-tech">
                    <summary className="small muted">技术详情</summary>
                    <div className="summary-row">
                      <span className="k">{S.export.adapter}</span>
                      <span className="v">{preview.adapterVersion}</span>
                    </div>
                    <div className="summary-row">
                      <span className="k">{S.export.preflightFingerprint}</span>
                      <span className="v mono" style={{ fontSize: 10.5 }}>{preview.fingerprint.slice(0, 20)}…</span>
                    </div>
                  </details>
                  {preview.warnings.map((warning, index) => (
                    <Notice tone="warning" key={index}>{warning}</Notice>
                  ))}
                </section>

                <section className="export-section">
                  <h3><Icon name="shield" />{S.export.blockingIssues}</h3>
                  {blockingIssues.length === 0 ? (
                    <Notice tone="success">{S.export.noBlocking}</Notice>
                  ) : (
                    blockingIssues.map((issue) => (
                      <Notice tone="danger" key={issue.code}>
                        <div className="row-wrap">
                          <span className="grow">{issue.message}</span>
                          {issue.assetIds.length > 0 ? (
                            <button
                              type="button"
                              className="btn sm subtle"
                              onClick={() =>
                                openWorkbench(issue.assetIds[0], {
                                  sequence: issue.assetIds,
                                  label: "导出问题顺序",
                                })
                              }
                            >
                              <Icon name="workbench" className="sm" />
                              {issueActionLabel(issue.code, issue.message)}
                            </button>
                          ) : /范围|scope/i.test(`${issue.code} ${issue.message}`) ? (
                            <button type="button" className="btn sm subtle" onClick={() => setStep(0)}>
                              <Icon name="filter" className="sm" />
                              修改导出范围
                            </button>
                          ) : (
                            <button type="button" className="btn sm subtle" onClick={() => navigate("quality")}>
                              <Icon name="quality" className="sm" />
                              {S.quality.title}
                            </button>
                          )}
                        </div>
                      </Notice>
                    ))
                  )}
                  {suggestionIssues.length > 0 ? (
                    <div className="stack" style={{ gap: 5 }}>
                      <div className="group-title">{S.export.suggestions}</div>
                      {suggestionIssues.map((issue) => (
                        <div key={issue.code} className="issue-line suggestion">
                          <Icon name="info" className="sm" style={{ marginTop: 1 }} />
                          <span className="issue-msg">{issue.message}</span>
                          {issue.assetIds.length > 0 ? (
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() =>
                                openWorkbench(issue.assetIds[0], {
                                  sequence: issue.assetIds,
                                  label: "导出建议顺序",
                                })
                              }
                            >
                              查看
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {preview.split.conflicts.length > 0 ? (
                    <Notice tone="danger">{preview.split.conflicts.join("；")}</Notice>
                  ) : null}
                </section>

                <div className="preflight-grid">
                  <section className="export-section">
                    <h3><Icon name="folder" />{S.export.tree}</h3>
                    <div className="tree">
                      {preview.tree.map((line) => (
                        <div key={line} className={line.endsWith("/") ? "tree-dir" : "tree-file"}>
                          {line.endsWith("/") ? line : `  ${line}`}
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="export-section">
                    <h3><Icon name="tag" />{S.export.samples}</h3>
                    <div className="stack" style={{ gap: 8 }}>
                      {preview.samples.map((sample) => (
                        <div className="sample-card" key={sample.imagePath}>
                          <div className="sample-main">
                            <div className="sample-path">{sample.imagePath}</div>
                            <div className="sample-caption">{sample.caption || "（空标注）"}</div>
                            <div className="tiny faint">
                              {sample.split === "val" ? "验证" : "训练"} · {sample.width}×{sample.height}
                            </div>
                          </div>
                          <Badge tone={sample.split === "val" ? "warning" : "info"}>
                            {sample.split === "val" ? "验证" : "训练"}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>

                <section className="export-section">
                  <h3><Icon name="file" />{S.export.files}</h3>
                  <div className="row-wrap">
                    {preview.files.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        className={classNames("chip", (selectedFile || preview.files[0]?.path) === file.path && "active")}
                        onClick={() => setSelectedFile(file.path)}
                      >
                        <Icon name="file" className="sm" />
                        {file.path}
                      </button>
                    ))}
                  </div>
                  {selectedPreviewFile ? (
                    <div className="file-preview">
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <span className="mono small">{selectedPreviewFile.path}</span>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={async () => {
                            const copied = await copyText(selectedPreviewFile.content || "");
                            notify({ message: copied ? S.common.copied : S.errors.clipboard, tone: copied ? "success" : "danger" });
                          }}
                        >
                          <Icon name="copy" className="sm" />
                          {S.common.copy}
                        </button>
                      </div>
                      <pre>{selectedPreviewFile.content || "（此文件内容在导出后生成）"}</pre>
                    </div>
                  ) : null}
                </section>

                {runningJob ? (
                  <section className="export-section">
                    <h3><Icon name="tasks" />{S.export.exporting}</h3>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="small">{runningJob.phase || "处理中"}</span>
                      <span className="mono small">
                        {runningJob.done}/{runningJob.total}
                      </span>
                    </div>
                    <div className="progress">
                      <span
                        style={{
                          width: `${Math.round(
                            (runningJob.total > 0 ? runningJob.done / runningJob.total : runningJob.progress) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                    <button type="button" className="btn ghost sm" onClick={() => setJobsOpen(true)}>
                      <Icon name="tasks" className="sm" />
                      {S.jobs.title}
                    </button>
                  </section>
                ) : result ? (
                  <section className="export-result">
                    <h3>
                      <Icon name="check-circle" style={{ color: "var(--success)" }} />
                      {S.export.resultTitle}
                    </h3>
                    <p className="small muted">{result.counts?.total ? `已生成 ${result.counts.total} 张训练素材。` : ""}</p>
                    <div className="result-path">{prettyPath(String(result.outputPath || ""))}</div>
                    <div className="row-wrap">
                      <Badge tone="success">{S.export.validationPassed}</Badge>
                      <Badge tone="neutral">{S.export.adapter}: {preview.adapterVersion}</Badge>
                      <Badge tone="neutral">{S.export.splitNote}：{preview.split.train} / {preview.split.val}</Badge>
                    </div>
                    {Array.isArray(result.validation?.checks) ? (
                      <div className="validation-list">
                        {result.validation.checks.map((check: any, index: number) => (
                          <div className={classNames("validation-row", !check.ok && "failed")} key={index}>
                            <span className="mark">{check.ok ? <Icon name="check" className="sm" /> : <Icon name="x" className="sm" />}</span>
                            <span>
                              <strong>{check.name}</strong> · {check.detail}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div className="result-actions">
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() =>
                          result.recordId
                            ? void api.openExportOutput(String(result.recordId)).catch((error) =>
                                notify({ tone: "danger", message: normalizeError(error).message }),
                              )
                            : undefined
                        }
                      >
                        <Icon name="folder-open" />
                        {S.export.openFolder}
                      </button>
                      <button
                        type="button"
                        className="btn subtle"
                        onClick={() =>
                          result.recordId
                            ? void copyEntry({
                                id: String(result.recordId),
                                snapshotId: "",
                                createdAt: new Date().toISOString(),
                                target: config.target,
                                package: config.package,
                                outputPath: String(result.outputPath || ""),
                                counts: result.counts || {},
                                validation: result.validation || {},
                                manifestSha256: null,
                              })
                            : undefined
                        }
                      >
                        <Icon name="copy" />
                        {copyLabel(config.target)}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => {
                          setPresetName("");
                          setPresetPrompt(true);
                        }}
                      >
                        <Icon name="save" />
                        {S.export.savePreset}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={async () => {
                          if (!result.recordId) return;
                          try {
                            setReport(await api.exportRecord(String(result.recordId)));
                          } catch (error) {
                            notify({ tone: "danger", message: normalizeError(error).message });
                          }
                        }}
                      >
                        <Icon name="file" />
                        {S.export.viewReport}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => {
                          setStep(1);
                          setPreview(null);
                          setResult(null);
                        }}
                      >
                        <Icon name="refresh" />
                        {S.export.rerun}
                      </button>
                    </div>
                  </section>
                ) : null}
              </>
            ) : null}

            <div className="export-foot">
              <button
                type="button"
                className="btn ghost"
                onClick={() => setStep((value) => Math.max(0, value - 1))}
                disabled={step === 0}
              >
                <Icon name="arrow-left" />
                {S.export.back}
              </button>
              <div className="spacer" />
              {step < 2 ? (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void goNext()}
                  disabled={previewLoading}
                >
                  {previewLoading ? <Spinner /> : null}
                  {step === 1 ? S.export.preflightTitle : S.export.next}
                  <Icon name="arrow-right" />
                </button>
              ) : !result ? (
                <div className="export-foot-primary">
                  {preview ? <span className="tiny faint">本次导出使用预检时确认的版本</span> : null}
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void start()}
                    disabled={!preview || starting || blockingIssues.length > 0 || Boolean(runningJob)}
                    title={
                      !preview
                        ? "请先完成预检"
                        : blockingIssues.length > 0
                          ? S.export.blockedHint
                          : undefined
                    }
                  >
                    {starting || runningJob ? <Spinner /> : <Icon name="export" />}
                    {runningJob ? S.export.exporting : S.export.startExport}
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <aside className="export-side">
            <button
              type="button"
              className="export-summary-toggle"
              onClick={() => setSummaryExpanded((value) => !value)}
              aria-expanded={summaryExpanded}
            >
              <Icon name="list" className="sm" />
              导出摘要
              <span className="tiny faint">{summaryExpanded ? "收起" : "展开"}</span>
            </button>
            <div className={classNames("export-summary-body", !summaryExpanded && "is-collapsed")}>
            <h3>{S.export.summary}</h3>
            <div className="summary-list">
              <div className="summary-row">
                <span className="k">{S.export.target}</span>
                <span className="v">{targetName(config.target)}</span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.package}</span>
                <span className="v">{config.package === "zip" ? S.export.zip : S.export.folder}</span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.scopeTitle}</span>
                <span className="v">
                  {config.scope.mode === "all"
                    ? S.export.scopeAll
                    : config.scope.mode === "approved"
                      ? S.export.scopeApproved
                      : config.scope.mode === "collection"
                        ? collections.find((item) => item.id === config.scope.collectionId)?.name || S.export.scopeCollection
                        : S.export.scopeSelection}
                </span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.countsValid}</span>
                <span className="v">{formatNumber(scopeCounts.eligible)}</span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.countsTrain} / {S.export.countsVal}</span>
                <span className="v">
                  {formatNumber(preview?.counts.train ?? project.counts.train)} /{" "}
                  {formatNumber(preview?.counts.val ?? project.counts.val)}
                </span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.naming}</span>
                <span className="v">{config.naming === "index" ? S.export.namingIndex : S.export.namingOriginal}</span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.imageFormat}</span>
                <span className="v">
                  {config.imageFormat === "jpg"
                    ? `JPEG · ${config.quality}`
                    : "PNG · 无损"}
                </span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.validationTitle}</span>
                <span className="v">
                  {config.validation.enabled
                    ? `${config.validation.mode === "auto" ? S.export.validationAuto : S.export.validationManual} · ${Math.round(config.validation.ratio * 100)}%`
                    : "未启用"}
                </span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.outputPath}</span>
                <span className="v mono" style={{ fontSize: 10 }}>
                  {preview?.outputPath ? prettyPath(preview.outputPath) : config.destDir ? prettyPath(config.destDir) : S.export.destinationDefault}
                </span>
              </div>
            </div>
            {preview ? (
              <div className="well">
                <div className="tiny faint">{S.export.estimatedSize}</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{formatBytes(preview.estimatedBytes)}</div>
                <div className="tiny faint" style={{ marginTop: 4 }}>
                  共 {preview.counts.eligible} 张
                </div>
              </div>
            ) : null}
            <Notice tone="info">{S.export.targetHint}</Notice>
            </div>
          </aside>
        </div>
      </div>

      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title={S.export.history}
        width="wide"
      >
        {records.length === 0 ? (
          <EmptyState icon="archive" title={S.export.historyEmpty} />
        ) : (
          <div className="record-list">
            {records.map((record) => {
              const ok = record.validation?.ok === true;
              return (
                <div className="record-row" key={record.id}>
                  <div className="record-main">
                    <div className="record-title">
                      <Badge tone={record.target === "kohya" ? "info" : "neutral"}>
                        {targetShort(record.target)}
                      </Badge>
                      <Badge tone={ok ? "success" : "warning"}>{ok ? S.export.validationPassed : S.export.validationFailed}</Badge>
                      <span className="small muted">{formatDate(record.createdAt)}</span>
                    </div>
                    <div className="record-path" title={prettyPath(record.outputPath)}>{prettyPath(record.outputPath)}</div>
                    <div className="tiny faint" style={{ marginTop: 2 }}>
                      {record.counts?.total ? `${record.counts.total} 张` : ""}
                      {record.counts?.train !== undefined ? ` · ${record.counts.train} 训练 / ${record.counts.val} 验证` : ""}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setReport(record)}
                    >
                      {S.export.viewReport}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={async () => {
                        try {
                          const restored = await api.exportSnapshotConfig(record.snapshotId);
                          setConfig(restored);
                          setPreview(null);
                          setResult(null);
                          setStep(0);
                          setHistoryOpen(false);
                          notify({ message: "已复用该导出的配置；请重新确认范围并预检。" });
                        } catch (error) {
                          notify({ tone: "danger", message: normalizeError(error).message });
                        }
                      }}
                    >
                      <Icon name="refresh" className="sm" />
                      复用配置
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => void copyEntry(record)}
                    >
                      {copyLabel(record.target)}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => void api.openExportOutput(record.id).catch((error) =>
                        notify({ tone: "danger", message: normalizeError(error).message }),
                      )}
                    >
                      <Icon name="folder-open" className="sm" />
                      {S.export.openFolder}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      <Modal
        open={report !== null}
        onClose={() => setReport(null)}
        title={S.export.reportTitle}
        width="wide"
        footer={
          <button type="button" className="btn primary" onClick={() => setReport(null)}>
            {S.common.close}
          </button>
        }
      >
        {report ? (
          <div className="stack" style={{ gap: 14 }}>
            <div className="path-block">{prettyPath(report.outputPath)}</div>
            <div className="summary-list">
              <div className="summary-row">
                <span className="k">{S.export.recordTarget}</span>
                <span className="v">{targetName(report.target)}</span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.recordCount}</span>
                <span className="v">{report.counts?.total ?? "—"}</span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.splitNote}</span>
                <span className="v">{report.counts?.train} / {report.counts?.val}</span>
              </div>
              <div className="summary-row">
                <span className="k">{S.export.preflightFingerprint}</span>
                <span className="v mono" style={{ fontSize: 10 }}>
                  {report.manifestSha256 || "—"}
                </span>
              </div>
            </div>
            {Array.isArray(report.validation?.checks) ? (
              <div className="validation-list">
                {report.validation.checks.map((check: any, index: number) => (
                  <div className={classNames("validation-row", !check.ok && "failed")} key={index}>
                    <span className="mark">{check.ok ? <Icon name="check" className="sm" /> : <Icon name="x" className="sm" />}</span>
                    <span><strong>{check.name}</strong> · {check.detail}</span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="hint">此记录没有详细校验数据。</span>
            )}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn subtle"
                onClick={() => void copyEntry(report)}
              >
                <Icon name="copy" />
                {copyLabel(report.target)}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void api.openExportOutput(report.id)}
              >
                <Icon name="folder-open" />
                {S.export.openFolder}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <PromptDialog
        open={presetPrompt}
        title={S.export.savePreset}
        body="保存当前导出配置（不含素材范围与目标路径之外的内容）。"
        label="预设名称"
        required
        confirmLabel={S.common.save}
        onSubmit={(value) => savePreset(value)}
        onClose={() => setPresetPrompt(false)}
      />
    </div>
  );
}
