import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, KeyRound, Lock, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  SheetContent,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { playCue } from "@/lib/sound";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { useCredentialStore } from "@/store/credential";

/**
 * 全局凭据弹窗：仅由 mock 的 `POST /api/v1/mock/credential-request`
 * 触发的 SSE `credential.request` 打开。真实 OAuth 连接器不会产生该事件。
 *
 * 本组件不再调用不存在的 `/api/v1/credential-requests/*`；输入内容
 * 不会提交到任何服务器，也不会写入 localStorage/sessionStorage。
 */
export function CredentialRequestDialog() {
  const pending = useCredentialStore((state) => state.pending);
  const isDesktop = useMediaQuery("(min-width: 640px)");

  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const settledRef = useRef<string | null>(null);
  const totalRef = useRef(0);
  const lastIdRef = useRef<string | null>(null);

  const requestId = pending?.requestId ?? null;

  // 新请求：重置输入、错误与倒计时基准。
  useEffect(() => {
    if (!pending) {
      lastIdRef.current = null;
      totalRef.current = 0;
      setToken("");
      setErrorMessage(null);
      setSubmitting(false);
      return;
    }
    if (lastIdRef.current === pending.requestId) return;
    lastIdRef.current = pending.requestId;
    settledRef.current = null;
    totalRef.current = Math.max(pending.expiresAt - Date.now(), 1);
    setToken("");
    setErrorMessage(null);
    setSubmitting(false);
    setNow(Date.now());
  }, [pending]);

  // 倒计时；回到前台时立即校正（MVP 的前台恢复）。
  useEffect(() => {
    if (!pending) return;
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 500);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
    };
  }, [pending]);

  const cancel = (reason: "denied" | "cancelled" | "timeout") => {
    const current = useCredentialStore.getState().pending;
    if (!current) return;
    if (settledRef.current === current.requestId) return;
    settledRef.current = current.requestId;

    useCredentialStore.getState().clear(current.requestId);
    setToken("");

    if (reason === "timeout") {
      playCue("error");
      toast.info("凭据请求已超时", {
        description: "本次 Mock 请求已结束",
      });
    } else if (reason === "denied") {
      toast.info("已拒绝这次 Mock 凭据请求");
    }
  };

  const remainingMs = pending ? pending.expiresAt - now : 0;
  const expired = pending !== null && remainingMs <= 0;

  useEffect(() => {
    if (!expired) return;
    void cancel("timeout");
    // cancel 读取 store 中的最新 pending，并带 settledRef 去重。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const current = useCredentialStore.getState().pending;
    if (!current || submitting) return;

    const value = token.trim();
    if (value === "") {
      setErrorMessage("请输入访问令牌");
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    settledRef.current = current.requestId;
    useCredentialStore.getState().clear(current.requestId);
    setToken("");
    setSubmitting(false);
    playCue("success");
    toast.success("Mock 凭据请求已完成", {
      description: "输入内容未提交到服务器，也未保存在本设备",
    });
  };

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    void cancel("cancelled");
  };

  const totalMs = totalRef.current > 0 ? totalRef.current : 120_000;
  const ratio = Math.max(0, Math.min(1, remainingMs / totalMs));
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const urgent = remainingMs > 0 && remainingMs <= 30_000;

  const body = pending && (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-3 pr-6">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
          <ShieldAlert className="size-5" />
        </div>
        <div className="min-w-0">
          <DialogTitle className="text-base font-semibold">Mock 凭据请求</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed text-muted-foreground">
            这是 mock 服务为 <span className="font-medium text-foreground">{pending.tool}</span>{" "}
            触发的测试弹窗。真实 OAuth 连接器不会产生此请求。
          </DialogDescription>
        </div>
      </div>

      <div className="mt-4 space-y-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">连接器</span>
          <span className="font-medium">{pending.connector.name}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">工具</span>
          <code className="truncate font-mono text-[11px]">{pending.tool}</code>
        </div>
        {pending.accountHint && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">账号</span>
            <span className="truncate font-mono text-[11px]">{pending.accountHint}</span>
          </div>
        )}
        {pending.reason && (
          <p className="border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">
            {pending.reason}
          </p>
        )}
      </div>

      {pending.scopes.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">需要的权限</div>
          <div className="flex flex-wrap gap-1.5">
            {pending.scopes.map((scope) => (
              <Badge key={scope} variant="outline" className="font-mono text-[10px]">
                {scope}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">剩余时间</span>
          <span
            className={cn("font-mono tabular-nums", urgent ? "text-destructive" : "text-muted-foreground")}
            aria-live="polite"
          >
            {clock}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500 ease-linear",
              urgent ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      </div>

      <form onSubmit={(event) => void handleSubmit(event)} className="mt-4 space-y-2">
        <label htmlFor="credential-token" className="text-[11px] font-medium text-muted-foreground">
          访问令牌（仅 Mock）
        </label>
        <Input
          id="credential-token"
          name="credential-token"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="粘贴或输入令牌"
          aria-invalid={errorMessage !== null}
          disabled={submitting}
          autoFocus
        />

        {errorMessage && (
          <p className="flex items-start gap-1.5 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            {errorMessage}
          </p>
        )}

        <p className="flex items-start gap-1.5 rounded-md bg-muted/50 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <Lock className="mt-0.5 size-3 shrink-0" />
          <span>
            Mock 模式：输入内容不会提交到服务器，也不会保存在本设备或写入日志。
          </span>
        </p>

        <Button type="submit" className="w-full" disabled={submitting || token.trim() === ""}>
          {submitting ? <Spinner /> : <KeyRound />}
          完成 Mock 请求
        </Button>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            disabled={submitting}
            onClick={() => void cancel("denied")}
          >
            拒绝
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="flex-1"
            disabled={submitting}
            onClick={() => void cancel("cancelled")}
          >
            取消
          </Button>
        </div>
      </form>
    </div>
  );

  const open = pending !== null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {isDesktop ? (
        <DialogContent
          className="z-[70] max-h-[92dvh] max-w-md overflow-y-auto"
          overlayClassName="z-[70]"
        >
          {body}
        </DialogContent>
      ) : (
        <SheetContent className="z-[70] max-h-[92dvh]" overlayClassName="z-[70]">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3">{body}</div>
        </SheetContent>
      )}
    </Dialog>
  );
}
