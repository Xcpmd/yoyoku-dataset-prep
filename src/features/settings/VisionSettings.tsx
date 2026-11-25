import { useEffect, useState } from "react";
import { Badge, Field, Notice, Select, Spinner } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { api, normalizeError } from "../../lib/api";
import type { VisionConfiguration, VisionConnection, VisionDepth, VisionModel, VisionParameters, VisionPreferences } from "../../lib/types";

const NEW_CONNECTION: VisionConnection = {
  id: "", name: "本机 Ollama", protocol: "ollama",
  baseUrl: "http://127.0.0.1:11434", parameters: {}, hasKey: false, verifiedModels: [],
};
const PROTOCOLS = [{ value: "ollama", label: "Ollama" }, { value: "openAi", label: "OpenAI 兼容接口" }];
const DEPTHS: { value: VisionDepth; label: string }[] = [
  { value: "simple", label: "简略" },
  { value: "detailed", label: "详细" },
  { value: "exhaustive", label: "极其详细" },
];
const OUTPUTS = [
  { value: "tags", label: "短语标签" },
  { value: "caption", label: "自然语言" },
  { value: "both", label: "两者" },
];
type NumericParameter = keyof Omit<VisionParameters, "think" | "reasoningEffort" | "tokenLimitField">;
const NUMBERS: [NumericParameter, string, number | undefined, number | undefined, number][] = [
  ["temperature", "温度", 0, 2, 0.05], ["topP", "Top P", 0, 1, 0.05],
  ["topK", "Top K", 0, 4096, 1], ["presencePenalty", "存在惩罚", -2, 2, 0.05],
  ["frequencyPenalty", "频率惩罚", -2, 2, 0.05], ["maxTokens", "最大输出 Token", 64, 32768, 1],
  ["contextSize", "上下文长度", 1024, 262144, 1], ["seed", "随机种子", undefined, undefined, 1],
];
const EFFORTS = ["", "none", "minimal", "low", "medium", "high", "xhigh"].map((value) => ({
  value, label: value || "服务默认",
}));
const TOKEN_LIMIT_FIELDS = [
  { value: "max_tokens", label: "max_tokens" },
  { value: "max_completion_tokens", label: "max_completion_tokens" },
];

export function VisionSettings({ active }: { active: boolean }) {
  const [configuration, setConfiguration] = useState<VisionConfiguration | null>(null);
  const [preferences, setPreferences] = useState<VisionPreferences | null>(null);
  const [connection, setConnection] = useState(NEW_CONNECTION);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [discoveredModels, setModels] = useState<VisionModel[]>([]);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState<{ message: string; error?: boolean } | null>(null);
  const [sample, setSample] = useState<{ tags: string[]; caption: string } | null>(null);

  useEffect(() => {
    if (!active || configuration) return;
    let cancelled = false;
    void api.visionConfiguration().then((data) => {
      if (cancelled) return;
      setConfiguration(data);
      setPreferences(data.preferences);
      const first = data.connections[0] ?? NEW_CONNECTION;
      setConnection(first);
      setModel(first.verifiedModels[0]?.name ?? "");
    }).catch((error) => {
      if (!cancelled) setFeedback({ message: normalizeError(error).message, error: true });
    });
    return () => { cancelled = true; };
  }, [active, configuration]);

  const changeConnection = (next: VisionConnection) => {
    setConnection(next);
    setKey("");
    setClearKey(false);
    setModels([]);
    setModel(next.verifiedModels[0]?.name ?? "");
    setSample(null);
    setFeedback(null);
  };

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setFeedback(null);
    setSample(null);
    try {
      await action();
    } catch (error) {
      setFeedback({ message: normalizeError(error).message, error: true });
    } finally {
      setBusy("");
    }
  };

  const saveConnection = async () => {
    const saved = await api.visionSaveConnection(connection, clearKey ? "" : key.trim() || undefined);
    setConnection(saved);
    setKey("");
    setClearKey(false);
    setConfiguration((current) => {
      if (!current) return current;
      const connections = current.connections.some((entry) => entry.id === saved.id)
        ? current.connections.map((entry) => entry.id === saved.id ? saved : entry)
        : [...current.connections, saved];
      return { ...current, connections };
    });
    return saved;
  };

  const discover = () => run("正在读取模型…", async () => {
    const saved = await saveConnection();
    setModels([]);
    const result = await api.visionDiscover(saved.id);
    setModels(result);
    updateVerifiedModels(saved.id, result.filter((item) => item.vision === true));
    setModel((current) => result.some((item) => item.name === current)
      ? current : result.find((item) => item.vision === true)?.name ?? "");
    setFeedback({ message: result.length ? `找到 ${result.length} 个模型` : "服务返回了空模型列表，可直接填写模型 ID 试测。" });
  });

  const persistPreferences = async () => {
    if (!preferences) return;
    await api.visionSavePreferences(preferences);
    setConfiguration((current) => current ? { ...current, preferences } : current);
  };

  const updateVerifiedModels = (id: string, verifiedModels: VisionConnection["verifiedModels"]) => {
    setConnection((current) => current.id === id ? { ...current, verifiedModels } : current);
    setConfiguration((current) => current ? {
      ...current,
      connections: current.connections.map((item) => item.id === id ? { ...item, verifiedModels } : item),
    } : current);
  };

  const ollama = connection.protocol === "ollama";
  const savedConnection = configuration?.connections.find((entry) => entry.id === connection.id);
  const sameAddress = savedConnection?.baseUrl === connection.baseUrl && savedConnection?.protocol === connection.protocol;
  const models = [
    ...discoveredModels,
    ...(sameAddress ? connection.verifiedModels : [])
      .filter((item) => !discoveredModels.some((found) => found.name === item.name))
      .map((item) => ({ ...item, vision: true, note: null })),
  ];
  const knownModel = models.find((item) => item.name === model.trim());
  const parameters = connection.parameters;
  const disabled = !!busy || !configuration;
  const updateParameters = (patch: Partial<VisionParameters>) => setConnection((current) => ({
    ...current, parameters: { ...current.parameters, ...patch },
  }));

  return (
    <section className="settings-card full vision-settings">
      <h3><Icon name="sparkles" />视觉模型打标</h3>
      <fieldset className="vision-settings-form" disabled={disabled}>
        <div className="vision-settings-columns">
          <div className="vision-settings-panel">
            <div className="row-wrap vision-settings-row">
              <h4>AI 服务</h4>
              <div className="spacer" />
              <button type="button" className="btn subtle sm" onClick={() => changeConnection(NEW_CONNECTION)}>
                <Icon name="plus" className="sm" /> 添加服务
              </button>
            </div>
            {configuration?.connections.length ? (
              <Select ariaLabel="已保存的服务" value={connection.id} placeholder="新服务"
                options={configuration.connections.map((item) => ({ value: item.id, label: item.name }))}
                onChange={(id) => {
                  const selected = configuration.connections.find((item) => item.id === id);
                  if (selected) changeConnection(selected);
                }} />
            ) : null}
            <div className="vision-fields">
              <Field label="服务名称">
                <input className="input" aria-label="服务名称" value={connection.name}
                  onChange={(event) => setConnection({ ...connection, name: event.target.value })} />
              </Field>
              <Field label="接口类型">
                <Select ariaLabel="接口类型" options={PROTOCOLS} value={connection.protocol} onChange={(value) => {
                  const protocol = value === "ollama" ? "ollama" : "openAi";
                  setKey("");
                  setClearKey(false);
                  setModels([]);
                  setModel("");
                  setSample(null);
                  setConnection({ ...connection, protocol, baseUrl: protocol === "ollama" ? NEW_CONNECTION.baseUrl : "", parameters: {} });
                }} />
              </Field>
            </div>
            <Field label="服务地址">
              <input className="input mono" aria-label="服务地址" value={connection.baseUrl}
                spellCheck={false} placeholder={ollama ? NEW_CONNECTION.baseUrl : "https://example.com/v1"}
                onChange={(event) => {
                  setKey("");
                  setClearKey(false);
                  setModels([]);
                  setModel("");
                  setSample(null);
                  setConnection({ ...connection, baseUrl: event.target.value });
                }} />
            </Field>
            <Field label="API 密钥">
              <input className="input" type="password" aria-label="API 密钥" autoComplete="off" value={key}
                placeholder={connection.hasKey && sameAddress && !clearKey ? "已保存，留空沿用" : "按服务要求填写"}
                onChange={(event) => { setKey(event.target.value); setClearKey(false); }} />
            </Field>
            {connection.hasKey && sameAddress ? (
              <label className="row small muted"><input type="checkbox" checked={clearKey}
                onChange={(event) => { setClearKey(event.target.checked); if (event.target.checked) setKey(""); }} />保存时清除密钥</label>
            ) : null}
            <details className="vision-advanced">
              <summary>推理参数</summary>
              <div className="vision-fields">
                {NUMBERS.filter(([name]) => ollama || name !== "contextSize").map(([name, label, min, max, step]) => (
                  <Field label={label} key={name}>
                    <input className="input" type="number" aria-label={label} min={min} max={max} step={step}
                      placeholder="自动" value={parameters[name] ?? ""}
                      onChange={(event) => updateParameters({ [name]: event.target.value === "" ? undefined : event.target.valueAsNumber })} />
                  </Field>
                ))}
                {ollama ? (
                  <label className="row small"><input type="checkbox" checked={!!parameters.think}
                    onChange={(event) => updateParameters({ think: event.target.checked })} />开启思考</label>
                ) : (
                  <>
                    <Field label="思考强度">
                      <Select ariaLabel="思考强度" options={EFFORTS} value={parameters.reasoningEffort ?? ""}
                        onChange={(value) => updateParameters({ reasoningEffort: value || undefined })} />
                    </Field>
                    {parameters.maxTokens !== undefined ? (
                      <Field label="输出长度参数名">
                        <Select ariaLabel="输出长度参数名" options={TOKEN_LIMIT_FIELDS}
                          value={parameters.tokenLimitField ?? "max_tokens"}
                          onChange={(value) => updateParameters({
                            tokenLimitField: value === "max_completion_tokens" ? value : "max_tokens",
                          })} />
                      </Field>
                    ) : null}
                  </>
                )}
              </div>
              <p className="hint">{ollama ? "思考开关仅对 Ollama 报告支持思考的模型生效。" : "显式填写的参数会传给服务。参数支持情况取决于所选模型及接口。"} </p>
            </details>
            <div className="row-wrap vision-settings-row">
              <button type="button" className="btn primary sm" onClick={() => void discover()}>保存并检测模型</button>
              <button type="button" className="btn subtle sm" onClick={() => void run("正在保存…", async () => {
                await saveConnection();
                setFeedback({ message: "服务设置已保存" });
              })}>保存服务</button>
              {connection.id ? (
                <button type="button" className="btn ghost sm" onClick={() => void run("正在移除…", async () => {
                  await api.visionRemoveConnection(connection.id);
                  const remaining = configuration?.connections.filter((item) => item.id !== connection.id) ?? [];
                  changeConnection(remaining[0] ?? NEW_CONNECTION);
                  setConfiguration((current) => current ? { ...current, connections: remaining } : current);
                  setFeedback({ message: "服务已移除" });
                })}>移除服务</button>
              ) : null}
            </div>
            <p className="hint">选择云端模型打标时，已应用裁剪的图片会发送到该服务。检测与试跑使用合成图。</p>
          </div>

          {preferences && configuration ? (
            <div className="vision-settings-panel">
              <h4>打标提示词</h4>
              <div className="vision-fields">
                <Field label="识别程度">
                  <Select ariaLabel="识别程度" options={DEPTHS} value={preferences.depth}
                    onChange={(depth) => setPreferences({ ...preferences, depth: depth as VisionDepth })} />
                </Field>
                <Field label="输出形式">
                  <Select ariaLabel="输出形式" options={OUTPUTS} value={preferences.output}
                    onChange={(output) => setPreferences({ ...preferences, output: output as VisionPreferences["output"] })} />
                </Field>
              </div>
              <Field label={`提示词 · ${DEPTHS.find((item) => item.value === preferences.depth)?.label}`}>
                <textarea className="textarea vision-prompt" aria-label="打标提示词" rows={8} spellCheck={false}
                  value={preferences[preferences.depth]}
                  onChange={(event) => setPreferences({ ...preferences, [preferences.depth]: event.target.value })} />
              </Field>
              <div className="row-wrap vision-settings-row">
                <button type="button" className="btn primary sm" onClick={() => void run("正在保存…", async () => {
                  await persistPreferences();
                  setFeedback({ message: "提示词与输出设置已保存" });
                })}>保存提示词设置</button>
                <button type="button" className="btn ghost sm" onClick={() => setPreferences({
                  ...preferences, [preferences.depth]: configuration.defaults[preferences.depth],
                })}>恢复本档默认</button>
              </div>
              <Field label="识别图片长边（px）">
                <input className="input" type="number" aria-label="识别图片长边" min={256} max={2048}
                  value={Number.isFinite(preferences.imageEdge) ? preferences.imageEdge : ""}
                  onChange={(event) => setPreferences({ ...preferences, imageEdge: event.target.valueAsNumber })} />
              </Field>
              <div className="vision-examples">
                <small>短语标签使用英文逗号加一个空格分隔</small>
                <code>person in a red coat, hold a bag, wet street, blue light</code>
                <small>自然语言每句写一个事实，使用完整的英文简单句</small>
                <code>A person wears a red coat. The person holds a paper bag.</code>
              </div>
            </div>
          ) : null}
        </div>
        <div className="vision-settings-panel vision-models">
          <h4>图像模型</h4>
          {models.length ? (
            <ul className="vision-model-list">
              {models.map((item) => (
                <li key={item.name} title={item.note ?? undefined}>
                  <button type="button" className={`btn ghost sm ${model === item.name ? "active" : ""}`}
                    aria-pressed={model === item.name} onClick={() => { setModel(item.name); setSample(null); }}>{item.name}</button>
                  <Badge tone={item.vision === true ? "success" : "neutral"}>
                    {item.vision === true ? "可打标" : item.vision === false ? "无图像能力" : "待验证"}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="row-wrap vision-model-actions">
            <input className="input" aria-label="模型 ID" placeholder="选择模型或填写模型 ID" value={model}
              onChange={(event) => { setModel(event.target.value); setSample(null); }} />
            <button type="button" className="btn subtle sm" disabled={!model.trim() || knownModel?.vision === false}
              onClick={() => void run("正在识别合成图…", async () => {
                const saved = await saveConnection();
                const checked = await api.visionVerify(saved.id, model.trim());
                setModels((current) => [checked, ...current.filter((item) => item.name !== checked.name)]);
                updateVerifiedModels(saved.id, [...saved.verifiedModels.filter((item) => item.name !== checked.name), checked]);
                setFeedback({ message: "图像验证通过，已加入打标列表" });
              })}>验证图像输入</button>
            <button type="button" className="btn subtle sm" disabled={!sameAddress || knownModel?.vision !== true}
              onClick={() => void run("正在试跑提示词…", async () => {
                const saved = await saveConnection();
                await persistPreferences();
                setSample(await api.visionTestPrompt(saved.id, model.trim()));
                setFeedback({ message: "试跑完成" });
              })}>保存并试跑</button>
          </div>
        </div>
      </fieldset>
      {busy ? <div className="row small" role="status"><Spinner />{busy}</div> : null}
      {feedback ? <Notice tone={feedback.error ? "danger" : "success"}>{feedback.message}</Notice> : null}
      {sample ? (
        <div className="vision-examples" aria-label="试跑输出">
          {sample.tags.length ? <code>{sample.tags.join(", ")}</code> : null}
          {sample.caption ? <p>{sample.caption}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
