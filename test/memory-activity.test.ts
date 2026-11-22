import assert from "node:assert/strict";
import test from "node:test";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import {
  ACTIVITY_MAX_TOKENS,
  buildActivityDigest,
  redactActivityText,
  summarizeArguments,
  type ActivitySource,
} from "../src/memory/activity.js";

const conversationId = 1 as ConversationId;

function entry(id: number, kind: string, model?: Message[]): EntryRecord {
  return {
    id: id as EntryId,
    conversationId,
    kind,
    ...(model === undefined ? {} : { model }),
  };
}

function user(id: number, text: string, timestamp?: number): ActivitySource {
  // Legacy entries may lack a timestamp even though the current type requires one.
  const message = {
    role: "user",
    content: [{ type: "text", text }],
    ...(timestamp === undefined ? {} : { timestamp }),
  } as Message;
  return { conversationId, entry: { ...entry(id, "pi.user", [message]) } };
}

function toolResult(id: number, toolName: string, text: string, timestamp: number, isError = false): ActivitySource {
  return {
    conversationId,
    entry: entry(id, "pi.tool-result", [{
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName,
      content: [{ type: "text", text }],
      isError,
      timestamp,
    }]),
  };
}

function source(id: number, kind: string, model?: Message[]): ActivitySource {
  return { conversationId, entry: { ...entry(id, kind, model) } };
}

test("activity: real text, tool calls, results and errors are grouped by event day", () => {
  const day1 = Date.parse("2026-11-20T23:50:00Z");
  const day2 = Date.parse("2026-11-21T00:10:00Z");
  const assistant: Message = fauxAssistantMessage(
    [{ type: "text", text: "Deploying the release now." }, fauxToolCall("write", { path: "MEMORY.md", content: "color: blue" }, { id: "w1" })],
    { timestamp: day2, stopReason: "toolUse" },
  );
  const failed: Message = fauxAssistantMessage("", { timestamp: day2 + 120_000, stopReason: "error", errorMessage: "provider timed out" });
  const digest = buildActivityDigest([
    user(2, "Deploy the release tomorrow.", day1),
    source(3, "pi.assistant", [assistant]),
    toolResult(4, "write", "permission denied", day2 + 60_000, true),
    source(5, "pi.assistant", [failed]),
    source(6, "pi.system", [{ role: "system", content: "rules", timestamp: day2 }]),
    source(7, "personal.cycle"),
  ], { timezone: "UTC" });

  assert.equal(digest.through, 7, "the cursor is the newest supplied entry, including skipped kinds");
  assert.equal(digest.entries, 6);
  assert.match(digest.text, /## 2026-11-20\n\[23:50\] user: Deploy the release tomorrow\./);
  assert.match(digest.text, /## 2026-11-21\n\[00:10\] assistant: Deploying the release now\./);
  assert.match(digest.text, /\[00:10\] tool write: \{"path":"MEMORY\.md","content":"color: blue"\}/);
  assert.match(digest.text, /\[00:11\] tool-result write \(error\): permission denied/);
  assert.match(digest.text, /\[00:12\] error: provider timed out/);
  assert.equal(digest.text.includes("rules"), false, "system messages are not activity");
  assert.equal(digest.text.includes("## 2026-11-22"), false);
});

test("activity: the configured timezone decides the day and the clock", () => {
  const digest = buildActivityDigest([
    user(1, "Late night in Shanghai.", Date.parse("2026-11-20T17:30:00Z")),
  ], { timezone: "Asia/Shanghai" });
  assert.match(digest.text, /## 2026-11-21\n\[01:30\] user: Late night in Shanghai\./);
});

test("activity: an event without a timestamp is filed as unknown, never dated by the clock", () => {
  const digest = buildActivityDigest([user(1, "No timestamp here.")], { timezone: "UTC" });
  assert.match(digest.text, /## unknown\n\[unknown\] user: No timestamp here\./);
});

test("activity: credentials never enter the digest", () => {
  const openAiKey = ["sk", "proj", "a".repeat(32)].join("-");
  const slackToken = ["xoxb", "123456789012", "abcdefghijklmnop"].join("-");
  const awsKey = ["AK", "IA", "FAKEKEYVALUE123456"].join("");
  const jwt = ["eyJ", "headerpart", "eyJ", "payloadpart", "signaturepart"].join(".");
  const fakeAssignment = "n0t-a-real-credential";
  const privateBody = "private-key-body";
  const privateKey = ["-----BEGIN RSA", "PRIVATE KEY-----", privateBody, "-----END RSA", "PRIVATE KEY-----"].join(" ");
  const proseSecret = "swordfish";
  const text = [
    `openai OPENAI_API_KEY=${fakeAssignment} ok`,
    "password: hunter2",
    '{"token":"xyz123","name":"blue"}',
    `Authorization: Bearer ${jwt}`,
    `slack ${slackToken}`,
    `aws ${awsKey}`,
    `openai ${openAiKey}`,
    privateKey,
    `my password is ${proseSecret}`,
  ].join("\n");
  const digest = buildActivityDigest([user(1, text, Date.parse("2026-11-20T10:00:00Z"))], { timezone: "UTC" });
  const secrets: [string, string][] = [
    ["assignment", fakeAssignment], ["password", "hunter2"], ["json token", "xyz123"], ["jwt", jwt],
    ["slack", slackToken], ["aws", awsKey], ["openai", openAiKey], ["private key", privateBody], ["prose", proseSecret],
  ];
  for (const [label, secret] of secrets) {
    assert.equal(digest.text.includes(secret), false, `the digest must not contain the ${label} value`);
  }
  assert.ok(digest.text.includes("[redacted]"));
  assert.ok(digest.text.includes('"name":"blue"'), "harmless fields survive redaction");
});

test("activity: redaction covers key-value, bearer, provider shapes and private-key blocks", () => {
  const privateKey = ["-----BEGIN RSA", "PRIVATE KEY-----", "private-key-body", "-----END RSA", "PRIVATE KEY-----"].join(" ");
  const cases = [
    "token=abc123",
    "api_key: abc123",
    '"client_secret":"abc123"',
    "password is abc123",
    "Bearer abc.def.ghi",
    privateKey,
  ];
  for (const value of cases) {
    const redacted = redactActivityText(value);
    assert.equal(redacted.includes("abc123"), false, value);
    assert.match(redacted, /\[redacted/);
  }
});

test("activity: a tool call's arguments are summarized, redacted and bounded", () => {
  const summary = summarizeArguments({ path: "notes/deploy.md", token: "abc123", body: "x".repeat(2_000) });
  assert.ok(summary.length <= 241, "the summary is bounded");
  assert.equal(summary.includes("abc123"), false);
  assert.ok(summary.includes("notes/deploy.md"));
});

test("activity: the digest keeps the newest evidence and drops whole old lines", () => {
  const sources: ActivitySource[] = [];
  const start = Date.parse("2026-11-20T00:00:00Z");
  for (let index = 1; index <= 400; index += 1) {
    sources.push(user(index, `Event ${index}: ${"lorem ipsum dolor sit amet ".repeat(6)}`, start + index * 60_000));
  }
  const digest = buildActivityDigest(sources, { timezone: "UTC" });
  assert.ok(estimateTextTokens(digest.text) <= ACTIVITY_MAX_TOKENS, "the rendered digest fits the cap");
  assert.ok(digest.dropped > 0, "old lines were dropped");
  assert.equal(digest.lines + digest.dropped, 400);
  assert.ok(digest.text.includes("Event 400:"), "the newest event is kept");
  assert.equal(digest.text.includes("Event 1:"), false, "the oldest event is dropped");
  // Trimming happens at line boundaries: every retained line is a whole event body.
  for (const line of digest.text.split("\n").filter((item) => item.startsWith("["))) {
    assert.match(line, /^\[\d{2}:\d{2}\] user: Event \d+: /, "no partial line survives");
  }
});

test("activity: duplicate entries from a fork are counted once", () => {
  const first = user(1, "One fact.", Date.parse("2026-11-20T10:00:00Z"));
  const duplicated: ActivitySource = { conversationId: 2 as ConversationId, entry: { ...first.entry } };
  const digest = buildActivityDigest([first, duplicated], { timezone: "UTC" });
  assert.equal(digest.entries, 1);
  assert.equal(digest.text.match(/One fact\./gu)?.length, 1);
});

test("activity: no sources is an empty digest with no cursor", () => {
  const digest = buildActivityDigest([], { timezone: "UTC" });
  assert.deepEqual(digest, { text: "", through: null, entries: 0, lines: 0, dropped: 0 });
});
