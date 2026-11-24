export type Page = "library" | "workbench" | "quality" | "export" | "settings";
export type ReviewStatus = "pending" | "approved" | "review" | "excluded";
export type CaptionMode = "tags" | "nl" | "mixed";
export type SplitLock = "train" | "val" | null;

export interface AppSettings {
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  reduceTransparency: boolean;
  reduceMotion: boolean;
  smoothZoom: boolean;
  highContrast: boolean;
  largeText: boolean;
  gridCardMin: number;
  inspectorWidth: number;
  pythonPath: string | null;
  modelsDir: string | null;
  baiduTranslateAppId: string | null;
  baiduTranslateKey: string | null;
  imageSlots: number;
}

export interface ProjectCounts {
  total: number;
  valid: number;
  pending: number;
  approved: number;
  review: number;
  excluded: number;
  train: number;
  val: number;
  collections: number;
  orphanCaptions: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  model: string;
  template: string;
  triggerWord: string;
  triggerMode: string;
  defaultCaptionMode: CaptionMode;
  settings: Record<string, any>;
  root: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
  counts: ProjectCounts;
  qualityStale: boolean;
  qualityScannedAt: string | null;
}

export interface RecentProject {
  id: string;
  name: string;
  model: string;
  path: string;
  imageCount: number;
  lastOpened: string;
  pinned: boolean;
  missing: boolean;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ColorAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface TransformPlan {
  version: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  crop: CropRect;
  scaleMode: "preserve" | "fitCrop" | "fitPad";
  width: number | null;
  height: number | null;
  longestEdge: number | null;
  allowUpscale: boolean;
  resample: "lanczos" | "bicubic";
  background: string;
  fillTransparent: boolean;
  color: ColorAdjust;
  format: "png" | "jpg";
  quality: number;
}

export interface Geometry {
  outWidth: number;
  outHeight: number;
  cropWidth: number;
  cropHeight: number;
  scaledWidth: number;
  scaledHeight: number;
  cropRatio: number;
  padRatio: number;
  scaleRatio: number;
  blocked: boolean;
  blockedReason: string | null;
}

export interface AssetSummary {
  id: string;
  name: string;
  ext: string;
  format: string;
  width: number;
  height: number;
  outWidth: number;
  outHeight: number;
  bytes: number;
  status: ReviewStatus;
  favorite: boolean;
  captionMode: CaptionMode;
  captionPreview: string;
  captionText: string;
  tags: string[];
  issueBlocking: number;
  issueSuggestion: number;
  duplicateGroupId: string | null;
  splitLock: SplitLock;
  thumbVersion: string;
  displayVersion: string;
  hasDraft: boolean;
  importedAt: string;
  lastHumanAt: string | null;
  sortIndex: number;
  revision: number;
  hasCaption: boolean;
  cropRatio: number;
  padRatio: number;
  scaleRatio: number;
  sourceLabel: string;
  note: string;
  missing: boolean;
  triggerDisabled: boolean;
}

export interface AssetsPage {
  items: AssetSummary[];
  total: number;
  nextOffset: number | null;
  nextCursor: string | null;
}

export interface IssueInfo {
  id: string;
  assetId: string;
  rule: string;
  level: "blocking" | "suggestion";
  message: string;
  evidence: Record<string, any>;
  ignored: boolean;
  ignoreReason: string | null;
}

export interface CaptionData {
  revisionId: string | null;
  mode: CaptionMode;
  tags: string[];
  text: string;
  finalText: string;
  source: string;
  createdAt: string | null;
  charCount: number;
  tagCount: number;
  tokenEstimate: number | null;
  tokenizerNote: string;
}

export interface TransformData {
  revisionId: string | null;
  plan: TransformPlan;
  draft: TransformPlan | null;
  draftRevisionId: string | null;
  createdAt: string | null;
  planHash: string | null;
  sourceHash: string | null;
}

export interface CollectionInfo {
  id: string;
  name: string;
  kind: "manual" | "query";
  count: number;
  createdAt: string;
  query: AssetFilter | null;
  sort: AssetSort | null;
  targetWidth: number | null;
  targetHeight: number | null;
}

export interface HistoryEntry {
  seq: number;
  label: string;
  commandType: string;
  createdAt: string;
  undone: boolean;
  targetIds: string[];
}

export interface AssetDetail {
  summary: AssetSummary;
  sha256: string;
  origWidth: number;
  origHeight: number;
  normWidth: number;
  normHeight: number;
  hasAlpha: boolean;
  phash: string | null;
  blurScore: number | null;
  darkRatio: number | null;
  brightRatio: number | null;
  sourceRoot: string | null;
  relPath: string;
  sourcePath: string;
  sourceSize: number | null;
  missing: boolean;
  excludedReason: string | null;
  reviewNote: string | null;
  issues: IssueInfo[];
  transform: TransformData;
  caption: CaptionData;
  collections: CollectionInfo[];
  history: HistoryEntry[];
  importedAt: string;
  filesize: number;
}

export interface AssetFilter {
  query: string;
  statuses: ReviewStatus[];
  orientations: string[];
  collectionIds: string[];
  issueRules: string[];
  issueLevels: string[];
  split: "train" | "val" | "unassigned" | null;
  duplicateOnly: boolean;
  favoriteOnly: boolean;
  minShortEdge: number | null;
  maxShortEdge: number | null;
  hasDraft: boolean;
  recycledOnly: boolean;
}

export interface AssetSort {
  field:
    | "import"
    | "name"
    | "edge"
    | "status"
    | "date"
    | "width"
    | "height"
    | "ratio"
    | "exposure"
    | "colorfulness"
    | "contrast"
    | "saturation";
  direction: "asc" | "desc";
}

export interface AssetPatch {
  status?: ReviewStatus;
  favorite?: boolean;
  splitLock?: "train" | "val" | "";
  note?: string;
  excludedReason?: string;
  triggerDisabled?: boolean;
}

export type BatchOp =
  | { kind: "addTags"; tags: string[] }
  | { kind: "removeTags"; tags: string[] }
  | { kind: "replaceTag"; from: string; to: string }
  | { kind: "moveToFront"; tag: string }
  | { kind: "copyCaption"; source: string }
  | { kind: "lowercase" }
  | { kind: "underscores" }
  | { kind: "cleanShort"; maxLen: number }
  | { kind: "setStatus"; status: ReviewStatus; reason?: string }
  | { kind: "setSplit"; split: "train" | "val" | null }
  | { kind: "addToCollection"; collection: string }
  | { kind: "removeFromCollection"; collection: string };

export interface BatchRequest {
  assetIds: string[];
  filter?: AssetFilter | null;
  op: BatchOp;
  excludeIds?: string[];
}

export interface BatchPreview {
  previewId: string;
  count: number;
  skipped: { assetId: string; name: string; reason: string }[];
  diffs: { assetId: string; name: string; before: string; after: string; changed: boolean }[];
  summary: string;
  warnings: string[];
  createdAt: string;
}

export interface BatchResult {
  applied: number;
  skipped: number;
  historySeq: number;
  label: string;
}

export interface ScanRequest {
  paths: string[];
  recursive: boolean;
  mode: "copy" | "reference";
  sidecarPriority: "txt" | "caption";
  duplicatePolicy: "skip" | "keep";
  captionConflictPolicy: string;
  collectionId?: string | null;
}

export interface ScanEntry {
  path: string;
  root: string;
  relPath: string;
  name: string;
  ext: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  sidecarPath: string | null;
  sidecarKind: string | null;
  sidecarText: string | null;
  sidecarConflicts: string[];
  status: string;
  problems: string[];
}

export interface ScanSummary {
  candidates: number;
  withSidecar: number;
  conflicts: number;
  unsupported: number;
  errors: number;
  oversized: number;
  animated: number;
  isolatedSidecars: number;
  truncated: number;
}

export interface ScanPreview {
  id: string;
  roots: string[];
  entries: ScanEntry[];
  summary: ScanSummary;
  skipped: { path: string; reason: string }[];
  options: ScanRequest;
}

export interface ImportResult {
  jobId: string;
  total: number;
}

export interface QualityRuleSummary {
  rule: string;
  title: string;
  level: "blocking" | "suggestion";
  description: string;
  count: number;
  ignored: number;
}

export interface QualitySummary {
  scannedAt: string | null;
  stale: boolean;
  configHash: string;
  blocking: number;
  suggestions: number;
  ignoredTotal: number;
  rules: QualityRuleSummary[];
}

export interface IssueRow {
  id: string;
  assetId: string;
  assetName: string;
  assetStatus: ReviewStatus;
  thumbVersion: string;
  message: string;
  evidence: Record<string, any>;
  ignored: boolean;
  ignoreReason: string | null;
}

export interface QualityIssues {
  rule: string;
  title: string;
  level: string;
  description: string;
  rows: IssueRow[];
}

export interface DuplicateMember {
  assetId: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  status: ReviewStatus;
  format: string;
  captionPreview: string;
  sourceLabel: string;
  thumbVersion: string;
  splitLock: SplitLock;
  keepRecommended: boolean;
  distance: number | null;
}

export interface DuplicateGroupView {
  id: string;
  kind: "exact" | "near";
  confirmed: boolean;
  keptAssetId: string | null;
  members: DuplicateMember[];
}

export interface DedupeMember {
  assetId: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  status: ReviewStatus;
  thumbVersion: string;
  displayVersion: string;
  distance: number | null;
  keepRecommended: boolean;
}

export interface DedupeGroup {
  id: string;
  kind: "exact" | "near";
  members: DedupeMember[];
}

export interface DedupeScan {
  threshold: number;
  scanned: number;
  groups: DedupeGroup[];
  recycled: number;
}

export interface MetricsBackfillResult {
  jobId: string;
  total: number;
}

export interface DedupeSummary {
  threshold: number;
  scanned: number;
  groups: number;
  duplicates: number;
  recycled: number;
}

export interface DedupeRecycled {
  assetId: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  thumbVersion: string;
  displayVersion: string;
  excludedReason: string | null;
  recycledAt: string | null;
}

export interface DedupeActionResult {
  moved: number;
  restored: number;
}

export interface OverviewBucket {
  label: string;
  count: number;
}

export interface QualityOverview {
  total: number;
  valid: number;
  excluded: number;
  approved: number;
  withCaption: number;
  sizeBuckets: OverviewBucket[];
  orientation: OverviewBucket[];
  bucketRows: OverviewBucket[];
  topTags: { tag: string; count: number }[];
  sources: OverviewBucket[];
  duplicateAssets: number;
  splitCounts: OverviewBucket[];
}

export interface ExportScope {
  mode: "all" | "approved" | "collection" | "selection";
  collectionId: string | null;
  assetIds: string[];
  restrictApproved: boolean;
}

export interface ValidationConfig {
  enabled: boolean;
  mode: "auto" | "manual";
  ratio: number;
  seed: number;
}

export interface SizePolicy {
  mode: "perAsset" | "preserve" | "fitCrop" | "fitPad";
  width: number | null;
  height: number | null;
  longestEdge: number | null;
  allowUpscale: boolean;
  background: string;
  fillTransparent: boolean;
  resample: "lanczos" | "bicubic";
}

export interface KohyaSubset {
  collectionId: string;
  name: string;
  repeats: number;
  keepTokens: number;
  shuffle: boolean;
}

export interface KohyaConfig {
  resolution: [number, number];
  enableBucket: boolean;
  bucketNoUpscale: boolean;
  bucketSteps: number;
  batchSize: number;
  shuffleCaption: boolean;
  keepTokens: number;
  subsets: KohyaSubset[];
}

export interface ExportConfig {
  target: "kohya" | "imagefolder";
  package: "folder" | "zip";
  destDir: string | null;
  name: string | null;
  scope: ExportScope;
  validation: ValidationConfig;
  naming: "index" | "original";
  imageFormat: "png" | "jpg";
  quality: number;
  captionExtension: ".txt" | ".caption";
  size: SizePolicy;
  kohya: KohyaConfig;
}

export interface ExportCounts {
  candidates: number;
  eligible: number;
  excluded: number;
  pending: number;
  approved: number;
  train: number;
  val: number;
  skipped: number;
}

export interface ExportIssue {
  level: "blocking" | "suggestion";
  code: string;
  message: string;
  assetIds: string[];
  action: string;
}

export interface PreviewFile {
  path: string;
  content: string | null;
  kind: string;
}

export interface ExportSample {
  imagePath: string;
  captionPath: string;
  caption: string;
  split: string;
  width: number;
  height: number;
}

export interface SplitSummary {
  enabled: boolean;
  mode: string;
  train: number;
  val: number;
  groups: number;
  targetRatio: number;
  actualRatio: number;
  conflicts: string[];
  note: string;
}

export interface ExportPreview {
  id: string;
  fingerprint: string;
  target: string;
  package: string;
  outputPath: string;
  counts: ExportCounts;
  issues: ExportIssue[];
  tree: string[];
  files: PreviewFile[];
  samples: ExportSample[];
  estimatedBytes: number;
  split: SplitSummary;
  config: ExportConfig;
  configHash: string;
  warnings: string[];
  adapterVersion: string;
}

export interface ExportRecordInfo {
  id: string;
  snapshotId: string;
  createdAt: string;
  target: string;
  package: string;
  outputPath: string;
  counts: Record<string, any>;
  validation: Record<string, any>;
  manifestSha256: string | null;
}

export interface JobItemError {
  itemId: string;
  path: string;
  message: string;
  code: string;
}

export interface JobInfo {
  id: string;
  kind: "import" | "export" | string;
  title: string;
  status: "queued" | "running" | "completed" | "completed_with_errors" | "failed" | "paused" | "cancelled";
  total: number;
  done: number;
  failed: number;
  progress: number;
  phase: string | null;
  error: { code: string; message: string; details?: any; itemIds?: string[] } | null;
  result: Record<string, any> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  kind: "wd14-tagger" | "caption";
  version: string;
  sizeBytes: number;
  path: string;
  device: string;
  status: "available" | "unavailable";
  license: string;
  note: string;
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  repo: string;
  files: string[];
  approxSize: string;
  installed: boolean;
  path: string;
}

export interface ModelDownloadProgress {
  modelId: string;
  file: string;
  downloaded: number;
  total: number;
  percent: number;
}

export interface ModelDownloadResult {
  modelId: string;
  path: string;
  files: string[];
  bytes: number;
}

export interface StorageStats {
  projectRoot: string;
  originalsBytes: number;
  cacheBytes: number;
  thumbBytes: number;
  displayBytes: number;
  previewBytes: number;
  stagingBytes: number;
  exportsBytes: number;
  databaseBytes: number;
  assets: number;
  cacheFiles: number;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  workerReady: boolean;
  workerPython: string;
  workerScript: string;
  workerLog: string;
  workerError: string | null;
  projectOpen: boolean;
}

export interface TranslateResult {
  translations: string[];
  provider: "baidu" | "mymemory" | "unknown" | string;
}

export interface PromptLibraryEntry {
  key: string;
  english: string;
  chinese: string;
  category: string;
}

export interface PromptUpsertRequest {
  originalKey?: string | null;
  english: string;
  chinese: string;
  category: string;
}

export interface CaptionTagState {
  order: string[];
  disabled: string[];
}

export interface TagTotalEntry {
  tag: string;
  count: number;
}

export interface TagTotalsResult {
  targetAssets: number;
  taggedAssets: number;
  tags: TagTotalEntry[];
  truncated: boolean;
}

export interface TagBulkRequest {
  /** 空数组表示作用于项目内全部图片。 */
  assetIds: string[];
  action: "add" | "remove" | "rename";
  from?: string;
  to?: string;
  tags?: string[];
}

export interface TagBulkResult {
  action: string;
  totalAssets: number;
  changedAssets: number;
  skippedAssets: number;
  historySeq: number | null;
}

export interface CachedTranslation {
  source: string;
  translated: string;
  provider: string;
}

export interface SuggestionInfo {
  revisionId: string;
  mode: CaptionMode;
  tags: string[];
  text: string;
  source: string;
  model: string;
  modelVersion: string;
  threshold: number | null;
  createdAt: string;
  status: string;
}

export interface WorkerPing {
  python: string;
  pillow: string;
  platform: string;
}

export interface ExportStartResult {
  jobId: string;
}

export interface SuggestionResult {
  assetId: string;
  revisionId: string;
  mode: CaptionMode;
  tags: string[];
  text: string;
  model: string;
  modelVersion: string;
  threshold: number;
  device: string;
  elapsedMs: number;
}

export interface TransformPreview {
  previewUrl: string;
  geometry: Geometry;
  cached: boolean;
  planHash: string;
}

export interface AssetPlanInfo {
  assetId: string;
  revision: number;
  plan: TransformPlan;
}

export interface TransformSaveResult {
  revisionId: string;
  planHash: string;
  geometry: Geometry;
  assetRevision: number;
  thumbVersion: string;
  reviewReset: boolean;
  warning: string | null;
  historySeq: number;
}

export interface CaptionSaveResult {
  revisionId: string | null;
  assetRevision: number;
  finalText: string;
  stats: { charCount: number; tagCount: number; tokenEstimate: number | null; tokenizerNote: string };
  reviewReset: boolean;
  historySeq: number | null;
  changed: boolean;
}

export interface CaptionPreviewResult {
  finalText: string;
  stats: { charCount: number; tagCount: number; tokenEstimate: number | null; tokenizerNote: string };
  charCount: number;
  tagCount: number;
}

export interface ConvertPreview {
  targetMode: CaptionMode;
  tags: string[];
  text: string;
  note: string;
}

export interface TrainingEntry {
  path: string;
  command: string;
}

export interface ProjectUpdate {
  name?: string;
  model?: string;
  triggerWord?: string;
  triggerMode?: string;
  defaultCaptionMode?: CaptionMode;
  settings?: Record<string, any>;
  recompute?: boolean;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  retryable?: boolean;
  details?: any;
  itemIds?: string[];
}
