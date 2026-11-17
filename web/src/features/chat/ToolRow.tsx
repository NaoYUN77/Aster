import { Check, ChevronRight, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** v1 工具调用只做紧凑展示：工具名 + 成功/失败，不展示参数。 */
export function ToolRow({
  name,
  status,
}: {
  name: string;
  status: "done" | "failed";
}) {
  const ok = status === "done";
  return (
    <details className="group mx-auto my-1.5 w-fit max-w-full list-none rounded-full border border-border bg-muted/50 text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-full px-3 py-1 outline-none transition-colors hover:bg-muted">
        <Wrench className="size-3" />
        <span className="truncate">工具：{name}</span>
        <span className="text-border">·</span>
        <span className={cn("inline-flex items-center gap-1", ok ? "text-success" : "text-destructive")}>
          {ok ? <Check className="size-3" /> : <X className="size-3" />}
          {ok ? "完成" : "失败"}
        </span>
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
      </summary>
      <p className="px-3 pb-2 pt-1 text-[11px] text-muted-foreground">
        v1 只显示工具状态，不展示调用参数或原始结果。
      </p>
    </details>
  );
}
