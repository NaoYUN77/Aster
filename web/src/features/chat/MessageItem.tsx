import { Clock3, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/api/errors";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/time";
import { DegradedNotice } from "@/features/models/DegradedNotice";
import { Markdown } from "./Markdown";
import { ToolRow } from "./ToolRow";
import type { DisplayMessage } from "./use-display-messages";

function ErrorLine({
  code,
  message,
  onRetry,
}: {
  code: string | null;
  message: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center justify-end gap-2 text-xs">
      <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-destructive">
        {errorText(code, message)}
      </span>
      {onRetry && (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onRetry}>
          <RotateCcw className="size-3" />
          重试
        </Button>
      )}
    </div>
  );
}

export function MessageItem({
  message,
  onRetry,
}: {
  message: DisplayMessage;
  onRetry: (message: DisplayMessage) => void;
}) {
  if (message.role === "system") {
    if (message.tool) {
      return <ToolRow name={message.tool.name} status={message.tool.status} />;
    }
    if (message.text.trim() === "") return null;
    return (
      <p className="my-2 text-center text-xs text-muted-foreground">{message.text}</p>
    );
  }

  if (message.role === "user") {
    const pending = message.status === "sending" || message.status === "queued";
    return (
      <div className="flex flex-col items-end gap-1 animate-fade-up">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-bubble-user px-4 py-2.5 text-[15px] leading-relaxed text-bubble-user-foreground shadow-sm">
          {message.text}
        </div>
        {message.status === "sending" && (
          <span className="flex items-center gap-1 pr-1 text-[11px] text-muted-foreground">
            <Spinner className="size-3" /> 发送中
          </span>
        )}
        {message.status === "queued" && (
          <span className="flex items-center gap-1 pr-1 text-[11px] text-muted-foreground">
            <Clock3 className="size-3" /> 排队中
          </span>
        )}
        {message.status === "failed" && (
          <ErrorLine
            code={message.errorCode}
            message={message.errorMessage}
            // 超长需要用户先改内容，重试同样的文本没有意义。
            onRetry={
              pending || message.errorCode === "TEXT_TOO_LONG"
                ? undefined
                : () => onRetry(message)
            }
          />
        )}
        {message.status === "aborted" && (
          <span className="pr-1 text-[11px] text-muted-foreground">已停止</span>
        )}
      </div>
    );
  }

  const usage = message.usage;
  const modelLabel = message.model?.name ?? message.model?.label;
  const showAutoBadge = usage?.kind === "auto" && !usage.degraded;

  return (
    <div className="flex flex-col gap-1 animate-fade-up">
      <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-card px-4 py-3 text-card-foreground shadow-sm ring-1 ring-border/70">
        {usage && <DegradedNotice usage={usage} />}
        {message.text.trim() !== "" ? (
          <Markdown text={message.text} />
        ) : (
          <p className="text-sm text-muted-foreground">（无文本内容）</p>
        )}

        {message.status === "failed" && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive">
            <span>{errorText(message.errorCode, message.errorMessage)}</span>
          </div>
        )}
        {message.status === "aborted" && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Square className="size-3" />
            已停止
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pl-1 text-[11px] text-muted-foreground">
        {showAutoBadge && <Badge variant="auto">自动降级</Badge>}
        {modelLabel && (
          <span className="max-w-[16rem] truncate font-mono" title={message.model?.id ?? modelLabel}>
            {modelLabel}
          </span>
        )}
        {modelLabel && <span className="text-border">·</span>}
        <span>{formatTime(message.createdAt)}</span>
      </div>
    </div>
  );
}

export function TypingIndicator({ modelLabel }: { modelLabel?: string }) {
  return (
    <div className="flex items-center gap-2 animate-fade-up">
      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-card px-4 py-3 shadow-sm ring-1 ring-border/70">
        <span className="flex items-center gap-1">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className={cn("size-1.5 rounded-full bg-muted-foreground/70 typing-dot")}
              style={{ animationDelay: `${index * 0.14}s` }}
            />
          ))}
        </span>
        <span className="text-xs text-muted-foreground">正在回复</span>
      </div>
      {modelLabel && (
        <span className="max-w-[12rem] truncate font-mono text-[11px] text-muted-foreground/70">
          {modelLabel}
        </span>
      )}
    </div>
  );
}
