import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { openMcpConnection } from "../src/mcp.js";
import type { McpServerConfig } from "../src/mcp-config.js";
import { parseWebSearchInput, searchWeb, WebSearchError } from "../src/web-search.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof WebSearchError ? error.code : undefined;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function providerResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rerank_score: 2.5,
    title: "DeepSeek Search",
    url: "https://example.com/search#fragment",
    snippet: "A concise snippet.",
    summary: "A longer summary.",
    content: "",
    site_name: "Example",
    site_icon: null,
    date: "2026-10-29T01:02:03Z",
    authority: 3,
    ...overrides,
  };
}

test("web search input is narrow, Unicode-aware, and applies a deterministic result default", () => {
  assert.deepEqual(parseWebSearchInput({ query: "  current news  " }), { query: "current news", maxResults: 5 });
  assert.deepEqual(parseWebSearchInput({ query: "😀".repeat(128), maxResults: 10 }), { query: "😀".repeat(128), maxResults: 10 });
  for (const value of [
    null,
    {},
    { query: "" },
    { query: "x", maxResults: 0 },
    { query: "x", maxResults: null },
    { query: "x", extra: true },
    { query: "x".repeat(129) },
    { query: "\ud800" },
  ]) {
    assert.throws(() => parseWebSearchInput(value), (error) => errorCode(error) === "INVALID_ARGUMENT");
  }
});

test("DeepSeek requests keep credentials in headers and normalize strict provider results", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const output = await searchWeb({ query: " node 24 ", maxResults: 2 }, {
    apiKey: "test-secret",
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return jsonResponse({ results: [
        providerResult(),
        providerResult({
          title: "Second",
          url: "http://example.org/#/article/42",
          snippet: "second",
          summary: "second summary",
          site_name: null,
          date: "2026-10-29T01:02:03+00:00",
          authority: -1,
          rerank_score: 0,
        }),
      ], ignored: "provider extension" });
    },
  });

  assert.equal(request?.url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(request?.init?.redirect, "manual");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer test-secret");
  const body = JSON.parse(String(request?.init?.body));
  assert.deepEqual(body, { query: "node 24", count: 2, need_content: false });
  assert.doesNotMatch(JSON.stringify(body), /test-secret/);
  assert.deepEqual(output, {
    ok: true,
    provider: "deepseek",
    query: "node 24",
    results: [
      {
        rank: 1,
        title: "DeepSeek Search",
        url: "https://example.com/search#fragment",
        snippet: "A concise snippet.",
        summary: "A longer summary.",
        siteName: "Example",
        publishedAt: "2026-10-29T01:02:03.000Z",
      },
      {
        rank: 2,
        title: "Second",
        url: "http://example.org/#/article/42",
        snippet: "second",
        summary: "second summary",
        siteName: null,
        publishedAt: "2026-10-29T01:02:03.000Z",
      },
    ],
  });
});

test("empty results succeed while malformed result fields fail the whole response", async () => {
  assert.deepEqual(await searchWeb({ query: "nothing" }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: [] }),
  }), { ok: true, provider: "deepseek", query: "nothing", results: [] });

  for (const result of [
    providerResult({ authority: 5 }),
    providerResult({ date: "not-a-date" }),
    providerResult({ date: "2026-02-30T01:02:03Z" }),
    providerResult({ url: "file:///etc/passwd" }),
    providerResult({ summary: undefined }),
    providerResult({ title: "  \n\t" }),
  ]) {
    await assert.rejects(
      searchWeb({ query: "x" }, { apiKey: "key", fetch: async () => jsonResponse({ results: [result] }) }),
      (error) => errorCode(error) === "UPSTREAM_PROTOCOL_ERROR",
    );
  }
});

test("provider failures are categorized without exposing response bodies or credentials", async () => {
  const cases = [
    [400, "UPSTREAM_REQUEST_REJECTED"],
    [401, "PROVIDER_AUTH_FAILED"],
    [402, "PROVIDER_BALANCE_REQUIRED"],
    [429, "RATE_LIMITED"],
    [504, "PROVIDER_UNAVAILABLE"],
    [418, "UPSTREAM_HTTP_ERROR"],
  ] as const;
  for (const [status, expected] of cases) {
    await assert.rejects(
      searchWeb({ query: "x" }, {
        apiKey: "secret-never-returned",
        fetch: async () => new Response("provider body with secret-never-returned", { status }),
      }),
      (error) => errorCode(error) === expected && !String(error).includes("secret-never-returned"),
    );
  }
  await assert.rejects(
    searchWeb({ query: "x" }, { apiKey: "key", fetch: async () => jsonResponse({ unexpected: true }) }),
    (error) => errorCode(error) === "UPSTREAM_PROTOCOL_ERROR",
  );
});

test("timeouts and caller cancellation abort the provider request", async () => {
  let timeoutSignal: AbortSignal | undefined;
  await assert.rejects(searchWeb({ query: "timeout" }, {
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
  const pending = searchWeb({ query: "cancel" }, {
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
  await assert.rejects(searchWeb({ query: "large" }, {
    apiKey: "key",
    fetch: async () => new Response("x", { headers: { "content-length": String(256 * 1024 + 1) } }),
  }), (error) => errorCode(error) === "RESULT_TOO_LARGE");
  await assert.rejects(searchWeb({ query: "large normalized output", maxResults: 10 }, {
    apiKey: "key",
    fetch: async () => jsonResponse({ results: Array.from({ length: 10 }, (_, index) => providerResult({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      snippet: "s".repeat(2_000),
      summary: "m".repeat(4_000),
    })) }),
  }), (error) => errorCode(error) === "RESULT_TOO_LARGE");
});

test("stdio framing rejects malformed and oversized messages without unbounded line buffering", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/web-search-mcp.ts")], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH },
  });
  const responses = createInterface({ input: child.stdout });
  const iterator = responses[Symbol.asyncIterator]();
  try {
    child.stdin.write("not-json\n");
    assert.deepEqual(JSON.parse((await iterator.next()).value as string), {
      jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" },
    });
    child.stdin.write(Buffer.alloc(64 * 1024 + 1, 0x78));
    assert.deepEqual(JSON.parse((await iterator.next()).value as string), {
      jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message exceeds the size limit" },
    });
    child.stdin.write("\n");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7 })}\n`);
    assert.deepEqual(JSON.parse((await iterator.next()).value as string), {
      jsonrpc: "2.0", id: 7, error: { code: -32600, message: "Invalid request" },
    });
  } finally {
    child.stdin.end();
    await once(child, "exit");
    responses.close();
  }
});

test("local stdio MCP server lists one tool and reports missing host credentials safely", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-search-mcp-"));
  const server: McpServerConfig = {
    name: "web",
    transport: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", resolve("src/web-search-mcp.ts")],
    env: {},
    inheritEnv: false,
    timeoutMs: 5_000,
    connectTimeoutMs: 5_000,
  };
  const connection = await openMcpConnection(server, { dataDir: directory, env: process.env });
  try {
    const tools = await connection.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ["web_search"]);
    assert.deepEqual(tools[0]?.inputSchema, {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 128, description: "The search query." },
        maxResults: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Maximum result count." },
      },
      required: ["query"],
      additionalProperties: false,
    });
    const result = await connection.callTool("web_search", { query: "test" }, { timeoutMs: 5_000 });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      ok: false,
      error: { code: "PROVIDER_AUTH_FAILED", message: "Web search credentials are not configured.", retryable: false },
    });
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(result.structuredContent) }]);
  } finally {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});
