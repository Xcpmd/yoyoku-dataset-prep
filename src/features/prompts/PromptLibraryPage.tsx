import { useCallback, useEffect, useMemo, useState } from "react";
import { api, normalizeError } from "../../lib/api";
import type { PromptLibraryEntry } from "../../lib/types";
import { useProject } from "../../app/ProjectContext";
import { classNames, formatNumber } from "../../lib/utils";
import { notifyPromptLibraryUpdated, loadPromptLibrary } from "../../lib/promptDictionary";
import { Icon } from "../../components/Icon";
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  Field,
  Modal,
  Notice,
  Spinner,
} from "../../components/ui";

interface DraftEntry {
  originalKey: string | null;
  english: string;
  chinese: string;
  category: string;
}

const PAGE_SIZES = [50, 100, 200];

export function PromptLibraryPage({ active }: { active: boolean }) {
  const { project, navigate, notify } = useProject();
  const [entries, setEntries] = useState<PromptLibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sortMode, setSortMode] = useState<"english" | "category" | "chinese">("english");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [draft, setDraft] = useState<DraftEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translationNote, setTranslationNote] = useState("");
  const [deleting, setDeleting] = useState<PromptLibraryEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const library = await loadPromptLibrary(project.id);
      setEntries(library.entries);
    } catch (error) {
      setLoadError(normalizeError(error).message);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const categories = useMemo(() => {
    const unique = new Set<string>();
    for (const entry of entries) unique.add(entry.category || "未分类");
    return Array.from(unique).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [entries]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = entries.filter((entry) => {
      if (category && entry.category !== category) return false;
      if (!needle) return true;
      return (
        entry.english.toLowerCase().includes(needle) ||
        entry.chinese.includes(needle) ||
        entry.category.toLowerCase().includes(needle)
      );
    });
    return list.sort((a, b) => {
      if (sortMode === "category") {
        return (
          a.category.localeCompare(b.category, "zh-CN") ||
          a.english.localeCompare(b.english, "en")
        );
      }
      if (sortMode === "chinese") {
        return (
          a.chinese.localeCompare(b.chinese, "zh-CN") ||
          a.english.localeCompare(b.english, "en")
        );
      }
      return a.english.localeCompare(b.english, "en");
    });
  }, [entries, query, category, sortMode]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, currentPage, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [query, category, sortMode, pageSize]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const openNew = () => {
    setTranslationNote("");
    setDraft({
      originalKey: null,
      english: "",
      chinese: "",
      category: category || categories[0] || "未分类",
    });
  };

  const openEdit = (entry: PromptLibraryEntry) => {
    setTranslationNote("");
    setDraft({
      originalKey: entry.key,
      english: entry.english,
      chinese: entry.chinese,
      category: entry.category,
    });
  };

  const draftValid =
    Boolean(draft) &&
    Boolean(draft?.english.trim()) &&
    Boolean(draft?.chinese.trim());

  const saveDraft = async () => {
    if (!draft || !draftValid || saving) return;
    setSaving(true);
    try {
      const saved = await api.promptLibraryUpsert({
        originalKey: draft.originalKey,
        english: draft.english,
        chinese: draft.chinese,
        category: draft.category,
      });
      notifyPromptLibraryUpdated();
      await load();
      setDraft(null);
      notify({
        tone: "success",
        message: draft.originalKey ? `已更新「${saved.english}」` : `已新增「${saved.english}」`,
      });
    } catch (error) {
      notify({ tone: "danger", title: "提示词保存失败", message: normalizeError(error).message });
    } finally {
      setSaving(false);
    }
  };

  const translateDraft = async (to: "zh" | "en") => {
    if (!draft || translating) return;
    const source = (to === "zh" ? draft.english : draft.chinese).trim();
    if (!source) {
      notify({ message: to === "zh" ? "请先填写英文提示词" : "请先填写中文翻译" });
      return;
    }
    setTranslating(true);
    setTranslationNote("");
    try {
      const result = await api.translateTexts([source], to);
      const translated = (result.translations[0] || "").trim();
      if (!translated) {
        setTranslationNote("没有返回翻译结果");
        return;
      }
      setDraft((current) =>
        current
          ? {
              ...current,
              ...(to === "zh" ? { chinese: translated } : { english: translated }),
            }
          : current,
      );
      setTranslationNote(to === "zh" ? "已填入中文翻译" : "已填入英文提示词");
    } catch (error) {
      notify({ tone: "danger", title: "翻译失败", message: normalizeError(error).message });
    } finally {
      setTranslating(false);
    }
  };

  const translateRow = async (entry: PromptLibraryEntry) => {
    if (translating) return;
    setTranslationNote("");
    setDraft({
      originalKey: entry.key,
      english: entry.english,
      chinese: entry.chinese,
      category: entry.category,
    });
    setTranslating(true);
    try {
      const result = await api.translateTexts([entry.english], "zh");
      const translated = (result.translations[0] || "").trim();
      if (!translated) {
        setTranslationNote("没有返回翻译结果");
        return;
      }
      setDraft((current) =>
        current && current.originalKey === entry.key && current.english === entry.english
          ? { ...current, chinese: translated }
          : current,
      );
      setTranslationNote("已填入中文翻译，确认后保存");
    } catch (error) {
      notify({ tone: "danger", title: "翻译失败", message: normalizeError(error).message });
    } finally {
      setTranslating(false);
    }
  };

  const deleteEntry = async () => {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await api.promptLibraryDelete(deleting.key);
      notifyPromptLibraryUpdated();
      const removed = deleting.english;
      setDeleting(null);
      await load();
      notify({ tone: "success", message: `已删除「${removed}」` });
    } catch (error) {
      notify({ tone: "danger", title: "删除失败", message: normalizeError(error).message });
    } finally {
      setDeleteBusy(false);
    }
  };

  const rangeStart = filtered.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(filtered.length, currentPage * pageSize);

  return (
    <div className="page">
      <div className="prompt-page">
        <div className="prompt-head">
          <div>
            <h1 className="page-title">提示词库</h1>
            <div className="page-subtitle">
              {project.name} · 手动补全、分类分组与中英翻译共用此词库
            </div>
          </div>
          <div className="spacer" />
          <button type="button" className="btn subtle" onClick={() => navigate("tag")}>
            <Icon name="tag" />
            返回打标
          </button>
          <button type="button" className="btn primary" onClick={openNew}>
            <Icon name="plus" />
            新增提示词
          </button>
        </div>

        <div className="prompt-toolbar">
          <div className="search-box">
            <Icon name="search" className="sm" />
            <input
              className="input"
              value={query}
              placeholder="搜索英文、中文或分类"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                className="search-clear"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
              >
                <Icon name="x" className="sm" />
              </button>
            ) : null}
          </div>
          <select
            className="select"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            title="按主分类筛选"
          >
            <option value="">全部分类</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select
            className="select prompt-sort-select"
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as "english" | "category" | "chinese")}
            title="排序方式"
          >
            <option value="english">英文 A→Z</option>
            <option value="category">按分类</option>
            <option value="chinese">按中文</option>
          </select>
          <span className="hint">
            共 {formatNumber(entries.length)} 条 · {categories.length} 个分类
            {filtered.length !== entries.length ? ` · 当前 ${formatNumber(filtered.length)} 条` : ""}
          </span>
          <div className="spacer" />
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void load()}
            disabled={loading}
            title="从项目数据库重新读取"
          >
            {loading ? <Spinner /> : <Icon name="refresh" className="sm" />}
            刷新
          </button>
        </div>

        {loadError ? <Notice tone="danger">{loadError}</Notice> : null}

        <div className="prompt-card">
          {loading && entries.length === 0 ? (
            <div className="prompt-loading">
              <Spinner />
              正在读取提示词库…
            </div>
          ) : pageItems.length === 0 ? (
            <EmptyState
              icon="search"
              title={entries.length === 0 ? "提示词库还是空的" : "没有匹配的提示词"}
              body={
                entries.length === 0
                  ? "首次打开打标页时会自动导入随应用分发的提示词 JSON，也可以在这里手动新增。"
                  : "换一个关键词或分类再试，或新增一条提示词。"
              }
              actions={
                <button type="button" className="btn primary" onClick={openNew}>
                  <Icon name="plus" />
                  新增提示词
                </button>
              }
            />
          ) : (
            <>
              <div className="prompt-table-wrap">
                <table className="prompt-table">
                  <thead>
                    <tr>
                      <th style={{ width: "36%" }}>英文提示词</th>
                      <th style={{ width: "30%" }}>中文翻译</th>
                      <th style={{ width: "18%" }}>主分类</th>
                      <th style={{ width: 148, textAlign: "right" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((entry) => (
                      <tr key={entry.key} onDoubleClick={() => openEdit(entry)}>
                        <td className="prompt-en">{entry.english}</td>
                        <td className="prompt-zh">{entry.chinese}</td>
                        <td>
                          <Badge tone="neutral">{entry.category}</Badge>
                        </td>
                        <td>
                          <div className="prompt-row-actions">
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() => openEdit(entry)}
                              title="编辑英文、中文与分类"
                            >
                              <Icon name="edit" className="sm" />
                              编辑
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() => void translateRow(entry)}
                              title="用翻译服务重新生成中文"
                              disabled={translating}
                            >
                              {translating ? <Spinner /> : <Icon name="sparkles" className="sm" />}
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() => setDeleting(entry)}
                              title="删除提示词"
                            >
                              <Icon name="trash" className="sm" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="prompt-pager">
                <span>
                  第 {formatNumber(rangeStart)}–{formatNumber(rangeEnd)} 条 · 第 {currentPage} /{" "}
                  {pageCount} 页
                </span>
                <select
                  className="select"
                  value={pageSize}
                  onChange={(event) => setPageSize(Number(event.target.value))}
                  title="每页条数"
                >
                  {PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      每页 {size} 条
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setPage(1)}
                  disabled={currentPage <= 1}
                >
                  <Icon name="chevrons-left" className="sm" />
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  disabled={currentPage <= 1}
                >
                  <Icon name="chevron-left" className="sm" />
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                  disabled={currentPage >= pageCount}
                >
                  <Icon name="chevron-right" className="sm" />
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setPage(pageCount)}
                  disabled={currentPage >= pageCount}
                >
                  <Icon name="chevrons-right" className="sm" />
                </button>
              </div>
            </>
          )}
        </div>

        <Notice tone="info">
          提示词库保存在项目 SQLite 中。修改后会立即用于打标页的补全、分组视图和翻译对照；删除只影响
          本项目，不会改动随应用分发的 JSON 文件。
        </Notice>
      </div>

      <Modal
        open={Boolean(draft)}
        onClose={() => {
          if (!saving) setDraft(null);
        }}
        title={draft?.originalKey ? "编辑提示词" : "新增提示词"}
        subtitle="英文用于自动补全，中文用于对照和翻译。"
        width="wide"
        closeOnBackdrop={!saving}
        footer={
          <>
            <span className="hint" style={{ marginRight: "auto" }}>
              {translationNote}
            </span>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setDraft(null)}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void saveDraft()}
              disabled={!draftValid || saving}
            >
              {saving ? <Spinner /> : <Icon name="save" />}
              保存
            </button>
          </>
        }
      >
        {draft ? (
          <div className="prompt-edit-grid">
            <Field label="英文提示词" hint="保存时会按空格与下划线归一化去重">
              <input
                className="input"
                value={draft.english}
                autoFocus
                onChange={(event) => {
                  setTranslationNote("");
                  setDraft({ ...draft, english: event.target.value });
                }}
                placeholder="例如 long hair"
              />
            </Field>
            <Field label="中文翻译">
              <input
                className="input"
                value={draft.chinese}
                onChange={(event) => {
                  setTranslationNote("");
                  setDraft({ ...draft, chinese: event.target.value });
                }}
                placeholder="例如 长发"
              />
            </Field>
            <Field label="主分类" hint="用于分组视图和补全筛选；可直接输入新分类">
              <input
                className="input"
                list="prompt-category-options"
                value={draft.category}
                onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                placeholder="未分类"
              />
              <datalist id="prompt-category-options">
                {categories.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </Field>
            <div className="prompt-translate-row">
              <button
                type="button"
                className="btn subtle sm"
                onClick={() => void translateDraft("zh")}
                disabled={translating || !draft.english.trim()}
                title="把英文提示词翻译成中文并填入"
              >
                {translating ? <Spinner /> : <Icon name="sparkles" className="sm" />}
                英译中
              </button>
              <button
                type="button"
                className="btn subtle sm"
                onClick={() => void translateDraft("en")}
                disabled={translating || !draft.chinese.trim()}
                title="把中文翻译成英文并填入"
              >
                {translating ? <Spinner /> : <Icon name="sparkles" className="sm" />}
                中译英
              </button>
              <span className="hint">翻译结果会先填入输入框，确认后保存。</span>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="删除提示词"
        body={
          <>
            将从本项目提示词库删除「{deleting?.english}」。已经写入图片标注的内容不会改变。
          </>
        }
        confirmLabel="删除"
        danger
        busy={deleteBusy}
        onClose={() => {
          if (!deleteBusy) setDeleting(null);
        }}
        onConfirm={() => void deleteEntry()}
      />
    </div>
  );
}
