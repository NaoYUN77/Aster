import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { setUnauthorizedHandler } from "@/api/client";
import { ChatPage } from "@/features/chat/ChatPage";
import { useChatEvents } from "@/features/chat/use-chat-events";
import { LoginPage } from "@/features/auth/LoginPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { SetupPage } from "@/features/settings/SetupPage";
import { useAuthStore } from "@/store/auth";
import { useChatStore } from "@/store/chat";
import { useConnectionStore } from "@/store/connection";
import { Splash } from "./Splash";

let lastUnauthorizedAt = 0;

function useBootstrap(): boolean {
  const bootstrapConnection = useConnectionStore((state) => state.bootstrap);
  const bootstrapAuth = useAuthStore((state) => state.bootstrap);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await bootstrapConnection();
      await bootstrapAuth();
      if (!cancelled) setReady(true);
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
