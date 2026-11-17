import type { components } from "./schema";

export type UiMessage = components["schemas"]["UiMessage"];
export type MessageRole = NonNullable<UiMessage["role"]>;
export type MessageStatus = NonNullable<UiMessage["status"]>;
export type MessagePage = components["schemas"]["MessagePage"];
export type ModelsResponse = components["schemas"]["ModelsResponse"];
export type ModelSelectResponse = components["schemas"]["SelectModelResponse"];
export type ModelKind = components["schemas"]["ModelSelectionKind"];
export type ModelRef = components["schemas"]["ModelEntry"];
export type MessageModel = components["schemas"]["MessageModel"];
export type CurrentModel = components["schemas"]["CurrentModel"];
export type SelectableModel = components["schemas"]["SelectableModel"];
export type LoginResponse = components["schemas"]["LoginResponse"];
export type MeResponse = components["schemas"]["MeResponse"];
export type HealthResponse = { ok: true; version: string };
/** 错误响应体里的 `error` 对象（契约 ErrorResponse）。 */
export type ErrorBody = components["schemas"]["ErrorResponse"]["error"];

/** request.done 事件里的模型使用信息。 */
export type ModelUsage = components["schemas"]["ModelUsage"];

export const EMPTY_MODEL_KIND_LABEL: Record<ModelKind, string> = {
  primary: "主模型",
  manual: "手动指定",
  auto: "自动降级",
};
