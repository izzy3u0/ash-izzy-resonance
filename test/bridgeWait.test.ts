import { serverFixture } from "./fixtures.js";
import type { InMemoryEventQueue } from "../src/queue.js";
import { buildBridgeEvent } from "../src/bridge/events.js";
import assert from "node:assert/strict";
import test from "node:test";

type RpcResult = {
  result?: {
    structuredContent?: Record<string, unknown>;
  };
};

let authorization = "";
let fixtureQueue: InMemoryEventQueue;
async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const fixture = await serverFixture();
  authorization = fixture.authorization;
  fixtureQueue = fixture.queue;
  try { await run(fixture.base); } finally { await fixture.close(); }
}

async function callTool(
  base: string,
  name: string,
  args: Record<string, unknown>,
  id: number,
): Promise<RpcResult> {
  const response = await fetch(base + "/mcp/music", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200, name);
  return await response.json() as RpcResult;
}

async function enqueue(_base: string, eventId: string, source: string, text: string): Promise<void> {
  assert.equal(fixtureQueue.enqueue(buildBridgeEvent(eventId, source, text)), true);
}

test("long-wait returns an already pending Music event immediately", async () => {
  await withServer(async (base) => {
    await enqueue(base, "wait-immediate-1", "netease.playback", "playback changed");

    const startedAt = Date.now();
    const body = await callTool(base, "cove_bridge_wait", { timeoutSeconds: 2 }, 1);
    const elapsedMs = Date.now() - startedAt;
    const result = body.result?.structuredContent ?? {};

    assert.equal(result.hasEvent, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.eventId, "wait-immediate-1");
    assert.equal(result.source, "netease.playback");
    assert.ok(elapsedMs < 1000, "pending event should not wait for the full timeout");

    await callTool(base, "cove_bridge_wait_ack", { eventId: "wait-immediate-1" }, 2);
  });
});

test("long-wait times out cleanly when no Music event arrives", async () => {
  await withServer(async (base) => {
    const startedAt = Date.now();
    const body = await callTool(base, "cove_bridge_wait", { timeoutSeconds: 1 }, 3);
    const elapsedMs = Date.now() - startedAt;
    const result = body.result?.structuredContent ?? {};

    assert.equal(result.hasEvent, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.awaitingReply, false);
    assert.ok(elapsedMs >= 850, "wait should remain open close to the requested timeout");
    assert.ok(elapsedMs < 2500, "wait should not hang beyond the requested timeout");
  });
});

test("long-wait does not bypass required-reply backpressure", async () => {
  await withServer(async (base) => {
    await enqueue(base, "wait-required-1", "netease.chatroom", "hello from NetEase");

    const first = await callTool(base, "cove_bridge_wait", { timeoutSeconds: 2 }, 4);
    const firstResult = first.result?.structuredContent ?? {};
    assert.equal(firstResult.hasEvent, true);
    assert.equal(firstResult.eventId, "wait-required-1");
    assert.equal(firstResult.replyPolicy, "required");

    const secondStartedAt = Date.now();
    const second = await callTool(base, "cove_bridge_wait", { timeoutSeconds: 2 }, 5);
    const elapsedMs = Date.now() - secondStartedAt;
    const secondResult = second.result?.structuredContent ?? {};

    assert.equal(secondResult.hasEvent, false);
    assert.equal(secondResult.timedOut, false);
    assert.equal(secondResult.awaitingReply, true);
    assert.equal(secondResult.eventId, "wait-required-1");
    assert.ok(elapsedMs < 1000, "backpressure should be reported immediately");

    await callTool(base, "cove_bridge_dismissed", { eventId: "wait-required-1" }, 6);
  });
});
