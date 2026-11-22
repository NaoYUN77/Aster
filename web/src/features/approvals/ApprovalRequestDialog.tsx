import { useEffect, useState } from "react";
import { toast } from "sonner";
import asterIdleUrl from "@/assets/companion/aster-idle.png";
import {
  resolveApproval,
  type ApprovalDecision,
  type ApprovalRequestView,
} from "@/api/approvals";
import { errorText, toApiError } from "@/api/errors";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  SheetContent,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { playCue } from "@/lib/sound";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { useApprovalStore } from "@/store/approvals";

const RULE_COPY: Record<
  ApprovalRequestView["rule"],
  { title: string; tag: string }
> = {
  destructive_shell: { title: "确认执行这条命令？", tag: "危险 Shell 命令" },
  workspace_escape: { title: "确认写入工作区外？", tag: "工作区越界写入" },
  external_write: { title: "确认执行外部写操作？", tag: "外部写操作" },
  subagent_write_escalation: {
    title: "确认授权子任务写入？",
    tag: "Sub-agent 写权限越界",
  },
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

  const copy = RULE_COPY[current.rule];
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
        toast.info("已拒绝该操作");
      } else {
        playCue("success");
        toast.success(
          decision === "approve_similar" ? "已批准（本次任务同类免批）" : "已批准执行",
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
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      {/* Meta Muse quiet eyebrow: source + timer + queue counter */}
      <div className="flex items-center justify-between gap-3 text-[12px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
          <span className="truncate font-medium text-foreground/80">{callerLabel}</span>
          <span className="opacity-40">·</span>
          <span
            className={cn(
              "font-mono tabular-nums",
              urgent ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            {clock}
          </span>
        </div>
        {pendingList.length > 1 && (
          <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            1 / {pendingList.length}
          </span>
        )}
      </div>

      {/* Hero: floating 3D Aster companion + serene editorial headline */}
      <div className="flex items-start gap-3.5">
        <img
          src={asterIdleUrl}
          alt="Aster"
          className="size-11 shrink-0 select-none object-contain"
          draggable={false}
        />
        <div className="min-w-0 flex-1 pt-0.5">
          <DialogTitle className="text-[17px] font-semibold tracking-[-0.015em] text-foreground">
            {copy.title}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {current.reason}
          </DialogDescription>
          {current.caller.kind === "subagent" && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
              子任务：<span className="text-foreground/85">{current.caller.task}</span>
            </p>
          )}
        </div>
      </div>

      {/* Single soft tonal surface — no nested border clutter */}
      <div className="rounded-2xl bg-muted/80 px-4 py-3.5">
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
          <span className="font-mono font-medium text-foreground/75">{current.toolName}</span>
          <span className="text-warning">{copy.tag}</span>
        </div>
        <pre className="m-0 max-h-44 overflow-auto font-mono text-[12.5px] leading-relaxed text-foreground whitespace-pre-wrap break-all">
          {formatArgs(current.toolName, current.args)}
        </pre>
      </div>

      {/* Whisper-quiet optional deny note */}
      <input
        id="approval-deny-reason"
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="可选：补充拒绝原因，告诉 Aster 改用什么方案…"
        disabled={submitting !== null}
        className="w-full rounded-2xl border border-transparent bg-muted/55 px-3.5 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/70 transition-colors focus:border-border focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
      />

      {/* Muse action bar: quiet deny on left, soft secondary + Meta Blue primary on right */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <button
          type="button"
          disabled={submitting !== null}
          onClick={() => void handleDecision("deny")}
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
        >
          {submitting === "deny" && <Spinner className="size-3.5" />}
          拒绝
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => void handleDecision("approve_similar")}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-secondary px-4 text-[13px] font-medium text-secondary-foreground transition-colors hover:bg-secondary/75 disabled:opacity-50"
          >
            {submitting === "approve_similar" && <Spinner className="size-3.5" />}
            本次同类免批
          </button>
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => void handleDecision("approve_once")}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-primary px-5 text-[13px] font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-92 disabled:opacity-50"
          >
            {submitting === "approve_once" && <Spinner className="size-3.5" />}
            批准一次
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <Dialog open={true}>
      {isDesktop ? (
        <DialogContent
          hideClose
          overlayClassName="bg-black/25 backdrop-blur-md"
          className="max-w-[460px] rounded-[28px] border border-border/80 bg-card p-6 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.18)] sm:p-7"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          {body}
        </DialogContent>
      ) : (
        <SheetContent
          overlayClassName="bg-black/25 backdrop-blur-md"
          className="rounded-t-[28px] border-t border-border/80 bg-card px-5 pb-[max(env(safe-area-inset-bottom),20px)] pt-3 shadow-[0_-16px_48px_-12px_rgba(0,0,0,0.16)]"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="pt-2">{body}</div>
        </SheetContent>
      )}
    </Dialog>
  );
}
