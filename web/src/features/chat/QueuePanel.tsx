import { useState } from "react";
import { Clock3, ListOrdered } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { QueuedRequest } from "@/api/types";
import { formatTime } from "@/lib/time";

type QueuePanelProps = {
  items: QueuedRequest[];
  activeStatus: "queued" | "running" | null;
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
  onPromote,
  onCancel,
}: QueuePanelProps) {
  const [pending, setPending] = useState<{
    requestId: string;
    action: "promote" | "cancel";
  } | null>(null);

  if (items.length === 0) return null;

  const canPromote = activeStatus === "running";

  const run = async (item: QueuedRequest, action: "promote" | "cancel") => {
    if (pending) return;
    setPending({ requestId: item.requestId, action });
    try {
      await (action === "promote" ? onPromote(item) : onCancel(item));
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      className="border-t border-border/70 bg-muted/20"
      aria-label="等待发送的消息"
    >
      <div className="mx-auto w-full max-w-3xl px-3 pb-2 pt-2">
        <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
          <ListOrdered className="size-3.5" />
          队列 · {items.length} 条
        </div>
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {items.map((item) => {
            const busy = pending?.requestId === item.requestId;
            return (
              <li
                key={item.requestId}
                className="rounded-lg border border-border/70 bg-card px-2.5 py-1.5 shadow-sm"
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
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock3 className="size-3" /> 排队中
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={!canPromote || busy}
                      title={
                        canPromote
                          ? "立即插入当前对话"
                          : "当前没有运行中的回复"
                      }
                      onClick={() => void run(item, "promote")}
                    >
                      {busy && pending.action === "promote" && (
                        <Spinner className="size-3" />
                      )}
                      立即插入
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px] text-muted-foreground"
                      disabled={busy}
                      onClick={() => void run(item, "cancel")}
                    >
                      {busy && pending.action === "cancel" && (
                        <Spinner className="size-3" />
                      )}
                      取消
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
