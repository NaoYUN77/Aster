import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Info,
  Settings,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import {
  connectorErrorText,
  type ConnectorId,
} from "@/api/connectors";
import { toApiError } from "@/api/errors";
import { SoundToggle } from "@/components/SoundToggle";
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
  const navigate = useNavigate();
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
    <div className="min-h-full bg-background">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur safe-top">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center gap-2 px-3 sm:px-5">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")} aria-label="返回聊天">
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-base font-semibold">连接器</h1>
          <Badge variant="outline" className="ml-1">
            7 个连接器
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <SoundToggle />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => navigate("/settings")}
              aria-label="设置"
            >
              <Settings className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl space-y-3 px-3 py-4 sm:px-5">
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <ShieldCheck className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">一次授权，三端复用</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                在任意一端完成授权后，服务器会加密保存连接。Web、桌面和手机会显示同一个
                “已连接”状态，不需要在每一端重复登录 Aster 或重复授权。
              </p>
            </div>
          </div>
        </section>

        {query.isError && (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
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
              className="h-6 px-2 text-destructive"
              onClick={() => void query.refetch()}
            >
              重试
            </Button>
          </div>
        )}

        {showCards && (
          <div className="grid gap-3 sm:grid-cols-2">
            {loading
              ? [0, 1].map((index) => (
                  <div
                    key={index}
                    className="rounded-xl border border-border bg-card p-4 shadow-sm"
                  >
                    <div className="flex items-start gap-3">
                      <Skeleton className="size-10 rounded-lg" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-3 w-32" />
                      </div>
                    </div>
                    <Skeleton className="mt-4 h-5 w-20" />
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

        <section className="rounded-xl border border-border bg-card p-4 text-[11px] leading-relaxed text-muted-foreground shadow-sm">
          <p>
            工具不会一次性列出：需要时由 Aster 通过 <code className="rounded bg-muted px-1 font-mono">tool_search</code>{" "}
            按需加载，这里只管理连接状态。
          </p>
          <p className="mt-2">
            Gmail 与 Outlook 只读邮件，Linear 只读 Issue，Notion 只读页面与数据库，
            Google Calendar / Drive 只读日历与文件。以上均不提供写入、发送、删除或修改入口。
            断开连接后，相关工具会立即在三端失效。
          </p>
          <p className="mt-2">
            授权会在系统浏览器中完成；回到 App 后状态由服务器推送或重新查询刷新。
          </p>
        </section>
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
