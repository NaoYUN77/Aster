import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { setUnauthorizedHandler } from "@/api/client";
import { ChatPage } from "@/features/chat/ChatPage";
import { useChatEvents } from "@/features/chat/use-chat-events";
import { LoginPage } from "@/features/auth/LoginPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { SetupPage } from "@/features/settings/SetupPage";
import { platform } from "@/lib/platform";
import { useAuthStore } from "@/store/auth";
import { useChatStore } from "@/store/chat";
import { useConnectionStore } from "@/store/connection";
import { Splash } from "./Splash";

let lastUnauthorizedAt = 0;

/** 引导超过这个时间就放弃等待，避免壳层停在启动页。 */
const BOOTSTRAP_TIMEOUT_MS = 4_000;

function useBootstrap(): boolean {
  const bootstrapConnection = useConnectionStore((state) => state.bootstrap);
  const bootstrapAuth = useAuthStore((state) => state.bootstrap);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const finish = () => {
      if (!cancelled) setReady(true);
    };
    const fallback = (error?: unknown) => {
      if (error !== undefined) console.warn("[Aster] 启动引导失败，进入服务器配置", error);
      // 存储/网络卡住时不能一直停在启动页：原生壳进入 /setup 重新配置服务器；
      // Web 同源、没有可配置的地址，直接去登录页（否则会和 SetupPage 互相重定向）。
      useConnectionStore.setState({ ready: true, needsServer: platform() !== "web" });
      useAuthStore.setState({
        status: "anonymous",
        token: null,
        ownerId: null,
        expiresAt: null,
      });
      finish();
    };

    void (async () => {
      // 不用 Promise.allSettled：它是 ES2020 运行时 API，旧 WebView 没有。
      const boot = Promise.all([bootstrapConnection(), bootstrapAuth()]);
      const timeout = new Promise<"timeout">((resolve) => {
        window.setTimeout(() => resolve("timeout"), BOOTSTRAP_TIMEOUT_MS);
      });

      try {
        const outcome = await Promise.race([boot, timeout]);
        if (outcome === "timeout") fallback();
        else finish();
      } catch (error) {
        fallback(error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bootstrapAuth, bootstrapConnection]);

  return ready;
}

function RequireAuth() {
  const status = useAuthStore((state) => state.status);
  const needsServer = useConnectionStore((state) => state.needsServer);

  if (needsServer) return <Navigate to="/setup" replace />;
  if (status !== "authenticated") return <Navigate to="/login" replace />;
  return <AuthenticatedShell />;
}

/** 登录后常驻：SSE 在聊天页与设置页之间保持连接，避免切页断流。 */
function AuthenticatedShell() {
  useChatEvents();
  return <Outlet />;
}

export function App() {
  const ready = useBootstrap();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      const now = Date.now();
      if (now - lastUnauthorizedAt < 3000) return;
      lastUnauthorizedAt = now;
      void useAuthStore.getState().invalidate();
      useChatStore.getState().reset();
      toast.error("登录已失效，请重新登录");
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  if (!ready) return <Splash />;

  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<ChatPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      {/* RequireAuth 内部渲染 AuthenticatedShell + Outlet，两页共用同一个 SSE 连接。 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
