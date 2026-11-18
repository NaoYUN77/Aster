import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MAX_CHARS = 32_000;

type ComposerProps = {
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  activeStatus: "queued" | "running" | null;
};

/**
 * 输入区右侧按钮组。运行中保留停止按钮，并在有输入时额外给出「插话」发送；
 * 排队中只保留停止（消息会进入队列，不能插话）；空闲时只有发送。
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
  onSend: () => void;
}) {
  const running = activeStatus === "running";
  const showSend = activeStatus === null || (running && hasText);

  return (
    <>
      {activeStatus !== null && (
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="size-9 shrink-0 rounded-full"
          onClick={onStop}
          aria-label="停止回复"
          title="停止"
        >
          <Square className="size-3.5 fill-current" />
        </Button>
      )}
      {showSend && (
        <Button
          type="button"
          size="icon"
          className="size-9 shrink-0 rounded-full"
          disabled={disabled || !hasText}
          onClick={onSend}
          aria-label={running ? "插话" : "发送"}
          title={running ? "插话" : "发送"}
        >
          <ArrowUp className="size-4" />
        </Button>
      )}
    </>
  );
}

export function Composer({ onSend, onStop, activeStatus }: ComposerProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [text]);

  const submit = async () => {
    if (pending) return;
    const value = text;
    if (value.trim() === "") return;
    // 超长直接给出明确文案；服务端仍会返回 TEXT_TOO_LONG 兜底。
    if (value.length > MAX_CHARS) {
      toast.error("消息太长，请缩短后重试");
      textareaRef.current?.focus();
      return;
    }

    setText("");
    setPending(true);
    try {
      const ok = await onSend(value);
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
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const overLimit = text.length > MAX_CHARS;

  return (
    <div className="border-t border-border/70 bg-background/90 backdrop-blur safe-bottom">
      <div className="mx-auto w-full max-w-3xl px-3 pb-3 pt-2.5">
        <div className="flex items-end gap-2 rounded-2xl border border-input bg-card p-2 shadow-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={
              activeStatus === "running"
                ? "插话…（Enter 插话，Shift+Enter 换行）"
                : "发消息…（Enter 发送，Shift+Enter 换行）"
            }
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/80"
            aria-label="消息输入框"
          />

          <ComposerActions
            activeStatus={activeStatus}
            hasText={text.trim() !== ""}
            disabled={pending || overLimit}
            onStop={onStop}
            onSend={() => void submit()}
          />
        </div>

        <div className="mt-1 flex items-center justify-between px-1.5 text-[11px] text-muted-foreground/80">
          <span>
            {activeStatus === "running"
              ? "正在回复，Enter 插话，Shift+Enter 换行"
              : activeStatus === "queued"
                ? "排队中，等待当前回复结束"
                : "文本对话 · 单 owner 自托管"}
          </span>
          {text.length > 28_000 && (
            <span className={cn(overLimit && "text-destructive")}>
              {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
            </span>
          )}
        </div>
        {overLimit && (
          <p className="mt-1 px-1.5 text-[11px] text-destructive" role="alert">
            消息太长：最多 {MAX_CHARS.toLocaleString()} 字符，请缩短后重试
          </p>
        )}
      </div>
    </div>
  );
}
