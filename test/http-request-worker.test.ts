import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EventHub } from "../src/http/events.js";
import { WebRequestStore } from "../src/http/store.js";
import { RequestWorker } from "../src/http/worker.js";
import { fakeAgent, fixtureSelection, message, steerHandle, waitFor } from "./http-testkit.js";

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
        return steerHandle(request.requestId, settled.promise);
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

test("the pending queue is listed in claim order and never contains running or settled rows", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-queue-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub } = recordingHub();
  const gate = Promise.withResolvers<void>();
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({
      service: fixture.service,
      reply: async () => {
        await gate.promise;
        return "done";
      },
    }),
  });
  try {
    const first = store.enqueue("queue-a", "a");
    const second = store.enqueue("queue-b", "b");
    const third = store.enqueue("queue-c", "c");
    worker.start();
    worker.notify();
    await waitFor(() => store.get(first.row.request_id)?.status === "running");

    assert.deepEqual(store.listQueued(), [
      {
        requestId: second.row.request_id,
        clientMessageId: "queue-b",
        text: "b",
        createdAt: second.row.created_at,
      },
      {
        requestId: third.row.request_id,
        clientMessageId: "queue-c",
        text: "c",
        createdAt: third.row.created_at,
      },
    ]);

    gate.resolve();
    await waitFor(() => store.get(third.row.request_id)?.status === "done");
    assert.deepEqual(store.listQueued(), []);
    assert.deepEqual(store.listQueued(1).length, 0);
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("promoting a queued message while running injects it into that run and is idempotent", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-promote-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub, events } = recordingHub();
  const gate = Promise.withResolvers<void>();
  const steerCalls: { requestId: string; text: string }[] = [];
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
        steerCalls.push({ requestId: request.requestId, text: request.text });
        return steerHandle(request.requestId, new Promise(() => {}));
      },
    }),
  });
  try {
    const original = store.enqueue("client-original", "original");
    const queued = store.enqueue("client-promote", "promoted text");
    worker.start();
    worker.notify();
    await waitFor(() => store.get(original.row.request_id)?.status === "running");

    const promoted = await worker.promote(queued.row.request_id);
    assert.deepEqual(promoted, {
      ok: true,
      mode: "steered",
      steerId: "steer:client-promote",
    });
    assert.equal(store.get(queued.row.request_id)?.status, "promoted");
    assert.deepEqual(store.listQueued(), []);
    assert.deepEqual(steerCalls, [{ requestId: "steer:client-promote", text: "promoted text" }]);

    const steered = events.find((event) => event.event === "request.steered");
    assert.deepEqual(steered?.data, {
      requestId: original.row.request_id,
      steerId: "steer:client-promote",
      clientMessageId: "client-promote",
      text: "promoted text",
      createdAt: (steered?.data as { createdAt: number }).createdAt,
    });
    const lastQueue = events.filter((event) => event.event === "queue.changed").at(-1);
    assert.deepEqual(lastQueue?.data, { items: [] });

    // A retry returns the same steer id and injects nothing again.
    assert.deepEqual(await worker.promote(queued.row.request_id), {
      ok: true,
      mode: "steered",
      steerId: "steer:client-promote",
    });
    assert.equal(steerCalls.length, 1);
    assert.equal(events.filter((event) => event.event === "request.steered").length, 1);

    gate.resolve();
    await waitFor(() => store.get(original.row.request_id)?.status === "done");
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("promoting with nothing running starts that message immediately, ahead of older queued rows", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-promote-idle-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub, events } = recordingHub();
  const order: string[] = [];
  const gate = Promise.withResolvers<void>();
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({
      service: fixture.service,
      reply: async (request) => {
        order.push(request.text);
        await gate.promise;
        return `answer:${request.text}`;
      },
    }),
  });
  try {
    const older = store.enqueue("client-older", "older");
    const target = store.enqueue("client-target", "start me");

    const promoted = await worker.promote(target.row.request_id);
    assert.deepEqual(promoted, { ok: true, mode: "started" });
    assert.equal(store.get(target.row.request_id)?.status, "running");
    assert.equal(store.get(older.row.request_id)?.status, "queued");
    assert.deepEqual(store.listQueued().map((item) => item.clientMessageId), ["client-older"]);

    gate.resolve();
    await waitFor(() => store.get(target.row.request_id)?.status === "done");
    assert.deepEqual(order, ["start me"]);
    assert.deepEqual(
      events.filter((event) => event.event === "request.running").map((event) => event.data),
      [{ requestId: target.row.request_id }],
    );
    assert.equal(store.get(older.row.request_id)?.status, "queued");
    assert.ok(events.some((event) => event.event === "queue.changed"));
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("promote refuses rows that already left the queue and reports a missing id", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-promote-refuse-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub } = recordingHub();
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({ service: fixture.service, reply: async () => "unused" }),
  });
  try {
    assert.deepEqual(await worker.promote("req_AAAAAAAAAAAAAAAA"), { ok: false, reason: "not_queued", requestStatus: null });

    const running = store.enqueue("client-running", "running");
    store.claimNext();
    assert.deepEqual(await worker.promote(running.row.request_id), { ok: false, reason: "not_queued", requestStatus: "running" });

    const aborted = store.enqueue("client-aborted", "aborted");
    store.markAborted(aborted.row.request_id);
    assert.deepEqual(await worker.promote(aborted.row.request_id), { ok: false, reason: "not_queued", requestStatus: "aborted" });

    const done = store.enqueue("client-done", "done");
    store.claimNext();
    store.markDone(done.row.request_id, "answer", { requested: null, actual: null, kind: null, degraded: false });
    assert.deepEqual(await worker.promote(done.row.request_id), { ok: false, reason: "not_queued", requestStatus: "done" });
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborting a queued row removes it from the queue and broadcasts the new list", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-queue-abort-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub, events } = recordingHub();
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({ service: fixture.service, reply: async () => "unused" }),
  });
  try {
    const first = store.enqueue("client-abort", "abort me");
    const second = store.enqueue("client-keep", "keep me");
    assert.deepEqual(worker.abort(first.row.request_id), { ok: true });
    assert.equal(store.get(first.row.request_id)?.status, "aborted");
    assert.deepEqual(store.listQueued().map((item) => item.clientMessageId), ["client-keep"]);
    assert.deepEqual(events.filter((event) => event.event === "queue.changed").at(-1)?.data, {
      items: [{
        requestId: second.row.request_id,
        clientMessageId: "client-keep",
        text: "keep me",
        createdAt: second.row.created_at,
      }],
    });
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("promote starts the message when the run goes idle before the injection lands", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-promote-race-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub, events } = recordingHub();
  const gate = Promise.withResolvers<void>();
  let concurrent = 0;
  let maxConcurrent = 0;
  const order: string[] = [];
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({
      service: fixture.service,
      reply: async (request) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(request.text);
        await gate.promise;
        concurrent -= 1;
        return `answer:${request.text}`;
      },
      steer: async () => {
        // The run finishes and the durable conversation is idle at the injection point.
        gate.resolve();
        throw Object.assign(new Error("idle"), { code: "NO_ACTIVE_REQUEST" });
      },
    }),
  });
  try {
    const original = store.enqueue("client-original", "original");
    const target = store.enqueue("client-target", "start me");
    worker.start();
    worker.notify();
    await waitFor(() => store.get(original.row.request_id)?.status === "running");

    assert.deepEqual(await worker.promote(target.row.request_id), { ok: true, mode: "started" });
    await waitFor(() => store.get(target.row.request_id)?.status === "done");
    assert.equal(store.get(original.row.request_id)?.status, "done");
    assert.deepEqual(order, ["original", "start me"]);
    assert.equal(maxConcurrent, 1);
    assert.ok(events.some((event) => event.event === "queue.changed"));
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("abort immediately followed by promote never strands a promoted row (20 iterations)", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-abort-promote-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub } = recordingHub();
  const releases = new Map<string, () => void>();
  const replies: string[] = [];
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({
      service: fixture.service,
      reply: (request, signal) => new Promise<string>((resolve, reject) => {
        replies.push(request.text);
        releases.set(request.requestId, () => resolve(`answer:${request.text}`));
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
        }, { once: true });
      }),
    }),
  });
  try {
    worker.start();
    for (let index = 0; index < 20; index += 1) {
      const base = store.enqueue(`race-base-${index}`, "base");
      worker.notify();
      await waitFor(() => store.get(base.row.request_id)?.status === "running");
      const target = store.enqueue(`race-target-${index}`, `target-${index}`);

      assert.deepEqual(worker.abort(base.row.request_id), { ok: true });
      const promoted = await worker.promote(target.row.request_id);

      if (promoted.ok) {
        assert.equal(promoted.mode, "started", "an aborted run must not take the steer path");
        await waitFor(() => releases.has(target.row.request_id));
        releases.get(target.row.request_id)!();
      } else {
        assert.equal(promoted.reason, "not_queued");
        assert.equal(promoted.requestStatus, "running", "a claimed row reports its new status");
        await waitFor(() => releases.has(target.row.request_id));
        releases.get(target.row.request_id)!();
      }

      await waitFor(() => store.get(target.row.request_id)?.status === "done");
      assert.notEqual(store.get(target.row.request_id)?.status, "promoted");
      assert.equal(store.get(base.row.request_id)?.status, "aborted");
    }
    assert.equal(replies.filter((text) => text === "base").length, 20);
    assert.equal(replies.filter((text) => text.startsWith("target-")).length, 20);
  } finally {
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a steer that settles without an answer returns its promoted row to the queue and runs it", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-steer-unanswered-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub, events } = recordingHub();
  const baseGate = Promise.withResolvers<void>();
  const replies: string[] = [];
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({
      service: fixture.service,
      reply: (request, signal) => {
        replies.push(request.text);
        if (request.text !== "base") return Promise.resolve(`answer:${request.text}`);
        return new Promise<string>((_resolve, reject) => {
          baseGate.promise.catch(() => {});
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
          }, { once: true });
        });
      },
      steer: async (request) => steerHandle(request.requestId, Promise.resolve(undefined), {
        status: async () => "queued",
        abort: async () => "aborted",
      }),
    }),
  });
  try {
    const base = store.enqueue("client-base", "base");
    const target = store.enqueue("client-target", "target text");
    worker.start();
    worker.notify();
    await waitFor(() => store.get(base.row.request_id)?.status === "running");

    const promoted = await worker.promote(target.row.request_id);
    assert.deepEqual(promoted, { ok: true, mode: "steered", steerId: "steer:client-target" });

    // The unanswered steer must not leave the row promoted.
    await waitFor(() => store.get(target.row.request_id)?.status === "queued");
    assert.ok(events.some((event) => event.event === "queue.changed"
      && (event.data as { items: { clientMessageId: string }[] }).items
        .some((item) => item.clientMessageId === "client-target")));

    worker.abort(base.row.request_id);
    await waitFor(() => store.get(target.row.request_id)?.status === "done");
    assert.equal(store.get(target.row.request_id)?.status, "done");
    assert.ok(replies.includes("target text"));
  } finally {
    baseGate.resolve();
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborting withdraws a still-queued steer and requeues its promoted row", async () => {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-worker-steer-withdraw-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const { hub } = recordingHub();
  const done = Promise.withResolvers<import("../src/http/projection.js").UiMessage | undefined>();
  const targetGate = Promise.withResolvers<void>();
  let steerStatus: "queued" | "placed" | "done" | "unanswered" = "queued";
  const replies: string[] = [];
  const worker = new RequestWorker({
    store,
    hub,
    ownerId: "owner",
    agent: fakeAgent({
      service: fixture.service,
      reply: (request, signal) => {
        replies.push(request.text);
        if (request.text !== "base") {
          return targetGate.promise.then(() => `answer:${request.text}`);
        }
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
          }, { once: true });
        });
      },
      steer: async (request) => steerHandle(request.requestId, done.promise, {
        status: async () => steerStatus,
        abort: async () => {
          steerStatus = "unanswered";
          done.resolve(undefined);
          return "aborted";
        },
      }),
    }),
  });
  try {
    const base = store.enqueue("client-base", "base");
    const target = store.enqueue("client-target", "target text");
    worker.start();
    worker.notify();
    await waitFor(() => store.get(base.row.request_id)?.status === "running");

    assert.deepEqual(await worker.promote(target.row.request_id),
      { ok: true, mode: "steered", steerId: "steer:client-target" });
    assert.equal(store.get(target.row.request_id)?.status, "promoted");

    assert.deepEqual(worker.abort(base.row.request_id), { ok: true });
    // The row was requeued and the worker claimed it, which is why it is running again.
    await waitFor(() => store.get(target.row.request_id)?.status === "running");
    assert.equal(steerStatus, "unanswered");
    targetGate.resolve();
    await waitFor(() => store.get(target.row.request_id)?.status === "done");
    assert.ok(replies.includes("target text"));
  } finally {
    targetGate.resolve();
    await worker.stop();
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
