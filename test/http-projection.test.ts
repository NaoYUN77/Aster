import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { projectEntry, projectEntries, WEB_HOST_MESSAGE_KIND } from "../src/http/projection.js";

const conversationId = 1 as ConversationId;
const usage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: number, kind: string, fields: Partial<EntryRecord> = {}): EntryRecord {
  return { id: id as EntryId, conversationId, kind, ...fields };
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "openai-completions",
    provider: "magpie",
    model: "opencode-go/glm-5.3-flash",
    usage,
    stopReason: "stop",
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

test("user and assistant turns become complete UI rows with the actual model", () => {
  const user = projectEntry(entry(1, "pi.user", {
    model: [{ role: "user", content: [{ type: "text", text: "你好" }], timestamp: 10 }],
  }));
  assert.deepEqual(user, {
    id: "1",
    role: "user",
    text: "你好",
    createdAt: 10,
    status: "complete",
    requestId: null,
    clientMessageId: null,
    model: null,
    errorCode: null,
    tool: null,
  });

  const answer = projectEntry(entry(2, "pi.assistant", { model: [assistant()] }));
  assert.equal(answer?.role, "assistant");
  assert.equal(answer?.text, "answer");
  assert.equal(answer?.status, "complete");
  assert.deepEqual(answer?.model, {
    id: "opencode-go/glm-5.3-flash",
    label: "magpie/opencode-go/glm-5.3-flash",
    provider: "magpie",
  });
});

test("a failed answer keeps its stable error code and never exposes provider text", () => {
  const failed = projectEntry(entry(3, "pi.assistant", {
    model: [assistant({ content: [], stopReason: "error", errorMessage: "模型暂时不可用" })],
  }));
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.errorCode, "MODEL_UNAVAILABLE");
  assert.equal(failed?.text, "模型暂时不可用");

  const aborted = projectEntry(entry(4, "pi.assistant", {
    model: [assistant({ stopReason: "aborted" })],
  }));
  assert.equal(aborted?.status, "aborted");

  // A stop before any visible token leaves no assistant bubble at all.
  assert.equal(projectEntry(entry(5, "pi.assistant", {
    model: [assistant({ content: [], stopReason: "aborted" })],
  })), undefined);
});

test("host notifications become system rows without a model or request id", () => {
  const reminder = projectEntry(entry(10, WEB_HOST_MESSAGE_KIND, {
    data: { text: "提醒：喝水", source: "reminder", createdAt: 1_700_000_000_123, key: "reminder:1" },
  }));
  assert.deepEqual(reminder, {
    id: "10",
    role: "system",
    text: "提醒：喝水",
    createdAt: 1_700_000_000_123,
    status: "complete",
    requestId: null,
    clientMessageId: null,
    model: null,
    errorCode: null,
    tool: null,
  });
  assert.equal(projectEntry(entry(11, WEB_HOST_MESSAGE_KIND, { data: { text: "  " } })), undefined);
  assert.equal(projectEntry(entry(12, WEB_HOST_MESSAGE_KIND, { data: {} })), undefined);
});

test("tool results are compact rows; internal entries are hidden", () => {
  const tool = projectEntry(entry(5, "pi.tool-result", {
    model: [{
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "raw secret output" }],
      isError: false,
      timestamp: 20,
    }],
  }));
  assert.deepEqual(tool?.tool, { name: "bash", status: "done" });
  assert.equal(tool?.text, "");
  assert.equal(JSON.stringify(tool).includes("raw secret output"), false);

  for (const kind of ["pi.system", "pi.reset", "pi.compaction", "personal.internal"]) {
    assert.equal(projectEntry(entry(6, kind, { model: [assistant()] })), undefined, kind);
  }

  assert.equal(projectEntries([
    entry(7, "pi.user", { model: [{ role: "user", content: [{ type: "text", text: "a" }], timestamp: 1 }] }),
    entry(8, "pi.system"),
    entry(9, "pi.assistant", { model: [assistant()] }),
  ]).map((message) => message.role).join(","), "user,assistant");
});
