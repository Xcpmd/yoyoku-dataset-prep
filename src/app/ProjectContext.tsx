import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import type {
  AppInfo,
  AppSettings,
  AssetFilter,
  AssetSort,
  CollectionInfo,
  JobInfo,
  ProjectInfo,
} from "../lib/types";
import type { ToastItem } from "../components/ui";

export type LibraryView = "grid" | "list";

export interface OpenWorkbenchOptions {
  sequence?: string[];
  label?: string;
}

export interface ProjectContextValue {
  project: ProjectInfo;
  appInfo: AppInfo | null;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  refreshProject: () => Promise<void>;
  closeProject: () => Promise<void>;

  page: string;
  navigate: (page: string) => void;

  selection: string[];
  selectionSet: Set<string>;
  setSelection: (ids: string[]) => void;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;

  filter: AssetFilter;
  setFilter: Dispatch<SetStateAction<AssetFilter>>;
  sort: AssetSort;
  setSort: (sort: AssetSort) => void;
  view: LibraryView;
  setView: (view: LibraryView) => void;

  sequence: string[];
  sequenceLabel: string;
  setSequence: (ids: string[], label?: string) => void;

  workbenchId: string | null;
  openWorkbench: (id: string, options?: OpenWorkbenchOptions) => void;

  refreshToken: number;
  bumpRefresh: () => void;
  /** 导入批次提交后的增量刷新信号；只用于图库，不触发项目与去重重算。 */
  librarySignal: number;

  collections: CollectionInfo[];
  reloadCollections: () => Promise<void>;

  jobs: JobInfo[];
  reloadJobs: () => Promise<void>;
  jobsOpen: boolean;
  setJobsOpen: (open: boolean) => void;

  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;

  importSignal: number;
  requestImport: () => void;
  searchSignal: number;
  requestSearch: () => void;

  navigateToLibrary: (filterPatch?: Partial<AssetFilter>) => void;
  notify: (toast: Omit<ToastItem, "id">) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export const ProjectProvider = ProjectContext.Provider;

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used inside ProjectProvider");
  return value;
}
