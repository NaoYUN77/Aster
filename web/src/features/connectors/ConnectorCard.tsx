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
    tone: "border-success/50 bg-success/5",
    icon: CircleCheck,
  },
  pending: {
    label: "等待授权…",
    variant: "warning" as const,
    tone: "border-warning/50 bg-warning/5",
    icon: Clock3,
  },
  disconnected: {
    label: "未连接",
    variant: "outline" as const,
    tone: "border-border bg-card",
    icon: Link2,
  },
  error: {
    label: "连接异常",
    variant: "destructive" as const,
    tone: "border-destructive/50 bg-destructive/5",
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
        "group flex w-full cursor-pointer flex-col gap-3 rounded-xl border p-4 text-left shadow-sm transition-colors",
        status.tone,
      )}
      onClick={handleCardClick}
      data-status={connector.status}
    >
      <div className="flex w-full items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-white p-1.5 shadow-xs">
          <img src={meta.icon} alt="" className="size-full object-contain" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{connector.name}</span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{meta.tagline}</p>
        </div>

        <button
          type="button"
          aria-label={`查看 ${connector.name} 详情`}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpen}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="flex w-full items-center gap-2 border-t border-border/60 pt-2.5">
        <Badge variant={status.variant} className="gap-1">
          <StatusIcon className="size-3" />
          {status.label}
        </Badge>

        <span className="ml-auto min-w-0 truncate text-right text-[11px] text-muted-foreground">
          {connector.status === "connected" && connector.account
            ? connector.account.label
            : connector.status === "pending"
              ? "在浏览器完成授权后自动刷新"
              : connector.status === "error"
                ? connector.lastError
                : "点击连接并在浏览器中授权"}
        </span>
      </div>

      <div className="flex w-full items-center justify-end gap-2">
        {connector.status === "pending" && manualAuthUrl && (
          <a
            href={manualAuthUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mr-auto text-[11px] font-medium text-primary underline underline-offset-2"
          >
            打开授权页
          </a>
        )}
        {connector.status === "connected" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 px-3 text-[11px]"
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
            className="h-8 px-3 text-[11px]"
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
            className="h-8 px-3 text-[11px]"
            disabled={busy}
            onClick={onConnect}
          >
            {connecting && <Spinner className="size-3" />}
            {connector.status === "error" ? "重试" : "连接"}
          </Button>
        )}
      </div>
    </div>
  );
}
