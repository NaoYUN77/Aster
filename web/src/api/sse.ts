import { ApiError, toApiError } from "./errors";
import { sseUrl } from "./client";

export type SseState = "connecting" | "open" | "reconnecting" | "closed";

export type ServerEvent = {
  event: string;
  data: unknown;
  id?: string;
};

export type SubscribeOptions = {
  baseUrl: string;
  token: string;
  signal: AbortSignal;
  onEvent: (event: ServerEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onState?: (state: SseState) => void;
  onUnauthorized?: () => void;
  /** 测试注入；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 解析一个 SSE 事件块；注释（心跳）返回 null。 */
export function parseSseBlock(block: string): ServerEvent | null {
  const lines = block.split(/\r?\n/);
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  let hasField = false;

  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      event = value;
      hasField = true;
    } else if (field === "data") {
      dataLines.push(value);
      hasField = true;
    } else if (field === "id") {
      id = value;
      hasField = true;
    }
  }

  if (!hasField && dataLines.length === 0) return null;

  const raw = dataLines.join("\n");
  let data: unknown = raw;
  if (raw !== "") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  } else {
    data = {};
  }

  return { event, data, ...(id !== undefined ? { id } : {}) };
}

/**
 * fetch + ReadableStream 实现的 SSE 订阅（EventSource 不能带 Authorization）。
 * 断线后按指数退避自动重连；调用方通过 AbortSignal 结束。
 */
export async function subscribeEvents(options: SubscribeOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = sseUrl(options.baseUrl);
  let attempt = 0;

  const setState = (state: SseState) => options.onState?.(state);

  while (!options.signal.aborted) {
    setState(attempt === 0 ? "connecting" : "reconnecting");
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${options.token}`,
          "Cache-Control": "no-cache",
        },
        cache: "no-store",
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) {
        setState("closed");
        return;
      }
      const apiError = toApiError(error);
      if (apiError.code === "NETWORK_ERROR") {
        attempt += 1;
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000), options.signal);
        continue;
      }
      options.onClose?.();
      throw apiError;
    }

    if (response.status === 401) {
      options.onUnauthorized?.();
      setState("closed");
      throw new ApiError("UNAUTHORIZED", "登录已失效，请重新登录", 401);
    }

    if (!response.ok || !response.body) {
      attempt += 1;
      setState("reconnecting");
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000), options.signal);
      continue;
    }

    attempt = 0;
    setState("open");
    options.onOpen?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (parsed) options.onEvent(parsed);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (options.signal.aborted) {
        setState("closed");
        options.onClose?.();
        return;
      }
      void error;
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }

    if (options.signal.aborted) {
      setState("closed");
      options.onClose?.();
      return;
    }

    options.onClose?.();
    attempt += 1;
    setState("reconnecting");
    await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000), options.signal);
  }

  setState("closed");
}
