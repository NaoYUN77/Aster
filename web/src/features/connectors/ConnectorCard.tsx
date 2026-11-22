import type { MouseEvent } from "react";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Link2,
} from "lucide-react";
import type { Connector } from "@/api/connectors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { connectorMeta } from "./catalog";

const STATUS_BADGE = {
  connected: {
    label: "已连接",
    variant: "success" as const,
    tone: "bg-secondary ring-1 ring-success/25",
    icon: CircleCheck,
  },
  pending: {
    label: "等待授权…",
    variant: "warning" as const,
    tone: "bg-secondary ring-1 ring-warning/30",
    icon: Clock3,
  },
  disconnected: {
    label: "未连接",
    variant: "outline" as const,
    tone: "bg-secondary",
    icon: Link2,
  },
  error: {
    label: "连接异常",
    variant: "destructive" as const,
    tone: "bg-secondary ring-1 ring-destructive/30",
    icon: CircleAlert,
  },
};

export function ConnectorCard({
  connector,
  manualAuthUrl = null,
  connecting = false,
  disconnecting = false,
  cancelling = false,
  onConnect,
  onDisconnect,
  onCancel,
  onOpen,
}: {
  connector: Connector;
  /** Web 弹窗被拦截时由调用方传入，用户可手动点击打开授权页。 */
  manualAuthUrl?: string | null;
  connecting?: boolean;
  disconnecting?: boolean;
  cancelling?: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onCancel: () => void;
  onOpen: () => void;
}) {
  const meta = connectorMeta(connector.id);
  if (!meta) return null;

  const status = STATUS_BADGE[connector.status] ?? STATUS_BADGE.disconnected;
  const StatusIcon = status.icon;
  const busy = connecting || disconnecting || cancelling;

  const handleCardClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (connector.status === "disconnected" || connector.status === "error") {
      onConnect();
    } else {
      onOpen();
    }
  };

  return (
    <div
      className={cn(
        "group flex w-full cursor-pointer flex-col justify-between gap-3.5 rounded-3xl p-4 text-left transition-all hover:brightness-[0.985] dark:hover:brightness-110",
        status.tone,
      )}
      onClick={handleCardClick}
      data-status={connector.status}
    >
      <div>
        <div className="flex w-full items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-border bg-white p-2 shadow-2xs">
            <img src={meta.icon} alt="" className="size-full object-contain" aria-hidden />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold">{connector.name}</span>
              <Badge variant={status.variant} className="shrink-0 gap-1 whitespace-nowrap rounded-full">
                <StatusIcon className="size-3 shrink-0" />
                {status.label}
              </Badge>
            </div>
            <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
              {connector.status === "connected" && connector.account
                ? connector.account.label
                : connector.status === "pending"
                  ? "在浏览器完成授权后自动刷新"
                  : connector.status === "error"
                    ? connector.lastError
                    : "未授权"}
            </p>
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {meta.tagline}
        </p>
      </div>

      <div className="flex w-full items-center justify-between gap-2 pt-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label={`查看 ${connector.name} 详情`}
            className="inline-flex h-9 items-center gap-0.5 rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground sm:h-8"
            onClick={onOpen}
          >
            <span>详情</span>
            <ChevronRight className="size-3.5" />
          </button>

          {connector.status === "pending" && manualAuthUrl && (
            <a
              href={manualAuthUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-xs font-medium text-primary underline underline-offset-2"
            >
              打开授权页
            </a>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {connector.status === "connected" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 rounded-full bg-card px-4 text-xs shadow-2xs sm:h-8 sm:px-3.5"
              disabled={busy}
              onClick={onDisconnect}
            >
              {disconnecting && <Spinner className="size-3" />}
              断开
            </Button>
          ) : connector.status === "pending" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 rounded-full bg-card px-4 text-xs shadow-2xs sm:h-8 sm:px-3.5"
              disabled={busy}
              onClick={onCancel}
            >
              {cancelling && <Spinner className="size-3" />}
              取消
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              className="h-9 rounded-full px-4 text-xs sm:h-8"
              disabled={busy}
              onClick={onConnect}
            >
              {connecting && <Spinner className="size-3" />}
              {connector.status === "error" ? "重试" : "连接"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
