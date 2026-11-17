import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  LogOut,
  PlugZap,
  Server,
  Smartphone,
  UserRound,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { platformLabel, isNative } from "@/lib/platform";
import { formatExpiry } from "@/lib/time";
import { useAuthStore } from "@/store/auth";
import { useChatStore } from "@/store/chat";
import {
  useConnectionStore,
  type ConnectionTestResult,
} from "@/store/connection";
import { ServerAddressForm } from "./ServerAddressForm";

const SSE_LABEL = {
  open: "已连接",
  connecting: "连接中",
  reconnecting: "重连中",
  closed: "未连接",
} as const;

function Section({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const testConnection = useConnectionStore((state) => state.testConnection);
  const ownerId = useAuthStore((state) => state.ownerId);
  const expiresAt = useAuthStore((state) => state.expiresAt);
  const logout = useAuthStore((state) => state.logout);
  const resetChat = useChatStore((state) => state.reset);
  const sseState = useChatStore((state) => state.sseState);

  const [editingServer, setEditingServer] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testConnection());
    } finally {
      setTesting(false);
    }
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
      resetChat();
      queryClient.clear();
      navigate("/login", { replace: true });
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="min-h-full bg-background">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur safe-top">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center gap-2 px-3 sm:px-5">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")} aria-label="返回聊天">
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-base font-semibold">设置</h1>
          <Badge variant="outline" className="ml-auto">
            {platformLabel()}
          </Badge>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl space-y-3 px-3 py-4 sm:px-5">
        <Section icon={<Server className="size-4" />} title="服务器">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2.5 py-2 font-mono text-xs">
              {baseUrl || "未配置"}
            </code>
            {isNative() ? (
              <Button variant="outline" size="sm" onClick={() => setEditingServer(true)}>
                修改地址
              </Button>
            ) : (
              <Badge variant="outline">Web 同源</Badge>
            )}
          </div>
          {!isNative() && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Web 端由 Caddy 同源提供，不允许在设置页改地址。
            </p>
          )}

          <Separator className="my-3" />

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              实时通道：
              <span className={sseState === "open" ? "text-success" : "text-warning"}>
                {SSE_LABEL[sseState]}
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => void runTest()}
              disabled={testing || baseUrl === ""}
            >
              {testing ? <Spinner /> : <PlugZap className="size-3.5" />}
              测试连接
            </Button>
          </div>

          {testResult && (
            <div
              className={
                testResult.ok
                  ? "mt-2 flex items-start gap-2 rounded-md bg-success/10 px-2.5 py-2 text-xs text-success"
                  : "mt-2 flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
              }
            >
              {testResult.ok ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span>
                {testResult.ok
                  ? `连接成功 · 服务版本 ${testResult.version} · ${testResult.latencyMs} ms`
                  : `连接失败：${testResult.message}`}
              </span>
            </div>
          )}
        </Section>

        <Section icon={<UserRound className="size-4" />} title="账号">
          <dl className="space-y-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Owner</dt>
              <dd className="truncate font-mono">{ownerId || "owner"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">登录有效期至</dt>
              <dd className="font-mono">{expiresAt ? formatExpiry(expiresAt) : "—"}</dd>
            </div>
          </dl>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3 w-full"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
          >
            {loggingOut ? <Spinner /> : <LogOut className="size-3.5" />}
            退出登录
          </Button>
        </Section>

        <Section icon={<Smartphone className="size-4" />} title="关于">
          <dl className="space-y-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">客户端</dt>
              <dd>Aster Web · v1</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">运行平台</dt>
              <dd>{platformLabel()}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">模型目录</dt>
              <dd className="font-mono">/api/v1/models</dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            单 owner 自托管。v1 不提供多用户、Hub、Live2D、头像或贴纸入口。模型选择与
            <code className="mx-1 rounded bg-muted px-1 font-mono">$model</code>
            共用同一套实时目录与降级策略。
          </p>
        </Section>
      </main>

      <Dialog open={editingServer} onOpenChange={setEditingServer}>
        <DialogContent>
          <DialogTitle className="mb-3 text-base font-semibold">修改服务器地址</DialogTitle>
          <ServerAddressForm
            initialUrl={baseUrl}
            submitLabel="保存"
            onSaved={() => setEditingServer(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
