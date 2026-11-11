// Conversation-aware memory (Slack hubs): one MemoryIntegration serving many conversations, each
// with its own long-term daily store, chosen by the conversation an operation belongs to.
//
// Two fixtures styles are used here:
//   - a real Harness with the composition root attached, one step at a time (registration,
//     per-conversation initialization, archive writes, retrieval through the native tools);
//   - a router model that answers chat, archive extraction and a memory_search probe driven from
//     the user text, so retrieval is exercised through the ordinary tool path, never a test shim.
//
// Nothing in these tests names a store from a model parameter: the store reaches each call site
// from `api.conversationId` (tools) and `runtime.conversationId` (the archive task).

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  Harness,
  type Conversation,
  type ConversationId,
  type EntryId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolRegistry } from "../src/tools.js";
import { MEMORY_BUDGET_DEFAULTS, type MemorySegment } from "../src/memory/contracts.js";
import { openDaily, publishSegments, searchDaily } from "../src/memory/daily.js";
import { readArchive } from "../src/memory/archive-task.js";
import { createMemoryIntegration, type MemoryIntegration } from "../src/memory/integration.js";

const context = BACKGROUND_CONTEXT;
const INSTRUCTIONS = "SYSTEM RULES: hubs are independent; cite memory sources.";
const MODEL = { provider: "faux", modelId: "faux-1" } as const;

function messageText(message: Message | undefined): string {
  if (message === undefined) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
}

/** The single model router: archive extraction, a memory_search probe, else a plain answer. */
function router(transcript: { readonly messages: readonly Message[] }) {
  const archiveCall = transcript.messages.some(
    (message) => message.role === "system" && messageText(message).includes("Extract useful daily events"),
  );
  if (archiveCall) {
    const input = transcript.messages.find((message) => message.role === "user");
    const sources = JSON.parse(messageText(input)) as { entryId: number }[];
    return fauxAssistantMessage(JSON.stringify({
      segments: sources.map((source) => ({
        sourceEntryId: source.entryId, kind: "result", status: "confirmed",
        text: `archived entry ${source.entryId}`, supersedes: [],
      })),
    }));
  }
  // Probe only the newest user message, and only until that request has its own search result:
  // a transcript that already answered a previous request's probe must not answer it again.
  let lastUser = -1;
  transcript.messages.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
  });
  if (lastUser >= 0) {
    const answered = transcript.messages.slice(lastUser + 1).some(
      (message) => message.role === "toolResult" && message.toolName === "memory_search",
    );
    const match = /SEARCH:(\S+)/.exec(messageText(transcript.messages[lastUser]));
    if (!answered && match !== null) {
      return fauxAssistantMessage(fauxToolCall("memory_search", { text: match[1]! }, { id: "search" }), { stopReason: "toolUse" });
    }
  }
  return fauxAssistantMessage("ok");
}

type HubsFixture = {
  readonly directory: string;
  readonly workspace: string;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly integration: MemoryIntegration;
  readonly harness: Harness;
  readonly root: Conversation;
};

async function openHubs(name: string): Promise<HubsFixture> {
  const directory = await mkdtemp(join(tmpdir(), name));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const integration = createMemoryIntegration({
    root: directory,
    instructions: INSTRUCTIONS,
    model: MODEL,
    contextWindow: 128_000,
    budget: MEMORY_BUDGET_DEFAULTS,
    reserveTokens: 16_384,
    timezone: "UTC",
  });
  const registry = createToolRegistry();
  for (const extension of integration.extensions()) registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
    models,
    registry,
    settings: { toolExecution: "sequential", compaction: integration.compactionSettings() },
  }, context);
  const root = await harness.root(context);
  await root.configure({ model: MODEL, cwd: workspace, instructions: INSTRUCTIONS }, context);
  integration.attach(harness, root);
  await integration.initialize(context);
  faux.setResponses(Array.from({ length: 300 }, () => router));
  harness.resume();
  return { directory, workspace, faux, integration, harness, root };
}

async function closeHubs(fixture: HubsFixture): Promise<void> {
  fixture.integration.close();
  await fixture.harness.close(context).catch(() => {});
  await rm(fixture.directory, { recursive: true, force: true }).catch(() => {});
}

async function member(fixture: HubsFixture): Promise<Conversation> {
  return fixture.harness.createConversation({
    ownership: { kind: "ownerless" },
    agent: { model: MODEL, cwd: fixture.workspace, instructions: INSTRUCTIONS },
  }, context);
}

/** Drive one request through the integration exactly as `agent.reply` does, for a conversation. */
async function drive(fixture: HubsFixture, conversation: Conversation, id: string, text: string): Promise<void> {
  const prepared = await fixture.integration.prepareRequestIn(conversation, { requestId: id, text }, context);
  const submission = await conversation.submit({ type: "input", content: text, requestId: id }, context);
  const settled = await submission.wait(context);
  assert.equal(settled.status, "done", `request ${id} must complete`);
  if (prepared.kind !== "replay") await fixture.integration.afterRequestIn(conversation, id, context);
}

async function lastMemorySearch(fixture: HubsFixture, conversation: Conversation): Promise<string | undefined> {
  const page = await conversation.entries({ order: "ascending" }, 400, undefined, context);
  let text: string | undefined;
  for (const entry of page.items) {
    if (entry.kind !== "pi.tool-result") continue;
    for (const message of entry.model ?? []) {
      if (message.role === "toolResult" && message.toolName === "memory_search") text = messageText(message);
    }
  }
  return text;
}

async function until(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a durable condition");
    await delay(25);
  }
}

function segment(id: string, date: string, text: string, kind: MemorySegment["kind"] = "result"): MemorySegment {
  return {
    version: 1, id, date, timezone: "UTC", page: 1, kind, status: "confirmed", text,
    sources: { conversationId: 1 as ConversationId, after: null, through: 1 as EntryId },
    supersedes: [], supersededBy: null,
  };
}

// ---------------------------------------------------------------------------
// (a) two hubs write to their own store on disk; (c) their archive state is independent
// ---------------------------------------------------------------------------

test("hubs: two conversations archive into their own daily store with independent state", { timeout: 60_000 }, async () => {
  const fixture = await openHubs("mem-hubs-stores-");
  try {
    const rootA = join(fixture.directory, "hubs", "alice");
    const rootB = join(fixture.directory, "hubs", "bob");
    const alice = await member(fixture);
    const bob = await member(fixture);
    fixture.integration.registerConversationStore(alice.id, rootA);
    fixture.integration.registerConversationStore(bob.id, rootB);

    // Registration is idempotent for the same pair, a no-op for the attached root conversation,
    // and a different root for an already registered conversation is a programming error.
    fixture.integration.registerConversationStore(alice.id, rootA);
    fixture.integration.registerConversationStore(fixture.root.id, fixture.directory);
    assert.throws(
      () => fixture.integration.registerConversationStore(alice.id, rootB),
      (error: unknown) => (error as { code?: string }).code === "invalid-input",
      "a conversation cannot be re-pointed at another root",
    );
    assert.throws(
      () => fixture.integration.registerConversationStore(fixture.root.id, rootA),
      (error: unknown) => (error as { code?: string }).code === "invalid-input",
      "the attached root conversation cannot be re-pointed",
    );

    await fixture.integration.initializeConversation(alice, context);
    await fixture.integration.initializeConversation(bob, context);
    assert.equal((await readArchive(fixture.harness, alice.id, context))?.initialized, true);
    assert.equal((await readArchive(fixture.harness, bob.id, context))?.initialized, true);

    // Per-conversation lifecycle: ending Alice's cycle writes only in Alice's conversation.
    await fixture.integration.resetConversationIn(alice, context);
    const aliceResets = (await alice.entries({ order: "ascending" }, 200, undefined, context)).items.filter((entry) => entry.kind === "pi.reset");
    assert.equal(aliceResets.length, 1, "Alice's reset is durable in her own conversation");
    const bobResets = (await bob.entries({ order: "ascending" }, 200, undefined, context)).items.filter((entry) => entry.kind === "pi.reset");
    assert.equal(bobResets.length, 0, "Bob's conversation is untouched by Alice's reset");

    // One past-dated user entry per hub is what the archive is allowed to cover.
    const past = Date.parse("2026-10-24T12:00:00Z");
    const appendPast = (conversation: Conversation) => fixture.harness.commit(
      async (tx) => (await tx.appendEntry(conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text: "a dated event" }], timestamp: past }],
      })).id,
      context,
    );

    await appendPast(alice);
    await drive(fixture, alice, "a-1", "hello alice");
    await until(async () => ((await readArchive(fixture.harness, alice.id, context))?.archivedThrough ?? 0) > 0);

    // Alice's run published into Alice's own store, and Bob's state is untouched.
    const aliceHits = (await searchDaily(openDaily(rootA))).hits;
    assert.equal(aliceHits.length, 1);
    assert.ok(aliceHits[0]!.segment.id.startsWith(`archive:${alice.id}:`), "the segment belongs to Alice's conversation");
    assert.equal((await readArchive(fixture.harness, bob.id, context))?.archivedThrough, null, "Bob's cursor is independent");
    assert.equal((await searchDaily(openDaily(rootB))).available, 0, "Bob's store stayed empty");

    await appendPast(bob);
    await drive(fixture, bob, "b-1", "hello bob");
    await until(async () => ((await readArchive(fixture.harness, bob.id, context))?.archivedThrough ?? 0) > 0);

    // Bob wrote his own store; Alice's root was not touched by Bob's run.
    const bobHits = (await searchDaily(openDaily(rootB))).hits;
    assert.equal(bobHits.length, 1);
    assert.ok(bobHits[0]!.segment.id.startsWith(`archive:${bob.id}:`), "the segment belongs to Bob's conversation");
    const aliceAll = (await searchDaily(openDaily(rootA))).hits;
    assert.deepEqual(aliceAll.map((hit) => hit.segment.id), aliceHits.map((hit) => hit.segment.id), "Bob's run wrote nothing into Alice's store");
    assert.ok(aliceAll.every((hit) => hit.segment.id.startsWith(`archive:${alice.id}:`)));
  } finally {
    await closeHubs(fixture);
  }
});

// ---------------------------------------------------------------------------
// (b) memory_search never crosses conversations; (d) a fork shares its hub's store
// ---------------------------------------------------------------------------

test("hubs: memory_search resolves the calling conversation's store, and a fork shares its hub's", { timeout: 60_000 }, async () => {
  const fixture = await openHubs("mem-hubs-retrieval-");
  try {
    const rootA = join(fixture.directory, "hubs", "alice");
    const rootB = join(fixture.directory, "hubs", "bob");
    await publishSegments(openDaily(rootA), [segment("note-alpha", "2026-10-01", "alpha-unique-marker lives in alice's hub")]);
    await publishSegments(openDaily(rootB), [segment("note-beta", "2026-10-01", "beta-unique-marker lives in bob's hub")]);

    const alice = await member(fixture);
    const bob = await member(fixture);
    fixture.integration.registerConversationStore(alice.id, rootA);
    fixture.integration.registerConversationStore(bob.id, rootB);

    // A follow-up under Alice's hub is a fork; it must share Alice's store.
    const forkAt = await fixture.harness.commit(
      async (tx) => (await tx.appendEntry(alice.id, {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text: "hub seed" }], timestamp: Date.now() }],
      })).id,
      context,
    );
    const aliceFork = await alice.fork(forkAt, { ownership: { kind: "ownerless" } }, context);
    fixture.integration.registerConversationStore(aliceFork.id, rootA);
    // A fork is initialized like any conversation (the host does this when it opens a thread), but it
    // owns no archive: its inherited history belongs to the Hub and it reaches the store it shares.
    await fixture.integration.initializeConversation(aliceFork, context);
    assert.equal(await readArchive(fixture.harness, aliceFork.id, context), undefined, "a fork has no archive of its own");

    // Bob searches for Alice's marker: his own store is consulted, so Alice's record never appears.
    await drive(fixture, bob, "b-other", "SEARCH:alpha-unique-marker");
    const bobSearchingAlice = await lastMemorySearch(fixture, bob);
    assert.ok(bobSearchingAlice !== undefined && bobSearchingAlice.startsWith("no matches"), "Bob's store holds no Alice record");
    assert.ok(!bobSearchingAlice.includes("note-alpha"), "Alice's record never appears in Bob's conversation");

    // Bob sees his own fact; Alice's own search sees hers.
    await drive(fixture, bob, "b-own", "SEARCH:beta-unique-marker");
    const bobOwn = await lastMemorySearch(fixture, bob);
    assert.ok(bobOwn?.includes("[note-beta]"), "Bob's own record is reachable in his own store");
    await drive(fixture, alice, "a-own", "SEARCH:alpha-unique-marker");
    const aliceAlpha = await lastMemorySearch(fixture, alice);
    assert.ok(aliceAlpha?.includes("[note-alpha]"), "Alice's own record is returned");

    // The isolation probe in the other direction: Alice's store holds no Bob record.
    await drive(fixture, alice, "a-other", "SEARCH:beta-unique-marker");
    const aliceSearchingBob = await lastMemorySearch(fixture, alice);
    assert.ok(aliceSearchingBob !== undefined && aliceSearchingBob.startsWith("no matches"), "Alice's store holds no Bob record");
    assert.ok(!aliceSearchingBob.includes("note-beta"), "Bob's record never appears in Alice's conversation");

    // The fork shares Alice's store: the same record is reachable from the fork.
    await drive(fixture, aliceFork, "r-f1", "SEARCH:alpha-unique-marker");
    const forkAlpha = await lastMemorySearch(fixture, aliceFork);
    assert.ok(forkAlpha?.includes("[note-alpha]"), "a fork reads the hub's store");
  } finally {
    await closeHubs(fixture);
  }
});

// ---------------------------------------------------------------------------
// An unregistered conversation is an explicit error, never a fallback to the owner's memory.
// ---------------------------------------------------------------------------

test("hubs: an unregistered conversation cannot reach any store", { timeout: 30_000 }, async () => {
  const fixture = await openHubs("mem-hubs-unregistered-");
  try {
    const stray = await member(fixture);
    await drive(fixture, stray, "s-1", "SEARCH:anything");
    const result = await lastMemorySearch(fixture, stray);
    assert.ok(result?.includes("MEMORY_INVALID_INPUT"), "the missing store is an explicit memory error, not a fallback");
    assert.equal(await readArchive(fixture.harness, stray.id, context), undefined, "no archive state was created for the stray conversation");
  } finally {
    await closeHubs(fixture);
  }
});
