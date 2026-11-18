import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EventHub } from "../src/http/events.js";
import { WebRequestStore } from "../src/http/store.js";
import { RequestWorker } from "../src/http/worker.js";
import { fakeAgent, fixtureSelection, message, waitFor } from "./http-testkit.js";

function recordingHub(): { hub: EventHub; events: { event: string; data: unknown }[] } {
  const events: { event: string; data: unknown }[] = [];
  const hub = {
    broadcast(event: string, data: unknown) {
      events.push({ event, data });
    },
  } as unknown as EventHub;
  return { hub, events };
}

test("clientMessageId is idempotent and one worker drains FIFO with one running request", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub, events } = recordingHub();
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let running = 0;
  let maxRunning = 0;
  const order: string[] = [];
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({
      service: fixture.service,
      reply: async (request) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        order.push(request.text);
        if (request.text === "first") await firstGate;
        running -= 1;
        return `echo:${request.text}`;
      },
    }),
  });
  try {
    const first = store.enqueue("client-1", "first");
    const duplicate = store.enqueue("client-1", "first");
    assert.equal(duplicate.row.request_id, first.row.request_id);
    assert.equal(duplicate.created, false);

    const second = store.enqueue("client-2", "second");
    worker.start();
    worker.notify();
    await waitFor(() => store.get(first.row.request_id)?.status === "running");
    assert.equal(store.get(second.row.request_id)?.status, "queued", "second stays queued");
    releaseFirst?.();
    await waitFor(() => store.get(second.row.request_id)?.status === "done");
    assert.equal(store.get(first.row.request_id)?.status, "done");
    assert.equal(maxRunning, 1);
    assert.deepEqual(order, ["first", "second"]);
    assert.ok(events.some((event) => event.event === "request.running"));
    const doneEvents = events.filter((event) => event.event === "request.done") as {
      data: { requestId: string; message: { requestId: string | null; clientMessageId: string | null } };
    }[];
    assert.equal(doneEvents.length, 2);
    for (const { data } of doneEvents) {
      assert.equal(data.message.requestId, data.requestId);
      assert.equal(data.message.clientMessageId, store.clientMessageId(data.requestId));
    }
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a provider failure becomes a failed row with a stable code and safe message", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-fail-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub, events } = recordingHub();
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({
      service: fixture.service,
      reply: async () => {
        throw Object.assign(new Error("upstream says secret"), { code: "MODEL_UNAVAILABLE" });
      },
    }),
  });
  try {
    const { row } = store.enqueue("client-fail", "hello");
    worker.start();
    worker.notify();
    await waitFor(() => store.get(row.request_id)?.status === "failed");
    const stored = store.get(row.request_id)!;
    assert.equal(stored.error_code, "MODEL_UNAVAILABLE");
    assert.equal(stored.error_message, "模型暂时不可用");
    assert.equal(JSON.stringify(stored).includes("secret"), false);
    const failed = events.find((event) => event.event === "request.failed");
    assert.deepEqual(failed?.data, {
      requestId: row.request_id,
      code: "MODEL_UNAVAILABLE",
      message: "模型暂时不可用",
    });
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("abort stops a running generation and a queued request is withdrawn", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-abort-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub, events } = recordingHub();
  let aborted = false;
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({
      service: fixture.service,
      reply: async (_request, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
        }, { once: true });
      }),
    }),
  });
  try {
    const running = store.enqueue("client-run", "slow");
    const queued = store.enqueue("client-queued", "later");
    worker.start();
    worker.notify();
    await waitFor(() => store.get(running.row.request_id)?.status === "running");

    assert.deepEqual(worker.abort(running.row.request_id), { ok: true });
    await waitFor(() => store.get(running.row.request_id)?.status === "aborted");
    assert.equal(aborted, true);
    assert.ok(events.some((event) => event.event === "request.aborted"));
    assert.equal(events.filter((event) => event.event === "request.done").length, 0);

    assert.deepEqual(worker.abort(queued.row.request_id), { ok: true });
    assert.equal(store.get(queued.row.request_id)?.status, "aborted");

    assert.deepEqual(worker.abort(running.row.request_id), { ok: false, reason: "not_active" });
    assert.deepEqual(worker.abort("req_missing"), { ok: false, reason: "not_found" });
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a request left running by a crash is failed as PROCESS_INTERRUPTED on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-recover-"));
  try {
    const path = join(directory, "web.sqlite");
    const first = new WebRequestStore(path);
    const { row } = first.enqueue("client-crash", "hello");
    assert.equal(first.claimNext()?.request_id, row.request_id);
    first.close();
    const second = new WebRequestStore(path);
    try {
      const recovered = second.get(row.request_id)!;
      assert.equal(recovered.status, "failed");
      assert.equal(recovered.error_code, "PROCESS_INTERRUPTED");
      assert.equal(recovered.error_message, "服务重启，请重试");
    } finally {
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("steer is accepted only for the running request, broadcasts once and reports its settled answer", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-steer-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub, events } = recordingHub();
  const gate = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<import("../src/http/projection.js").UiMessage | undefined>();
  const steerCalls: string[] = [];
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({
      service: fixture.service,
      reply: async () => {
        await gate.promise;
        return "original answer";
      },
      steer: async (request) => {
        steerCalls.push(request.requestId);
        return { steerId: request.requestId, done: settled.promise };
      },
    }),
  });
  try {
    const { row } = store.enqueue("client-original", "original");
    worker.start();
    worker.notify();
    await waitFor(() => store.get(row.request_id)?.status === "running");

    assert.deepEqual(await worker.steer("another-request", "client-steer", "steer text"),
      { ok: false, reason: "not_active" });
    assert.equal(steerCalls.length, 0);

    assert.deepEqual(await worker.steer(row.request_id, "client-steer", "steer text"),
      { ok: true, steerId: "steer:client-steer" });
    const steered = events.filter((event) => event.event === "request.steered");
    assert.equal(steered.length, 1);
    assert.deepEqual(steered[0]?.data, {
      requestId: row.request_id,
      steerId: "steer:client-steer",
      clientMessageId: "client-steer",
      text: "steer text",
      createdAt: (steered[0]?.data as { createdAt: number }).createdAt,
    });
    const createdAt = (steered[0]?.data as { createdAt?: unknown } | undefined)?.createdAt;
    assert.equal(typeof createdAt, "number");
    assert.ok((createdAt as number) > 0);

    // A retry of the same admission gets the same id and must not show the user row twice.
    assert.deepEqual(await worker.steer(row.request_id, "client-steer", "steer text"),
      { ok: true, steerId: "steer:client-steer" });
    assert.equal(events.filter((event) => event.event === "request.steered").length, 1);

    const answer = message({ id: "steer-answer", text: "steer answer" });
    settled.resolve(answer);
    await waitFor(() => events.some((event) => event.event === "steer.done"));
    assert.deepEqual(events.find((event) => event.event === "steer.done")?.data, {
      requestId: row.request_id,
      steerId: "steer:client-steer",
      message: answer,
    });

    gate.resolve();
    await waitFor(() => store.get(row.request_id)?.status === "done");
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("steering with no running request is refused without touching the queue", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-steer-idle-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub, events } = recordingHub();
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({ service: fixture.service, reply: async () => "unused" }),
  });
  try {
    worker.start();
    assert.deepEqual(await worker.steer("request-any", "client-steer", "too late"),
      { ok: false, reason: "no_active_request" });
    assert.equal(store.active(), undefined);
    assert.equal(events.length, 0);
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
