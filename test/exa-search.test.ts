import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createToolRegistry } from "../src/tools.js";
import { ExaSearchError, parseExaSearchInput, searchExa } from "../src/exa-search.js";
import { createWebExtension } from "../src/web-tools.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof ExaSearchError ? error.code : undefined;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function providerResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "https://example.com/search",
    title: "Exa Search",
    url: "https://example.com/search#fragment",
    publishedDate: "2026-11-08T07:30:00.000Z",
    author: "A. Writer",
    highlights: ["A concise snippet.", "A second highlight."],
    ...overrides,
  };
}

test("Exa search input is narrow, Unicode-aware, and applies a deterministic result default", () => {
  assert.deepEqual(parseExaSearchInput({ query: "  current news  " }), { query: "current news", maxResults: 5 });
  assert.deepEqual(parseExaSearchInput({ query: "😀".repeat(128), maxResults: 10 }), { query: "😀".repeat(128), maxResults: 10 });
  for (const value of [
    null,
    {},
    { query: "" },
    { query: "   " },
    { query: "x", maxResults: 0 },
    { query: "x", maxResults: 11 },
    { query: "x", maxResults: null },
    { query: "x", extra: true },
    { query: "x".repeat(129) },
    { query: "\ud800" },
  ]) {
    assert.throws(() => parseExaSearchInput(value), (error) => errorCode(error) === "INVALID_ARGUMENT");
  }
});

test("Exa requests keep credentials in headers and normalize strict provider results", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const output = await searchExa({ query: " node 24 ", maxResults: 2 }, {
    apiKey: "test-secret",
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return jsonResponse({
        requestId: "request-1",
        results: [
          providerResult(),
          providerResult({
            title: "Second",
            url: "http://example.org/#/article/42",
            highlights: ["second"],
            publishedDate: "2026-11-08T07:30:00+00:00",
            author: null,
          }),
        ],
        costDollars: { total: 0.007 },
        resolvedSearchType: "auto",
        notices: [{ code: "RESTRICTIONS_RELAXED", path: "/query", message: "Restrictions matched nothing.", details: { removed: 2 } }],
        warnings: [{ code: "IGNORED_FIELD", path: "/startCrawlDate", message: "Has no effect." }],
      });
    },
  });

  assert.equal(request?.url, "https://api.exa.ai/search");
  assert.equal(request?.init?.method, "POST");
  assert.equal(request?.init?.redirect, "manual");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer test-secret");
  const body = JSON.parse(String(request?.init?.body));
  assert.deepEqual(body, { query: "node 24", type: "auto", numResults: 2, contents: { highlights: true } });
  assert.doesNotMatch(JSON.stringify(body), /test-secret/);
  assert.deepEqual(output, {
    ok: true,
    provider: "exa",
    query: "node 24",
    results: [
      {
        rank: 1,
        title: "Exa Search",
        url: "https://example.com/search#fragment",
        snippet: "A concise snippet. … A second highlight.",
        publishedAt: "2026-11-08T07:30:00.000Z",
      },
      {
        rank: 2,
        title: "Second",
        url: "http://example.org/#/article/42",
        snippet: "second",
        publishedAt: "2026-11-08T07:30:00.000Z",
      },
    ],
    notices: [{ code: "RESTRICTIONS_RELAXED", message: "Restrictions matched nothing." }],
  });
});

test("provider warnings never reach the model and absent optional fields stay empty", async () => {
  const output = await searchExa({ query: "minimal" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({
      results: [{ title: "", url: "https://b.test" }],
      warnings: [{ code: "IGNORED_FIELD", path: "/moderation", message: "Has no effect." }],
    }),
  });

  assert.deepEqual(output, {
    ok: true,
    provider: "exa",
    query: "minimal",
    results: [{ rank: 1, title: "", url: "https://b.test/", snippet: "", publishedAt: null }],
    notices: [],
  });
  assert.doesNotMatch(JSON.stringify(output), /IGNORED_FIELD/);
});

test("Exa dates that are unknown stay null while unusable dates fail the response", async () => {
  for (const publishedDate of [undefined, null, ""]) {
    const output = await searchExa({ query: "unknown date" }, {
      apiKey: "key",
      fetch: async () => jsonResponse({ results: [providerResult({ publishedDate })] }),
    });
    assert.equal(output.results[0]?.publishedAt, null);
  }

  for (const publishedDate of ["not-a-date", "2026-13-01T00:00:00Z", "2026-11-08", 1_760_000_000]) {
    await assert.rejects(
      searchExa({ query: "x" }, { apiKey: "key", fetch: async () => jsonResponse({ results: [providerResult({ publishedDate })] }) }),
      (error) => errorCode(error) === "UPSTREAM_PROTOCOL_ERROR",
    );
  }
});

test("highlights are optional, join in order, and malformed ones fail the response", async () => {
  const joined = await searchExa({ query: "join" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [providerResult({ highlights: [" first ", "", "second"] })] }),
  });
  assert.equal(joined.results[0]?.snippet, "first … second");

  for (const highlights of [null, "text", [1], ["\ud800"]]) {
    await assert.rejects(
      searchExa({ query: "x" }, { apiKey: "key", fetch: async () => jsonResponse({ results: [providerResult({ highlights })] }) }),
      (error) => errorCode(error) === "UPSTREAM_PROTOCOL_ERROR",
    );
  }
});

test("notices reach the model only in the documented shape", async () => {
  const output = await searchExa({ query: "notices" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({
      results: [],
      notices: [
        { code: "RESTRICTIONS_RELAXED", path: "/query", message: " First " },
        { code: "OTHER_NOTICE", path: "/query", message: "Second." },
      ],
    }),
  });
  assert.deepEqual(output.notices, [
    { code: "RESTRICTIONS_RELAXED", message: "First" },
    { code: "OTHER_NOTICE", message: "Second." },
  ]);

  // A notice the provider sent with an absent or empty field still carries a code or a message,
  // so it reaches the model rather than failing a response whose results are intact.
  const sparse = await searchExa({ query: "sparse" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({
      results: [],
      notices: [{}, { code: "ONLY_CODE" }, { message: "only message" }, { code: "  ", message: "  " }],
    }),
  });
  assert.deepEqual(sparse.notices, [
    { code: "", message: "" },
    { code: "ONLY_CODE", message: "" },
    { code: "", message: "only message" },
    { code: "", message: "" },
  ]);

  for (const notices of ["text", [5], [{ code: 5 }], [{ code: "X", message: [] }]]) {
    await assert.rejects(
      searchExa({ query: "x" }, { apiKey: "key", fetch: async () => jsonResponse({ results: [], notices }) }),
      (error) => errorCode(error) === "UPSTREAM_PROTOCOL_ERROR",
    );
  }
});

test("results beyond the requested maximum are not exposed", async () => {
  const output = await searchExa({ query: "bounded", maxResults: 1 }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [
      providerResult({ title: "First" }),
      providerResult({ title: "Second" }),
    ] }),
  });

  assert.deepEqual(output.results.map(({ title }) => title), ["First"]);
});

test("provider text is governed by total budgets rather than undocumented field limits", async () => {
  const title = "t".repeat(501);
  const output = await searchExa({ query: "long title" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [providerResult({ title })] }),
  });

  assert.equal(output.results[0]?.title, title);
});

test("empty results succeed while a response without the requested result list fails", async () => {
  assert.deepEqual(await searchExa({ query: "nothing" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [], requestId: "r" }),
  }), { ok: true, provider: "exa", query: "nothing", results: [], notices: [] });

  for (const response of [
    { unexpected: true },
    { results: "text" },
    // A synthesis answer to `type:"auto"` is not the list this tool asked for.
    { output: { content: "prose" } },
    { results: [providerResult({ title: 1 })] },
    { results: [providerResult({ url: 1 })] },
    { results: [providerResult({ url: "file:///etc/passwd" })] },
    { results: [providerResult({ url: "https://user:s3cret@example.com/" })] },
    { results: [null] },
  ]) {
    await assert.rejects(
      searchExa({ query: "x" }, { apiKey: "key", fetch: async () => jsonResponse(response) }),
      (error) => errorCode(error) === "UPSTREAM_PROTOCOL_ERROR",
    );
  }
});

test("provider failures are categorized without exposing response bodies or credentials", async () => {
  const cases = [
    [400, "UPSTREAM_REQUEST_REJECTED"],
    [401, "PROVIDER_AUTH_FAILED"],
    [402, "PROVIDER_BALANCE_REQUIRED"],
    [403, "UPSTREAM_HTTP_ERROR"],
    [429, "RATE_LIMITED"],
    [503, "PROVIDER_UNAVAILABLE"],
    [504, "PROVIDER_UNAVAILABLE"],
    [418, "UPSTREAM_HTTP_ERROR"],
  ] as const;
  for (const [status, expected] of cases) {
    await assert.rejects(
      searchExa({ query: "x" }, {
        apiKey: "secret-never-returned",
        fetch: async () => new Response(
          JSON.stringify({ requestId: "r", error: "body with secret-never-returned", tag: "X" }),
          { status },
        ),
      }),
      (error) => errorCode(error) === expected && !String(error).includes("secret-never-returned"),
    );
  }
  await assert.rejects(
    searchExa({ query: "x" }, { apiKey: "" }),
    (error) => errorCode(error) === "PROVIDER_AUTH_FAILED",
  );
});

test("timeouts and caller cancellation abort the provider request", async () => {
  let timeoutSignal: AbortSignal | undefined;
  await assert.rejects(searchExa({ query: "timeout" }, {
    apiKey: "key",
    timeoutMs: 10,
    fetch: async (_input, init) => {
      timeoutSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        timeoutSignal?.addEventListener("abort", () => reject(timeoutSignal?.reason), { once: true });
      });
    },
  }), (error) => errorCode(error) === "TIMEOUT");
  assert.equal(timeoutSignal?.aborted, true);

  const caller = new AbortController();
  let callerSignal: AbortSignal | undefined;
  const pending = searchExa({ query: "cancel" }, {
    apiKey: "key",
    signal: caller.signal,
    fetch: async (_input, init) => {
      callerSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        callerSignal?.addEventListener("abort", () => reject(callerSignal?.reason), { once: true });
      });
    },
  });
  caller.abort();
  await assert.rejects(pending, (error) => errorCode(error) === "CANCELLED");
  assert.equal(callerSignal?.aborted, true);
});

test("oversized upstream responses and normalized outputs fail explicitly", async () => {
  await assert.rejects(searchExa({ query: "large" }, {
    apiKey: "key",
    fetch: async () => new Response("x", { headers: { "content-length": String(256 * 1024 + 1) } }),
  }), (error) => errorCode(error) === "RESULT_TOO_LARGE");
  await assert.rejects(searchExa({ query: "large normalized output", maxResults: 10 }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: Array.from({ length: 10 }, (_, index) => providerResult({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      highlights: ["h".repeat(3_000)],
    })) }),
  }), (error) => errorCode(error) === "RESULT_TOO_LARGE");
});

test("built-in Exa search registers with read governance and host-only credentials", async () => {
  let authorization: string | null = null;
  const registry = createToolRegistry([createWebExtension({
    exaApiKey: "host-secret",
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return jsonResponse({ results: [] });
    },
  })], { authority: "restricted", log: () => {} });

  // Only the provider whose credential exists is declared; the DeepSeek pair stays unregistered.
  assert.equal(registry.lookup("web_search"), undefined);
  assert.equal(registry.lookup("web_fetch"), undefined);
  const record = registry.lookup("exa_search");
  assert.ok(record);
  assert.deepEqual(record.source, { kind: "builtin", extension: "web-tools" });
  assert.equal(record.authz, "read");
  assert.equal(record.trust, "trusted");
  assert.equal(record.replay, "unsafe");
  const tool = registry.snapshot().tools().find(({ tool }) => tool.name === "exa_search")!.tool;
  assert.equal(JSON.stringify(tool.parameters).includes("apiKey"), false);
  const result = await tool.execute({ query: "test" }, {
    conversationId: 1, taskId: 2, callId: "search",
  } as ToolExecutionApi, BACKGROUND_CONTEXT);
  assert.equal(result.isError, undefined);
  assert.equal(authorization, "Bearer host-secret");
  assert.deepEqual(result.structuredOutput, { ok: true, provider: "exa", query: "test", results: [], notices: [] });
  assert.deepEqual(result.output, [{ type: "text", text: JSON.stringify(result.structuredOutput) }]);
});

test("a web extension without any provider credential is rejected instead of registering nothing", () => {
  assert.throws(() => createWebExtension({}), /at least one provider credential/);
});
