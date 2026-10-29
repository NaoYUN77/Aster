import { once } from "node:events";
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  parseJsonRpcMessage,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@earendil-works/pi-mcp";
import { parseStrictJson } from "./strict-json.js";
import { WebSearchError, searchWeb, type WebSearchFailure, type WebSearchOutput } from "./web-search.js";

const PROTOCOL_VERSION = "2025-11-25";
const SERVER_NAME = "aster-web-search";
const SERVER_VERSION = "0.1.0";
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CONCURRENT_SEARCHES = 2;

export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search the public web for current information and return source URLs with concise snippets.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 128, description: "The search query." },
      maxResults: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Maximum result count." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    anyOf: [
      {
        type: "object",
        properties: {
          ok: { const: true },
          provider: { const: "deepseek" },
          query: { type: "string" },
          results: { type: "array", items: {
            type: "object",
            properties: {
              rank: { type: "integer", minimum: 1 },
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
              summary: { type: "string" },
              siteName: { type: ["string", "null"] },
              publishedAt: { type: ["string", "null"] },
            },
            required: ["rank", "title", "url", "snippet", "summary", "siteName", "publishedAt"],
            additionalProperties: false,
          } },
        },
        required: ["ok", "provider", "query", "results"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ok: { const: false },
          error: { type: "object", properties: {
            code: { type: "string" },
            message: { type: "string" },
            retryable: { type: "boolean" },
          }, required: ["code", "message", "retryable"], additionalProperties: false },
        },
        required: ["ok", "error"],
        additionalProperties: false,
      },
    ],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

type ErrorResponse = JsonRpcResponse | {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: { readonly code: number; readonly message: string };
};

const requests = new Map<JsonRpcId, AbortController>();
let initialized = false;
let inputClosed = false;
let activeSearches = 0;
let output = Promise.resolve();

function send(message: ErrorResponse): Promise<void> {
  const line = `${JSON.stringify(message)}\n`;
  const next = output.then(async () => {
    if (inputClosed) return;
    if (!process.stdout.write(line)) await once(process.stdout, "drain");
  });
  output = next.catch(() => {});
  return next;
}

function protocolError(id: JsonRpcId | null, code: number, message: string): Promise<void> {
  return send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(message: JsonRpcRequest): Promise<void> {
  if (message.method === "initialize") {
    initialized = true;
    await send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    } });
    return;
  }
  if (!initialized) {
    await protocolError(message.id, -32002, "Server is not initialized");
    return;
  }
  if (message.method === "ping") {
    await send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    await send({ jsonrpc: "2.0", id: message.id, result: { tools: [WEB_SEARCH_TOOL] } });
    return;
  }
  if (message.method !== "tools/call") {
    await protocolError(message.id, -32601, "Method not found");
    return;
  }
  if (!isRecord(message.params) || message.params.name !== WEB_SEARCH_TOOL.name) {
    await protocolError(message.id, -32602, "Unknown tool");
    return;
  }
  if (activeSearches >= MAX_CONCURRENT_SEARCHES) {
    await sendToolResult(message.id, new WebSearchError("BUSY", "Web search is busy; try again later.", true).failure(), true);
    return;
  }

  const controller = new AbortController();
  requests.set(message.id, controller);
  activeSearches++;
  void executeSearch(message.id, message.params.arguments, controller);
}

async function executeSearch(id: JsonRpcId, args: unknown, controller: AbortController): Promise<void> {
  try {
    const result = await searchWeb(args, {
      apiKey: process.env.SEARCH_DEEPSEEK_API_KEY,
      signal: controller.signal,
    });
    if (!controller.signal.aborted) await sendToolResult(id, result, false);
  } catch (cause) {
    const failure = cause instanceof WebSearchError
      ? cause
      : new WebSearchError("NETWORK_ERROR", "Web search failed.", true);
    if (!controller.signal.aborted || failure.code !== "CANCELLED") await sendToolResult(id, failure.failure(), true);
  } finally {
    activeSearches--;
    requests.delete(id);
  }
}

function handleNotification(message: JsonRpcNotification): void {
  if (message.method !== "notifications/cancelled" || !isRecord(message.params)) return;
  const id = message.params.requestId;
  if (typeof id === "string" || typeof id === "number") requests.get(id)?.abort();
}

function sendToolResult(id: JsonRpcId, result: WebSearchOutput | WebSearchFailure, isError: boolean): Promise<void> {
  return send({ jsonrpc: "2.0", id, result: {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError,
  } });
}

async function handleLine(line: Uint8Array): Promise<void> {
  let value: unknown;
  try {
    value = parseStrictJson(line, MAX_MESSAGE_BYTES);
  } catch {
    await protocolError(null, -32700, "Parse error");
    return;
  }
  try {
    const message = parseJsonRpcMessage(value);
    if (isJsonRpcRequest(message)) await handleRequest(message);
    else if (isJsonRpcNotification(message)) handleNotification(message);
    // Responses belong to requests initiated by this server; it initiates none, so ignore them.
  } catch {
    await protocolError(responseId(value), -32600, "Invalid request");
  }
}

function responseId(value: unknown): JsonRpcId | null {
  if (!isRecord(value)) return null;
  return typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
}

async function readInput(): Promise<void> {
  let pending = Buffer.alloc(0);
  let discarding = false;
  for await (const chunk of process.stdin) {
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    while (bytes.length > 0) {
      const newline = bytes.indexOf(0x0a);
      if (discarding) {
        if (newline < 0) break;
        discarding = false;
        bytes = bytes.subarray(newline + 1);
        continue;
      }
      if (newline < 0) {
        if (pending.length + bytes.length > MAX_MESSAGE_BYTES) {
          pending = Buffer.alloc(0);
          discarding = true;
          await protocolError(null, -32600, "Message exceeds the size limit");
        } else {
          pending = Buffer.concat([pending, bytes]);
        }
        break;
      }
      const line = pending.length === 0 ? bytes.subarray(0, newline) : Buffer.concat([pending, bytes.subarray(0, newline)]);
      pending = Buffer.alloc(0);
      bytes = bytes.subarray(newline + 1);
      if (line.length > MAX_MESSAGE_BYTES) {
        await protocolError(null, -32600, "Message exceeds the size limit");
      } else if (line.length > 0) {
        await handleLine(line.at(-1) === 0x0d ? line.subarray(0, -1) : line);
      }
    }
  }
  if (!discarding && pending.length > 0) await protocolError(null, -32700, "Parse error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

try {
  await readInput();
} finally {
  inputClosed = true;
  for (const controller of requests.values()) controller.abort();
}
