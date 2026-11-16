import type { components } from "./schema";

export type UiMessage = components["schemas"]["UiMessage"];
export type MessageRole = NonNullable<UiMessage["role"]>;
export type MessageStatus = NonNullable<UiMessage["status"]>;
export type MessagePage = components["schemas"]["MessagePage"];
export type ModelsResponse = components["schemas"]["ModelsResponse"];
export type ModelSelectResponse = components["schemas"]["ModelSelectResponse"];
export type ModelKind = components["schemas"]["ModelKind"];
export type ModelRef = components["schemas"]["ModelRef"];
export type CurrentModel = components["schemas"]["CurrentModel"];
export type SelectableModel = components["schemas"]["SelectableModel"];
export type LoginResponse = components["schemas"]["LoginResponse"];
export type MeResponse = { ownerId: string; expiresAt: number };
export type HealthResponse = { ok: true; version: string };
export type ErrorBody = components["schemas"]["Error"];

/** request.done 事件里的模型使用信息。 */
export type ModelUsage = {
  requested?: (ModelRef & { kind?: ModelKind }) | null;
  actual?: ModelRef | null;
  kind: ModelKind;
  degraded: boolean;
};

export const EMPTY_MODEL_KIND_LABEL: Record<ModelKind, string> = {
  primary: "主模型",
  manual: "手动指定",
  auto: "自动降级",
};
