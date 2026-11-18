import { ChevronRight, CircleAlert, CircleCheck } from "lucide-react";
import type { Connector } from "@/api/connectors";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { connectorMeta } from "./catalog";

const STATUS_BADGE = {
  connected: { label: "已连接", variant: "success" as const },
  pending: { label: "等待授权", variant: "warning" as const },
  disconnected: { label: "未连接", variant: "outline" as const },
  error: { label: "需要重新授权", variant: "destructive" as const },
};

export function ConnectorCard({
  connector,
  loading,
  onOpen,
}: {
  connector: Connector;
  loading: boolean;
  onOpen: () => void;
}) {
  const meta = connectorMeta(connector.id);
  if (!meta) return null;

  const status = STATUS_BADGE[connector.status] ?? STATUS_BADGE.disconnected;
  const connected = connector.status === "connected";

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-colors",
        "hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
      aria-label={`${connector.name}：${status.label}`}
    >
      <div className="flex w-full items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-white p-1.5 shadow-xs">
          <img src={meta.icon} alt="" className="size-full object-contain" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{connector.name}</span>
            {connector.readOnly && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] leading-4">
                只读
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{meta.tagline}</p>
        </div>

        {loading ? (
          <Spinner className="mt-1 size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        )}
      </div>

      <div className="flex w-full items-center gap-2 border-t border-border/60 pt-2.5">
        <Badge variant={status.variant} className="gap-1">
          {connected && <CircleCheck className="size-3" />}
          {connector.status === "error" && <CircleAlert className="size-3" />}
          {status.label}
        </Badge>
        <span className="ml-auto min-w-0 truncate text-right text-[11px] text-muted-foreground">
          {connected && connector.account
            ? connector.account.label
            : connector.status === "pending"
              ? "等待浏览器授权"
              : connector.lastError
                ? connector.lastError
                : "点击连接"}
        </span>
      </div>
    </button>
  );
}
