import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { TogetherWorker, createTogetherWorker } from "../src/netease/togetherWorker.js";
import { NeteaseClient, NeteaseApiError } from "../src/netease/client.js";
import { NeteaseRealtimeTransport } from "../src/netease/realtimeTransport.js";
import { parseLatestInvite } from "../src/netease/inviteParser.js";
import { invitation, roomFixture, OWNER } from "./roomFixtures.js";
import { serverFixture } from "./fixtures.js";

test("Together configuration requires a session and an explicit allowed inviter; disabling is explicit", () => {
  assert.throws(() => createTogetherWorker(() => {}, undefined, {}), /MUSIC_U/);
  assert.throws(() => createTogetherWorker(() => {}, undefined, { NETEASE_COOKIE: "MUSIC_U=fixture" }), /INVITER_UID/);
  assert.throws(() => new TogetherWorker({ cookie: "", enabled: true, onEvent: () => {} }), /INVITER_UID/);
  assert.equal(createTogetherWorker(() => {}, undefined, { TOGETHER_ENABLED: "false" }).getStatus().enabled, false);
});

test("invitation parser requires the main account as both actual sender and URL inviter", () => {
  assert.equal(parseLatestInvite(invitation(), OWNER)?.inviterId, OWNER);
  for (const history of [
    invitation("room", "9000", OWNER), invitation("room", OWNER, "someone-else"),
    invitation("room", OWNER, OWNER, Date.now() - 6 * 60_000),
    invitation("room", OWNER, OWNER, Date.now() + 60_000),
  ]) assert.equal(parseLatestInvite(history, OWNER), null);
  const missingSender = invitation();
  delete (missingSender.msgs[0] as { fromUser?: unknown }).fromUser;
  assert.equal(parseLatestInvite(missingSender, OWNER), null);
});

test("valid invitation establishes a verified room binding, account identity, state and lyrics", async () => {
  const f = roomFixture();
  await f.join();
  assert.equal(f.worker.getStatus().accountId, "9000");
  assert.equal(f.worker.getStatus().phase, "listening");
  assert.equal(f.calls.accept, 1);
  assert.equal(f.calls.credentials, 1);
  assert.ok(f.worker.getReplyTarget()?.bindingId);
  const state = f.playbackState.getCurrentState();
  assert.equal(state.inRoom, true);
  assert.equal(state.song?.name, "Fixture song");
  assert.equal(state.playStatus, "PLAY");
  assert.ok(state.progressMs >= 10000);
  assert.equal(state.lyric?.current, "current");
});

test("same-account login is rejected instead of treating the human as Ash", async () => {
  const f = roomFixture();
  f.client.getAccountProfile = async () => ({ id: OWNER, nickname: "fixture", avatarUrl: null, gender: null });
  await assert.rejects(f.internals.validateAccountSession(), /different accounts/);
  assert.equal(f.worker.getStatus().accountId, null);
});

test("worker rejects another inviter and does not adopt an existing room after startup", async () => {
  const f = roomFixture();
  await assert.rejects(f.internals.acceptInvite({ roomId: "other", inviterId: "999", messageTime: Date.now() }), /not allowed/);
  f.setRemote({ inRoom: true, roomId: "unknown-room", chatRoomId: "123" });
  await assert.rejects(f.internals.pollOnce(), /Unbound/);
  assert.equal(f.calls.accept, 0);
  assert.equal(f.calls.credentials, 0);
  assert.equal(f.worker.getReplyTarget(), null);
  await assert.rejects(f.worker.sendChatRoomText("must not send"), /binding/);
  await assert.rejects(f.worker.leaveTogether(), /binding/);
  assert.equal(f.calls.sends.length, 0);
  assert.equal(f.calls.end, 0);
});

test("only owner messages enter the queue, with room binding and message deduplication", async () => {
  const f = roomFixture();
  await f.join();
  f.message("third-party message", "999");
  f.message("own-account echo", "9000");
  const id = "same-provider-id";
  f.message("owner message", OWNER, id);
  f.message("owner message", OWNER, id);
  const event = f.queue.reserveNext();
  assert.equal(event?.source, "netease.chatroom");
  assert.match(event?.visibleText ?? "", /owner message/);
  assert.deepEqual(event?.replyTarget, f.worker.getReplyTarget());
  assert.equal(f.queue.status().conversation.total, 1);
});

test("a room change blocks send/control before side effects and invalidates cached state", async () => {
  const f = roomFixture();
  await f.join();
  const target = f.worker.getReplyTarget()!;
  f.setRemote({ inRoom: true, roomId: "other-room", chatRoomId: "456" });
  await assert.rejects(f.worker.sendChatRoomText("must not reach another room", target), /binding changed/);
  await assert.rejects(f.worker.pausePlayback(), /binding/);
  assert.equal(f.calls.sends.length, 0);
  assert.equal(f.playbackState.getCurrentState().inRoom, false);
  assert.equal(f.worker.getReplyTarget(), null);
});

test("exit is confirmed and does not immediately accept the old invitation again", async () => {
  const f = roomFixture();
  await f.join();
  const old = invitation("trusted-room", OWNER, OWNER, Date.now() - 10);
  const result = await f.worker.leaveTogether();
  assert.equal(result.ended, true);
  assert.equal(f.calls.end, 1);
  assert.equal(f.worker.getReplyTarget(), null);
  assert.equal(f.playbackState.getCurrentState().inRoom, false);
  f.setHistory(old);
  await f.internals.pollOnce();
  assert.equal(f.calls.accept, 1);
});

test("unconfirmed acceptance and unconfirmed exit never report success", async () => {
  const f = roomFixture();
  f.client.acceptInvite = async () => ({ inRoom: true, roomId: "different", chatRoomId: "123" });
  await assert.rejects(f.join(), /does not match/);
  assert.equal(f.worker.getReplyTarget(), null);
  const g = roomFixture();
  await g.join();
  g.client.endRoom = async () => {};
  await assert.rejects(g.worker.leaveTogether(), /not confirmed/);
});

test("provider exceptions retain operation/code but discard cookies, tokens and verification text", async () => {
  const require = createRequire(import.meta.url);
  const sdk = require("NeteaseCloudMusicApi") as Record<string, (params: unknown) => Promise<unknown>>;
  const original = sdk.user_account;
  const sentinel = "fixture-sensitive-session-and-code";
  try {
    sdk.user_account = async () => { throw new Error(sentinel); };
    const client = new NeteaseClient("MUSIC_U=fixture-only");
    await assert.rejects(client.getAccountProfile(), (error: unknown) => {
      assert.ok(error instanceof NeteaseApiError);
      assert.equal(error.operation, "user_account");
      assert.ok(!error.message.includes(sentinel));
      return true;
    });
    sdk.user_account = async () => ({ body: { code: 301, message: sentinel } });
    await assert.rejects(client.getAccountProfile(), (error: unknown) => {
      assert.ok(error instanceof NeteaseApiError);
      assert.equal(error.code, 301);
      assert.ok(!error.message.includes(sentinel));
      return true;
    });
    sdk.user_account = async () => { throw { status: 488, cookie: [sentinel], body: { code: 488, message: sentinel } }; };
    await assert.rejects(client.getAccountProfile(), (error: unknown) => {
      assert.ok(error instanceof NeteaseApiError);
      assert.equal(error.code, 488);
      assert.ok(!error.message.includes(sentinel));
      return true;
    });
  } finally { sdk.user_account = original; }
});

test("native receive logs omit message bodies and connection errors omit exception contents", () => {
  const logs: string[] = [];
  const original = console.log;
  const transport = new NeteaseRealtimeTransport(false);
  const emitter = new EventEmitter();
  const internals = transport as unknown as { installRuntimeHandlers(value: unknown): void; roomNumber: number };
  internals.roomNumber = 123;
  internals.installRuntimeHandlers(emitter);
  const sentinel = "fixture-private-message-MUSIC_U";
  try {
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    emitter.emit("receiveMsg", 123, { msg_type_: 0, msg_body_: sentinel, from_id_: OWNER, client_msg_id_: "fixture-id" });
  } finally { console.log = original; }
  assert.ok(logs.length > 0);
  assert.ok(!logs.join("\n").includes(sentinel));
  transport.recordConnectionError(new Error(sentinel));
  assert.ok(!JSON.stringify(transport.getStatus().lastError).includes(sentinel));
});

test("HTTP MCP mock end-to-end: join, read song/lyrics, receive, ACK, reply, ordinary send and leave", async () => {
  const f = roomFixture();
  await f.join();
  const http = await serverFixture({ queue: f.queue, playbackState: f.playbackState, togetherWorker: f.worker });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(http.base + "/mcp/music", {
      method: "POST",
      headers: { authorization: http.authorization, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    return (await response.json() as { result: { isError?: boolean; structuredContent?: Record<string, any> } }).result;
  };
  try {
    const state = await call("netease_together_now");
    assert.equal(state.structuredContent?.song.id, "101");
    assert.equal(state.structuredContent?.lyric.current, "current");
    const status = await call("netease_together_status");
    assert.equal(status.structuredContent?.accountId, "9000");
    assert.equal(status.structuredContent?.bound, true);
    const bindingId = status.structuredContent?.binding.bindingId;
    f.message("minimal-realistic-chain");
    const event = await call("cove_bridge_wait", { timeoutSeconds: 1 });
    assert.equal(event.structuredContent?.source, "netease.chatroom");
    assert.match(event.structuredContent?.visibleText, /minimal-realistic-chain/);
    const eventId = event.structuredContent?.eventId;
    await call("cove_bridge_wait_ack", { eventId });
    const reply = await call("cove_bridge_reply", { eventId, messages: ["fixture reply"] });
    assert.equal(reply.structuredContent?.completed, true);
    const duplicate = await call("cove_bridge_reply", { eventId, messages: ["fixture reply"] });
    assert.equal(duplicate.structuredContent?.deduplicated, true);
    const sent = await call("netease_together_send_message", { text: "ordinary fixture text", bindingId });
    assert.equal(sent.structuredContent?.ok, true);
    assert.deepEqual(f.calls.sends.map((s) => s.text), ["fixture reply", "ordinary fixture text"]);
    const left = await call("netease_together_leave");
    assert.equal(left.structuredContent?.ended, true);
    assert.equal((await call("netease_together_now")).structuredContent?.inRoom, false);
    assert.equal((await call("netease_together_send_message", { text: "stale", bindingId })).isError, true);
    assert.equal(f.calls.sends.length, 2);
  } finally { await http.close(); }
});

test("an old event cannot be corrected onto a new room's active reply", async () => {
  const f = roomFixture();
  await f.join("first");
  f.message("first-room-message");
  const old = f.queue.reserveNext()!;
  await f.worker.leaveTogether();
  await f.join("second");
  f.message("second-room-message");
  const current = f.queue.reserveNext((event) => Boolean(event.replyTarget && f.worker.isCurrentReplyTarget(event.replyTarget)))!;
  const http = await serverFixture({ queue: f.queue, playbackState: f.playbackState, togetherWorker: f.worker });
  try {
    const response = await fetch(http.base + "/mcp/music", {
      method: "POST", headers: { authorization: http.authorization, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cove_bridge_reply", arguments: { eventId: old.id, messages: ["must not leak"] } } }),
    });
    const body = await response.json() as { result: { isError: boolean } };
    assert.equal(body.result.isError, true);
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.queue.getOutstandingRequiredReplyEvent((event) => event.id === current.id)?.id, current.id);
  } finally { await http.close(); }
});
