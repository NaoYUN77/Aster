import { arr, bool, int, lit, nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { ExaSearchError, searchExa, type ExaSearchFailure, type ExaSearchOutput } from "./exa-search.js";
import { fetchWeb, WebFetchError, type WebFetchFailure, type WebFetchOutput } from "./web-fetch.js";
import { searchWeb, WebSearchError, type WebSearchFailure, type WebSearchOutput } from "./web-search.js";
import type { GovernedTool } from "./tools.js";

const MAX_CONCURRENT_REQUESTS = 2;
const errorSchema = obj({
  code: str(),
  message: str(),
  retryable: bool(),
});
const failureSchema = obj({
  ok: lit(false),
  error: errorSchema,
});
const webSearchOutputSchema = union([
  obj({
    ok: lit(true),
    provider: lit("deepseek"),
    query: str(),
    results: arr(obj({
      rank: int({ minimum: 1 }),
      title: str(),
      url: str(),
      snippet: str(),
      summary: str(),
      siteName: union([str(), nul()]),
      publishedAt: union([str(), nul()]),
    })),
  }),
  failureSchema,
]);
const webFetchOutputSchema = union([
  obj({
    ok: lit(true),
    provider: lit("deepseek"),
    url: str(),
    title: str(),
    content: str(),
    truncated: bool(),
  }),
  failureSchema,
]);
/** Exa reports its own result fields, so this shape is not the DeepSeek one with fields missing. */
const exaSearchOutputSchema = union([
  obj({
    ok: lit(true),
    provider: lit("exa"),
    query: str(),
    results: arr(obj({
      rank: int({ minimum: 1 }),
      title: str(),
      url: str(),
      snippet: str(),
      publishedAt: union([str(), nul()]),
    })),
    notices: arr(obj({ code: str(), message: str() })),
  }),
  failureSchema,
]);

export type WebToolsOptions = {
  /** DeepSeek Search/Fetch credential; without it neither DeepSeek tool is registered. */
  readonly deepseekApiKey?: string;
  /** Exa Search credential; without it `exa_search` is not registered. */
  readonly exaApiKey?: string;
  readonly fetch?: typeof fetch;
};

/** Every built-in web tool is trusted, read-only, and reaches a remote API the host pays for. */
const READ_GOVERNANCE = {
  source: { kind: "builtin" as const, extension: "web-tools" },
  trust: "trusted" as const,
  authz: "read" as const,
};

function toolResult(
  result: WebSearchOutput | WebSearchFailure | WebFetchOutput | WebFetchFailure | ExaSearchOutput | ExaSearchFailure,
  isError = false,
): ToolExecutionResult {
  const text = JSON.stringify(result);
  return {
    ...(isError ? { isError: true } : {}),
    output: [{ type: "text", text }],
    structuredOutput: JSON.parse(text),
  };
}

/**
 * Built-in web tools bound to host credentials; secrets are never model parameters. Each provider's
 * tools are registered only when the host supplied that provider's credential, and all of them
 * share one in-flight counter because they compete for the same process egress budget.
 */
export function createWebExtension(options: WebToolsOptions) {
  let activeRequests = 0;
  const webSearch = Object.assign(defineTool({
    name: "web_search",
    description: "Search the public web for current information and return source URLs with concise snippets.",
    parameters: obj({
      query: str({ minLength: 1, maxLength: 128, description: "The search query." }),
      maxResults: opt(int({ minimum: 1, maximum: 10, default: 5, description: "Maximum result count." })),
    }),
    structuredOutputSchema: webSearchOutputSchema,
    replay: "unsafe",
    execute: async (args, _api, context) => {
      if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        return toolResult(new WebSearchError("BUSY", "Web search is busy; try again later.", true).failure(), true);
      }
      activeRequests++;
      try {
        const result = await searchWeb(args, {
          apiKey: options.deepseekApiKey,
          signal: context.abortSignal,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        return toolResult(result);
      } catch (cause) {
        if (context.abortSignal?.aborted) throw cause;
        const failure = cause instanceof WebSearchError
          ? cause
          : new WebSearchError("NETWORK_ERROR", "Web search failed.", true);
        return toolResult(failure.failure(), true);
      } finally {
        activeRequests--;
      }
    },
  }), { governance: READ_GOVERNANCE }) satisfies GovernedTool;

  const webFetch = Object.assign(defineTool({
    name: "web_fetch",
    description: "Fetch one public web page by URL and return its extracted Markdown content.",
    parameters: obj({
      url: str({ minLength: 1, maxLength: 8_192, description: "An absolute public HTTP(S) page URL." }),
    }),
    structuredOutputSchema: webFetchOutputSchema,
    replay: "unsafe",
    execute: async (args, _api, context) => {
      if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        return toolResult(new WebFetchError("BUSY", "Web fetch is busy; try again later.", true).failure(), true);
      }
      activeRequests++;
      try {
        const result = await fetchWeb(args, {
          apiKey: options.deepseekApiKey,
          signal: context.abortSignal,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        return toolResult(result);
      } catch (cause) {
        if (context.abortSignal?.aborted) throw cause;
        const failure = cause instanceof WebFetchError
          ? cause
          : new WebFetchError("NETWORK_ERROR", "Web fetch failed.", true);
        return toolResult(failure.failure(), true);
      } finally {
        activeRequests--;
      }
    },
  }), { governance: READ_GOVERNANCE }) satisfies GovernedTool;

  const exaSearch = Object.assign(defineTool({
    name: "exa_search",
    description: "Search the public web with Exa and return ranked source URLs with the page snippets most relevant to the query. Results carry a publication date when Exa knows it, plus any notice Exa gives about how the results were produced.",
    parameters: obj({
      query: str({ minLength: 1, maxLength: 128, description: "The search query." }),
      maxResults: opt(int({ minimum: 1, maximum: 10, default: 5, description: "Maximum result count." })),
    }),
    structuredOutputSchema: exaSearchOutputSchema,
    replay: "unsafe",
    execute: async (args, _api, context) => {
      if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        return toolResult(new ExaSearchError("BUSY", "Exa search is busy; try again later.", true).failure(), true);
      }
      activeRequests++;
      try {
        const result = await searchExa(args, {
          apiKey: options.exaApiKey,
          signal: context.abortSignal,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        return toolResult(result);
      } catch (cause) {
        if (context.abortSignal?.aborted) throw cause;
        const failure = cause instanceof ExaSearchError
          ? cause
          : new ExaSearchError("NETWORK_ERROR", "Exa search failed.", true);
        return toolResult(failure.failure(), true);
      } finally {
        activeRequests--;
      }
    },
  }), { governance: READ_GOVERNANCE }) satisfies GovernedTool;

  const tools: GovernedTool[] = [
    ...(options.deepseekApiKey === undefined ? [] : [webSearch, webFetch]),
    ...(options.exaApiKey === undefined ? [] : [exaSearch]),
  ];
  if (tools.length === 0) throw new Error("web-tools requires at least one provider credential");
  return defineExtension({ name: "web-tools", tools });
}
