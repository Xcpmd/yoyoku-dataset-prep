import { useState } from "react";
import { Icon } from "../../components/Icon";
import { Modal, Notice, Select, Spinner, type SelectOption } from "../../components/ui";
import { api, normalizeError } from "../../lib/api";
import type { AssetFilter, CollectionInfo, FilterExpression } from "../../lib/types";
import { emptyFilter } from "../../lib/utils";

type Group = Extract<FilterExpression, { kind: "group" }>;
type Rule = Extract<FilterExpression, { kind: "rule" }>;
type Option = [value: string, label: string];
type Field = [value: string, label: string, options: "text" | "number" | Option[]];

const yesNo: Option[] = [["yes", "是"], ["no", "否"]];
const fields: [string, Field[]][] = [
  ["标注与审核", [
    ["status", "审核状态", [["pending", "待审核"], ["approved", "已通过"], ["review", "需复核"], ["excluded", "已排除"]]],
    ["tag", "标签", "text"],
    ["caption", "标注正文", "text"],
    ["hasCaption", "有标注内容", yesNo],
    ["captionMode", "标注模式", [["tags", "标签"], ["nl", "自然语言"], ["mixed", "混合"]]],
    ["triggerDisabled", "停用触发词", yesNo],
    ["note", "备注", "text"],
    ["issueLevel", "质检级别", [["blocking", "阻断"], ["suggestion", "建议"], ["ignored", "已忽略"]]],
    ["issueRule", "质检问题", [
      ["source_missing", "原图丢失"], ["caption_empty", "标注为空"], ["output_blocked", "输出尺寸受阻"],
      ["crop_empty", "裁剪无有效像素"], ["animated", "多帧图片"], ["low_resolution", "短边偏低"],
      ["extreme_aspect", "超长比例"], ["heavy_crop", "裁剪面积较大"], ["heavy_pad", "补边面积较大"],
      ["upscale", "需要放大"], ["transparent", "透明像素"], ["icc_anomaly", "嵌入色彩异常"],
      ["unreviewed", "未人工审核"], ["trigger_missing", "触发词缺失"], ["trigger_duplicate", "触发词重复"],
      ["text_truncated", "文本偏长"], ["blur", "疑似模糊"], ["exposure", "曝光异常"],
      ["exact_duplicate", "精确重复"], ["near_duplicate", "感知近似重复"],
      ["duplicate_weight", "重复权重过高"], ["sidecar_conflict", "标注候选冲突"],
    ]],
  ]],
  ["文件与尺寸", [
    ["name", "文件名", "text"],
    ["path", "相对路径", "text"],
    ["extension", "扩展名", "text"],
    ["fileSize", "文件大小（MiB）", "number"],
    ["orientation", "方向", [["portrait", "竖图"], ["landscape", "横图"], ["square", "方图"]]],
    ["width", "原图宽度（px）", "number"],
    ["height", "原图高度（px）", "number"],
    ["shortEdge", "原图短边（px）", "number"],
    ["longEdge", "原图长边（px）", "number"],
    ["ratio", "原图宽高比", "number"],
    ["outWidth", "输出宽度（px）", "number"],
    ["outHeight", "输出高度（px）", "number"],
    ["alpha", "带透明通道", yesNo],
    ["missing", "原图丢失", yesNo],
  ]],
  ["整理与裁剪", [
    ["favorite", "已收藏", yesNo],
    ["duplicate", "属于重复组", yesNo],
    ["draft", "有裁剪草稿", yesNo],
    ["cropped", "已应用图像处理", yesNo],
    ["split", "用途", [["train", "训练"], ["val", "验证"], ["unassigned", "未分配"]]],
    ["collection", "手动集合", []],
  ]],
];

const definitions = Object.fromEntries(fields.flatMap(([, entries]) => entries).map((item) => [item[0], item]));
const textOperators: Option[] = [["contains", "包含"], ["is", "等于"], ["regex", "匹配正则"]];
const numberOperators: Option[] = [["gte", "≥"], ["lte", "≤"], ["is", "="], ["gt", ">"], ["lt", "<"]];
const fieldGroups = fields.map(([label, entries]) => ({
  label,
  options: entries.map(([value, label]) => ({ value, label })),
}));
const scopeOptions = [{ value: "library", label: "图库" }, { value: "recycled", label: "回收区" }];
const matchOptions = [{ value: "all", label: "全部满足（AND）" }, { value: "any", label: "任一满足（OR）" }];

function selectOptions(options: Option[]): SelectOption[] {
  return options.map(([value, label]) => ({ value, label }));
}

function rule(field: string, value: string, operator = "is"): Rule {
  return { kind: "rule", field, operator, value, negated: false };
}

function group(children: FilterExpression[] = [], mode: Group["mode"] = "all"): Group {
  return { kind: "group", mode, negated: false, children };
}

function toGroup(filter: AssetFilter): Group {
  const children: FilterExpression[] = [];
  const addChoices = (field: string, values: string[], mode: Group["mode"] = "any") => {
    const rules = values.map((value) => rule(field, value));
    if (rules.length === 1) children.push(rules[0]);
    if (rules.length > 1) children.push(group(rules, mode));
  };
  addChoices("status", filter.statuses);
  addChoices("orientation", filter.orientations);
  addChoices("collection", filter.collectionIds);
  addChoices("issueRule", filter.issueRules);
  addChoices("issueLevel", filter.issueLevels, "all");
  if (filter.split) children.push(rule("split", filter.split));
  if (filter.favoriteOnly) children.push(rule("favorite", "yes"));
  if (filter.duplicateOnly) children.push(rule("duplicate", "yes"));
  if (filter.hasDraft) children.push(rule("draft", "yes"));
  if (filter.minShortEdge != null) children.push(rule("shortEdge", String(filter.minShortEdge), "gte"));
  if (filter.maxShortEdge != null) children.push(rule("shortEdge", String(filter.maxShortEdge), "lte"));
  const expression = filter.expression;
  if (!expression) return group(children);
  if (children.length === 0 && expression.kind === "group") return expression;
  if (expression.kind === "group" && expression.mode === "all" && !expression.negated) {
    return group([...children, ...expression.children]);
  }
  return group([...children, expression]);
}

export function FilterDialog({ filter, collections, onClose, onApply, onSave }: {
  filter: AssetFilter;
  collections: CollectionInfo[];
  onClose: () => void;
  onApply: (filter: AssetFilter) => void;
  onSave: (filter: AssetFilter) => void;
}) {
  const [root, setRoot] = useState(() => toGroup(filter));
  const [recycled, setRecycled] = useState(filter.recycledOnly);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (next: FilterExpression) => {
    if (next.kind === "group") setRoot(next);
    setError("");
  };
  const submit = async (action: (filter: AssetFilter) => void) => {
    const next: AssetFilter = {
      ...emptyFilter(),
      expression: root.children.length ? root : null,
      recycledOnly: recycled,
      query: filter.query,
      regexSearch: filter.regexSearch,
      searchTarget: filter.searchTarget,
      searchCaseSensitive: filter.searchCaseSensitive,
    };
    setBusy(true);
    setError("");
    try {
      await api.validateAssetFilter(next);
      action(next);
    } catch (error) {
      setError(normalizeError(error).message);
    } finally {
      setBusy(false);
    }
  };
  const collectionOptions: Option[] = collections.filter((item) => item.kind !== "query").map((item) => [item.id, item.name]);

  return (
    <Modal
      open
      title="筛选图片"
      width="wide"
      onClose={() => !busy && onClose()}
      initialFocus="#gallery-filter-scope"
      footer={
        <>
          <button type="button" className="btn subtle" disabled={busy} onClick={() => void submit(onSave)}>存为智能集合</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit(onApply)}>
            {busy ? <Spinner /> : null}应用筛选
          </button>
        </>
      }
    >
      <fieldset className="gallery-filter-form" disabled={busy}>
        <div className="row-wrap gallery-filter-scope">
          <div className="row-wrap small">
            <label htmlFor="gallery-filter-scope">图片范围</label>
            <Select id="gallery-filter-scope" ariaLabel="图片范围" options={scopeOptions}
              value={recycled ? "recycled" : "library"} onChange={(value) => setRecycled(value === "recycled")} />
          </div>
          <button type="button" className="btn ghost sm" onClick={() => { setRoot(group()); setRecycled(false); setError(""); }}>
            重置条件
          </button>
        </div>
        <FilterNode node={root} onChange={update} depth={1} collectionOptions={collectionOptions} />
        {error ? <Notice tone="danger"><span className="gallery-pattern-error">{error}</span></Notice> : null}
      </fieldset>
    </Modal>
  );
}

function FilterNode({ node, onChange, onRemove, depth, collectionOptions }: {
  node: FilterExpression;
  onChange: (node: FilterExpression) => void;
  onRemove?: () => void;
  depth: number;
  collectionOptions: Option[];
}) {
  const negate = (
    <label className="gallery-filter-negate" title="反转匹配结果">
      <input type="checkbox" checked={node.negated} onChange={(event) => onChange({ ...node, negated: event.target.checked })} />
      取反
    </label>
  );
  const remove = onRemove ? (
    <button type="button" className="btn icon ghost sm" aria-label={node.kind === "group" ? "删除条件组" : "删除条件"} onClick={onRemove}>
      <Icon name="x" className="sm" />
    </button>
  ) : null;

  if (node.kind === "group") {
    return (
      <div className="gallery-filter-group">
        <div className="row-wrap gallery-filter-group-head">
          <Select ariaLabel="组内匹配方式" options={matchOptions}
            value={node.mode} onChange={(value) => onChange({ ...node, mode: value === "any" ? "any" : "all" })} />
          {negate}
          {remove}
        </div>
        {node.children.map((child, index) => (
          <FilterNode
            key={index}
            node={child}
            depth={depth + 1}
            collectionOptions={collectionOptions}
            onChange={(next) => onChange({ ...node, children: node.children.map((item, position) => position === index ? next : item) })}
            onRemove={() => onChange({ ...node, children: node.children.filter((_, position) => position !== index) })}
          />
        ))}
        <div className="row-wrap">
          <button type="button" className="btn subtle sm" disabled={depth >= 12} onClick={() => onChange({ ...node, children: [...node.children, rule("status", "pending")] })}>
            <Icon name="plus" className="sm" /> 条件
          </button>
          <button type="button" className="btn ghost sm" disabled={depth >= 11} onClick={() => onChange({ ...node, children: [...node.children, group([rule("status", "pending")])] })}>
            <Icon name="plus" className="sm" /> 条件组
          </button>
        </div>
      </div>
    );
  }

  const definition = definitions[node.field];
  const options = node.field === "collection" ? collectionOptions : definition?.[2] ?? [];
  const operators = options === "text" ? textOperators : options === "number" ? numberOperators : null;
  const selectValues = typeof options === "string" ? [] : selectOptions(options);
  if (typeof options !== "string" && node.value && !selectValues.some((option) => option.value === node.value)) {
    selectValues.unshift({ value: node.value, label: node.field === "collection" ? "已删除的集合" : node.value });
  }
  return (
    <div className="gallery-filter-rule">
      <Select
        ariaLabel="筛选字段"
        value={node.field}
        groups={fieldGroups}
        options={definition ? undefined : [{ value: node.field, label: node.field, disabled: true }]}
        onChange={(field) => {
          const choices = field === "collection" ? collectionOptions : definitions[field][2];
          const operator = choices === "number" ? "gte" : choices === "text" ? "contains" : "is";
          onChange({ ...node, field, operator, value: typeof choices === "string" ? "" : choices[0]?.[0] ?? "" });
        }}
      />
      {operators ? (
        <Select ariaLabel="比较方式" value={node.operator} options={selectOptions(operators)}
          onChange={(operator) => onChange({ ...node, operator })} />
      ) : null}
      {typeof options === "string" ? (
        <input
          className="input gallery-filter-value"
          aria-label="条件值"
          type={options === "number" ? "number" : "text"}
          min={0}
          step="any"
          value={node.value}
          placeholder={node.operator === "regex" ? "^示例" : node.field === "extension" ? "png" : undefined}
          onChange={(event) => onChange({ ...node, value: event.target.value })}
        />
      ) : (
        <Select className="gallery-filter-value" ariaLabel="条件值" value={node.value}
          options={selectValues} placeholder={selectValues.length ? "请选择" : "暂无可选项"}
          disabled={!selectValues.length} onChange={(value) => onChange({ ...node, value })} />
      )}
      {negate}
      {remove}
    </div>
  );
}
