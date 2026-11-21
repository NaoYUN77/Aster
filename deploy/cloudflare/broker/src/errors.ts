/** Every failure the broker reports, with a safe fixed message. Details never include values. */
export class BrokerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BrokerError";
    this.status = status;
    this.code = code;
  }
}

export function brokerError(
  status: number,
  code: string,
  message: string,
): { readonly error: { readonly code: string; readonly message: string } } {
  return { error: { code, message } };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Secret and token responses must never be cached by an intermediary.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function emptyResponse(status = 204): Response {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
