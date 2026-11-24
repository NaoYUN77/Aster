import { Bell, CalendarClock, Clock3, Radar, RotateCcw, Square } from "lucide-react";
import asterIdleUrl from "@/assets/companion/aster-idle.png";
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
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 text-destructive">
        {errorText(code, message)}
      </span>
      {onRetry && (
        <Button variant="ghost" size="sm" className="h-8 rounded-full px-2.5 text-xs" onClick={onRetry}>
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
  // 工具元数据优先于 role：后端把工具结果投影成
  // `role:"assistant", text:"", tool:{...}`，不能当普通空气泡渲染。
  if (message.tool) {
    const tool = message.tool as {
      name: string;
      status: "done" | "failed";
      args?: unknown;
      input?: unknown;
      result?: unknown;
      output?: unknown;
    };
    return (
      <ToolRow
        name={tool.name}
        status={tool.status}
        args={tool.args ?? tool.input}
        result={tool.result ?? tool.output}
      />
    );
  }

  if (message.role === "system") {
    if (message.text.trim() === "") return null;
    const sourceMeta =
      message.hostSource === "routine"
        ? { label: "定时任务", Icon: CalendarClock }
        : message.hostSource === "watch"
          ? { label: "监控动态", Icon: Radar }
          : { label: "自动提醒", Icon: Bell };
    const SourceIcon = sourceMeta.Icon;
    return (
      <div className="flex items-start gap-2.5 animate-fade-up sm:gap-3">
        <img
          src={asterIdleUrl}
          alt="Aster"
          className="mt-0.5 size-7 shrink-0 select-none object-contain sm:size-8"
          draggable={false}
        />
        <div className="min-w-0 flex-1">
          <div className="max-w-full rounded-2xl border border-border/80 bg-secondary/55 px-3.5 py-2.5 text-foreground sm:max-w-[92%]">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Badge variant="outline" className="gap-1 rounded-full bg-card/80 px-2 py-0.5 text-[11px] font-medium text-primary">
                <SourceIcon className="size-3" />
                {sourceMeta.label}
              </Badge>
            </div>
            <Markdown text={message.text} />
          </div>
          {message.createdAt > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="font-mono">{formatTime(message.createdAt)}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.role === "user") {
    const pending = message.status === "sending" || message.status === "queued";
    return (
      <div className="flex flex-col items-end gap-1 animate-fade-up">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[22px] rounded-br-md bg-bubble-user px-4 py-2.5 text-[15px] leading-relaxed text-bubble-user-foreground sm:max-w-[74%]">
          {message.text}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 pr-1 text-[11px] text-muted-foreground">
          {message.steer && (
            <span className="rounded-full bg-accent px-1.5 py-0.5 font-medium text-accent-foreground">
              插话 · 本轮
            </span>
          )}
          {message.status === "sending" && (
            <span className="inline-flex items-center gap-1">
              <Spinner className="size-3" /> 发送中
            </span>
          )}
          {message.status === "queued" && (
            <span className="inline-flex items-center gap-1">
              <Clock3 className="size-3" /> 排队中
            </span>
          )}
          {message.status === "aborted" && <span>已停止</span>}
          <span className="font-mono">{formatTime(message.createdAt)}</span>
        </div>
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
      </div>
    );
  }

  const usage = message.usage;
  const modelLabel = message.model?.label ?? message.model?.id;
  const showAutoBadge = usage?.kind === "auto" && !usage.degraded;

  return (
    <div className="flex items-start gap-2.5 animate-fade-up sm:gap-3">
      <img
        src={asterIdleUrl}
        alt="Aster"
        className="mt-0.5 size-7 shrink-0 select-none object-contain sm:size-8"
        draggable={false}
      />
      <div className="min-w-0 flex-1">
        <div className="max-w-full text-foreground sm:max-w-[92%]">
          {usage && <DegradedNotice usage={usage} />}
          {message.text.trim() !== "" ? (
            <Markdown text={message.text} />
          ) : (
            <p className="text-sm text-muted-foreground">（无文本内容）</p>
          )}

          {message.status === "failed" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <span>{errorText(message.errorCode, message.errorMessage)}</span>
            </div>
          )}
          {message.status === "aborted" && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground">
              <Square className="size-3" />
              已停止
            </div>
          )}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {showAutoBadge && <Badge variant="auto">自动降级</Badge>}
          {modelLabel && (
            <span className="max-w-[16rem] truncate font-mono" title={message.model?.id ?? modelLabel}>
              {modelLabel}
            </span>
          )}
          {modelLabel && <span className="text-border">·</span>}
          <span className="font-mono">{formatTime(message.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

export function TypingIndicator({ modelLabel }: { modelLabel?: string }) {
  return (
    <div className="flex items-center gap-2.5 animate-fade-up sm:gap-3">
      <img
        src={asterIdleUrl}
        alt="Aster"
        className="size-7 shrink-0 select-none object-contain sm:size-8"
        draggable={false}
      />
      <div className="inline-flex items-center gap-2 rounded-full bg-secondary px-3.5 py-2">
        <span className="flex items-center gap-1">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className={cn("size-1.5 rounded-full bg-primary typing-dot")}
              style={{ animationDelay: `${index * 0.14}s` }}
            />
          ))}
        </span>
        <span className="text-xs font-medium text-muted-foreground">正在回复</span>
      </div>
      {modelLabel && (
        <span className="max-w-[12rem] truncate font-mono text-[11px] text-muted-foreground/75">
          {modelLabel}
        </span>
      )}
    </div>
  );
}
