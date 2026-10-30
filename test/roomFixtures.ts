import { randomUUID } from "node:crypto";
import { buildBridgeEvent } from "../src/bridge/events.js";
import { TogetherWorker } from "../src/netease/togetherWorker.js";
import type { NeteaseClient } from "../src/netease/client.js";
import type { NeteaseRealtimeTransport, RealtimeChatRoomMessage, RealtimePlaybackEvent } from "../src/netease/realtimeTransport.js";
import type { TogetherInvite, TogetherRoom } from "../src/netease/types.js";
import { PlaybackStateStore } from "../src/netease/playbackState.js";
import { InMemoryEventQueue } from "../src/queue.js";

export const OWNER = "12345";
export function invitation(roomId = "trusted-room", senderId = OWNER, inviterId = OWNER, time = Date.now()) {
  return { msgs: [{
    type: 23, time, fromUser: { userId: senderId },
    msg: JSON.stringify({ nativeUrl: "orpheus://listenTogether?roomId=" + roomId + "&inviterId=" + inviterId }),
  }] };
}

export function roomFixture() {
  const queue = new InMemoryEventQueue();
  const playbackState = new PlaybackStateStore();
  let remote: TogetherRoom = { inRoom: false, roomId: null, chatRoomId: null };
  let history = invitation();
  let connected = false;
  let connectedRoom: TogetherRoom = { ...remote };
  const calls = { accept: 0, end: 0, credentials: 0, heartbeats: 0, reports: 0, sends: [] as Array<{ text: string; roomId: string | null }> };
  const client = {
    getAccountProfile: async () => ({ id: "9000", nickname: "fixture", avatarUrl: null, gender: null }),
    getRoomStatus: async () => ({ ...remote }),
    getPrivateHistory: async (uid: string) => {
      if (uid !== OWNER) throw new Error("Unexpected private conversation");
      return history;
    },
    getRecentContacts: async () => { throw new Error("Must not scan other contacts"); },
    acceptInvite: async (roomId: string, inviterId: string) => {
      if (inviterId !== OWNER) throw new Error("Unexpected inviter");
      calls.accept++;
      remote = { inRoom: true, roomId, chatRoomId: "123" };
      return { ...remote };
    },
    getRealtimeCredentials: async () => { calls.credentials++; return { accId: "9000", token: "fixture-only", addresses: [] }; },
    getPlaying: async () => ({ songId: "101", playStatus: "PLAY" as const, progress: 10000, serverSeq: 1 }),
    getSongDetails: async (id: string) => ({ id, name: "Fixture song", artist: "Fixture artist", durationMs: 180000 }),
    getLyrics: async () => ({ lrc: "[00:00.00]first\n[00:10.00]current\n[00:20.00]next", tlyric: null, romalrc: null, klyric: null, yrc: null, ytlrc: null, yromalrc: null, raw: {} }),
    sendHeartbeat: async () => { calls.heartbeats++; },
    endRoom: async (roomId: string) => {
      if (roomId !== remote.roomId) throw new Error("Wrong room");
      calls.end++; remote = { inRoom: false, roomId: null, chatRoomId: null };
    },
    searchSongs: async () => [{ id: "202", name: "Requested song", artist: "Fixture artist", durationMs: 100000 }],
  };
  const realtime = {
    getStatus: () => ({
      enabled: true, connected, roomId: connectedRoom.roomId, chatRoomId: connectedRoom.chatRoomId,
      credentialsReady: connected, lastPlaybackEvent: null, lastChatMessage: null, lastError: null,
    }),
    connect: async (options: { roomId: string; chatRoomId: string }) => {
      connected = true; connectedRoom = { inRoom: true, roomId: options.roomId, chatRoomId: options.chatRoomId };
    },
    disconnect: async () => { connected = false; connectedRoom = { inRoom: false, roomId: null, chatRoomId: null }; },
    recordConnectionError: () => { connected = false; },
    sendChatRoomText: async (text: string) => {
      if (!connected) throw new Error("Not connected");
      calls.sends.push({ text, roomId: connectedRoom.roomId });
      return { ok: true as const, roomId: connectedRoom.roomId!, chatRoomId: connectedRoom.chatRoomId!, text, messageId: randomUUID(), code: 200 };
    },
  };
  const worker = new TogetherWorker({
    cookie: "MUSIC_U=fixture-only", enabled: true, inviterUid: OWNER,
    client: client as unknown as NeteaseClient,
    realtime: realtime as unknown as NeteaseRealtimeTransport,
    stateSink: playbackState,
    onEvent: (source, text, context, target) => {
      const event = buildBridgeEvent(randomUUID(), source, text, new Date().toISOString(), context);
      event.replyTarget = target;
      queue.enqueue(event);
    },
  });
  const internals = worker as unknown as {
    validateAccountSession(): Promise<void>;
    pollOnce(): Promise<void>;
    acceptInvite(invite: TogetherInvite): Promise<void>;
    handleRealtimeChatMessage(message: RealtimeChatRoomMessage): void;
    handleRealtimePlaybackEvent(event: RealtimePlaybackEvent): void;
  };
  return {
    queue, playbackState, worker, internals, calls, client, realtime,
    setRemote: (value: TogetherRoom) => { remote = value; },
    setHistory: (value: ReturnType<typeof invitation>) => { history = value; },
    async join(roomId = "trusted-room") {
      history = invitation(roomId, OWNER, OWNER, Date.now() + 1);
      await internals.validateAccountSession();
      await internals.pollOnce();
    },
    message(text = "hello from owner", senderId = OWNER, messageId: string = randomUUID()) {
      internals.handleRealtimeChatMessage({
        type: "chatroom_message", category: "text", msgType: 0,
        senderId, senderNick: "fixture", text, messageId, timetagMs: Date.now(), receivedAtMs: Date.now(),
      });
    },
  };
}
