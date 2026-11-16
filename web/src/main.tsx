import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import "./index.css";
import { App } from "./app/App";
import { AppProviders } from "./app/providers";
import { isNative } from "./lib/platform";
import { USE_MOCK } from "./lib/env";

function applyColorScheme(): void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.classList.toggle("dark", media.matches);
  };
  apply();
  media.addEventListener("change", apply);
}

async function prepareMocks(): Promise<void> {
  if (!USE_MOCK) return;
  const { startMockWorker } = await import("@/api/mock/browser");
  await startMockWorker();
  // 便于验收时确认当前是 mock 数据，而不是真实后端。
  console.info("[Aster] MSW mock 已启用；VITE_USE_MOCK=0 可关闭。");
}

async function bootstrap(): Promise<void> {
  applyColorScheme();
  try {
    await prepareMocks();
  } catch (error) {
    console.error("[Aster] mock 启动失败", error);
  }

  const Router = isNative() ? HashRouter : BrowserRouter;
  const container = document.getElementById("root");
  if (!container) throw new Error("找不到 #root 容器");

  createRoot(container).render(
    <StrictMode>
      <Router>
        <AppProviders>
          <App />
        </AppProviders>
      </Router>
    </StrictMode>,
  );
}

void bootstrap();
