import { Badge } from "@/components/ui/badge";
import type { ModelKind } from "@/api/types";

const LABEL: Record<ModelKind, string> = {
  primary: "主模型",
  manual: "手动指定",
  auto: "自动降级",
};

const VARIANT: Record<ModelKind, "outline" | "manual" | "auto"> = {
  primary: "outline",
  manual: "manual",
  auto: "auto",
};

export function ModelBadge({ kind }: { kind: ModelKind }) {
  return <Badge variant={VARIANT[kind]}>{LABEL[kind]}</Badge>;
}
