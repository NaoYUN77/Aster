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

export function isErrorBody(value: unknown): value is ErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ErrorBody).code === "string" &&
    typeof (value as ErrorBody).message === "string"
  );
}

export function toApiError(error: unknown, status = 0): ApiError {
  if (error instanceof ApiError) return error;
  if (isErrorBody(error)) return new ApiError(error.code, error.message, status);
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
  if (code && ERROR_CODE_TEXT[code]) return ERROR_CODE_TEXT[code];
  if (fallback && fallback.trim() !== "") return fallback;
  return "操作失败，请重试";
}
