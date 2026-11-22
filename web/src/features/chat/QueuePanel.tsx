import { useState } from "react";
import { Clock3, ListOrdered } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { QueuedRequest } from "@/api/types";
import { formatTime } from "@/lib/time";

type QueuePanelProps = {
  items: QueuedRequest[];
  activeStatus: "queued" | "running" | null;
  /** 服务端队列快照尚未确认的 promote 行（来自 store，queue.changed 时清除）。 */
  promoting: string[];
  onPromote: (item: QueuedRequest) => Promise<void>;
  onCancel: (item: QueuedRequest) => Promise<void>;
};

/**
 * 输入框上方的等待队列。只有运行中才允许「立即插入」；
 * 排队中/空闲时消息只能按 FIFO 等待（或取消）。
 */
export function QueuePanel({
  items,
  activeStatus,
  promoting,
  onPromote,
  onCancel,
}: QueuePanelProps) {
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  if (items.length === 0) return null;

  const canPromote = activeStatus === "running";

  const runCancel = async (item: QueuedRequest) => {
    if (cancellingId) return;
    setCancellingId(item.requestId);
    try {
      await onCancel(item);
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <section
      className="shrink-0 bg-background"
      aria-label="等待发送的消息"
    >
      <div className="mx-auto w-full max-w-3xl px-3 pb-1.5 pt-1 sm:px-6">
        <div className="rounded-2xl bg-secondary px-3 py-2">
          <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
            <ListOrdered className="size-3.5 text-primary" />
            队列 · {items.length} 条
          </div>
          <ul className="max-h-40 space-y-1.5 overflow-y-auto">
            {items.map((item) => {
              const promotingThis = promoting.includes(item.requestId);
              const cancelling = cancellingId === item.requestId;
              const busy = promotingThis || cancelling;
              return (
                <li
                  key={item.requestId}
                  className="rounded-xl bg-card px-3 py-2 shadow-2xs"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate text-xs text-card-foreground"
                      title={item.text}
                    >
                      {item.text}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">
                      {formatTime(item.createdAt)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Clock3 className="size-3" /> 排队中
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 rounded-full px-2.5 text-[11px]"
                        disabled={!canPromote || busy}
                        title={
                          canPromote
                            ? "立即插入当前对话"
                            : "当前没有运行中的回复"
                        }
                        onClick={() => void onPromote(item)}
                      >
                        {promotingThis && <Spinner className="size-3" />}
                        立即插入
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 rounded-full px-2.5 text-[11px] text-muted-foreground"
                        disabled={busy}
                        onClick={() => void runCancel(item)}
                      >
                        {cancelling && <Spinner className="size-3" />}
                        取消
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
