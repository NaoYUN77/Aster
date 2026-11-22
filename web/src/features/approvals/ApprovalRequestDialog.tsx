import { useEffect, useState } from "react";
import { Bot, Check, CheckCheck, ShieldAlert, Terminal, X } from "lucide-react";
import { toast } from "sonner";
import {
  resolveApproval,
  type ApprovalDecision,
  type ApprovalRequestView,
} from "@/api/approvals";
import { errorText, toApiError } from "@/api/errors";
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
import { useApprovalStore } from "@/store/approvals";

const RULE_LABELS: Record<ApprovalRequestView["rule"], string> = {
  destructive_shell: "危险 Shell 命令",
  workspace_escape: "工作区越界写入",
  external_write: "外部写操作",
  subagent_write_escalation: "Sub-agent 写权限越界",
};

function formatArgs(toolName: string, args: unknown): string {
  if (
    toolName === "bash" &&
    args !== null &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    typeof (args as { command?: unknown }).command === "string"
  ) {
    return (args as { command: string }).command;
  }
  try {
    return JSON.stringify(args ?? {}, null, 2);
  } catch {
    return String(args ?? "");
  }
}

export function ApprovalRequestDialog() {
  const pendingList = useApprovalStore((state) => state.pending);
  const removeApproval = useApprovalStore((state) => state.remove);
  const current = pendingList[0] ?? null;
  const isDesktop = useMediaQuery("(min-width: 640px)");

  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setReason("");
    setSubmitting(null);
    setNow(Date.now());
  }, [current?.id]);

  useEffect(() => {
    if (!current) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [current]);

  if (!current) return null;

  const expiresMs = Date.parse(current.expiresAt);
  const remainingMs = Number.isFinite(expiresMs) ? Math.max(0, expiresMs - now) : 0;
  const seconds = Math.ceil(remainingMs / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const urgent = remainingMs > 0 && remainingMs <= 60_000;

  const callerLabel =
    current.caller.kind === "main"
      ? "Main Agent"
      : `Sub-agent · ${current.caller.subagentId}`;

  const handleDecision = async (decision: ApprovalDecision) => {
    if (submitting !== null) return;
    setSubmitting(decision);
    try {
      await resolveApproval(current.id, {
        decision,
        ...(decision === "deny" && reason.trim() !== "" ? { reason: reason.trim() } : {}),
      });
      removeApproval(current.id);
      if (decision === "deny") {
        toast.info("已拒绝敏感操作");
      } else {
        playCue("success");
        toast.success(
          decision === "approve_similar" ? "已批准（本次任务同类免批）" : "已批准一次",
        );
      }
    } catch (error) {
      const apiErr = toApiError(error);
      if (apiErr.status === 404 || apiErr.status === 409) {
        removeApproval(current.id);
        toast.info("该审批请求已处理或已过期");
      } else {
        toast.error(errorText(apiErr.code, apiErr.message));
      }
    } finally {
      setSubmitting(null);
    }
  };

  const body = (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-start gap-3 pr-6">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
          <ShieldAlert className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle className="text-base font-semibold">敏感操作审批</DialogTitle>
            {pendingList.length > 1 && (
              <Badge variant="warning" className="whitespace-nowrap">
                待处理 1 / {pendingList.length}
              </Badge>
            )}
          </div>
          <DialogDescription className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {current.reason}
          </DialogDescription>
        </div>
      </div>

      <div className="space-y-2.5 rounded-2xl border border-border bg-muted/40 p-3.5 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="gap-1 whitespace-nowrap">
              <Bot className="size-3" />
              {callerLabel}
            </Badge>
            <Badge variant="outline" className="gap-1 whitespace-nowrap font-mono">
              <Terminal className="size-3" />
              {current.toolName}
            </Badge>
            <Badge variant="warning" className="whitespace-nowrap">
              {RULE_LABELS[current.rule]}
            </Badge>
          </div>
          <span
            className={cn(
              "font-mono text-[11px] tabular-nums",
              urgent ? "font-semibold text-destructive" : "text-muted-foreground",
            )}
          >
            剩余 {clock}
          </span>
        </div>

        {current.caller.kind === "subagent" && (
          <div className="text-[11px] text-muted-foreground">
            子任务目标：<span className="text-foreground">{current.caller.task}</span>
          </div>
        )}

        <pre className="max-h-48 overflow-auto rounded-xl border border-border/80 bg-background/90 p-2.5 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-all">
          {formatArgs(current.toolName, current.args)}
        </pre>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="approval-deny-reason" className="text-xs text-muted-foreground">
          拒绝原因（可选，将反馈给 Agent 以便改用安全方案）
        </label>
        <Input
          id="approval-deny-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="例如：不要删目录，只清理 .tmp 文件"
          disabled={submitting !== null}
          className="rounded-2xl"
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          disabled={submitting !== null}
          onClick={() => void handleDecision("deny")}
          className="rounded-full"
        >
          {submitting === "deny" ? <Spinner className="size-3.5" /> : <X className="size-3.5" />}
          拒绝
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={submitting !== null}
          onClick={() => void handleDecision("approve_similar")}
          className="rounded-full"
        >
          {submitting === "approve_similar" ? (
            <Spinner className="size-3.5" />
          ) : (
            <CheckCheck className="size-3.5" />
          )}
          本次任务同类免批
        </Button>
        <Button
          type="button"
          disabled={submitting !== null}
          onClick={() => void handleDecision("approve_once")}
          className="rounded-full"
        >
          {submitting === "approve_once" ? (
            <Spinner className="size-3.5" />
          ) : (
            <Check className="size-3.5" />
          )}
          批准一次
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog open={true}>
      {isDesktop ? (
        <DialogContent
          className="max-w-lg rounded-3xl p-6"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          {body}
        </DialogContent>
      ) : (
        <SheetContent
          className="rounded-t-3xl p-5"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          {body}
        </SheetContent>
      )}
    </Dialog>
  );
}
