import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import asterIdleUrl from "@/assets/companion/aster-idle.png";
import {
  resolveApproval,
  type ApprovalDecision,
  type ApprovalRequestView,
} from "@/api/approvals";
import { errorText, toApiError } from "@/api/errors";
import { Spinner } from "@/components/ui/spinner";
import { playCue } from "@/lib/sound";
import { cn } from "@/lib/utils";
import { useApprovalStore } from "@/store/approvals";

export const APPROVAL_RULE_COPY: Record<
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

export function formatApprovalArgs(toolName: string, args: unknown): string {
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

export function useCountdownClock(expiresAt: string | null) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return { clock: "0:00", urgent: false };
  const expiresMs = Date.parse(expiresAt);
  const remainingMs = Number.isFinite(expiresMs) ? Math.max(0, expiresMs - now) : 0;
  const seconds = Math.ceil(remainingMs / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return { clock, urgent: remainingMs > 0 && remainingMs <= 60_000 };
}

/**
 * 三处审批入口（Main 对话内联 / Sub-agent 行内展开 / 跨页悬浮胶囊）共用的
 * Meta Muse 审批操作内核：单层柔和参数块 + 极紧凑 `h-8` 轻量原因输入 + 三动作按钮。
 */
export function ApprovalActionBody({
  approval,
  showReasonLine = true,
  onResolved,
}: {
  approval: ApprovalRequestView;
  showReasonLine?: boolean;
  onResolved?: () => void;
}) {
  const removeApproval = useApprovalStore((state) => state.remove);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const copy = APPROVAL_RULE_COPY[approval.rule];

  useEffect(() => {
    setReason("");
    setSubmitting(null);
  }, [approval.id]);

  const handleDecision = async (decision: ApprovalDecision) => {
    if (submitting !== null) return;
    setSubmitting(decision);
    try {
      await resolveApproval(approval.id, {
        decision,
        ...(decision === "deny" && reason.trim() !== "" ? { reason: reason.trim() } : {}),
      });
      removeApproval(approval.id);
      onResolved?.();
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
        removeApproval(approval.id);
        onResolved?.();
        toast.info("该审批请求已处理或已过期");
      } else {
        toast.error(errorText(apiErr.code, apiErr.message));
      }
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="space-y-2.5">
      {showReasonLine && (
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {approval.reason}
        </p>
      )}

      <div className="rounded-xl bg-muted/85 px-3.5 py-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
          <span className="font-mono font-medium text-foreground/75">{approval.toolName}</span>
          <span className="text-warning">{copy.tag}</span>
        </div>
        <pre className="m-0 max-h-36 overflow-auto font-mono text-[12px] leading-relaxed text-foreground whitespace-pre-wrap break-all">
          {formatApprovalArgs(approval.toolName, approval.args)}
        </pre>
      </div>

      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="可选：补充拒绝原因，告诉 Aster 改用什么方案…"
        disabled={submitting !== null}
        className="h-8 w-full rounded-xl border border-transparent bg-muted/60 px-3 text-xs text-foreground placeholder:text-muted-foreground/70 transition-colors focus:border-border focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
      />

      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <button
          type="button"
          disabled={submitting !== null}
          onClick={() => void handleDecision("deny")}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
        >
          {submitting === "deny" && <Spinner className="size-3" />}
          拒绝
        </button>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => void handleDecision("approve_similar")}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-secondary px-3.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/75 disabled:opacity-50"
          >
            {submitting === "approve_similar" && <Spinner className="size-3" />}
            本次同类免批
          </button>
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => void handleDecision("approve_once")}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-primary px-4 text-xs font-medium text-primary-foreground shadow-2xs transition-opacity hover:opacity-92 disabled:opacity-50"
          >
            {submitting === "approve_once" && <Spinner className="size-3" />}
            批准一次
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 非阻塞可折叠审批胶囊（默认单行收起，点击就地展开，支持 `< 1 / N >` 多条切换）。
 */
export function ApprovalCapsuleItem({
  approvals,
  defaultExpanded = false,
  trailingLink,
  className,
}: {
  approvals: ApprovalRequestView[];
  defaultExpanded?: boolean;
  trailingLink?: React.ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [index, setIndex] = useState(0);

  const safeIndex = approvals.length === 0 ? 0 : Math.min(index, approvals.length - 1);
  const current = approvals[safeIndex] ?? null;
  const { clock, urgent } = useCountdownClock(current?.expiresAt ?? null);

  useEffect(() => {
    if (approvals.length === 0) {
      setExpanded(defaultExpanded);
      setIndex(0);
    }
  }, [approvals.length, defaultExpanded]);

  if (!current) return null;

  const copy = APPROVAL_RULE_COPY[current.rule];
  const callerTag =
    current.caller.kind === "main"
      ? "Main"
      : `Sub-agent · ${current.caller.subagentId}`;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm transition-all",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3.5 py-2 text-xs">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="size-2 shrink-0 rounded-full bg-warning animate-pulse" aria-hidden />
          <span className="truncate font-medium text-foreground">
            需要审批 · <span className="font-mono">{current.toolName}</span>
          </span>
          <span className="hidden shrink-0 text-warning sm:inline">（{copy.tag}）</span>
        </button>

        <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          {approvals.length > 1 && (
            <div className="inline-flex items-center gap-0.5 rounded-full bg-secondary px-1.5 py-0.5 text-[11px] tabular-nums">
              <button
                type="button"
                aria-label="上一条审批"
                onClick={() => setIndex((prev) => (prev - 1 + approvals.length) % approvals.length)}
                className="rounded-full p-0.5 hover:bg-card hover:text-foreground"
              >
                <ChevronLeft className="size-3" />
              </button>
              <span className="px-0.5">
                {safeIndex + 1} / {approvals.length}
              </span>
              <button
                type="button"
                aria-label="下一条审批"
                onClick={() => setIndex((prev) => (prev + 1) % approvals.length)}
                className="rounded-full p-0.5 hover:bg-card hover:text-foreground"
              >
                <ChevronRight className="size-3" />
              </button>
            </div>
          )}

          <span
            className={cn(
              "font-mono text-[11px] tabular-nums",
              urgent ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            {clock}
          </span>

          {trailingLink}

          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-secondary"
          >
            <span>{expanded ? "收起" : "查看"}</span>
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/70 px-3.5 pb-3.5 pt-3">
          {current.caller.kind === "subagent" && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <span className="rounded-full bg-secondary px-2 py-0.5 font-medium text-foreground/80">
                {callerTag}
              </span>
              <span className="truncate">{current.caller.task}</span>
            </div>
          )}
          <ApprovalActionBody approval={current} />
        </div>
      )}
    </div>
  );
}

/**
 * Main Agent 触发的敏感操作审批：直接内联呈现在对话流底部（无遮罩、不阻塞滚动与输入），
 * 处理完毕后自动消失，交给正常工具执行流接棒。
 */
export function MainApprovalInline() {
  const pending = useApprovalStore((state) => state.pending);
  const mainApprovals = pending.filter((item) => item.caller.kind === "main");

  if (mainApprovals.length === 0) return null;

  return (
    <div className="animate-fade-up flex items-start gap-2.5" role="region" aria-label="主对话敏感操作审批">
      <img
        src={asterIdleUrl}
        alt="Aster"
        className="mt-1 size-7 shrink-0 select-none object-contain"
        draggable={false}
      />
      <div className="min-w-0 flex-1 max-w-xl">
        <ApprovalCapsuleItem approvals={mainApprovals} defaultExpanded={false} />
      </div>
    </div>
  );
}
