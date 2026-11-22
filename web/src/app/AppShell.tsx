import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Link2,
  LogOut,
  MessageCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sun,
  X,
} from "lucide-react";
import asterIdleUrl from "@/assets/companion/aster-idle.png";
import { SoundToggle } from "@/components/SoundToggle";
import { Badge } from "@/components/ui/badge";
import { useConnectors } from "@/features/connectors/use-connectors";
import { USE_MOCK } from "@/lib/env";
import { platformLabel } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth";
import { useChatStore } from "@/store/chat";
import { useThemeStore } from "@/store/theme";

const CONNECTION_META = {
  open: { label: "已连接", dot: "bg-success", text: "text-muted-foreground" },
  connecting: { label: "连接中", dot: "bg-warning", text: "text-warning" },
  reconnecting: { label: "重连中", dot: "bg-warning", text: "text-warning" },
  closed: { label: "未连接", dot: "bg-destructive", text: "text-destructive" },
} as const;

type MobileNavContextValue = {
  openMobileNav: () => void;
};

const MobileNavContext = createContext<MobileNavContextValue>({
  openMobileNav: () => {},
});

export function useMobileNav() {
  return useContext(MobileNavContext);
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const sseState = useChatStore((state) => state.sseState);
  const resetChat = useChatStore((state) => state.reset);
  const logout = useAuthStore((state) => state.logout);
  const resolvedTheme = useThemeStore((state) => state.resolved);
  const toggleTheme = useThemeStore((state) => state.toggle);
  const connectorsQuery = useConnectors();

  const connectedCount =
    connectorsQuery.data?.connectors.filter((c) => c.status === "connected")
      .length ?? 0;

  const conn = CONNECTION_META[sseState];
  const pulsing = sseState === "connecting" || sseState === "reconnecting";

  const handleNav = (to: string) => {
    setMobileOpen(false);
    navigate(to);
  };

  const handleLogout = async () => {
    setMobileOpen(false);
    await logout();
    resetChat();
    queryClient.clear();
    navigate("/login", { replace: true });
  };

  const navItems = [
    { path: "/", label: "对话", icon: MessageCircle, badge: null as number | null },
    {
      path: "/connectors",
      label: "连接器",
      icon: Link2,
      badge: connectedCount > 0 ? connectedCount : null,
    },
    { path: "/settings", label: "设置", icon: Settings, badge: null as number | null },
  ];

  const isActive = (path: string) =>
    path === "/" ? location.pathname === "/" : location.pathname.startsWith(path);

  return (
    <MobileNavContext.Provider value={{ openMobileNav: () => setMobileOpen(true) }}>
      <div className="flex h-full min-h-0 w-full overflow-hidden bg-background text-foreground">
        {/* Desktop / Web Meta Muse Left Sidebar */}
        <aside
          className={cn(
            "hidden h-full shrink-0 flex-col border-r border-border bg-muted/70 transition-[width] duration-200 md:flex",
            collapsed ? "w-16" : "w-[232px]",
          )}
        >
          <div
            className={cn(
              "flex h-14 items-center px-3",
              collapsed ? "justify-center" : "justify-between",
            )}
          >
            {!collapsed && (
              <button
                type="button"
                onClick={() => handleNav("/")}
                className="flex min-w-0 items-center gap-2 rounded-full py-1 pr-2 text-left transition-opacity hover:opacity-80"
              >
                <img
                  src={asterIdleUrl}
                  alt="Aster"
                  className="size-7 shrink-0 object-contain"
                  draggable={false}
                />
                <span className="truncate text-[15px] font-semibold tracking-tight">
                  Aster
                </span>
                {USE_MOCK && (
                  <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                    Mock
                  </Badge>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
              aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
              title={collapsed ? "展开侧栏" : "收起侧栏"}
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </button>
          </div>

          <nav className="flex-1 space-y-1 px-2.5 py-2" aria-label="主导航">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);
              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => handleNav(item.path)}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-full text-[13.5px] font-medium transition-all",
                    collapsed ? "h-10 justify-center px-0" : "h-10 px-3.5",
                    active
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  {!collapsed && (
                    <>
                      <span className="min-w-0 flex-1 truncate text-left">
                        {item.label}
                      </span>
                      {item.badge !== null && (
                        <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-foreground">
                          {item.badge}
                        </span>
                      )}
                    </>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="border-t border-border p-2.5">
            {!collapsed ? (
              <div className="flex items-center justify-between gap-2 rounded-2xl bg-card px-3 py-2 shadow-2xs">
                <div
                  className={cn("flex min-w-0 items-center gap-1.5 text-xs", conn.text)}
                  title={`实时通道：${conn.label} · ${platformLabel()}`}
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      conn.dot,
                      pulsing && "animate-pulse",
                    )}
                  />
                  <span className="truncate">{conn.label}</span>
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={toggleTheme}
                    className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    aria-label={resolvedTheme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
                    title={resolvedTheme === "dark" ? "浅色模式" : "深色模式"}
                  >
                    {resolvedTheme === "dark" ? (
                      <Sun className="size-3.5" />
                    ) : (
                      <Moon className="size-3.5" />
                    )}
                  </button>
                  <SoundToggle className="size-7 rounded-full" />
                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    aria-label="退出登录"
                    title="退出登录"
                  >
                    <LogOut className="size-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-1">
                <span
                  className={cn("size-2.5 rounded-full", conn.dot, pulsing && "animate-pulse")}
                  title={`实时通道：${conn.label}`}
                />
                <button
                  type="button"
                  onClick={toggleTheme}
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                  aria-label={resolvedTheme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
                  title={resolvedTheme === "dark" ? "浅色模式" : "深色模式"}
                >
                  {resolvedTheme === "dark" ? (
                    <Sun className="size-4" />
                  ) : (
                    <Moon className="size-4" />
                  )}
                </button>
                <SoundToggle className="size-8 rounded-full" />
              </div>
            )}
          </div>
        </aside>

        {/* Main View Area */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>

        {/* Mobile Slide-Over Navigation Drawer */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-50 flex bg-black/35 backdrop-blur-[1px] md:hidden"
            onClick={(event) => {
              if (event.target === event.currentTarget) setMobileOpen(false);
            }}
          >
            <div className="flex h-full w-[272px] max-w-[82vw] flex-col bg-background shadow-2xl safe-top safe-bottom">
              <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
                <div className="flex items-center gap-2.5">
                  <img
                    src={asterIdleUrl}
                    alt="Aster"
                    className="size-8 shrink-0 object-contain"
                    draggable={false}
                  />
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[15px] font-semibold tracking-tight">Aster</span>
                      {USE_MOCK && (
                        <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                          Mock
                        </Badge>
                      )}
                    </div>
                    <div className={cn("mt-0.5 flex items-center gap-1.5 text-[11px]", conn.text)}>
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          conn.dot,
                          pulsing && "animate-pulse",
                        )}
                      />
                      <span>
                        {conn.label} · {platformLabel()}
                      </span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileOpen(false)}
                  className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                  aria-label="关闭导航"
                >
                  <X className="size-4" />
                </button>
              </div>

              <nav className="flex-1 space-y-1 p-3" aria-label="移动导航">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.path);
                  return (
                    <button
                      key={item.path}
                      type="button"
                      onClick={() => handleNav(item.path)}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 rounded-2xl px-3.5 text-sm font-medium transition-colors",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground/80 hover:bg-secondary",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {item.label}
                      </span>
                      {item.badge !== null && (
                        <span className="rounded-full bg-card px-2 py-0.5 text-[11px] font-semibold text-foreground shadow-2xs">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>

              <div className="border-t border-border p-3 space-y-1.5">
                <div className="flex items-center justify-between rounded-2xl bg-secondary px-3.5 py-2">
                  <span className="text-xs font-medium text-muted-foreground">外观</span>
                  <button
                    type="button"
                    onClick={toggleTheme}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full bg-card px-3 text-xs font-medium text-foreground shadow-2xs"
                  >
                    {resolvedTheme === "dark" ? (
                      <>
                        <Sun className="size-3.5" />
                        <span>切换浅色</span>
                      </>
                    ) : (
                      <>
                        <Moon className="size-3.5" />
                        <span>切换深色</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="flex items-center justify-between rounded-2xl bg-secondary px-3.5 py-2">
                  <span className="text-xs font-medium text-muted-foreground">提示音</span>
                  <SoundToggle className="size-9 rounded-full" />
                </div>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-destructive/10 text-sm font-medium text-destructive transition-colors hover:bg-destructive/15"
                >
                  <LogOut className="size-4" />
                  <span>退出登录</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </MobileNavContext.Provider>
  );
}
