use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// 应用与项目
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub theme: String,
    pub density: String,
    pub reduce_transparency: bool,
    pub reduce_motion: bool,
    pub smooth_zoom: bool,
    pub high_contrast: bool,
    pub large_text: bool,
    pub grid_card_min: u32,
    pub inspector_width: u32,
    pub python_path: Option<String>,
    pub models_dir: Option<String>,
    pub baidu_translate_app_id: Option<String>,
    pub baidu_translate_key: Option<String>,
    pub image_slots: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            density: "comfortable".into(),
            reduce_transparency: false,
            reduce_motion: false,
            smooth_zoom: true,
            high_contrast: false,
            large_text: false,
            grid_card_min: 168,
            inspector_width: 336,
            python_path: None,
            models_dir: None,
            baidu_translate_app_id: None,
            baidu_translate_key: None,
            image_slots: 4,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub name: String,
    pub model: String,
    pub path: String,
    pub image_count: i64,
    pub last_opened: String,
    pub pinned: bool,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RecentStore {
    pub projects: Vec<RecentProject>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectCounts {
    pub total: i64,
    pub valid: i64,
    pub pending: i64,
    pub approved: i64,
    pub review: i64,
    pub excluded: i64,
    pub train: i64,
    pub val: i64,
    pub collections: i64,
    pub orphan_captions: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub model: String,
    pub template: String,
    pub trigger_word: String,
    pub trigger_mode: String,
    pub default_caption_mode: String,
    pub settings: serde_json::Value,
    pub root: String,
    pub created_at: String,
    pub updated_at: String,
    pub schema_version: u32,
    pub counts: ProjectCounts,
    pub quality_stale: bool,
    pub quality_scanned_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub id: String,
    pub name: String,
    pub model: String,
    pub path: String,
    pub image_count: i64,
    pub last_opened: String,
    pub pinned: bool,
    pub missing: bool,
}

// ---------------------------------------------------------------------------
// 变换计划
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Default for CropRect {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorAdjust {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
}

impl Default for ColorAdjust {
    fn default() -> Self {
        Self { brightness: 1.0, contrast: 1.0, saturation: 1.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TransformPlan {
    pub version: u32,
    pub rotation: i32,
    pub flip_h: bool,
    pub flip_v: bool,
    pub crop: CropRect,
    pub scale_mode: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub longest_edge: Option<u32>,
    pub allow_upscale: bool,
    pub resample: String,
    pub background: String,
    /// 导出/渲染时是否把透明像素填充为白色。关闭后 PNG 保留透明通道。
    pub fill_transparent: bool,
    pub color: ColorAdjust,
    pub format: String,
    pub quality: u32,
}

impl Default for TransformPlan {
    fn default() -> Self {
        Self {
            version: 1,
            rotation: 0,
            flip_h: false,
            flip_v: false,
            crop: CropRect::default(),
            scale_mode: "preserve".into(),
            width: None,
            height: None,
            longest_edge: None,
            allow_upscale: false,
            resample: "lanczos".into(),
            background: "#ffffff".into(),
            fill_transparent: true,
            color: ColorAdjust::default(),
            format: "png".into(),
            quality: 95,
        }
    }
}

impl TransformPlan {
    pub fn sanitized(mut self) -> Self {
        if !matches!(self.rotation, 0 | 90 | 180 | 270) {
            self.rotation = 0;
        }
        if !matches!(self.scale_mode.as_str(), "preserve" | "fitCrop" | "fitPad") {
            self.scale_mode = "preserve".into();
        }
        if !matches!(self.resample.as_str(), "lanczos" | "bicubic") {
            self.resample = "lanczos".into();
        }
        if !matches!(self.format.as_str(), "png" | "jpg") {
            self.format = "png".into();
        }
        if self.quality < 1 || self.quality > 100 {
            self.quality = 95;
        }
        let c = &mut self.crop;
        c.w = c.w.clamp(0.001, 1.0);
        c.h = c.h.clamp(0.001, 1.0);
        c.x = c.x.clamp(0.0, 1.0 - c.w);
        c.y = c.y.clamp(0.0, 1.0 - c.h);
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub out_width: u32,
    pub out_height: u32,
    pub crop_width: u32,
    pub crop_height: u32,
    pub scaled_width: u32,
    pub scaled_height: u32,
    pub crop_ratio: f64,
    pub pad_ratio: f64,
    pub scale_ratio: f64,
    pub blocked: bool,
    pub blocked_reason: Option<String>,
}

// ---------------------------------------------------------------------------
// 资产与标注
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AssetFilter {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_target: Option<String>,
    pub search_case_sensitive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regex_search: Option<RegexSearch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression: Option<FilterExpression>,
    pub statuses: Vec<String>,
    pub orientations: Vec<String>,
    pub collection_ids: Vec<String>,
    pub issue_rules: Vec<String>,
    pub issue_levels: Vec<String>,
    pub split: Option<String>,
    pub duplicate_only: bool,
    pub favorite_only: bool,
    pub min_short_edge: Option<u32>,
    pub max_short_edge: Option<u32>,
    pub has_draft: bool,
    /// 只看去重回收区；默认视图会隐藏回收区图片。
    pub recycled_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegexSearch {
    pub pattern: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FilterExpression {
    Group { mode: FilterMode, negated: bool, children: Vec<FilterExpression> },
    Rule { field: String, operator: String, value: String, negated: bool },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterMode {
    All,
    Any,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssetSort {
    pub field: String,
    pub direction: String,
}

impl Default for AssetSort {
    fn default() -> Self {
        Self { field: "import".into(), direction: "asc".into() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSummary {
    pub id: String,
    pub name: String,
    pub ext: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub out_width: u32,
    pub out_height: u32,
    pub bytes: i64,
    pub status: String,
    pub favorite: bool,
    pub caption_mode: String,
    pub caption_preview: String,
    pub caption_text: String,
    pub tags: Vec<String>,
    pub issue_blocking: i64,
    pub issue_suggestion: i64,
    pub duplicate_group_id: Option<String>,
    pub split_lock: Option<String>,
    pub thumb_version: String,
    pub display_version: String,
    pub has_draft: bool,
    pub imported_at: String,
    pub last_human_at: Option<String>,
    pub sort_index: i64,
    pub revision: i64,
    pub has_caption: bool,
    pub crop_ratio: f64,
    pub pad_ratio: f64,
    pub scale_ratio: f64,
    pub source_label: String,
    pub note: String,
    pub missing: bool,
    pub trigger_disabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsPage {
    pub items: Vec<AssetSummary>,
    pub total: i64,
    pub next_offset: Option<i64>,
    /// 稳定游标：下一页从该资产之后开始；排序键变化或该资产消失时前端回退到偏移分页。
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueInfo {
    pub id: String,
    pub asset_id: String,
    pub rule: String,
    pub level: String,
    pub message: String,
    pub evidence: serde_json::Value,
    pub ignored: bool,
    pub ignore_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionData {
    pub revision_id: Option<String>,
    pub mode: String,
    pub tags: Vec<String>,
    pub text: String,
    pub final_text: String,
    pub source: String,
    pub created_at: Option<String>,
    pub char_count: usize,
    pub tag_count: usize,
    pub token_estimate: Option<usize>,
    pub tokenizer_note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformData {
    pub revision_id: Option<String>,
    pub plan: TransformPlan,
    pub draft: Option<TransformPlan>,
    pub draft_revision_id: Option<String>,
    pub created_at: Option<String>,
    pub plan_hash: Option<String>,
    pub source_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDetail {
    pub summary: AssetSummary,
    pub sha256: String,
    pub orig_width: u32,
    pub orig_height: u32,
    pub norm_width: u32,
    pub norm_height: u32,
    pub has_alpha: bool,
    pub phash: Option<String>,
    pub blur_score: Option<f64>,
    pub dark_ratio: Option<f64>,
    pub bright_ratio: Option<f64>,
    pub source_root: Option<String>,
    pub rel_path: String,
    pub source_path: String,
    pub source_size: Option<i64>,
    pub missing: bool,
    pub excluded_reason: Option<String>,
    pub review_note: Option<String>,
    pub issues: Vec<IssueInfo>,
    pub transform: TransformData,
    pub caption: CaptionData,
    pub collections: Vec<CollectionInfo>,
    pub history: Vec<HistoryEntry>,
    pub imported_at: String,
    pub filesize: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AssetPatch {
    pub status: Option<String>,
    pub favorite: Option<bool>,
    pub split_lock: Option<String>,
    pub note: Option<String>,
    pub excluded_reason: Option<String>,
    pub trigger_disabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BatchOp {
    AddTags { tags: Vec<String> },
    ExtractTags { pattern: String, syntax: ExtractSyntax, templates: Vec<String> },
    RegexRemoveTags { pattern: String },
    RegexReplaceTags { pattern: String, replacement: String },
    RemoveTags { tags: Vec<String> },
    ReplaceTag { from: String, to: String },
    MoveToFront { tag: String },
    CopyCaption { source: String },
    Lowercase,
    Underscores,
    CleanShort { #[serde(rename = "maxLen")] max_len: usize },
    SetStatus { status: String, reason: Option<String> },
    SetSplit { split: Option<String> },
    AddToCollection { collection: String },
    RemoveFromCollection { collection: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtractSyntax {
    Template,
    Regex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequest {
    pub asset_ids: Vec<String>,
    pub filter: Option<AssetFilter>,
    pub op: BatchOp,
    #[serde(default)]
    pub exclude_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSkip {
    pub asset_id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDiff {
    pub asset_id: String,
    pub name: String,
    pub before: String,
    pub after: String,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_changes: Option<BatchTagChanges>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTagChanges {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPreview {
    pub preview_id: String,
    pub count: i64,
    pub skipped: Vec<BatchSkip>,
    pub skipped_count: usize,
    pub diffs: Vec<BatchDiff>,
    pub summary: String,
    pub warnings: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub applied: i64,
    pub skipped: i64,
    pub history_seq: i64,
    pub label: String,
}

// ---------------------------------------------------------------------------
// 集合与历史
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub count: i64,
    pub created_at: String,
    pub query: Option<AssetFilter>,
    pub sort: Option<AssetSort>,
    pub target_width: Option<i64>,
    pub target_height: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub seq: i64,
    pub label: String,
    pub command_type: String,
    pub created_at: String,
    pub undone: bool,
    pub target_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// 质检
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityRuleSummary {
    pub rule: String,
    pub title: String,
    pub level: String,
    pub description: String,
    pub count: i64,
    pub ignored: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualitySummary {
    pub scanned_at: Option<String>,
    pub stale: bool,
    pub config_hash: String,
    pub blocking: i64,
    pub suggestions: i64,
    pub ignored_total: i64,
    pub rules: Vec<QualityRuleSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRow {
    pub id: String,
    pub asset_id: String,
    pub asset_name: String,
    pub asset_status: String,
    pub thumb_version: String,
    pub message: String,
    pub evidence: serde_json::Value,
    pub ignored: bool,
    pub ignore_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityIssues {
    pub rule: String,
    pub title: String,
    pub level: String,
    pub description: String,
    pub rows: Vec<IssueRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateMember {
    pub asset_id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub bytes: i64,
    pub status: String,
    pub format: String,
    pub caption_preview: String,
    pub source_label: String,
    pub thumb_version: String,
    pub split_lock: Option<String>,
    pub keep_recommended: bool,
    pub distance: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroupView {
    pub id: String,
    pub kind: String,
    pub confirmed: bool,
    pub kept_asset_id: Option<String>,
    pub members: Vec<DuplicateMember>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewBucket {
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewTag {
    pub tag: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityOverview {
    pub total: i64,
    pub valid: i64,
    pub excluded: i64,
    pub approved: i64,
    pub with_caption: i64,
    pub size_buckets: Vec<OverviewBucket>,
    pub orientation: Vec<OverviewBucket>,
    pub bucket_rows: Vec<OverviewBucket>,
    pub top_tags: Vec<OverviewTag>,
    pub sources: Vec<OverviewBucket>,
    pub duplicate_assets: i64,
    pub split_counts: Vec<OverviewBucket>,
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanRequest {
    pub paths: Vec<String>,
    pub recursive: bool,
    pub mode: String,
    pub sidecar_priority: String,
    pub duplicate_policy: String,
    pub caption_conflict_policy: String,
    #[serde(default)]
    pub collection_id: Option<String>,
}

impl Default for ScanRequest {
    fn default() -> Self {
        Self {
            paths: Vec::new(),
            recursive: true,
            mode: "copy".into(),
            sidecar_priority: "txt".into(),
            duplicate_policy: "skip".into(),
            caption_conflict_policy: "keep-external".into(),
            collection_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    pub path: String,
    pub root: String,
    pub rel_path: String,
    pub name: String,
    pub ext: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub bytes: i64,
    pub sidecar_path: Option<String>,
    pub sidecar_kind: Option<String>,
    pub sidecar_text: Option<String>,
    pub sidecar_conflicts: Vec<String>,
    pub status: String,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanSummary {
    pub candidates: i64,
    pub with_sidecar: i64,
    pub conflicts: i64,
    pub unsupported: i64,
    pub errors: i64,
    pub oversized: i64,
    pub animated: i64,
    pub isolated_sidecars: i64,
    pub truncated: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSkip {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPreview {
    pub id: String,
    pub roots: Vec<String>,
    pub entries: Vec<ScanEntry>,
    pub summary: ScanSummary,
    pub skipped: Vec<ScanSkip>,
    pub options: ScanRequest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub job_id: String,
    pub total: i64,
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportScope {
    pub mode: String,
    pub collection_id: Option<String>,
    pub asset_ids: Vec<String>,
    pub restrict_approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ValidationConfig {
    pub enabled: bool,
    pub mode: String,
    pub ratio: f64,
    pub seed: u64,
}

impl Default for ValidationConfig {
    fn default() -> Self {
        Self { enabled: false, mode: "auto".into(), ratio: 0.1, seed: 42 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SizePolicy {
    pub mode: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub longest_edge: Option<u32>,
    pub allow_upscale: bool,
    pub background: String,
    pub fill_transparent: bool,
    pub resample: String,
}

impl Default for SizePolicy {
    fn default() -> Self {
        Self {
            mode: "perAsset".into(),
            width: None,
            height: None,
            longest_edge: None,
            allow_upscale: false,
            background: "#ffffff".into(),
            fill_transparent: true,
            resample: "lanczos".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KohyaSubset {
    pub collection_id: String,
    pub name: String,
    pub repeats: u32,
    pub keep_tokens: u32,
    pub shuffle: bool,
}

impl Default for KohyaSubset {
    fn default() -> Self {
        Self {
            collection_id: String::new(),
            name: String::new(),
            repeats: 1,
            keep_tokens: 0,
            shuffle: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KohyaConfig {
    pub resolution: [u32; 2],
    pub enable_bucket: bool,
    pub bucket_no_upscale: bool,
    pub bucket_steps: u32,
    pub batch_size: u32,
    pub shuffle_caption: bool,
    pub keep_tokens: u32,
    pub subsets: Vec<KohyaSubset>,
}

impl Default for KohyaConfig {
    fn default() -> Self {
        Self {
            resolution: [1024, 1024],
            enable_bucket: true,
            bucket_no_upscale: true,
            bucket_steps: 64,
            batch_size: 1,
            shuffle_caption: false,
            keep_tokens: 0,
            subsets: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoraScriptConfig {
    /// 分组（集合）ID -> 单图训练次数。
    pub repeats: HashMap<String, u32>,
    /// 不属于任何分组的图片使用的单图训练次数。
    pub ungrouped_repeats: u32,
}

impl Default for LoraScriptConfig {
    fn default() -> Self {
        Self {
            repeats: HashMap::new(),
            ungrouped_repeats: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportConfig {
    pub target: String,
    pub package: String,
    pub dest_dir: Option<String>,
    pub name: Option<String>,
    pub scope: ExportScope,
    pub validation: ValidationConfig,
    pub naming: String,
    pub image_format: String,
    pub quality: u32,
    pub caption_extension: String,
    pub size: SizePolicy,
    pub kohya: KohyaConfig,
    pub lora_script: LoraScriptConfig,
}

impl Default for ExportConfig {
    fn default() -> Self {
        Self {
            target: "kohya".into(),
            package: "folder".into(),
            dest_dir: None,
            name: None,
            scope: ExportScope { mode: "all".into(), collection_id: None, asset_ids: Vec::new(), restrict_approved: false },
            validation: ValidationConfig::default(),
            naming: "index".into(),
            image_format: "png".into(),
            quality: 95,
            caption_extension: ".txt".into(),
            size: SizePolicy::default(),
            kohya: KohyaConfig::default(),
            lora_script: LoraScriptConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCounts {
    pub candidates: i64,
    pub eligible: i64,
    pub excluded: i64,
    pub pending: i64,
    pub approved: i64,
    pub train: i64,
    pub val: i64,
    pub skipped: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportIssue {
    pub level: String,
    pub code: String,
    pub message: String,
    pub asset_ids: Vec<String>,
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    pub path: String,
    pub content: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSample {
    pub image_path: String,
    pub caption_path: String,
    pub caption: String,
    pub split: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitSummary {
    pub enabled: bool,
    pub mode: String,
    pub train: i64,
    pub val: i64,
    pub groups: i64,
    pub target_ratio: f64,
    pub actual_ratio: f64,
    pub conflicts: Vec<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    pub id: String,
    pub fingerprint: String,
    pub target: String,
    pub package: String,
    pub output_path: String,
    pub counts: ExportCounts,
    pub issues: Vec<ExportIssue>,
    pub tree: Vec<String>,
    pub files: Vec<PreviewFile>,
    pub samples: Vec<ExportSample>,
    pub estimated_bytes: u64,
    pub split: SplitSummary,
    pub config: ExportConfig,
    pub config_hash: String,
    pub warnings: Vec<String>,
    pub adapter_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStartResult {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRecordInfo {
    pub id: String,
    pub snapshot_id: String,
    pub created_at: String,
    pub target: String,
    pub package: String,
    pub output_path: String,
    pub counts: serde_json::Value,
    pub validation: serde_json::Value,
    pub manifest_sha256: Option<String>,
}

// ---------------------------------------------------------------------------
// 任务、模型、存储
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub total: i64,
    pub done: i64,
    pub failed: i64,
    pub progress: f64,
    pub phase: Option<String>,
    pub error: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip)]
    pub input: serde_json::Value,
    #[serde(skip)]
    pub checkpoint: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobItemError {
    pub item_id: String,
    pub path: String,
    pub message: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub version: String,
    pub size_bytes: u64,
    pub path: String,
    pub device: String,
    pub status: String,
    pub license: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntry {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub files: Vec<String>,
    pub approx_size: String,
    pub installed: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadProgress {
    pub model_id: String,
    pub file: String,
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadResult {
    pub model_id: String,
    pub path: String,
    pub files: Vec<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub project_root: String,
    pub originals_bytes: u64,
    pub cache_bytes: u64,
    pub thumb_bytes: u64,
    pub display_bytes: u64,
    pub preview_bytes: u64,
    pub staging_bytes: u64,
    pub exports_bytes: u64,
    pub database_bytes: u64,
    pub assets: i64,
    pub cache_files: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub worker_ready: bool,
    pub worker_python: String,
    pub worker_script: String,
    pub worker_log: String,
    pub worker_error: Option<String>,
    pub project_open: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerPing {
    pub python: String,
    pub pillow: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionResult {
    pub asset_id: String,
    pub revision_id: String,
    pub mode: String,
    pub tags: Vec<String>,
    pub text: String,
    pub vision_language: bool,
    pub model: String,
    pub model_version: String,
    pub threshold: f64,
    pub device: String,
    pub elapsed_ms: u64,
}
