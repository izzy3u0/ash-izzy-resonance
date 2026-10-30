import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createMcpAccess, oauthConfigFromEnv, validIngestToken } from "../src/auth.js";
import { listenerWakeHub } from "../src/listenerWake.js";
import { authFixture, oauthConfig, serverFixture } from "./fixtures.js";

test("OAuth configuration fails closed without owner, client, issuer and HTTPS origin", () => {
  assert.throws(() => oauthConfigFromEnv({}), /Missing required/);
  for (const key of ["publicOrigin", "issuer"] as const) {
    for (const value of ["http://example.test", "https://u:p@example.test", "https://example.test/path", "https://example.test/?token=x"]) {
      assert.throws(() => createMcpAccess({ ...oauthConfig, [key]: value }), /HTTPS origin/);
    }
  }
  assert.throws(() => createMcpAccess({ ...oauthConfig, subject: "" }), /required/);
});

test("valid owner JWT is accepted; missing, malformed, wrong signature and wrong claims are rejected", async () => {
  const fixture = await authFixture();
  await fixture.access.verify(fixture.authorization);
  for (const header of [undefined, "", "Bearer invalid", fixture.authorization + " extra", "Basic something"]) {
    await assert.rejects(fixture.access.verify(header));
  }
  const other = await authFixture();
  await assert.rejects(fixture.access.verify(other.authorization));
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { sub: "other-owner" }, { azp: "other-client" }, { iss: "https://attacker.example.test/" },
    { aud: "https://another-resource.example.test" }, { scope: "openid" },
    { exp: now - 60 }, { nbf: now + 120 }, { iat: now + 120 }, { exp: now + 7200 },
    { exp: undefined }, { iat: undefined }, { sub: undefined }, { azp: undefined },
  ]) {
    await assert.rejects(fixture.access.verify("Bearer " + await fixture.sign(claims)));
  }
});

test("both MCP paths reject unauthorized discovery and execution for every transport method", async () => {
  const fixture = await serverFixture();
  try {
    for (const path of ["/mcp", "/mcp/music"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await fetch(fixture.base + path, { method });
        assert.equal(response.status, 401);
        assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=.*oauth-protected-resource/);
        assert.deepEqual(await response.json(), { error: "unauthorized" });
      }
      const wrongOwner = await fixture.sign({ sub: "someone-else" });
      const response = await fetch(fixture.base + path, {
        method: "POST", headers: { authorization: "Bearer " + wrongOwner, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      assert.equal(response.status, 401);
    }
  } finally { await fixture.close(); }
});

test("public health reveals no queues or provider state; metadata identifies the exact OAuth resource", async () => {
  const fixture = await serverFixture();
  try {
    const health = await (await fetch(fixture.base + "/healthz")).json();
    assert.deepEqual(Object.keys(health).sort(), ["ok", "service", "version"]);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp/music"]) {
      const response = await fetch(fixture.base + path);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), fixture.access.metadata);
    }
    const request = await fetch(fixture.base + "/mcp", { method: "OPTIONS" });
    assert.equal(request.status, 204);
  } finally { await fixture.close(); }
});

test("generic ingress is disabled by default, requires a separate secret and cannot forge NetEase events", async () => {
  let fixture = await serverFixture();
  try { assert.equal((await fetch(fixture.base + "/events", { method: "POST" })).status, 404); }
  finally { await fixture.close(); }
  const ingestToken = randomBytes(32).toString("hex");
  assert.equal(validIngestToken("", undefined), false);
  fixture = await serverFixture({ ingestToken });
  try {
    for (const authorization of [undefined, fixture.authorization, "Bearer wrong"]) {
      assert.equal((await fetch(fixture.base + "/events", {
        method: "POST", headers: authorization ? { authorization } : {},
      })).status, 401);
    }
    for (const source of ["netease.chatroom", "NetEase.playback"]) {
      const response = await fetch(fixture.base + "/events", {
        method: "POST", headers: { authorization: "Bearer " + ingestToken },
        body: JSON.stringify({ source, text: "forged" }),
      });
      assert.equal(response.status, 400);
    }
    const response = await fetch(fixture.base + "/events", {
      method: "POST", headers: { authorization: "Bearer " + ingestToken },
      body: JSON.stringify({ source: "test", text: "fixture event" }),
    });
    assert.equal(response.status, 201);
    assert.equal(fixture.queue.status().total, 1);
  } finally { await fixture.close(); }
});

test("wake SSE rejects unknown tokens and consumes an authorized single-use session once", async () => {
  const fixture = await serverFixture();
  try {
    assert.equal((await fetch(fixture.base + "/listener/events")).status, 401);
    assert.equal((await fetch(fixture.base + "/listener/events", {
      headers: { authorization: fixture.authorization },
    })).status, 401);
    const rpc = await fetch(fixture.base + "/mcp/music", {
      method: "POST",
      headers: { authorization: fixture.authorization, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cove_bridge_listener_session", arguments: {} } }),
    });
    const body = await rpc.json() as { result: { structuredContent: { token: string } } };
    const token = body.result.structuredContent.token;
    const response = await fetch(fixture.base + "/listener/events?session=" + encodeURIComponent(token));
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.equal((await fetch(fixture.base + "/listener/events?session=" + encodeURIComponent(token))).status, 401);
  } finally { await fixture.close(); }
  assert.equal(listenerWakeHub.status().sessions, 0);
});

test("authorized tool discovery exposes only phase-one account tools and declares OAuth", async () => {
  const fixture = await serverFixture();
  try {
    const response = await fetch(fixture.base + "/mcp/music", {
      method: "POST",
      headers: { authorization: fixture.authorization, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = await response.json() as { result: { tools: Array<{ name: string; _meta: Record<string, unknown> }> } };
    const names = body.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("netease_search_songs"));
    assert.ok(names.includes("netease_together_status"));
    assert.ok(!names.includes("netease_create_playlist"));
    assert.ok(!names.includes("netease_my_playlists"));
    assert.ok(!names.includes("netease_like_song"));
    assert.ok(!names.includes("netease_play_history"));
    assert.ok(!names.includes("netease_daily_recommend"));
    for (const tool of body.result.tools) {
      assert.deepEqual(tool._meta.securitySchemes, [{ type: "oauth2", scopes: ["bridge:access"] }]);
    }
  } finally { await fixture.close(); }
});
