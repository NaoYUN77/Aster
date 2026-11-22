import { useEffect, useState } from "react";
import { Info, Menu, Unplug } from "lucide-react";
import {
  connectorErrorText,
  type ConnectorId,
} from "@/api/connectors";
import { toApiError } from "@/api/errors";
import { useMobileNav } from "@/app/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { mergeCatalog } from "./catalog";
import { ConnectorCard } from "./ConnectorCard";
import { ConnectorDetail } from "./ConnectorDetail";
import {
  useCancelConnectorAuthorization,
  useConnectConnector,
  useConnectors,
  useDisconnectConnector,
} from "./use-connectors";

export function ConnectorsPage() {
  const { openMobileNav } = useMobileNav();
  const query = useConnectors();
  const connectMutation = useConnectConnector();
  const disconnectMutation = useDisconnectConnector();
  const cancelMutation = useCancelConnectorAuthorization();
  const [selectedId, setSelectedId] = useState<ConnectorId | null>(null);

  const handleConnect = (id: ConnectorId) => {
    if (connectMutation.isPending) return;
    connectMutation.mutate(id);
  };
  const handleDisconnect = (id: ConnectorId) => {
    if (disconnectMutation.isPending) return;
    disconnectMutation.mutate(id);
  };
  const handleCancel = (id: ConnectorId) => {
    if (cancelMutation.isPending) return;
    cancelMutation.mutate(id);
  };

  const connectors = mergeCatalog(query.data?.connectors ?? []);
  const connectedCount = connectors.filter((c) => c.status === "connected").length;
  const selected = connectors.find((connector) => connector.id === selectedId) ?? null;
  const loading = query.isPending;
  const apiError = query.error ? toApiError(query.error) : null;
  const disabled = apiError?.code === "CONNECTORS_DISABLED";
  const showCards = !disabled && !(query.isError && !query.data);

  // 从系统浏览器授权完回到 App 时主动对齐一次服务端状态。
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void query.refetch();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [query.refetch]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border bg-background/90 backdrop-blur safe-top">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2.5 px-3 sm:px-6">
          <button
            type="button"
            onClick={openMobileNav}
            className="flex size-10 items-center justify-center rounded-full bg-secondary text-foreground md:hidden"
            aria-label="打开导航"
          >
            <Menu className="size-5" />
          </button>
          <h1 className="text-base font-semibold tracking-tight">连接器</h1>
          <Badge variant="outline" className="shrink-0 whitespace-nowrap rounded-full">
            已连接 {connectedCount} / {connectors.length}
          </Badge>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-4 px-3 py-4 sm:px-6 sm:py-6">
          {query.isError && (
            <div className="flex items-start gap-2 rounded-2xl bg-destructive/10 px-4 py-3 text-xs text-destructive">
              {disabled ? (
                <Unplug className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <Info className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span className="flex-1">
                {connectorErrorText(apiError?.code)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 rounded-full px-2.5 text-destructive"
                onClick={() => void query.refetch()}
              >
                重试
              </Button>
            </div>
          )}

          {showCards && (
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              {loading
                ? [0, 1, 2].map((index) => (
                    <div
                      key={index}
                      className="rounded-3xl bg-secondary p-4"
                    >
                      <div className="flex items-start gap-3">
                        <Skeleton className="size-10 rounded-2xl" />
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-4 w-24" />
                          <Skeleton className="h-3 w-32" />
                        </div>
                      </div>
                      <Skeleton className="mt-5 h-8 w-20 rounded-full" />
                    </div>
                  ))
                : connectors.map((connector) => (
                    <ConnectorCard
                      key={connector.id}
                      connector={connector}
                      manualAuthUrl={
                        connectMutation.variables === connector.id
                          ? (connectMutation.data?.manualAuthUrl ?? null)
                          : null
                      }
                      connecting={
                        connectMutation.isPending &&
                        connectMutation.variables === connector.id
                      }
                      disconnecting={
                        disconnectMutation.isPending &&
                        disconnectMutation.variables === connector.id
                      }
                      cancelling={
                        cancelMutation.isPending &&
                        cancelMutation.variables === connector.id
                      }
                      onConnect={() => handleConnect(connector.id)}
                      onDisconnect={() => handleDisconnect(connector.id)}
                      onCancel={() => handleCancel(connector.id)}
                      onOpen={() => setSelectedId(connector.id)}
                    />
                  ))}
            </div>
          )}
        </div>
      </main>

      <ConnectorDetail
        connector={selected}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        isMock={query.data?.mock === true}
      />
    </div>
  );
}
