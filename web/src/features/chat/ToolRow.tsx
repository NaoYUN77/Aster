import { Check, ChevronRight, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";

function formatPayload(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 工具调用折叠行：
 * - 完成态保持与主题一致的中性色调，不用刺眼特殊色；
 * - 展开后展示调用参数与原始结果（若后端返回）。
 */
export function ToolRow({
  name,
  status,
  args,
  result,
}: {
  name: string;
  status: "done" | "failed";
  args?: unknown;
  result?: unknown;
}) {
  const ok = status === "done";
  const formattedArgs = formatPayload(args);
  const formattedResult = formatPayload(result);

  return (
    <details className="group my-1.5 w-fit max-w-full list-none overflow-hidden rounded-2xl border border-border bg-secondary text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 outline-none transition-colors hover:text-foreground">
        <Wrench className="size-3 shrink-0" />
        <span className="truncate font-medium text-foreground/85">工具：{name}</span>
        <span className="text-border">·</span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1",
            ok ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {ok ? <Check className="size-3" /> : <X className="size-3" />}
          {ok ? "完成" : "失败"}
        </span>
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
      </summary>

      <div className="space-y-2 border-t border-border px-3 py-2.5 text-[11px]">
        <div>
          <div className="mb-1 font-medium text-foreground/75">调用参数</div>
          {formattedArgs ? (
            <pre className="max-h-40 overflow-auto rounded-xl bg-code-bg p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
              {formattedArgs}
            </pre>
          ) : (
            <p className="text-muted-foreground/80">（未返回参数）</p>
          )}
        </div>
        <div>
          <div className="mb-1 font-medium text-foreground/75">原始结果</div>
          {formattedResult ? (
            <pre className="max-h-48 overflow-auto rounded-xl bg-code-bg p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
              {formattedResult}
            </pre>
          ) : (
            <p className="text-muted-foreground/80">（未返回原始结果）</p>
          )}
        </div>
      </div>
    </details>
  );
}
