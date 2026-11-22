import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  Check,
  CheckCircle2,
  Copy,
  Link2,
  LogOut,
  Menu,
  PlugZap,
  Server,
  Smartphone,
  UserRound,
  Volume2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useMobileNav } from "@/app/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useConnectors } from "@/features/connectors/use-connectors";
import { isNative, platformLabel } from "@/lib/platform";
import { playCue } from "@/lib/sound";
import { formatExpiry } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth";
import { useChatStore } from "@/store/chat";
import {
  useConnectionStore,
  type ConnectionTestResult,
} from "@/store/connection";
import { useNotificationStore } from "@/store/notifications";
import { useSoundStore } from "@/store/sound";
import { useThemeStore, type ThemeMode } from "@/store/theme";
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
    <section className="rounded-3xl bg-secondary p-5">
      <h2 className="mb-3.5 flex items-center gap-2 text-sm font-semibold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function SettingsPage() {
  const { openMobileNav } = useMobileNav();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const testConnection = useConnectionStore((state) => state.testConnection);
  const ownerId = useAuthStore((state) => state.ownerId);
  const expiresAt = useAuthStore((state) => state.expiresAt);
  const logout = useAuthStore((state) => state.logout);
  const resetChat = useChatStore((state) => state.reset);
  const sseState = useChatStore((state) => state.sseState);
  const muted = useSoundStore((state) => state.muted);
  const toggleSound = useSoundStore((state) => state.toggle);
  const notifyEnabled = useNotificationStore((state) => state.enabled);
  const notifyPermission = useNotificationStore((state) => state.permission);
  const requestNotifyPermission = useNotificationStore((state) => state.requestPermission);
  const setNotifyEnabled = useNotificationStore((state) => state.setEnabled);
  const sendNotification = useNotificationStore((state) => state.notify);
  const themeMode = useThemeStore((state) => state.mode);
  const setThemeMode = useThemeStore((state) => state.setMode);
  const connectorsQuery = useConnectors();

  const [editingServer, setEditingServer] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const connectedConnectors =
    connectorsQuery.data?.connectors.filter((c) => c.status === "connected") ?? [];

  const copyServerUrl = async () => {
    if (!baseUrl) return;
    try {
      await navigator.clipboard.writeText(baseUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 1600);
    } catch {
      /* 忽略剪贴板权限错误 */
    }
  };

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
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border bg-background/90 backdrop-blur safe-top">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-2.5 px-3 sm:px-6">
          <button
            type="button"
            onClick={openMobileNav}
            className="flex size-10 items-center justify-center rounded-full bg-secondary text-foreground md:hidden"
            aria-label="打开导航"
          >
            <Menu className="size-5" />
          </button>
          <h1 className="text-base font-semibold tracking-tight">设置</h1>
          <Badge variant="outline" className="ml-auto rounded-full">
            {platformLabel()}
          </Badge>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-3 py-4 sm:px-6 sm:py-6">
          <div className="grid gap-4 md:grid-cols-2">
            <Section icon={<Server className="size-4" />} title="服务器与实时通道">
              <div className="flex items-center gap-2 rounded-2xl bg-card p-2 shadow-2xs">
                <code
                  className="min-w-0 flex-1 truncate px-1.5 font-mono text-xs"
                  title={baseUrl || "未配置"}
                >
                  {baseUrl || "未配置"}
                </code>
                {baseUrl && (
                  <button
                    type="button"
                    onClick={() => void copyServerUrl()}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="复制服务器地址"
                    title="复制地址"
                  >
                    {copiedUrl ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                  </button>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      sseState === "open" ? "bg-success" : "bg-warning",
                    )}
                  />
                  实时通道：{SSE_LABEL[sseState]}
                </span>
                <div className="flex items-center gap-1.5">
                  {isNative() && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 rounded-full bg-card px-3.5 text-xs shadow-2xs sm:h-8"
                      onClick={() => setEditingServer(true)}
                    >
                      修改地址
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-full bg-card px-3.5 text-xs shadow-2xs sm:h-8"
                    onClick={() => void runTest()}
                    disabled={testing || baseUrl === ""}
                  >
                    {testing ? <Spinner /> : <PlugZap className="size-3.5" />}
                    测试连接
                  </Button>
                </div>
              </div>

              {testResult && (
                <div
                  className={
                    testResult.ok
                      ? "mt-3 flex items-start gap-2 rounded-2xl bg-success/10 px-3 py-2 text-xs text-success"
                      : "mt-3 flex items-start gap-2 rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive"
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

            <Section icon={<Volume2 className="size-4" />} title="外观与提示音">
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium">界面主题</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      支持浅色、深色或跟随系统切换
                    </p>
                  </div>
                  <div className="inline-flex shrink-0 items-center rounded-full bg-card p-1 shadow-2xs">
                    {(
                      [
                        { id: "light", label: "浅色" },
                        { id: "dark", label: "深色" },
                        { id: "system", label: "系统" },
                      ] as Array<{ id: ThemeMode; label: string }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setThemeMode(opt.id)}
                        className={cn(
                          "h-7 rounded-full px-2.5 text-xs font-medium transition-colors",
                          themeMode === opt.id
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-border pt-3.5">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium">回复与授权提示音</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      需要令牌、授权完成或出错时本地合成提醒
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!muted}
                    onClick={() => {
                      const willUnmute = muted;
                      toggleSound();
                      if (willUnmute) playCue("success");
                    }}
                    className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full bg-card py-1 pl-3 pr-1.5 shadow-2xs transition-colors sm:min-h-9"
                  >
                    <span
                      className={cn(
                        "text-xs font-medium",
                        !muted ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {!muted ? "开启" : "关闭"}
                    </span>
                    <span
                      className={cn(
                        "flex h-5 w-9 items-center rounded-full p-0.5 transition-colors",
                        !muted ? "justify-end bg-primary" : "justify-start bg-border",
                      )}
                    >
                      <span className="size-4 rounded-full bg-white shadow-xs" />
                    </span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-[13.5px] font-medium">系统提醒弹窗</p>
                      <span className="rounded-full bg-card px-2 py-0.5 text-[11px] text-muted-foreground shadow-2xs">
                        {notifyPermission === "granted"
                          ? notifyEnabled
                            ? "已开启"
                            : "已暂停"
                          : notifyPermission === "denied"
                            ? "系统已拒绝"
                            : notifyPermission === "unsupported"
                              ? "当前不支持"
                              : "未授权"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      后台或切走窗口时，在浏览器 / Windows 右下角 / 手机通知栏弹出提醒
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {notifyPermission === "granted" ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-9 rounded-full bg-card px-3 text-xs shadow-2xs sm:h-8"
                          onClick={async () => {
                            const ok = await sendNotification({
                              priority: "high",
                              cue: "attention",
                              title: "Aster 测试提醒",
                              body: "系统提醒弹窗与提示音已就绪，点击可回到对话页。",
                              forceSystem: true,
                            });
                            if (ok) toast.success("已发送测试系统通知");
                            else toast.info("系统通知当前处于暂停或不可用状态");
                          }}
                        >
                          <Bell className="size-3.5" />
                          测试通知
                        </Button>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={notifyEnabled}
                          onClick={() => setNotifyEnabled(!notifyEnabled)}
                          className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full bg-card py-1 pl-3 pr-1.5 shadow-2xs transition-colors sm:min-h-9"
                        >
                          <span
                            className={cn(
                              "text-xs font-medium",
                              notifyEnabled ? "text-primary" : "text-muted-foreground",
                            )}
                          >
                            {notifyEnabled ? "开启" : "关闭"}
                          </span>
                          <span
                            className={cn(
                              "flex h-5 w-9 items-center rounded-full p-0.5 transition-colors",
                              notifyEnabled ? "justify-end bg-primary" : "justify-start bg-border",
                            )}
                          >
                            <span className="size-4 rounded-full bg-white shadow-xs" />
                          </span>
                        </button>
                      </>
                    ) : notifyPermission === "default" ? (
                      <Button
                        type="button"
                        size="sm"
                        className="h-9 rounded-full px-3.5 text-xs sm:h-8"
                        onClick={async () => {
                          const perm = await requestNotifyPermission();
                          if (perm === "granted") {
                            playCue("success");
                            toast.success("已开启系统提醒通知");
                          } else if (perm === "denied") {
                            toast.info("权限被拒绝，可在浏览器或系统设置中重新允许");
                          }
                        }}
                      >
                        <Bell className="size-3.5" />
                        申请通知权限
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </Section>

            <Section icon={<Link2 className="size-4" />} title="连接器">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {connectedConnectors.length > 0
                  ? `已连接 ${connectedConnectors.length} 项：${connectedConnectors.map((c) => c.name).join(" · ")}`
                  : "尚未连接外部账号，可在连接器页按需授权。"}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4 h-10 w-full rounded-full bg-card text-xs shadow-2xs sm:h-9"
                onClick={() => navigate("/connectors")}
              >
                <Link2 className="size-3.5" />
                管理连接器
              </Button>
            </Section>

            <Section icon={<UserRound className="size-4" />} title="账号与客户端">
              <dl className="space-y-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Owner</dt>
                  <dd className="truncate font-mono">{ownerId || "owner"}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">登录有效期至</dt>
                  <dd className="font-mono">{expiresAt ? formatExpiry(expiresAt) : "—"}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">运行平台</dt>
                  <dd className="inline-flex items-center gap-1">
                    <Smartphone className="size-3 text-muted-foreground" />
                    {platformLabel()}
                  </dd>
                </div>
              </dl>
              <Button
                variant="destructive"
                size="sm"
                className="mt-4 h-10 w-full rounded-full text-xs sm:h-9"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
              >
                {loggingOut ? <Spinner /> : <LogOut className="size-3.5" />}
                退出登录
              </Button>
            </Section>
          </div>
        </div>
      </main>

      <Dialog open={editingServer} onOpenChange={setEditingServer}>
        <DialogContent className="rounded-3xl">
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
