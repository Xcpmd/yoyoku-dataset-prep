import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { classNames } from "../lib/utils";
import { Icon } from "./Icon";

/**
 * 不渲染独立标题栏：只提供最小化 / 最大化 / 关闭三个应用内按钮。
 * 项目页把它放进顶栏；项目列表页以浮层按钮放在右上角。
 */
export function WindowControls({ floating = false }: { floating?: boolean }) {
  const [maximized, setMaximized] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    const sync = () => {
      appWindow
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => undefined);
    };
    sync();
    appWindow
      .onResized(() => sync())
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const run = async (action: "minimize" | "maximize" | "close") => {
    if (busy) return;
    setBusy(true);
    try {
      const appWindow = getCurrentWindow();
      if (action === "minimize") await appWindow.minimize();
      else if (action === "maximize") {
        await appWindow.toggleMaximize();
        setMaximized(await appWindow.isMaximized());
      } else {
        await appWindow.close();
      }
    } catch {
      // 纯浏览器预览没有 Tauri 窗口环境。
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={classNames("window-controls", floating && "floating")}
      role="group"
      aria-label="窗口控制"
    >
      <button
        type="button"
        className="window-control"
        aria-label="最小化"
        title="最小化"
        onClick={() => void run("minimize")}
      >
        <Icon name="minus" size={12} />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? "还原" : "最大化"}
        title={maximized ? "还原" : "最大化"}
        onClick={() => void run("maximize")}
      >
        <Icon name={maximized ? "restore" : "maximize"} size={11} />
      </button>
      <button
        type="button"
        className="window-control close"
        aria-label="关闭"
        title="关闭"
        onClick={() => void run("close")}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
