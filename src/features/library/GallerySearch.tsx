import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/ui";
import { api, normalizeError } from "../../lib/api";
import { S } from "../../lib/strings";
import type { AssetFilter, RegexSearchTarget } from "../../lib/types";
import { emptyFilter } from "../../lib/utils";

const SEARCH_DELAY_MS = 300;
const targets = ([
  ["all", "全部字段"], ["name", "文件名"], ["path", "相对路径"],
  ["tag", "标签"], ["caption", "标注正文"], ["note", "备注"],
] satisfies [RegexSearchTarget, string][]).map(([value, label]) => ({ value, label }));

type SearchDraft = {
  input: string;
  regex: boolean;
  target: RegexSearchTarget;
  caseSensitive: boolean;
};

function searchKey(draft: SearchDraft): string {
  return JSON.stringify([draft.input, !!draft.input && draft.regex, draft.target, draft.caseSensitive]);
}

export function useGallerySearch(filter: AssetFilter, setFilter: Dispatch<SetStateAction<AssetFilter>>) {
  const pattern = filter.regexSearch?.pattern;
  const input = pattern ?? filter.query;
  const regex = pattern !== undefined;
  const target = filter.regexSearch?.target ?? filter.searchTarget ?? "all";
  const caseSensitive = filter.searchCaseSensitive ?? false;
  const saved = useMemo(() => ({ input, regex, target, caseSensitive }), [input, regex, target, caseSensitive]);
  const [draft, setDraft] = useState<SearchDraft>(saved);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const expectedSearch = useRef<string | null>(null);
  const savedKey = searchKey(saved);
  const draftKey = searchKey(draft);

  useEffect(() => {
    if (expectedSearch.current === searchKey(saved)) {
      expectedSearch.current = null;
      return;
    }
    sequence.current += 1;
    setDraft(saved);
    setError("");
  }, [saved]);

  useEffect(() => {
    if (composing || draftKey === savedKey) return;
    const request = ++sequence.current;
    const timer = window.setTimeout(async () => {
      const searchPatch = {
        query: draft.regex ? "" : draft.input,
        regexSearch: draft.regex && draft.input ? { pattern: draft.input, target: draft.target } : null,
        searchTarget: draft.target,
        searchCaseSensitive: draft.caseSensitive,
      };
      try {
        if (searchPatch.regexSearch) {
          await api.validateAssetFilter({ ...emptyFilter(), ...searchPatch });
        }
        if (sequence.current !== request) return;
        expectedSearch.current = draftKey;
        setFilter((current) => ({ ...current, ...searchPatch }));
      } catch (error) {
        if (sequence.current === request) setError(normalizeError(error).message);
      }
    }, draft.input ? SEARCH_DELAY_MS : 0);
    return () => {
      sequence.current += 1;
      window.clearTimeout(timer);
    };
  }, [composing, draft, draftKey, savedKey, setFilter]);

  const update = (patch: Partial<SearchDraft>) => {
    sequence.current += 1;
    setError("");
    setDraft((current) => ({ ...current, ...patch }));
  };

  return {
    draft,
    error,
    update,
    startComposition: () => {
      sequence.current += 1;
      setComposing(true);
    },
    endComposition: () => setComposing(false),
    reset: () => {
      sequence.current += 1;
      expectedSearch.current = null;
      setComposing(false);
      setError("");
      setDraft({ input: "", regex: false, target: "all", caseSensitive: false });
    },
  };
}

export function GallerySearch({ search, inputRef }: {
  search: ReturnType<typeof useGallerySearch>;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { draft, error, update, startComposition, endComposition } = search;
  return (
    <div className="gallery-search" role="search" aria-label="搜索图片">
      <div className="search-box gallery-search-box">
        <Icon name="search" className="sm" />
        <input
          ref={inputRef}
          id="library-search"
          className="input"
          placeholder={draft.regex ? "正则搜索" : "搜索图片"}
          value={draft.input}
          onChange={(event) => update({ input: event.target.value })}
          onCompositionStart={startComposition}
          onCompositionEnd={(event) => {
            update({ input: event.currentTarget.value });
            endComposition();
          }}
          onBlur={endComposition}
          aria-label={draft.regex ? "正则搜索表达式" : S.library.searchPlaceholder}
          aria-invalid={!!error}
          aria-describedby={error ? "gallery-search-error" : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="gallery-search-options">
          {draft.input ? (
            <button type="button" className="gallery-search-toggle" aria-label={S.common.clear} title={S.common.clear} onClick={() => {
              update({ input: "" });
              inputRef.current?.focus();
            }}>
              <Icon name="x" className="sm" />
            </button>
          ) : null}
          <button
            type="button"
            className="gallery-search-toggle"
            aria-label="区分大小写"
            title="区分大小写"
            aria-pressed={draft.caseSensitive}
            onClick={() => update({ caseSensitive: !draft.caseSensitive })}
          >
            Aa
          </button>
          <button
            type="button"
            className="gallery-search-toggle gallery-regex-toggle"
            aria-label="正则搜索"
            title="正则搜索"
            aria-pressed={draft.regex}
            onClick={() => update({ regex: !draft.regex })}
          >
            .*
          </button>
          <Select
            className="gallery-search-target"
            value={draft.target}
            options={targets}
            ariaLabel="搜索字段"
            title="搜索字段"
            onChange={(value) => update({ target: value as RegexSearchTarget })}
          />
        </div>
      </div>
      {error ? <div id="gallery-search-error" role="alert" className="gallery-pattern-error">{error}</div> : null}
    </div>
  );
}
