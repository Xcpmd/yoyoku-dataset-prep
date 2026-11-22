import { RootProvider, useRoot } from "./app/AppProvider";
import { ToastProvider, Spinner } from "./components/ui";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { ProjectShell } from "./app/ProjectShell";
import { Icon } from "./components/Icon";
import { WindowControls } from "./components/WindowControls";
import { ModelDownloadDock } from "./components/ModelDownloadDock";

function BootScreen({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return (
    <div
      data-tauri-drag-region
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 16,
        padding: 24,
        background: "var(--page)",
        color: "var(--ink)",
      }}
    >
      <WindowControls floating />
      <img src="/app-icon.png" alt="" width={58} height={58} className="boot-icon" />
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: 22, letterSpacing: "-0.02em" }}>Yoyoku Dataset Prep</h1>
        <p style={{ marginTop: 4, color: "var(--muted)", fontSize: 13 }}>
          {error ? "应用初始化遇到问题" : "正在打开工作区…"}
        </p>
      </div>
      {error ? (
        <>
          <div className="notice danger" style={{ maxWidth: 520 }}>
            <Icon name="alert" className="sm" />
            <div>{error}</div>
          </div>
          <button type="button" className="btn primary" onClick={onRetry}>
            重试
          </button>
        </>
      ) : (
        <Spinner size="lg" />
      )}
    </div>
  );
}

function AppInner() {
  const { ready, bootError, retryBoot, project } = useRoot();
  if (!ready) return <BootScreen />;
  if (bootError) return <BootScreen error={bootError} onRetry={retryBoot} />;
  return project ? <ProjectShell key={project.id} /> : <ProjectsPage />;
}

export default function App() {
  return (
    <ToastProvider>
      <RootProvider>
        <div className="app-root">
          <div className="app-content">
            <AppInner />
          </div>
          <ModelDownloadDock />
        </div>
      </RootProvider>
    </ToastProvider>
  );
}
