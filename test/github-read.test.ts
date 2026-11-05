import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TSchema } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { McpAbortError } from "@earendil-works/pi-mcp";
import { Compile } from "typebox/compile";
import { openAgent } from "../src/agent.js";
import { readConfig } from "../src/config.js";
import { createGithubReadExtension, GITHUB_READ_SECTION_BYTES } from "../src/github-read.js";
import type { GithubReader, McpHost } from "../src/mcp.js";
import type { TextRequest } from "../src/messages.js";
import type { GovernedTool } from "../src/tools.js";

const api = undefined as unknown as ToolExecutionApi;

function reader(overrides: Partial<GithubReader> = {}): GithubReader {
  return {
    async readRepoStatus() {
      return { pullRequests: "PR #1 open", issues: "Issue #2 open", workflowRuns: "Run 3 success" };
    },
    ...overrides,
  };
}

function toolOf(source: GithubReader): GovernedTool {
  return createGithubReadExtension(source).tools!.find(({ name }) => name === "github_repo_status") as GovernedTool;
}

function outputText(result: ToolExecutionResult): string {
  const block = result.output?.[0];
  assert.ok(block?.type === "text", "the tool returns one text block");
  return block.text;
}

function details(result: ToolExecutionResult): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

test("github_repo_status formats a labeled, untrusted, model-only snapshot", async () => {
  const tool = toolOf(reader());
  assert.deepEqual(tool.callers, ["model"], "code mode has no caller");
  assert.deepEqual(tool.governance, {
    source: { kind: "builtin", extension: "github-read" },
    trust: "untrusted",
    authz: "read",
  });
  assert.equal(tool.replay, "unsafe");

  const result = await tool.execute({ owner: "octo", repo: "repo" }, api, BACKGROUND_CONTEXT);
  assert.notEqual(result.isError, true);
  const text = outputText(result);
  assert.match(text, /octo\/repo/);
  assert.match(text, /## Open pull requests\nPR #1 open/);
  assert.match(text, /## Open issues\nIssue #2 open/);
  assert.match(text, /## Recent workflow runs\nRun 3 success/);
  assert.match(text, /untrusted data/);
  assert.equal(details(result).truncated, false);
});

test("github_repo_status bounds each section independently on a UTF-8 boundary", async () => {
  const long = "问".repeat(GITHUB_READ_SECTION_BYTES);
  const tool = toolOf(reader({
    async readRepoStatus() {
      return { pullRequests: long, issues: "issue", workflowRuns: "run" };
    },
  }));
  const result = await tool.execute({ owner: "o", repo: "r" }, api, BACKGROUND_CONTEXT);
  const text = outputText(result);
  assert.match(text, /\[truncated: kept \d+ of \d+ bytes\]/);
  assert.match(text, /## Open issues\nissue/, "a long section does not hide later sections");
  assert.equal(details(result).truncated, true);
});

test("github_repo_status reports policy failures without leaking transport text", async () => {
  const tool = toolOf(reader({
    async readRepoStatus() {
      throw Object.assign(new Error("internal detail that must not reach the model"), { code: "GITHUB_APPROVAL_DISABLED" });
    },
  }));
  const result = await tool.execute({ owner: "o", repo: "r" }, api, BACKGROUND_CONTEXT);
  assert.equal(result.isError, true);
  assert.equal(details(result).code, "GITHUB_APPROVAL_DISABLED");
  assert.equal(details(result).stage, "not_sent");
  const text = outputText(result);
  assert.match(text, /GITHUB_APPROVAL_DISABLED/);
  assert.doesNotMatch(text, /internal detail/);
});

test("github_repo_status marks a remote tool error as a sent result with bounded detail", async () => {
  const tool = toolOf(reader({
    async readRepoStatus() {
      throw Object.assign(new Error("remote"), { code: "GITHUB_TOOL_ERROR", reply: "Resource not accessible" });
    },
  }));
  const result = await tool.execute({ owner: "o", repo: "r" }, api, BACKGROUND_CONTEXT);
  assert.equal(result.isError, true);
  assert.equal(details(result).stage, "sent_result_rejected");
  assert.match(outputText(result), /Resource not accessible/);
});

test("github_repo_status preserves cancellation as a task abort", async () => {
  const tool = toolOf(reader({
    async readRepoStatus() {
      throw new McpAbortError();
    },
  }));
  await assert.rejects(tool.execute({ owner: "o", repo: "r" }, api, BACKGROUND_CONTEXT), McpAbortError);
});

test("github_repo_status accepts only explicit repository coordinates", () => {
  const compiled = Compile(toolOf(reader()).parameters as TSchema);
  assert.equal(compiled.Check({ owner: "o", repo: "r" }), true);
  assert.equal(compiled.Check({ owner: "o", repo: "r", endpoint: "https://example.invalid" }), false);
  assert.equal(compiled.Check({ owner: "", repo: "r" }), false);
  assert.equal(compiled.Check({ owner: "o" }), false);
});

test("openAgent exposes github_repo_status residently in the main conversation", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-github-read-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    let reads = 0;
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("github_repo_status", { owner: "octo", repo: "repo" }), { stopReason: "toolUse" }),
      (transcript) => {
        const result = transcript.messages.find((message) => message.role === "toolResult" && message.toolName === "github_repo_status");
        assert.ok(result?.role === "toolResult" && !result.isError);
        assert.ok(result.content.some((part) => part.type === "text" && part.text.includes("PR #1 open")));
        return fauxAssistantMessage("done");
      },
    ]);
    const host: McpHost = {
      extensions: [],
      github: {
        async readRepoStatus() {
          reads++;
          return { pullRequests: "PR #1 open", issues: "Issue #2 open", workflowRuns: "Run 3 success" };
        },
      },
      subscribeAvailability: (listener) => { listener("github", "available"); return () => {}; },
      close: async () => {},
    };
    const config = readConfig({
      TELEGRAM_BOT_TOKEN: "test",
      TELEGRAM_OWNER_ID: "1",
      MODEL_PROVIDER: "openai",
      MODEL_ID: "faux-1",
      OPENAI_API_KEY: "test",
      DATA_DIR: directory,
    });
    app = await openAgent(config, models, undefined, { mcp: host });
    const request: TextRequest = { requestId: "telegram:test:1", conversationId: "telegram:test", senderId: "1", text: "Check GitHub." };
    assert.equal(await app.reply(request, new AbortController().signal), "done");
    assert.equal(reads, 1, "the model called the host reader once");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
