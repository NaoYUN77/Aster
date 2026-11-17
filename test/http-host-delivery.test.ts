import assert from "node:assert/strict";
import test from "node:test";
import { AgentGate } from "../src/http/agent-gate.js";
import type { EventHub } from "../src/http/events.js";
import { WebHostDelivery, type HostMessageAgent } from "../src/http/host-delivery.js";
import type { UiMessage } from "../src/http/projection.js";

function message(text: string, id = "1"): UiMessage {
  return {
    id,
    role: "system",
    text,
    createdAt: 1,
    status: "complete",
    requestId: null,
    clientMessageId: null,
    model: null,
    errorCode: null,
    tool: null,
  };
}

function recordingHub(): { hub: EventHub; events: { event: string; data: unknown }[] } {
  const events: { event: string; data: unknown }[] = [];
  return {
    hub: { broadcast(event: string, data: unknown) { events.push({ event, data }); } } as unknown as EventHub,
    events,
  };
}

test("host delivery persists once and broadcasts the same host.message", async () => {
  const { hub, events } = recordingHub();
  const calls: { text: string; key?: string; source: string }[] = [];
  const agent: HostMessageAgent = {
    async hostMessage(input) {
      calls.push({ text: input.text, ...(input.key === undefined ? {} : { key: input.key }), source: input.source });
      return message(input.text, String(calls.length));
    },
  };
  const delivery = new WebHostDelivery({ agent, hub, gate: new AgentGate() });
  const sent = await delivery.send("reminder", "提醒：喝水", new AbortController().signal, "reminder:1");
  assert.equal(sent.id, "1");
  assert.deepEqual(calls, [{ text: "提醒：喝水", key: "reminder:1", source: "reminder" }]);
  assert.deepEqual(events, [{ event: "host.message", data: { message: sent } }]);
});

test("the agent gate serializes host writes with each other", async () => {
  const gate = new AgentGate();
  let active = 0;
  let maxActive = 0;
  const agent: HostMessageAgent = {
    async hostMessage(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return message(input.text);
    },
  };
  const delivery = new WebHostDelivery({ agent, hub: recordingHub().hub, gate });
  await Promise.all([
    delivery.send("watch", "one", new AbortController().signal),
    delivery.send("routine", "two", new AbortController().signal),
  ]);
  assert.equal(maxActive, 1);
});

test("an already-aborted signal writes nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const agent: HostMessageAgent = {
    async hostMessage() {
      throw new Error("must not be called");
    },
  };
  const delivery = new WebHostDelivery({ agent, hub: recordingHub().hub, gate: new AgentGate() });
  await assert.rejects(delivery.send("reminder", "x", controller.signal), { name: "AbortError" });
});
