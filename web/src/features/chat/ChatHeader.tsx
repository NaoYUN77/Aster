import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Asterisk, LogOut, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModelPicker } from "@/features/models/ModelPicker";
import { USE_MOCK } from "@/lib/env";
import { cn } from "@/lib/utils";
import { platformLabel } from "@/lib/platform";
import { useAuthStore } from "@/store/auth";
import { useChatStore } from "@/store/chat";

const CONNECTION_META = {
  open: { label: "已连接", dot: "bg-success", text: "text-muted-foreground" },
  connecting: { label: "连接中", dot: "bg-warning", text: "text-warning" },
  reconnecting: { label: "重连中", dot: "bg-warning", text: "text-warning" },
  closed: { label: "未连接", dot: "bg-destructive", text: "text-destructive" },
} as const;

export function ChatHeader() {
  const sseState = useChatStore((state) => state.sseState);
  const resetChat = useChatStore((state) => state.reset);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const meta = CONNECTION_META[sseState];
  const pulsing = sseState === "connecting" || sseState === "reconnecting";

  const handleLogout = async () => {
    await logout();
    resetChat();
    queryClient.clear();
    navigate("/login", { replace: true });
  };

  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur safe-top">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-3 sm:gap-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Asterisk className="size-4" strokeWidth={2.5} />
          </div>
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-[15px] font-semibold tracking-tight">Aster</span>
            {USE_MOCK && (
              <Badge variant="warning" className="hidden sm:inline-flex">
                Mock
              </Badge>
            )}
          </div>
        </div>

        <div
          className={cn(
            "hidden items-center gap-1.5 text-[11px] md:flex",
            meta.text,
          )}
          title={`实时通道：${meta.label}`}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              meta.dot,
              pulsing && "animate-pulse",
            )}
          />
          {meta.label}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <ModelPicker />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="rounded-full" aria-label="账号菜单">
                <Settings className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>{platformLabel()} · 单 owner</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate("/settings")}>
                <Settings className="size-3.5" />
                设置
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void handleLogout()}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="size-3.5" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
