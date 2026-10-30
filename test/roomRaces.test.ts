import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { NeteaseRealtimeTransport, type RealtimePlaybackEvent } from "../src/netease/realtimeTransport.js";
import { roomFixture } from "./roomFixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("leaving during credential retrieval never reconnects the old room", async () => {
  const f = roomFixture();
  const started = deferred<void>();
  const release = deferred<void>();
  const original = f.client.getRealtimeCredentials;
  f.client.getRealtimeCredentials = async () => {
    started.resolve(); await release.promise; return await original();
  };
  const joining = f.join();
  await started.promise;
  await f.worker.leaveTogether();
  release.resolve();
  await joining;
  assert.equal(f.worker.getReplyTarget(), null);
  assert.equal(f.realtime.getStatus().connected, false);
});

test("native ticket completion after disconnect never calls native enter", async () => {
  const transport = new NeteaseRealtimeTransport();
  const started = deferred<void>();
  const release = deferred<[number, string]>();
  let enters = 0;
  const internals = transport as unknown as {
    ensureRuntime(): Promise<void>;
    requestEnterTicket(): Promise<[number, string]>;
    chatroom: unknown;
  };
  internals.ensureRuntime = async () => {};
  internals.chatroom = { enter: () => { enters++; return true; }, exit: () => {} };
  internals.requestEnterTicket = async () => { started.resolve(); return await release.promise; };
  const connecting = transport.connect({
    roomId: "room", chatRoomId: "123", credentials: { accId: "9000", token: "fixture-only", addresses: [] },
  });
  await started.promise;
  await transport.disconnect();
  release.resolve([200, "fixture-ticket"]);
  await connecting;
  assert.equal(enters, 0);
  assert.equal(transport.getStatus().connected, false);
});

test("disconnected native room messages cannot repopulate last-message cache", async () => {
  const transport = new NeteaseRealtimeTransport();
  const emitter = new EventEmitter();
  const internals = transport as unknown as { installRuntimeHandlers(value: unknown): void; roomNumber: number | null };
  internals.installRuntimeHandlers(emitter);
  await transport.disconnect();
  emitter.emit("receiveMsg", 123, { msg_type_: 0, msg_body_: "stale", from_id_: "12345" });
  assert.equal(transport.getStatus().lastChatMessage, null);
});

test("queued old-room playback work cannot run against a newly bound room", async () => {
  const f = roomFixture();
  await f.join("first");
  const started = deferred<void>();
  const release = deferred<void>();
  const original = f.client.getSongDetails;
  const lookedUp: string[] = [];
  f.client.getSongDetails = async (id: string) => {
    lookedUp.push(id);
    if (id === "202") { started.resolve(); await release.promise; }
    return await original(id);
  };
  const playback = (songId: string, serverSeq: number): RealtimePlaybackEvent => ({
    type: "playback", serverSeq, commandType: "GOTO", songId, formerSongId: "101",
    progressMs: 0, playStatus: "PLAY", receivedAtMs: Date.now(),
  });
  f.internals.handleRealtimePlaybackEvent(playback("202", 2));
  await started.promise;
  f.internals.handleRealtimePlaybackEvent(playback("303", 3));
  await f.worker.leaveTogether();
  const joining = f.join("second");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.worker.getReplyTarget()?.roomId, "second");
  release.resolve();
  await joining;
  assert.ok(!lookedUp.includes("303"), "queued work must keep its original room binding");
  assert.equal(f.playbackState.getCurrentState().song?.id, "101");
});

test("a fresh invitation to the same room establishes a new binding incarnation", async () => {
  const f = roomFixture();
  await f.join("same-room");
  const oldTarget = f.worker.getReplyTarget()!;
  await f.worker.leaveTogether();
  await f.join("same-room");
  assert.notEqual(f.worker.getReplyTarget()?.bindingId, oldTarget.bindingId);
  await assert.rejects(f.worker.sendChatRoomText("stale", oldTarget), /binding/);
  assert.equal(f.calls.sends.length, 0);
});
