import { serverFixture } from "./fixtures.js";
import type { InMemoryEventQueue } from "../src/queue.js";
import { buildBridgeEvent } from "../src/bridge/events.js";
import assert from "node:assert/strict";
import test from "node:test";

let authorization = "";
let fixtureQueue: InMemoryEventQueue;
async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const fixture = await serverFixture();
  authorization = fixture.authorization;
  fixtureQueue = fixture.queue;
  try { await run(fixture.base); } finally { await fixture.close(); }
}

async function rpc(base: string, path: string, id: number, method: string) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "compat-test", version: "1.0.0" },
          }
        : {},
    }),
  });
  assert.equal(response.status, 200, path + ":" + method);
  return await response.json() as {
    result?: {
      serverInfo?: { name?: string };
      tools?: Array<{ name: string }>;
      resources?: Array<{ uri: string }>;
    };
  };
}

test("legacy /mcp and scoped /mcp/music both initialize", async () => {
  await withServer(async (base) => {
    const legacy = await rpc(base, "/mcp", 1, "initialize");
    const music = await rpc(base, "/mcp/music", 2, "initialize");
    assert.equal(legacy.result?.serverInfo?.name, "cove-resonance");
    assert.equal(music.result?.serverInfo?.name, "cove-resonance-music");
  });
});

test("legacy and scoped endpoints both keep the Music V2 tool surface", async () => {
  const required = [
    "netease_together_now",
    "netease_together_realtime_status",
    "netease_together_leave",
    "netease_together_pause",
    "netease_together_resume",
    "netease_together_goto",
    "netease_together_next",
    "netease_together_enqueue_next",
    "netease_together_send_message",
    "open_cove_bridge",
    "cove_bridge_listener_session",
    "cove_bridge_reply",
    "cove_bridge_sync",
    "cove_bridge_delivered",
    "cove_bridge_dismissed",
    "cove_bridge_release",
    "cove_bridge_wait",
    "cove_bridge_wait_ack",
  ];
  await withServer(async (base) => {
    for (const path of ["/mcp", "/mcp/music"]) {
      const body = await rpc(base, path, 3, "tools/list");
      const names = new Set((body.result?.tools ?? []).map((tool) => tool.name));
      for (const name of required) assert.equal(names.has(name), true, path + ":" + name);
    }
  });
});

test("stable widget resource URI is preserved", async () => {
  await withServer(async (base) => {
    for (const path of ["/mcp", "/mcp/music"]) {
      const body = await rpc(base, path, 4, "resources/list");
      const uris = new Set((body.result?.resources ?? []).map((resource) => resource.uri));
      assert.equal(uris.has("ui://widget/cove-bridge.html"), true, path);
    }
  });
});
