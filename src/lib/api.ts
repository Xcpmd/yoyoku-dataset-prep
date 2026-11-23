import { invoke } from "@tauri-apps/api/core";
import type {
  ApiErrorShape,
  AppInfo,
  AppSettings,
  AssetDetail,
  AssetFilter,
  AssetPatch,
  AssetSort,
  AssetSummary,
  AssetPlanInfo,
  AssetsPage,
  BatchPreview,
  BatchRequest,
  BatchResult,
  CaptionPreviewResult,
  CaptionSaveResult,
  CaptionTagState,
  CollectionInfo,
  ConvertPreview,
  DedupeActionResult,
  DedupeRecycled,
  DedupeScan,
  DuplicateGroupView,
  ExportConfig,
  ExportPreview,
  ExportRecordInfo,
  ExportStartResult,
  HistoryEntry,
  ImportResult,
  IssueRow,
  JobInfo,
  ModelInfo,
  ModelCatalogEntry,
  ModelDownloadResult,
  CachedTranslation,
  PromptLibraryEntry,
  PromptUpsertRequest,
  TranslateResult,
  ProjectInfo,
  ProjectUpdate,
  QualityIssues,
  QualityOverview,
  QualitySummary,
  RecentProject,
  ScanPreview,
  ScanRequest,
  StorageStats,
  SuggestionInfo,
  SuggestionResult,
  TagBulkRequest,
  TagBulkResult,
  TagTotalsResult,
  TrainingEntry,
  TransformPreview,
  TransformPlan,
  TransformSaveResult,
  WorkerPing,
} from "./types";

export class ApiError extends Error {
  code: string;
  retryable: boolean;
  details: unknown;
  itemIds: string[];

  constructor(shape: ApiErrorShape) {
    super(shape.message || "操作失败");
    this.name = "ApiError";
    this.code = shape.code || "APP_ERROR";
    this.retryable = Boolean(shape.retryable);
    this.details = shape.details;
    this.itemIds = shape.itemIds || [];
  }
}

export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (typeof error === "string") {
    return new ApiError({ code: "APP_ERROR", message: error });
  }
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.message === "string") {
      return new ApiError({
        code: typeof value.code === "string" ? value.code : "APP_ERROR",
        message: value.message,
        retryable: Boolean(value.retryable),
        details: value.details,
        itemIds: Array.isArray(value.itemIds) ? (value.itemIds as string[]) : [],
      });
    }
  }
  return new ApiError({ code: "APP_ERROR", message: String(error ?? "操作失败") });
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeError(error);
  }
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  workerPing: () => call<WorkerPing>("worker_ping"),
  workerLogs: () => call<void>("worker_logs"),
  getSettings: () => call<AppSettings>("app_settings_get"),
  setSettings: (settings: AppSettings) => call<AppSettings>("app_settings_set", { settings }),
  recentProjects: () => call<RecentProject[]>("recent_projects"),
  removeRecent: (id: string) => call<void>("recent_remove", { id }),
  pinRecent: (id: string) => call<void>("recent_pin", { id }),

  pickFolder: (title?: string) => call<string | null>("dialog_pick_folder", { title }),
  pickImages: (title?: string) => call<string[]>("dialog_pick_images", { title }),
  pickZip: (title?: string) => call<string | null>("dialog_pick_zip", { title }),
  saveZip: (defaultName?: string) => call<string | null>("dialog_save_zip", { defaultName }),

  createProject: (req: {
    name: string;
    parentDir: string;
    model: string;
    template: string;
    triggerWord: string;
    defaultCaptionMode: string;
  }) => call<ProjectInfo>("project_create", { req }),
  createSample: () => call<ProjectInfo>("project_create_sample"),
  openProject: (path: string) => call<ProjectInfo>("project_open", { path }),
  openRecent: (id: string) => call<ProjectInfo>("project_open_recent", { id }),
  relocateProject: (id: string, path: string) => call<ProjectInfo>("project_relocate", { id, path }),
  closeProject: () => call<void>("project_close"),
  getProject: () => call<ProjectInfo>("project_get"),
  updateProject: (req: ProjectUpdate) => call<ProjectInfo>("project_update", { req }),
  revealProject: () => call<void>("project_reveal"),
  revealPath: (path: string) => call<void>("reveal_path", { path }),
  backupProject: (req: { destPath: string; portable: boolean }) =>
    call<{ path: string; portable: boolean; files: number; missing: string[]; bytes: number }>(
      "project_backup",
      { req },
    ),
  restoreProject: (zipPath: string, targetParent: string) =>
    call<{
      project: ProjectInfo;
      restoredPath: string;
      portable: boolean;
      warnings: string[];
    }>("project_restore", { zipPath, targetParent }),
  relinkRoot: (oldRoot: string, newRoot: string) =>
    call<{ relinked: number; missing: string[] }>("asset_relink_root", {
      req: { oldRoot, newRoot },
    }),

  scanImport: (req: ScanRequest) => call<ScanPreview>("import_scan", { req }),
  startImport: (scanId: string, collectionId?: string | null) =>
    call<ImportResult>("import_start", { scanId, collectionId: collectionId || null }),
  retryImport: (jobId: string) => call<ImportResult>("import_retry", { jobId }),

  queryAssets: (filter: AssetFilter, sort: AssetSort, offset: number, limit: number) =>
    call<AssetsPage>("assets_query", { req: { filter, sort, offset, limit } }),
  assetIds: (filter: AssetFilter) => call<string[]>("assets_ids", { filter }),
  getAsset: (id: string) => call<AssetDetail>("asset_get", { id }),
  assetSummaries: (ids: string[]) => call<AssetSummary[]>("assets_summaries", { ids }),
  assetTransformPlans: (ids: string[]) => call<AssetPlanInfo[]>("assets_transform_plans", { ids }),
  updateAsset: (id: string, patch: AssetPatch) =>
    call<{ asset: AssetSummary; historySeq: number; qualityStale: boolean }>("asset_update", {
      id,
      patch,
    }),
  assetDisplay: (id: string) => call<string>("asset_display", { id }),
  assetReveal: (id: string) => call<void>("asset_reveal", { id }),

  batchPreview: (req: BatchRequest) => call<BatchPreview>("batch_preview", { req }),
  batchApply: (previewId: string) => call<BatchResult>("batch_apply", { previewId }),
  undo: () =>
    call<{ label: string; seq: number; commandType: string; redoable: boolean; affectedIds: string[] } | null>(
      "undo",
    ),
  redo: () =>
    call<{ label: string; seq: number; commandType: string; redoable: boolean; affectedIds: string[] } | null>(
      "redo",
    ),
  historyRecent: (limit = 30) => call<HistoryEntry[]>("history_recent", { limit }),

  listCollections: () => call<CollectionInfo[]>("collections_list"),
  createCollection: (req: {
    name: string;
    kind: "manual" | "query";
    query?: AssetFilter | null;
    sort?: AssetSort | null;
    targetWidth?: number | null;
    targetHeight?: number | null;
  }) => call<CollectionInfo>("collection_create", { req }),
  updateCollection: (req: {
    id: string;
    name?: string;
    query?: AssetFilter | null;
    sort?: AssetSort | null;
    targetWidth?: number | null;
    targetHeight?: number | null;
  }) => call<CollectionInfo>("collection_update", { req }),
  deleteCollection: (id: string) => call<void>("collection_delete", { id }),
  collectionIds: (id: string) => call<string[]>("collection_ids", { id }),

  transformPreview: (assetId: string, plan: TransformPlan, maxSide = 1600) =>
    call<TransformPreview>("transform_preview", { req: { assetId, plan, maxSide } }),
  transformSave: (assetId: string, plan: TransformPlan, expectedRevision: number) =>
    call<TransformSaveResult>("transform_save", { req: { assetId, plan, expectedRevision } }),
  saveDraft: (assetId: string, plan: TransformPlan) =>
    call<{ draftRevisionId: string | null; savedAt: string | null }>("transform_draft_save", {
      assetId,
      plan,
    }),
  clearDraft: (assetId: string) => call<void>("transform_draft_clear", { assetId }),

  saveCaption: (req: {
    assetId: string;
    mode: string;
    tags: string[];
    text: string;
    expectedRevision: number;
    source?: string;
  }) => call<CaptionSaveResult>("caption_save", { req }),
  previewCaption: (req: {
    mode: string;
    tags: string[];
    text: string;
    triggerDisabled?: boolean;
  }) => call<CaptionPreviewResult>("caption_preview", { req }),
  convertPreview: (assetId: string, targetMode: string) =>
    call<ConvertPreview>("caption_convert_preview", { assetId, targetMode }),
  captionTagStateGet: (assetId: string) =>
    call<CaptionTagState>("caption_tag_state_get", { assetId }),
  captionTagStateSet: (assetId: string, tagState: CaptionTagState) =>
    call<void>("caption_tag_state_set", { assetId, tagState }),
  captionTagTotals: (assetIds: string[]) =>
    call<TagTotalsResult>("caption_tag_totals", { assetIds }),
  captionTagBulk: (req: TagBulkRequest) =>
    call<TagBulkResult>("caption_tag_bulk", { req }),
  captionSuggestions: (assetId: string) =>
    call<SuggestionInfo[]>("caption_suggestions", { assetId }),
  generateSuggestion: (req: {
    assetId: string;
    model?: string;
    threshold?: number;
    characterThreshold?: number;
  }) => call<SuggestionResult>("suggestion_generate", { req }),
  applySuggestion: (revisionId: string, expectedRevision: number) =>
    call<CaptionSaveResult>("suggestion_apply", { req: { revisionId, expectedRevision } }),

  runQuality: () =>
    call<{
      summary: QualitySummary;
      duplicateGroups: number;
      scanned: number;
      durationMs: number;
    }>("quality_run"),
  qualitySummary: () => call<QualitySummary>("quality_summary"),
  qualityIssues: (rule: string, includeIgnored = false, split?: "train" | "val" | null) =>
    call<QualityIssues>("quality_issues", { rule, includeIgnored, split: split || null }),
  ignoreIssue: (issueId: string, reason: string) =>
    call<void>("quality_ignore", { issueId, reason }),
  unignoreIssue: (issueId: string) => call<void>("quality_unignore", { issueId }),
  qualityDuplicates: () => call<DuplicateGroupView[]>("quality_duplicates"),
  duplicateAction: (req: {
    groupId: string;
    action: "keep" | "excludeOthers" | "notDuplicate" | "excludeSelected";
    assetIds?: string[];
    keptAssetId?: string | null;
  }) => call<number>("quality_duplicate_action", { req }),
  qualityOverview: () => call<QualityOverview>("quality_overview"),

  dedupeScan: (threshold?: number) =>
    call<DedupeScan>("dedupe_scan", { threshold: threshold ?? null }),
  dedupeRecycled: () => call<DedupeRecycled[]>("dedupe_recycled"),
  dedupeRecycle: (assetIds: string[]) =>
    call<DedupeActionResult>("dedupe_recycle", { assetIds }),
  dedupeRestore: (assetIds: string[]) =>
    call<DedupeActionResult>("dedupe_restore", { assetIds }),

  exportPreview: (config: ExportConfig) => call<ExportPreview>("export_preview", { config }),
  exportStart: (previewId: string) => call<ExportStartResult>("export_start", { previewId }),
  exportSnapshotConfig: (snapshotId: string) =>
    call<ExportConfig>("export_snapshot_config", { snapshotId }),
  exportRecords: () => call<ExportRecordInfo[]>("export_records"),
  exportRecord: (id: string) => call<ExportRecordInfo>("export_record", { id }),
  exportAbsoluteEntry: (recordId: string) =>
    call<TrainingEntry>("export_absolute_entry", { recordId }),
  openExportOutput: (recordId: string) => call<void>("export_open_output", { recordId }),

  jobs: () => call<JobInfo[]>("jobs_list"),
  pauseJob: (jobId: string) => call<void>("jobs_pause", { jobId }),
  resumeJob: (jobId: string) => call<ImportResult | null>("jobs_resume", { jobId }),
  cancelJob: (jobId: string) => call<void>("jobs_cancel", { jobId }),
  retryFailed: (jobId: string) => call<ImportResult | null>("jobs_retry_failed", { jobId }),

  translateTexts: (texts: string[], to: "zh" | "en") =>
    call<TranslateResult>("translate_texts", { req: { texts, to } }),

  promptLibraryCount: () => call<number>("prompt_library_count"),
  promptLibraryList: () => call<PromptLibraryEntry[]>("prompt_library_list"),
  promptLibraryImport: (entries: PromptLibraryEntry[]) =>
    call<number>("prompt_library_import", { entries }),
  promptLibraryUpsert: (req: PromptUpsertRequest) =>
    call<PromptLibraryEntry>("prompt_library_upsert", { req }),
  promptLibraryDelete: (key: string) => call<void>("prompt_library_delete", { key }),
  translationCacheGet: (texts: string[], to: "zh" | "en") =>
    call<CachedTranslation[]>("translation_cache_get", { texts, to }),

  models: () => call<ModelInfo[]>("models_list"),
  modelCatalog: () => call<ModelCatalogEntry[]>("models_catalog"),
  downloadModel: (modelId: string) => call<ModelDownloadResult>("model_download", { modelId }),
  openModelsDir: () => call<void>("models_open_dir"),
  storageStats: () => call<StorageStats>("storage_stats"),
  clearCache: () => call<StorageStats>("cache_clear"),
};

export type { AssetSummary, IssueRow };
