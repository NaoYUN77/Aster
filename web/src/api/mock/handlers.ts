import { HttpResponse, delay, http } from "msw";
import {
  mockAbort,
  mockActiveRequest,
  mockAuthorized,
  mockCancelCredential,
  mockConnect,
  mockConnectors,
  mockDisconnect,
  mockLogin,
  mockLogout,
  mockMessages,
  mockModels,
  mockRequestCredential,
  mockSelectModel,
  mockSendMessage,
  mockSnapshot,
  mockSubmitCredential,
  subscribeMockEvents,
} from "./store";

const API = "*/api/v1";

/** 与契约一致：错误统一包在 `{ error: { code, message } }` 里。 */
function apiError(code: string, message: string, status: number) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

function unauthorized(message = "登录已失效，请重新登录") {
  return apiError("UNAUTHORIZED", message, 401);
}

function authorized(request: Request) {
  return mockAuthorized(request.headers.get("authorization"));
}

export const handlers = [
  http.get(`${API}/health`, async () => {
    await delay(120);
    return HttpResponse.json({ ok: true, version: "mock-0.1.0" });
  }),

  http.post(`${API}/auth/login`, async ({ request }) => {
    await delay(350);
    const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
    if (!body || typeof body.password !== "string" || body.password === "") {
      return apiError("INVALID_REQUEST", "请输入密码", 400);
    }
    const session = mockLogin(body.password);
    if (!session) {
      return apiError("INVALID_CREDENTIALS", "密码错误", 401);
    }
    return HttpResponse.json({
      ...session,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }),

  http.post(`${API}/auth/logout`, async ({ request }) => {
    await delay(120);
    const auth = authorized(request);
    if (!auth) return unauthorized();
    mockLogout(auth.token);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${API}/auth/me`, async ({ request }) => {
    await delay(120);
    const auth = authorized(request);
    if (!auth) return unauthorized();
    return HttpResponse.json({
      ownerId: auth.ownerId,
      expiresAt: new Date(auth.expiresAt).toISOString(),
    });
  }),

  http.get(`${API}/messages`, async ({ request }) => {
    await delay(200);
    if (!authorized(request)) return unauthorized();
    const url = new URL(request.url);
    const before = url.searchParams.get("before");
    const limitValue = Number(url.searchParams.get("limit") ?? "30");
    const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.trunc(limitValue), 1), 100) : 30;
    return HttpResponse.json(mockMessages(before, limit));
  }),

  http.post(`${API}/messages`, async ({ request }) => {
    await delay(220);
    if (!authorized(request)) return unauthorized();
    const body = (await request.json().catch(() => null)) as
      | { clientMessageId?: unknown; text?: unknown }
      | null;
    if (
      !body ||
      typeof body.clientMessageId !== "string" ||
      body.clientMessageId.trim() === "" ||
      typeof body.text !== "string"
    ) {
      return apiError("INVALID_REQUEST", "请求不合法", 400);
    }
    const result = mockSendMessage(body.clientMessageId, body.text);
    if ("error" in result) {
      const tooLong = result.error === "TEXT_TOO_LONG";
      return apiError(
        result.error,
        tooLong ? "消息过长，最多 32000 个字符" : "请求不合法",
        400,
      );
    }
    return HttpResponse.json(result, { status: 202 });
  }),

  http.post(`${API}/requests/:requestId/abort`, async ({ request, params }) => {
    await delay(150);
    if (!authorized(request)) return unauthorized();
    const result = mockAbort(String(params.requestId));
    if (!result.ok) {
      return apiError(
        result.code ?? "CONFLICT",
        result.status === 404 ? "请求不存在" : "当前状态不能停止",
        result.status,
      );
    }
    return HttpResponse.json({ requestId: String(params.requestId), status: "aborted" });
  }),

  http.get(`${API}/models`, async ({ request }) => {
    await delay(180);
    if (!authorized(request)) return unauthorized();
    return HttpResponse.json(mockModels());
  }),

  http.post(`${API}/models/select`, async ({ request }) => {
    await delay(220);
    if (!authorized(request)) return unauthorized();
    const body = (await request.json().catch(() => null)) as
      | { action?: unknown; modelId?: unknown }
      | null;

    if (body?.action === "select" && typeof body.modelId === "string") {
      const result = mockSelectModel({ action: "select", modelId: body.modelId });
      if (!result.ok) {
        return apiError(result.code, result.message, result.status);
      }
      return HttpResponse.json({ ...result.models, effective: result.effective });
    }

    if (body?.action === "primary") {
      const result = mockSelectModel({ action: "primary" });
      if (!result.ok) {
        return apiError(result.code, result.message, result.status);
      }
      return HttpResponse.json({ ...result.models, effective: result.effective });
    }

    return apiError("INVALID_REQUEST", "action 不合法", 400);
  }),

  http.get(`${API}/connectors`, async ({ request }) => {
    await delay(160);
    if (!authorized(request)) return unauthorized();
    return HttpResponse.json(mockConnectors());
  }),

  http.post(`${API}/connectors/:id/connect`, async ({ request, params }) => {
    await delay(800);
    if (!authorized(request)) return unauthorized();
    const result = mockConnect(String(params.id));
    if (!result.ok) return apiError(result.code, result.message, result.status);
    return HttpResponse.json({ connector: result.connector });
  }),

  http.post(`${API}/connectors/:id/disconnect`, async ({ request, params }) => {
    await delay(260);
    if (!authorized(request)) return unauthorized();
    const result = mockDisconnect(String(params.id));
    if (!result.ok) return apiError(result.code, result.message, result.status);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API}/mock/credential-request`, async ({ request }) => {
    await delay(120);
    if (!authorized(request)) return unauthorized();
    const body = (await request.json().catch(() => null)) as { connectorId?: unknown } | null;
    const connectorId = typeof body?.connectorId === "string" ? body.connectorId : "github";
    const result = mockRequestCredential(connectorId);
    if ("error" in result) return apiError(result.error, "连接器不存在", 404);
    return HttpResponse.json(result, { status: 202 });
  }),

  http.post(`${API}/credential-requests/:requestId`, async ({ request, params }) => {
    await delay(300);
    if (!authorized(request)) return unauthorized();
    const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
    if (!body || typeof body.token !== "string" || body.token.trim() === "") {
      return apiError("INVALID_REQUEST", "令牌不能为空", 400);
    }
    // 明文 token 只用于本次 mock 校验，不写日志、不写存储。
    const result = mockSubmitCredential(String(params.requestId), body.token);
    if (!result.ok) return apiError(result.code, result.message, result.status);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API}/credential-requests/:requestId/cancel`, async ({ request, params }) => {
    await delay(120);
    if (!authorized(request)) return unauthorized();
    const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
    const reason = typeof body?.reason === "string" ? body.reason : "cancelled";
    const result = mockCancelCredential(String(params.requestId), reason);
    if (!result.ok) return apiError(result.code, result.message, result.status);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${API}/events`, async ({ request }) => {
    if (!authorized(request)) return unauthorized();

    let unsubscribe: (() => void) | undefined;
    let heartbeat: number | undefined;
    let closed = false;

    const cleanup = () => {
      closed = true;
      unsubscribe?.();
      if (heartbeat !== undefined) window.clearInterval(heartbeat);
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            cleanup();
          }
        };

        send("snapshot", mockSnapshot());

        unsubscribe = subscribeMockEvents(({ event, data }) => send(event, data));

        // 若连接建立时已有活动请求，补一条便于 UI 立刻进入 running。
        const active = mockActiveRequest();
        if (active?.status === "running") {
          send("request.running", { requestId: active.requestId });
        }

        heartbeat = window.setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            cleanup();
          }
        }, 15_000);
      },
      cancel() {
        cleanup();
      },
    });

    return new HttpResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  }),
];
