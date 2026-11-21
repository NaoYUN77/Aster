import { TriangleAlert } from "lucide-react";
import type { ModelUsage } from "@/api/types";

/**
 * 手动选择的模型失败、实际由别的模型回答时的非阻塞提示。
 * 不自动把 UI 改成实际模型；选择仍保持原样（sticky）。
 */
export function DegradedNotice({ usage }: { usage: ModelUsage }) {
  if (!usage.degraded) return null;
  const requested = usage.requested?.label ?? usage.requested?.id;
  const actual = usage.actual?.label ?? usage.actual?.id;
  if (!requested || !actual) return null;

  return (
    <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <p>
        手动选择的 {requested} 不可用，本次由 {actual} 回答。选择仍保持为 {requested}。
      </p>
    </div>
  );
}
