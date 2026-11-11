import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { FORK_CLOSED_NOTICE, HubStore, MAX_FORK_ROUNDS, memberMemoryRoot, memberWorkspace } from "../src/hubs.js";

const OWNER_HUB = 1 as ConversationId;
const MEMBER_HUB = 7 as ConversationId;
const FORK = 8 as ConversationId;

const CHANNEL = "C0CHANNEL12";

async function withStore(run: (store: HubStore, path: string) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pa-hubs-"));
  const path = join(directory, "hubs.sqlite");
  const store = new HubStore(path);
  try {
    await run(store, path);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a member Hub is adopted once and a different conversation is refused", async () => {
  await withStore((store) => {
    assert.equal(store.member("U0MEMBER123"), undefined, "an unknown member has no Hub");
    assert.deepEqual(store.adopt("U0MEMBER123", MEMBER_HUB), { memberId: "U0MEMBER123", conversationId: MEMBER_HUB });
    // Adopting the same conversation again is a retry after a crash, not a change of Hub.
    assert.deepEqual(store.adopt("U0MEMBER123", MEMBER_HUB), { memberId: "U0MEMBER123", conversationId: MEMBER_HUB });
    assert.equal(store.member("U0MEMBER123")?.conversationId, MEMBER_HUB);
    assert.equal(store.memberOf(MEMBER_HUB), "U0MEMBER123", "a Hub conversation maps back to its member");
    assert.equal(store.memberOf(OWNER_HUB), undefined, "the owner's root conversation has no member row");
    // Reassigning a member to another conversation would silently move their history and memory.
    assert.throws(() => store.adopt("U0MEMBER123", 9 as ConversationId), /already has a Hub conversation/);
  });
});

test("a thread records its Hub, its fork and its rounds exactly once per request", async () => {
  await withStore((store) => {
    const opened = store.openThread(CHANNEL, "1700000000.000100", MEMBER_HUB);
    assert.deepEqual(opened, {
      channel: CHANNEL,
      threadTs: "1700000000.000100",
      conversationId: MEMBER_HUB,
      fork: undefined,
      rounds: 0,
      closed: false,
    });
    // Opening an existing thread returns it unchanged instead of resetting its budget.
    assert.equal(store.openThread(CHANNEL, "1700000000.000100", MEMBER_HUB).rounds, 0);

    store.setFork(CHANNEL, "1700000000.000100", FORK);
    assert.equal(store.thread(CHANNEL, "1700000000.000100")?.fork, FORK);

    const first = store.recordRound(CHANNEL, "1700000000.000100", "slack:T1:Ev1");
    assert.equal(first.rounds, 1);
    // Slack redelivers an unacknowledged envelope and recovery replays an unfinished request: the same
    // request id is one round, so a replay cannot end a thread early.
    assert.equal(store.recordRound(CHANNEL, "1700000000.000100", "slack:T1:Ev1").rounds, 1);
    for (const event of ["Ev2", "Ev3", "Ev4"]) store.recordRound(CHANNEL, "1700000000.000100", `slack:T1:${event}`);
    const capped = store.recordRound(CHANNEL, "1700000000.000100", "slack:T1:Ev5");
    assert.equal(capped.rounds, MAX_FORK_ROUNDS);
    assert.equal(capped.closed, false, "reaching the cap does not close the thread by itself");

    store.closeThread(CHANNEL, "1700000000.000100");
    assert.equal(store.thread(CHANNEL, "1700000000.000100")?.closed, true);
    // Closing twice keeps the first time, so the notice is not sent again by a retry.
    store.closeThread(CHANNEL, "1700000000.000100");
    assert.equal(store.thread(CHANNEL, "1700000000.000100")?.closed, true);
  });
});

test("threads and members survive a restart, and unknown keys stay unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-hubs-"));
  const path = join(directory, "hubs.sqlite");
  try {
    const first = new HubStore(path);
    first.adopt("U0MEMBER123", MEMBER_HUB);
    first.openThread(CHANNEL, "1700000000.000100", MEMBER_HUB);
    first.setFork(CHANNEL, "1700000000.000100", FORK);
    first.recordRound(CHANNEL, "1700000000.000100", "slack:T1:Ev1");
    first.close();
    const reopened = new HubStore(path);
    assert.equal(reopened.member("U0MEMBER123")?.conversationId, MEMBER_HUB);
    const thread = reopened.thread(CHANNEL, "1700000000.000100");
    assert.equal(thread?.fork, FORK);
    assert.equal(thread?.rounds, 1);
    assert.equal(reopened.thread(CHANNEL, "1700000000.999999"), undefined);
    assert.equal(reopened.thread("C0OTHERC12", "1700000000.000100"), undefined, "the anchor is per channel");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Hub keeps its own memory store root and workspace, derived from its member", () => {
  assert.equal(memberMemoryRoot("/data", "U0MEMBER123"), "/data/memory/members/U0MEMBER123");
  assert.equal(memberWorkspace("/data", "U0MEMBER123"), "/data/workspace/members/U0MEMBER123");
  // Paths are built from the transport's id shape only: a member id can never be a path traversal.
  assert.throws(() => memberMemoryRoot("/data", "../../etc"), /Not a Slack member id/);
  assert.throws(() => memberWorkspace("/data", "U0MEMBER123/../.."), /Not a Slack member id/);
  // The notice is host text, never a model output, and says exactly one thing.
  assert.equal(FORK_CLOSED_NOTICE, "该问题循环过多，请不要再回复。");
});
