import type { ErrorBody } from "./types";

/** 统一的前端错误：只保留安全文案与服务端错误码，不展示堆栈。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const STATUS_FALLBACK: Record<number, { code: string; message: string }> = {
  400: { code: "INVALID_REQUEST", message: "请求不合法" },
  401: { code: "UNAUTHORIZED", message: "登录已失效，请重新登录" },
  403: { code: "FORBIDDEN", message: "没有访问权限" },
  404: { code: "NOT_FOUND", message: "请求的资源不存在" },
  409: { code: "CONFLICT", message: "当前状态不允许该操作" },
  413: { code: "TEXT_TOO_LONG", message: "消息太长，请缩短后重试" },
  429: { code: "RATE_LIMITED", message: "操作太频繁，请稍后再试" },
  500: { code: "INTERNAL_ERROR", message: "服务端出错了，请稍后重试" },
  502: { code: "BAD_GATEWAY", message: "服务暂时不可用，请稍后重试" },
  503: { code: "UNAVAILABLE", message: "服务暂时不可用，请稍后重试" },
  504: { code: "TIMEOUT", message: "服务响应超时，请稍后重试" },
};

export function statusError(status: number): ApiError {
  const fallback = STATUS_FALLBACK[status] ?? {
    code: `HTTP_${status}`,
    message: "请求失败，请稍后重试",
  };
  return new ApiError(fallback.code, fallback.message, status);
}

/**
 * 契约错误体是 `{"error":{"code","message"}}`；同时兼容早期的扁平 `{code,message}`。
 */
export function errorBodyOf(value: unknown): ErrorBody | null {
  if (typeof value !== "object" || value === null) return null;
  const envelope = (value as { error?: unknown }).error;
  const candidate = envelope ?? value;
  if (typeof candidate !== "object" || candidate === null) return null;
  const body = candidate as ErrorBody;
  if (typeof body.code !== "string" || typeof body.message !== "string") return null;
  return body;
}

export function isErrorBody(value: unknown): value is ErrorBody {
  return errorBodyOf(value) !== null;
}

export function toApiError(error: unknown, status = 0): ApiError {
  if (error instanceof ApiError) return error;
  const body = errorBodyOf(error);
  if (body) return new ApiError(body.code, body.message, status);
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError("TIMEOUT", "请求超时，请重试", status);
  }
  if (error instanceof TypeError) {
    return new ApiError("NETWORK_ERROR", "无法连接服务器，请检查网络或服务器地址", status);
  }
  if (error instanceof Error) {
    return new ApiError("UNKNOWN_ERROR", "操作失败，请重试", status);
  }
  return new ApiError("UNKNOWN_ERROR", "操作失败，请重试", status);
}

/** 面向用户的安全文案：优先使用服务端 message，其次错误码表。 */
export function userFacingMessage(error: unknown): string {
  const apiError = toApiError(error);
  if (apiError.status >= 500 && apiError.code === "INTERNAL_ERROR") {
    return "服务端出错了，请稍后重试";
  }
  return apiError.message;
}

export const ERROR_CODE_TEXT: Record<string, string> = {
  INVALID_REQUEST: "请求不合法",
  INVALID_CREDENTIALS: "密码错误",
  PAYLOAD_TOO_LARGE: "请求内容太大",
  REQUEST_NOT_FOUND: "请求不存在",
  REQUEST_NOT_ACTIVE: "请求已结束",
  UNHEALTHY: "服务器健康检查未通过",
  ABORTED: "已停止",
  EXECUTION_ERROR: "执行出错，请重试",
  AGENT_TIMEOUT: "模型响应超时，请重试",
  AGENT_UNANSWERED: "模型没有返回内容，请重试",
  AGENT_TRUNCATED: "回复被截断，请重试",
  EMPTY_REPLY: "模型返回了空回复，请重试",
  AGENT_LOOP_DETECTED: "模型执行异常，请重试",
  AGENT_SESSION_FAILED: "会话启动失败，请重试",
  MODEL_UNAVAILABLE: "模型暂时不可用",
  MODEL_INCOMPATIBLE: "所选模型不支持本次请求，请先切换模型",
  PROCESS_INTERRUPTED: "服务重启，请重试",
  MODEL_NOT_FOUND: "模型不存在，请刷新模型列表",
  MODEL_OUT_OF_SCOPE: "该模型不在可选范围内",
  MODEL_SWITCH_DISABLED: "当前配置未启用模型切换",
  SELECTION_WRITE_FAILED: "保存模型选择失败，请重试",
  UNAUTHORIZED: "登录已失效，请重新登录",
  RATE_LIMITED: "操作太频繁，请稍后再试",
  NETWORK_ERROR: "无法连接服务器，请检查网络或服务器地址",
  TIMEOUT: "请求超时，请重试",
  TEXT_TOO_LONG: "消息太长，请缩短后重试",
};

export function errorText(code: string | null | undefined, fallback?: string | null): string {
  const serverMessage = fallback?.trim() ?? "";
  // 服务端对超长给出了带上限的明确文案，直接展示；其余错误码用固定安全文案。
  if (code === "TEXT_TOO_LONG" && serverMessage !== "") return serverMessage;
  if (code && ERROR_CODE_TEXT[code]) return ERROR_CODE_TEXT[code];
  if (serverMessage !== "") return serverMessage;
  return "操作失败，请重试";
}
