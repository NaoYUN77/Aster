import assert from "node:assert/strict";
import test from "node:test";
import { Inbox } from "../src/inbox.js";

const request = {
  requestId: "proactive:1",
  conversationId: "1",
  senderId: "1",
  text: "proactive",
};

test("host delivery is idempotent across partial sends and preserves unknown outcomes", () => {
  const inbox = new Inbox(":memory:");
  try {
    const reply = "x".repeat(5000);
    inbox.enqueue(request, reply);
    assert.equal(inbox.deliveryStatus(request.requestId), "ready");
    const first = inbox.nextPart(request.requestId)!;
    inbox.beginPart(request.requestId, first.part);
    inbox.confirmPart(request.requestId, first.part, "telegram-1");
    const second = inbox.nextPart(request.requestId)!;
    assert.ok(second.part > first.part);
    inbox.beginPart(request.requestId, second.part);
    inbox.recover();
    inbox.enqueue(request, reply);
    assert.equal(inbox.deliveryStatus(request.requestId), "uncertain");
    assert.equal(inbox.next(), undefined, "an unknown send is not retried");
    assert.equal(inbox.nextPart(request.requestId), undefined);
    assert.throws(() => inbox.enqueue(request, "different"), /different content/);
    assert.throws(() => inbox.enqueue({ ...request, conversationId: "2" }, reply), /different content/);
  } finally {
    inbox.close();
  }
});

test("a saved host delivery reaches sent without invoking the agent reply path", () => {
  const inbox = new Inbox(":memory:");
  try {
    inbox.enqueue(request, "ready to deliver");
    assert.equal(inbox.next()?.status, "ready");
    const part = inbox.nextPart(request.requestId)!;
    inbox.beginPart(request.requestId, part.part);
    inbox.confirmPart(request.requestId, part.part, "telegram-2");
    inbox.enqueue(request, "ready to deliver");
    assert.equal(inbox.deliveryStatus(request.requestId), "sent");
    assert.equal(inbox.next(), undefined);
    assert.equal(inbox.deliveryStatus("proactive:missing"), "missing");
  } finally {
    inbox.close();
  }
});
