import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowDown, RefreshCw, WifiOff } from "lucide-react";
import asterIdleUrl from "@/assets/companion/aster-idle.png";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { SseState } from "@/api/sse";
import { MainApprovalInline } from "@/features/approvals/ApprovalActionCard";
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
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 pb-6 pt-[96px] md:px-6 md:pt-[118px]">
      <div className="flex justify-end">
        <Skeleton className="h-10 w-48 rounded-[22px]" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4 rounded-lg" />
        <Skeleton className="h-4 w-2/3 rounded-lg" />
        <Skeleton className="h-4 w-1/2 rounded-lg" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-10 w-40 rounded-[22px]" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-4/5 rounded-lg" />
        <Skeleton className="h-4 w-3/5 rounded-lg" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center px-6 pt-16">
      <div className="max-w-sm text-center">
        <img
          src={asterIdleUrl}
          alt="Aster"
          className="mx-auto mb-3 size-16 object-contain opacity-90"
          draggable={false}
        />
        <h2 className="text-base font-semibold tracking-tight">开始对话</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          直接发一条消息，Aster 会随时响应并把执行状态清晰呈现给你。
        </p>
        <p className="mt-3 text-xs text-muted-foreground/80">
          输入框左下角可随时切换模型，也可发送{" "}
          <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono">$model</code> 命令。
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
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const scrollToBottom = (smooth = true) => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottom.current = true;
    setShowScrollBottom(false);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  };

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = distance < 140;
    setShowScrollBottom(distance > 220);

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
      <div className="flex h-full items-center justify-center px-6 pt-16">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <WifiOff className="size-5" />
          </div>
          <h2 className="text-base font-semibold">历史加载失败</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {errorMessage ?? "无法读取历史消息，请稍后重试。"}
          </p>
          <Button variant="outline" size="sm" className="mt-4 rounded-full" onClick={onRetryLoad}>
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
        <div className="pointer-events-none absolute inset-x-0 top-[88px] z-20 flex justify-center md:top-[108px]">
          <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-background/95 px-3 py-1 text-[11px] font-medium text-warning shadow-sm backdrop-blur">
            <Spinner className="size-3" />
            {sseState === "connecting" ? "正在连接实时通道…" : "连接中断，正在重连…"}
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-3xl space-y-5 px-4 pb-6 pt-[92px] md:px-6 md:pb-8 md:pt-[114px]">
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
                  <div className="flex justify-center py-1">
                    <span className="rounded-full bg-secondary px-3 py-1 text-[11px] font-medium text-muted-foreground">
                      {day}
                    </span>
                  </div>
                )}
                <MessageItem message={message} onRetry={onRetryMessage} />
              </Fragment>
            );
          })}

          {activeStatus === "running" && (
            <TypingIndicator modelLabel={activeModelLabel} />
          )}
          <MainApprovalInline />
          <div className="h-1" />
        </div>
      </div>

      {showScrollBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="animate-fade-up absolute bottom-3 left-1/2 z-20 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover/95 px-3.5 text-xs font-medium text-popover-foreground shadow-lg backdrop-blur transition-transform active:scale-95"
        >
          <ArrowDown className="size-3.5" />
          <span>回到底部</span>
        </button>
      )}
    </div>
  );
}
