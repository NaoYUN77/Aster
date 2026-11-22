import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SendMode } from "./use-chat-actions";

const MAX_CHARS = 32_000;

type ComposerProps = {
  onSend: (text: string, mode: SendMode) => Promise<boolean>;
  onStop: () => void;
  activeStatus: "queued" | "running" | null;
  /** 输入框左下角插槽（例如内嵌模型选择器），保持 Composer 单测可独立渲染。 */
  leftSlot?: ReactNode;
};

/** Enter = 排队，Ctrl/⌘+Enter = 立即插入，Shift+Enter = 换行。 */
export function sendModeForKey(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): SendMode | null {
  if (event.key !== "Enter" || event.shiftKey) return null;
  return event.ctrlKey || event.metaKey ? "steer" : "queue";
}

/**
 * 输入区右侧按钮组：
 * - 运行中且有输入：停止 +「排队」+「立即插入」；
 * - 排队中：停止 + 单个发送（继续入队）；
 * - 空闲：单个发送。
 */
export function ComposerActions({
  activeStatus,
  hasText,
  disabled,
  onStop,
  onSend,
}: {
  activeStatus: "queued" | "running" | null;
  hasText: boolean;
  disabled: boolean;
  onStop: () => void;
  onSend: (mode: SendMode) => void;
}) {
  const running = activeStatus === "running";
  const showRunningSend = running && hasText;
  const showSingleSend = activeStatus !== "running";

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {activeStatus !== null && (
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="size-9 shrink-0 rounded-full bg-card text-foreground shadow-2xs hover:bg-accent sm:size-8"
          onClick={onStop}
          aria-label="停止回复"
          title="停止"
        >
          <Square className="size-3.5 fill-current" />
        </Button>
      )}
      {showRunningSend && (
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 shrink-0 rounded-full bg-card px-3 text-xs shadow-2xs sm:h-8"
            disabled={disabled}
            onClick={() => onSend("queue")}
            aria-label="排队"
            title="排队发送（Enter）"
          >
            排队
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-9 shrink-0 rounded-full px-3 text-xs sm:h-8"
            disabled={disabled}
            onClick={() => onSend("steer")}
            aria-label="立即插入"
            title="立即插入当前对话（Ctrl/⌘+Enter）"
          >
            立即插入
          </Button>
        </>
      )}
      {showSingleSend && (
        <Button
          type="button"
          size="icon"
          className="size-9 shrink-0 rounded-full disabled:bg-border disabled:text-muted-foreground disabled:opacity-100 sm:size-8"
          disabled={disabled || !hasText}
          onClick={() => onSend("queue")}
          aria-label="发送"
          title="发送"
        >
          <ArrowUp className="size-4" />
        </Button>
      )}
    </div>
  );
}

export function Composer({ onSend, onStop, activeStatus, leftSlot }: ComposerProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [scrollable, setScrollable] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    const next = Math.min(element.scrollHeight, 144);
    element.style.height = `${next}px`;
    setScrollable(element.scrollHeight > 144);
  }, [text]);

  const submit = async (requestedMode: SendMode) => {
    if (pending) return;
    const value = text;
    if (value.trim() === "") return;
    // 超长直接给出明确文案；服务端仍会返回 TEXT_TOO_LONG 兜底。
    if (value.length > MAX_CHARS) {
      toast.error("消息太长，请缩短后重试");
      textareaRef.current?.focus();
      return;
    }

    // 非运行状态下没有可插入的 run，统一按普通发送处理。
    const mode: SendMode =
      activeStatus === "running" ? requestedMode : "queue";

    setText("");
    setPending(true);
    try {
      const ok = await onSend(value, mode);
      if (!ok) {
        setText((current) => (current === "" ? value : current));
        textareaRef.current?.focus();
      }
    } finally {
      setPending(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const mode = sendModeForKey(event);
    if (mode === null) return;
    event.preventDefault();
    void submit(mode);
  };

  const overLimit = text.length > MAX_CHARS;

  return (
    <div className="shrink-0 bg-background safe-bottom">
      <div className="mx-auto w-full max-w-3xl px-3 pb-3 pt-1.5 sm:px-6 sm:pb-4">
        <div className="rounded-[24px] border border-border bg-secondary transition-all focus-within:border-primary focus-within:bg-card focus-within:ring-2 focus-within:ring-ring">
          <div className="px-4 pb-1 pt-3 sm:pt-3.5">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={
                activeStatus === "running"
                  ? "补充或继续发消息…"
                  : "给 Aster 发消息…"
              }
              className={cn(
                "max-h-36 min-h-[30px] w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/80",
                scrollable ? "overflow-y-auto" : "overflow-y-hidden",
              )}
              aria-label="消息输入框"
            />
          </div>

          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
            <div className="min-w-0 flex-1">{leftSlot}</div>
            <ComposerActions
              activeStatus={activeStatus}
              hasText={text.trim() !== ""}
              disabled={pending || overLimit}
              onStop={onStop}
              onSend={(mode) => void submit(mode)}
            />
          </div>
        </div>

        {(activeStatus !== null || text.length > 28_000) && (
          <div className="mt-1.5 flex items-center justify-between px-2 text-[11px] text-muted-foreground/85">
            <span>
              {activeStatus === "running"
                ? "正在回复，Enter 排队，Ctrl/⌘+Enter 立即插入"
                : activeStatus === "queued"
                  ? "排队中，等待当前回复结束"
                  : ""}
            </span>
            {text.length > 28_000 && (
              <span className={cn("font-mono", overLimit && "text-destructive")}>
                {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
              </span>
            )}
          </div>
        )}
        {overLimit && (
          <p className="mt-1 px-2 text-[11px] text-destructive" role="alert">
            消息太长：最多 {MAX_CHARS.toLocaleString()} 字符，请缩短后重试
          </p>
        )}
      </div>
    </div>
  );
}
