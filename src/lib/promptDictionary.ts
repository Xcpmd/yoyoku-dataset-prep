/**
 * Prompt tag library persisted in the project SQLite database.
 *
 * On first use the JSON files under public/prompts are parsed, assigned their
 * main category (file name / top-level supermarket category), imported into
 * the project database, and then read back from SQLite. Sub-categories are not
 * used for classification.
 */
import { api } from "./api";
import type { PromptLibraryEntry } from "./types";

const PROMPT_FILES = [
  "tag_supper_market.json",
  "action.json",
  "clothes.json",
  "decor.json",
  "env.json",
  "eye.json",
  "face.json",
  "goods.json",
  "hair.json",
  "negative.json",
  "often.json",
  "person.json",
  "scene.json",
  "shape.json",
  "shoes.json",
  "socks.json",
  "start.json",
  "style.json",
  "NSFW.json",
] as const;

export type PromptDictionary = Map<string, string>;

export interface PromptLibrary {
  entries: PromptLibraryEntry[];
  dictionary: PromptDictionary;
  categoryOf: Map<string, string>;
  categories: string[];
}

export const PROMPT_LIBRARY_UPDATED_EVENT = "yoyoku:prompt-library-updated";

let cache: { key: string; promise: Promise<PromptLibrary> } | null = null;

export function normalizePromptKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looseKey(value: string): string {
  let key = normalizePromptKey(value);
  // `(long hair:1.2)` / `long hair (style)` style tags should still resolve.
  const weighted = key.match(/^\((.+?)(?::[\d.]+)?\)$/);
  if (weighted) key = normalizePromptKey(weighted[1]);
  return key.replace(/[()]/g, "").trim();
}

function addEntry(
  entries: PromptLibraryEntry[],
  seen: Set<string>,
  english: unknown,
  chinese: unknown,
  category: string,
): void {
  if (typeof english !== "string" || typeof chinese !== "string") return;
  const en = english.trim();
  const zh = chinese.trim();
  const key = normalizePromptKey(en);
  if (!key || !zh || seen.has(key)) return;
  seen.add(key);
  entries.push({ key, english: en, chinese: zh, category: category.trim() || "未分类" });
}

function walkContent(
  entries: PromptLibraryEntry[],
  seen: Set<string>,
  value: unknown,
  category: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkContent(entries, seen, item, category);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.en === "string" && typeof record.zh === "string") {
    addEntry(entries, seen, record.en, record.zh, category);
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") walkContent(entries, seen, child, category);
  }
}

function walkTree(
  entries: PromptLibraryEntry[],
  seen: Set<string>,
  value: unknown,
  category: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkTree(entries, seen, item, category);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const children = Array.isArray(record.children) ? record.children : [];
  if (children.length > 0) {
    for (const child of children) walkTree(entries, seen, child, category);
    return;
  }
  if (typeof record.name === "string" && typeof record.translation === "string") {
    addEntry(entries, seen, record.name, record.translation, category);
  }
}

function parseFile(file: string, data: unknown): PromptLibraryEntry[] {
  const entries: PromptLibraryEntry[] = [];
  const seen = new Set<string>();
  if (Array.isArray(data)) {
    // tag_supper_market.json: each top-level node is a main category.
    for (const node of data) {
      if (!node || typeof node !== "object") continue;
      const record = node as Record<string, unknown>;
      const category =
        typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : "未分类";
      walkTree(entries, seen, record.children, category);
    }
    return entries;
  }
  if (!data || typeof data !== "object") return entries;
  const record = data as Record<string, unknown>;
  const category =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : file.replace(/\.json$/i, "");
  walkContent(entries, seen, record.content, category);
  return entries;
}

function buildLibrary(entries: PromptLibraryEntry[]): PromptLibrary {
  const dictionary: PromptDictionary = new Map();
  const categoryOf = new Map<string, string>();
  const categories = new Set<string>();
  for (const entry of entries) {
    const key = normalizePromptKey(entry.english);
    if (!key) continue;
    if (!dictionary.has(key)) dictionary.set(key, entry.chinese);
    if (!categoryOf.has(key)) categoryOf.set(key, entry.category || "未分类");
    categories.add(entry.category || "未分类");
  }
  return {
    entries,
    dictionary,
    categoryOf,
    categories: Array.from(categories).sort((a, b) => a.localeCompare(b, "zh-CN")),
  };
}

async function fetchBundledLibrary(): Promise<PromptLibraryEntry[]> {
  const responses = await Promise.allSettled(
    PROMPT_FILES.map(async (file) => {
      const response = await fetch(`/prompts/${encodeURIComponent(file)}`, { cache: "force-cache" });
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      return parseFile(file, (await response.json()) as unknown);
    }),
  );
  const entries: PromptLibraryEntry[] = [];
  const seen = new Set<string>();
  for (const response of responses) {
    if (response.status !== "fulfilled") continue;
    for (const entry of response.value) {
      const key = normalizePromptKey(entry.english);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries;
}

async function load(): Promise<PromptLibrary> {
  try {
    const stored = await api.promptLibraryList();
    if (stored.length > 0) return buildLibrary(stored);
  } catch {
    // 首次打开或旧数据库时回退到随应用分发的 JSON。
  }
  const bundled = await fetchBundledLibrary();
  if (bundled.length > 0) {
    try {
      await api.promptLibraryImport(bundled);
    } catch {
      // 导入失败时仍然允许本次会话使用内存中的词库。
    }
  }
  return buildLibrary(bundled);
}

export function loadPromptLibrary(projectId = ""): Promise<PromptLibrary> {
  if (!cache || cache.key !== projectId) {
    const promise = load().catch((error) => {
      if (cache?.promise === promise) cache = null;
      throw error;
    });
    cache = { key: projectId, promise };
  }
  return cache.promise;
}

export function loadPromptDictionary(): Promise<PromptDictionary> {
  return loadPromptLibrary().then((library) => library.dictionary);
}

export function lookupPromptTranslation(dictionary: PromptDictionary, tag: string): string | null {
  if (dictionary.size === 0) return null;
  const direct = dictionary.get(normalizePromptKey(tag));
  if (direct) return direct;
  const loose = dictionary.get(looseKey(tag));
  return loose || null;
}

export function lookupPromptCategory(library: PromptLibrary, tag: string): string {
  const category =
    library.categoryOf.get(normalizePromptKey(tag)) ||
    library.categoryOf.get(looseKey(tag));
  return category || "未分类";
}

export function invalidatePromptLibrary(): void {
  cache = null;
}

/** 词库被管理页修改后，让所有已挂载的标注面板立即重新读取 SQLite。 */
export function notifyPromptLibraryUpdated(): void {
  invalidatePromptLibrary();
  window.dispatchEvent(new CustomEvent(PROMPT_LIBRARY_UPDATED_EVENT));
}
