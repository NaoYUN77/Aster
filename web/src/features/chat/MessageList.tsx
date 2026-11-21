import { Fragment, useEffect, useRef } from "react";
import { MessageCircle, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { SseState } from "@/api/sse";
import { formatDayLabel } from "@/lib/time";
import { MessageItem, TypingIndicator } from "./MessageItem";
import type { DisplayMessage } from "./use-display-messages";

type MessageListProps = {
  messages: DisplayMessage[];
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  onRetryLoad: () => void;
  hasMore: boolean;
  isFetchingEarlier: boolean;
  onLoadEarlier: () => void;
  activeStatus: "queued" | "running" | null;
  activeModelLabel?: string;
  sseState: SseState;
  onRetryMessage: (message: DisplayMessage) => void;
};

function LoadingState() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
      <div className="flex justify-end">
        <Skeleton className="h-9 w-48 rounded-2xl" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-9 w-40 rounded-2xl" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <MessageCircle className="size-6" />
        </div>
        <h2 className="text-base font-semibold">开始对话</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          发一条文本消息，Aster 会把状态（排队 / 正在回复 / 完成 / 失败 / 已停止）显示在这里。
        </p>
        <p className="mt-3 text-xs text-muted-foreground/80">
          右上角可以查看并切换模型；也可在输入框发送 <code className="rounded bg-muted px-1 py-0.5 font-mono">$model</code> 命令。
        </p>
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  isLoading,
  isError,
  errorMessage,
  onRetryLoad,
  hasMore,
  isFetchingEarlier,
  onLoadEarlier,
  activeStatus,
  activeModelLabel,
  sseState,
  onRetryMessage,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = distance < 140;

    if (element.scrollTop < 64 && hasMore && !isFetchingEarlier) {
      prependAnchor.current = {
        height: element.scrollHeight,
        top: element.scrollTop,
      };
      onLoadEarlier();
    }
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    if (prependAnchor.current) {
      const { height, top } = prependAnchor.current;
      prependAnchor.current = null;
      element.scrollTop = top + (element.scrollHeight - height);
      return;
    }

    if (stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages.length, activeStatus]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [isLoading]);

  if (isLoading) return <LoadingState />;

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <WifiOff className="size-5" />
          </div>
          <h2 className="text-base font-semibold">历史加载失败</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {errorMessage ?? "无法读取历史消息，请稍后重试。"}
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={onRetryLoad}>
            <RefreshCw className="size-3.5" />
            重试
          </Button>
        </div>
      </div>
    );
  }

  if (messages.length === 0) return <EmptyState />;

  let previousDay = "";

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {(sseState === "reconnecting" || sseState === "connecting") && (
        <div className="flex items-center justify-center gap-2 border-b border-border/60 bg-warning/10 px-4 py-1.5 text-[11px] text-warning">
          <Spinner className="size-3" />
          {sseState === "connecting" ? "正在连接实时通道…" : "连接中断，正在重连…"}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-5">
          {isFetchingEarlier && (
            <div className="flex justify-center py-1">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          )}
          {!hasMore && messages.length > 12 && (
            <p className="pb-1 text-center text-[11px] text-muted-foreground/70">
              已到最早的消息
            </p>
          )}

          {messages.map((message) => {
            const day = formatDayLabel(message.createdAt);
            const showDay = day !== previousDay;
            previousDay = day;
            return (
              <Fragment key={message.id}>
                {showDay && (
                  <div className="flex items-center gap-3 py-1">
                    <span className="h-px flex-1 bg-border/60" />
                    <span className="text-[11px] text-muted-foreground">{day}</span>
                    <span className="h-px flex-1 bg-border/60" />
                  </div>
                )}
                <MessageItem message={message} onRetry={onRetryMessage} />
              </Fragment>
            );
          })}

          {activeStatus === "running" && (
            <TypingIndicator modelLabel={activeModelLabel} />
          )}
          <div className="h-1" />
        </div>
      </div>
    </div>
  );
}
