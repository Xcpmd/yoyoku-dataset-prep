import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useProject } from "../../app/ProjectContext";
import { Icon } from "../../components/Icon";
import { PromptDialog } from "../../components/ui";
import { api, normalizeError } from "../../lib/api";
import { S } from "../../lib/strings";
import type { AssetFilter } from "../../lib/types";
import { classNames, emptyFilter, filterActiveCount, filterRuleCount, statusLabel } from "../../lib/utils";
import { FilterDialog } from "./FilterDialog";
import { GallerySearch, useGallerySearch } from "./GallerySearch";

interface FilterBarState {
  search: ReturnType<typeof useGallerySearch>;
  inputRef: RefObject<HTMLInputElement | null>;
  filterCount: number;
  chips: { key: string; label: string; remove: () => void }[];
  openFilter: () => void;
  clearAll: () => void;
}

const FilterBarContext = createContext<FilterBarState | null>(null);

export function DatasetFilterProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const { filter, setFilter, sort, collections, reloadCollections, notify, searchSignal, page } = useProject();
  const [filterOpen, setFilterOpen] = useState(false);
  const [smartFilter, setSmartFilter] = useState<AssetFilter | null>(null);
  const search = useGallerySearch(filter, setFilter);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSearchSignal = useRef(searchSignal);
  const filterCount = filterActiveCount(filter) - Number(!!filter.query.trim());

  useEffect(() => {
    if (!active || lastSearchSignal.current === searchSignal) return;
    lastSearchSignal.current = searchSignal;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [active, page, searchSignal]);

  const saveCollection = async (name: string) => {
    if (!smartFilter || !name.trim()) return;
    setSmartFilter(null);
    try {
      await api.createCollection({ name: name.trim(), kind: "query", query: smartFilter, sort });
      await reloadCollections();
      notify({ tone: "success", message: `已保存智能集合「${name.trim()}」` });
    } catch (error) {
      notify({ tone: "danger", title: S.errors.generic, message: normalizeError(error).message });
    }
  };

  const activeFilterChips = useMemo(() => {
    const chips: { key: string; label: string; remove: () => void }[] = [];
    filter.statuses.forEach((status) =>
      chips.push({
        key: `status-${status}`,
        label: statusLabel(status),
        remove: () => setFilter({ ...filter, statuses: filter.statuses.filter((value) => value !== status) }),
      }),
    );
    filter.issueLevels.forEach((level) =>
      chips.push({
        key: `level-${level}`,
        label: level === "blocking" ? S.library.filterBlocking : level === "ignored" ? S.library.filterIgnored : S.library.filterSuggestion,
        remove: () => setFilter({ ...filter, issueLevels: filter.issueLevels.filter((value) => value !== level) }),
      }),
    );
    filter.orientations.forEach((orientation) =>
      chips.push({
        key: `orientation-${orientation}`,
        label:
          orientation === "landscape"
            ? S.library.orientationLandscape
            : orientation === "portrait"
              ? S.library.orientationPortrait
              : S.library.orientationSquare,
        remove: () => setFilter({ ...filter, orientations: filter.orientations.filter((value) => value !== orientation) }),
      }),
    );
    filter.collectionIds.forEach((id) => {
      const collection = collections.find((item) => item.id === id);
      chips.push({
        key: `collection-${id}`,
        label: collection?.name || "集合",
        remove: () => setFilter({ ...filter, collectionIds: filter.collectionIds.filter((value) => value !== id) }),
      });
    });
    if (filter.split) {
      chips.push({
        key: "split",
        label: filter.split === "train" ? "训练" : filter.split === "val" ? "验证" : "未分配",
        remove: () => setFilter({ ...filter, split: null }),
      });
    }
    if (filter.duplicateOnly) {
      chips.push({ key: "duplicate", label: S.library.filterDuplicate, remove: () => setFilter({ ...filter, duplicateOnly: false }) });
    }
    if (filter.favoriteOnly) {
      chips.push({ key: "favorite", label: S.library.filterFavorites, remove: () => setFilter({ ...filter, favoriteOnly: false }) });
    }
    if (filter.hasDraft) {
      chips.push({ key: "draft", label: S.library.filterDraft, remove: () => setFilter({ ...filter, hasDraft: false }) });
    }
    if (filter.recycledOnly) {
      chips.push({ key: "recycled", label: "回收区", remove: () => setFilter({ ...filter, recycledOnly: false }) });
    }
    if (filter.minShortEdge) {
      chips.push({ key: "minEdge", label: `短边 ≥ ${filter.minShortEdge}`, remove: () => setFilter({ ...filter, minShortEdge: null }) });
    }
    if (filter.maxShortEdge) {
      chips.push({ key: "maxEdge", label: `短边 ≤ ${filter.maxShortEdge}`, remove: () => setFilter({ ...filter, maxShortEdge: null }) });
    }
    filter.issueRules.forEach((rule) => chips.push({
      key: "issue-" + rule,
      label: `质检 · ${rule}`,
      remove: () => setFilter({ ...filter, issueRules: filter.issueRules.filter((value) => value !== rule) }),
    }));
    if (filter.expression) chips.push({
      key: "expression",
      label: `组合条件 · ${filterRuleCount(filter.expression)} 项`,
      remove: () => setFilter({ ...filter, expression: null }),
    });
    return chips;
  }, [filter, collections, setFilter]);

  return (
    <FilterBarContext.Provider value={{
      search,
      inputRef,
      filterCount,
      chips: activeFilterChips,
      openFilter: () => setFilterOpen(true),
      clearAll: () => {
        search.reset();
        setFilter(emptyFilter());
      },
    }}>
      {children}
      {active && filterOpen ? (
        <FilterDialog
          filter={filter}
          collections={collections}
          onClose={() => setFilterOpen(false)}
          onApply={(next) => {
            setFilter((current) => ({
              ...next,
              query: current.query,
              regexSearch: current.regexSearch,
              searchTarget: current.searchTarget,
              searchCaseSensitive: current.searchCaseSensitive,
            }));
            setFilterOpen(false);
          }}
          onSave={(next) => {
            setSmartFilter(next);
            setFilterOpen(false);
          }}
        />
      ) : null}
      <PromptDialog
        open={active && smartFilter !== null}
        title={S.library.saveSmartCollection}
        label={S.library.smartCollectionName}
        required
        confirmLabel={S.common.add}
        onSubmit={(value) => void saveCollection(value)}
        onClose={() => setSmartFilter(null)}
      />
    </FilterBarContext.Provider>
  );
}

export function DatasetFilterControls() {
  const { search, inputRef, filterCount, openFilter } = useContext(FilterBarContext)!;
  return (
    <>
      <GallerySearch search={search} inputRef={inputRef} />
      <button
        type="button"
        className={classNames("btn", filterCount > 0 ? "secondary" : "subtle")}
        onClick={openFilter}
        aria-haspopup="dialog"
      >
        <Icon name="filter" />
        {S.library.filter}
        {filterCount > 0 ? <span className="count info">{filterCount}</span> : null}
      </button>
    </>
  );
}

export function DatasetFilterChips() {
  const { chips, openFilter, clearAll } = useContext(FilterBarContext)!;
  if (!chips.length) return null;
  return (
    <div className="active-filters">
      {chips.map((chip) => (
        <span className="chip active" key={chip.key}>
          {chip.key === "expression" ? (
            <button type="button" className="gallery-filter-chip-label" onClick={openFilter}>{chip.label}</button>
          ) : chip.label}
          <button type="button" className="x" aria-label={`移除 ${chip.label}`} onClick={chip.remove}>
            <Icon name="x" className="sm" />
          </button>
        </span>
      ))}
      <button type="button" className="btn ghost sm" onClick={clearAll}>
        {S.common.clearAll}
      </button>
    </div>
  );
}

export function DatasetFilterBar({ className }: { className?: string }) {
  return (
    <div className={classNames("dataset-filter-bar", className)}>
      <div className="dataset-filter-controls">
        <DatasetFilterControls />
      </div>
      <DatasetFilterChips />
    </div>
  );
}
