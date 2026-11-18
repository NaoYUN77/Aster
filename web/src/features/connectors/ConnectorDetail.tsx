import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Info,
  Link2,
  Lock,
  ShieldCheck,
  Unplug,
  Zap,
} from "lucide-react";
import type { Connector } from "@/api/connectors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { connectorMeta } from "./catalog";
import {
  useConnectConnector,
  useDisconnectConnector,
  useRequestMockCredential,
} from "./use-connectors";

function formatConnectedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Connector 详情 / 授权面板。
 *
 * 点击连接后由 API 层创建连接并打开系统浏览器；OAuth 回调与 token
 * 都由服务端处理。本端只进入等待授权，以 SSE 或重新查询确认最终状态。
 */
export function ConnectorDetail({
  connector,
  open,
  onOpenChange,
  isMock,
}: {
  connector: Connector | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMock: boolean;
}) {
  const connect = useConnectConnector();
  const disconnect = useDisconnectConnector();
  const mockRequest = useRequestMockCredential();
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const connectorId = connector?.id ?? null;

  useEffect(() => {
    setConfirmingDisconnect(false);
  }, [connectorId, open]);

  // 跨端授权完成时（查询刷新后变成已连接）收起等待态。
  useEffect(() => {
    if (connector?.status === "connected") setConfirmingDisconnect(false);
  }, [connector?.status]);

  if (!connector) return null;

  const meta = connectorMeta(connector.id);
  const connected = connector.status === "connected";
  const busy = connect.isPending || disconnect.isPending;
  const awaiting =
    connector.status === "pending" ||
    (connect.data?.status === "pending" && !connected);
  const connectedAt = formatConnectedAt(connector.connectedAt);
  const permissions = connector.scopes.length > 0 ? connector.scopes : meta?.permissions ?? [];

  const handleConnect = () => {
    if (busy) return;
    connect.mutate(connector.id);
  };

  const handleDisconnect = () => {
    if (busy) return;
    if (!confirmingDisconnect) {
      setConfirmingDisconnect(true);
      return;
    }
    disconnect.mutate(connector.id, {
      onSuccess: () => {
        setConfirmingDisconnect(false);
        onOpenChange(false);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="flex items-start gap-3 pr-6">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-white p-2 shadow-xs">
            {meta ? (
              <img src={meta.icon} alt="" className="size-full object-contain" aria-hidden />
            ) : (
              <Link2 className="size-5 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              {connector.name}
              {connector.readOnly && (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px] leading-4">
                  只读
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
              {meta?.tagline ?? connector.description}
            </DialogDescription>
          </div>
          <Badge
            variant={
              connected
                ? "success"
                : connector.status === "error"
                  ? "destructive"
                  : connector.status === "pending"
                    ? "warning"
                    : "outline"
            }
            className="ml-auto shrink-0"
          >
            {connected
              ? "已连接"
              : connector.status === "error"
                ? "连接异常"
                : connector.status === "pending"
                  ? "等待授权"
                  : "未连接"}
          </Badge>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {connector.description || meta?.description}
        </p>

        {connector.lastError && (
          <p className="mt-3 rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
            {connector.lastError}
          </p>
        )}

        {connected && connector.account && (
          <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
            <div className="text-[11px] text-muted-foreground">已连接账号</div>
            <div className="mt-0.5 truncate font-mono text-sm">{connector.account.label}</div>
            {connector.account.detail && (
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {connector.account.detail}
              </div>
            )}
            {connectedAt && (
              <div className="mt-1 text-[11px] text-muted-foreground">连接于 {connectedAt}</div>
            )}
          </div>
        )}

        {awaiting && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-warning">
            <Info className="mt-0.5 size-3 shrink-0" />
            已发起授权，等待服务器确认。完成后三端都会自动显示已连接，无需重复登录。
          </p>
        )}

        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            {connected ? "已授予的权限" : "授权后可用"}
          </div>
          <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
            {permissions.map((permission) => (
              <li key={permission} className="flex items-start gap-1.5">
                <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-success/80" />
                <span className="break-all font-mono">{permission}</span>
              </li>
            ))}
          </ul>
          {connector.readOnly && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <Lock className="mt-0.5 size-3 shrink-0" />
              Gmail 本轮只读：不会发送、删除或修改你的邮件。
            </p>
          )}
        </div>

        <Separator className="my-4" />

        <div className="flex flex-col gap-2">
          {connected ? (
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={handleConnect} disabled={busy}>
                {connect.isPending ? <Spinner /> : <Link2 />}
                {connect.isPending ? "正在打开浏览器…" : "重新授权"}
              </Button>
              <Button
                variant="destructive"
                className={cn("flex-1", confirmingDisconnect && "ring-2 ring-destructive/30")}
                onClick={handleDisconnect}
                disabled={busy}
              >
                {disconnect.isPending ? <Spinner /> : <Unplug />}
                {confirmingDisconnect ? "确认断开" : "断开连接"}
              </Button>
            </div>
          ) : (
            <Button className="w-full" onClick={handleConnect} disabled={busy}>
              {connect.isPending ? <Spinner /> : <Link2 />}
              {connect.isPending
                ? "正在打开浏览器…"
                : connector.status === "pending"
                  ? "继续授权"
                  : connector.status === "error"
                    ? "重新授权"
                    : `连接 ${connector.name}`}
            </Button>
          )}

          {confirmingDisconnect && (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-[11px] leading-relaxed text-destructive">
                断开后相关工具将不可用，三端同时失效。
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingDisconnect(false)}
                disabled={disconnect.isPending}
              >
                取消
              </Button>
            </div>
          )}

          {isMock && (
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => mockRequest.mutate(connector.id)}
              disabled={mockRequest.isPending}
            >
              {mockRequest.isPending ? <Spinner /> : <Zap />}
              模拟凭据请求（Mock）
            </Button>
          )}

          <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
            授权由服务器加密保存，Web / 桌面 / 手机共用同一份连接。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
