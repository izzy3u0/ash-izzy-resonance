import { randomUUID } from "node:crypto";
import type { BoundReplyTarget } from "../types.js";
import { safeError, SafeOperationError } from "../security.js";
import { NeteaseApiError, NeteaseClient, type AccountProfile } from "./client.js";
import { parseLatestInvite } from "./inviteParser.js";
import { buildFullLyricsModelContext, countAvailableLyricPayloads } from "./lyricsContext.js";
import type { PlaybackStateSink } from "./playbackState.js";
import {
  NeteaseRealtimeTransport,
  type RealtimeChatRoomMessage,
  type RealtimeChatSendResult,
  type RealtimePlaybackEvent,
  type RealtimeTransportStatus,
} from "./realtimeTransport.js";
import type {
  PlayingState,
  SongDetails,
  TogetherInvite,
  TogetherWorkerStatus,
} from "./types.js";

type EventSink = (source: string, text: string, modelContext?: string, replyTarget?: BoundReplyTarget) => unknown;

type TogetherWorkerOptions = {
  cookie: string;
  enabled: boolean;
  client?: NeteaseClient;
  realtime?: NeteaseRealtimeTransport;
  inviterUid?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  playbackReconcileIntervalMs?: number;
  playbackControlTimeoutMs?: number;
  onEvent: EventSink;
  stateSink?: PlaybackStateSink;
};

export type PlaybackControlResult = {
  ok: true;
  confirmed: true;
  commandType: "PLAY" | "PAUSE" | "GOTO";
  roomId: string;
  songId: string;
  playStatus: "PLAY" | "PAUSE";
  progressMs: number;
  clientSeq: number;
  serverSeq: number;
  confirmedAt: string;
};

export type QueueMutationResult = {
  ok: true;
  confirmed: true;
  action: "ENQUEUE_NEXT";
  roomId: string;
  songId: string;
  afterSongId: string;
  version: number;
  confirmedAt: string;
};

type PendingPlaybackControl = {
  commandType: "PLAY" | "PAUSE" | "GOTO";
  roomId: string;
  songId: string;
  clientSeq: number;
  senderId: string;
  expectedPlayStatus: "PLAY" | "PAUSE";
  baselineServerSeq: number | null;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: PlaybackControlResult) => void;
  reject: (error: Error) => void;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TogetherWorker {
  private boundRoom: BoundReplyTarget | null = null;
  private inviteNotBeforeMs = Date.now();
  private readonly client: NeteaseClient;
  private readonly realtime: NeteaseRealtimeTransport;
  private readonly handledInvites = new Set<string>();
  private readonly handledChatMessageKeys = new Set<string>();
  private running = false;
  private roomId: string | null = null;
  private chatRoomId: string | null = null;
  private previousSongId: string | null = null;
  private previousPlayStatus: PlayingState["playStatus"] = "UNKNOWN";
  private joinedPending = false;
  private lastHeartbeatAt = 0;
  private lastRealtimeAttemptAt = 0;
  private lastPlaybackServerSeq: number | null = null;
  private lastPlaybackReconcileAt = 0;
  private latestPlaying: PlayingState | null = null;
  private latestPlaybackObservedAtMs = 0;
  private nextPlaybackClientSeq = 1;
  private pendingPlaybackControl: PendingPlaybackControl | null = null;
  private queueMutationPending = false;
  private playbackHandlingTail: Promise<void> = Promise.resolve();
  private errorStreak = 0;
  private accountProfile: AccountProfile | null = null;
  private currentLyricsModelContext: string | null = null;
  private status: TogetherWorkerStatus;

  constructor(private readonly options: TogetherWorkerOptions) {
    if (options.enabled && !/^\d+$/.test(options.inviterUid ?? "")) {
      throw new Error("NETEASE_INVITER_UID is required when Together is enabled");
    }
    this.client = options.client ?? new NeteaseClient(options.cookie);
    this.realtime = options.realtime ?? new NeteaseRealtimeTransport(
      options.enabled,
      (message) => {
        this.handleRealtimeChatMessage(message);
      },
      (event) => {
        this.handleRealtimePlaybackEvent(event);
      },
    );
    this.status = {
      enabled: options.enabled,
      phase: options.enabled ? "starting" : "disabled",
      accountId: null,
      roomId: null,
      currentSong: null,
      playStatus: "UNKNOWN",
      lastPollAt: null,
      lastHeartbeatAt: null,
      lastError: null,
    };
  }

  getStatus(): TogetherWorkerStatus {
    return { ...this.status };
  }

  getRealtimeStatus(): RealtimeTransportStatus {
    const status = this.realtime.getStatus();
    return {
      ...status,
      lastError: status.lastError ? "realtime_unavailable" : null,
      lastChatMessage: this.boundRoom && status.roomId === this.boundRoom.roomId
        && status.chatRoomId === this.boundRoom.chatRoomId && status.lastChatMessage?.senderId === this.options.inviterUid
        ? status.lastChatMessage : null,
    };
  }

  getReplyTarget(): BoundReplyTarget | null {
    return this.boundRoom?.chatRoomId ? { ...this.boundRoom } : null;
  }

  isCurrentReplyTarget(target: BoundReplyTarget): boolean {
    const current = this.boundRoom;
    return Boolean(current && current.roomId === this.roomId
      && current.bindingId === target.bindingId
      && current.roomId === target.roomId && current.chatRoomId === target.chatRoomId);
  }

  private assertRoomBinding(target = this.boundRoom): BoundReplyTarget {
    if (!target || !this.isCurrentReplyTarget(target)) {
      throw new Error("No trusted Together room binding; invite the account again.");
    }
    return target;
  }

  async verifyBoundRoom(target = this.boundRoom): Promise<BoundReplyTarget> {
    const expected = { ...this.assertRoomBinding(target) };
    const remote = await this.client.getRoomStatus();
    if (!remote.inRoom || remote.roomId !== expected.roomId
      || (remote.chatRoomId && remote.chatRoomId !== expected.chatRoomId)
      || !this.isCurrentReplyTarget(expected)) {
      this.leaveRoom("Together room binding ended.");
      throw new Error("Together room binding changed; operation refused.");
    }
    return expected;
  }

  async sendChatRoomText(text: string, target?: BoundReplyTarget): Promise<RealtimeChatSendResult> {
    const expected = await this.verifyBoundRoom(target);
    this.assertRoomBinding(expected);
    const realtime = this.realtime.getStatus();
    if (!realtime.connected || realtime.roomId !== expected.roomId || realtime.chatRoomId !== expected.chatRoomId) {
      throw new Error("Trusted Together realtime is not connected.");
    }
    return await this.realtime.sendChatRoomText(text);
  }

  private emitRoomEvent(source: string, text: string, context?: string): void {
    const target = this.getReplyTarget();
    if (!target) return;
    this.options.onEvent(source, text, context, target);
  }

  async leaveTogether(): Promise<{
    ok: true;
    ended: boolean;
    alreadyOut: boolean;
    roomId: string | null;
    confirmedAt: string;
  }> {
    const remote = await this.client.getRoomStatus();
    if (!remote.inRoom || !remote.roomId) {
      this.leaveRoom("一起听已经结束了。我会继续等你的下一次邀请。");
      return {
        ok: true,
        ended: false,
        alreadyOut: true,
        roomId: null,
        confirmedAt: new Date().toISOString(),
      };
    }

    const expected = this.assertRoomBinding();
    if (remote.roomId !== expected.roomId) {
      this.leaveRoom("Together room binding changed.");
      throw new Error("Refusing to end an unbound room; exit it in the NetEase app.");
    }
    const roomId = remote.roomId;
    this.inviteNotBeforeMs = Date.now();
    await this.client.endRoom(roomId);
    const confirmed = await this.client.getRoomStatus();
    if (confirmed.inRoom) {
      throw new Error("NetEase Together leave was not confirmed by authoritative room status.");
    }

    this.leaveRoom("一起听已退出。我会继续等你的下一次邀请。");
    return {
      ok: true,
      ended: true,
      alreadyOut: false,
      roomId,
      confirmedAt: new Date().toISOString(),
    };
  }

  async pausePlayback(): Promise<PlaybackControlResult> {
    return await this.controlPlayback("PAUSE");
  }

  async resumePlayback(): Promise<PlaybackControlResult> {
    return await this.controlPlayback("PLAY");
  }

  async gotoPlayback(songId: string): Promise<PlaybackControlResult> {
    const binding = await this.verifyBoundRoom();
    const targetSongId = songId.trim();
    if (!/^\d+$/.test(targetSongId)) {
      throw new Error("NetEase target songId must be numeric.");
    }
    if (!this.roomId) {
      throw new Error("NetEase Listen Together is not currently in a room.");
    }

    const playlist = await this.client.getTogetherPlaylist(this.roomId);
    this.assertRoomBinding(binding);
    if (!playlist.displayList.includes(targetSongId)) {
      throw new Error(
        `NetEase GOTO target is not in the current Together displayList: ${targetSongId}. Enqueue it before GOTO.`,
      );
    }

    return await this.controlPlayback("GOTO", targetSongId);
  }

  async nextPlayback(): Promise<PlaybackControlResult> {
    const binding = await this.verifyBoundRoom();
    if (!this.roomId) throw new Error("NetEase Listen Together is not currently in a room.");
    const currentSongId = this.latestPlaying?.songId ?? this.status.currentSong?.id ?? null;
    if (!currentSongId) throw new Error("NetEase current playback state is unavailable.");

    const playlist = await this.client.getTogetherPlaylist(this.roomId);
    if (playlist.playMode !== "ORDER_LOOP") {
      throw new Error(`Unsupported NetEase Together playMode for NEXT: ${playlist.playMode ?? "unknown"}`);
    }
    if (!playlist.displayList.length) {
      throw new Error("NetEase Together displayList is empty.");
    }

    const currentIndex = playlist.displayList.indexOf(currentSongId);
    if (currentIndex < 0) {
      throw new Error(`Current NetEase song is missing from displayList: ${currentSongId}`);
    }

    const stillCurrentSongId = this.latestPlaying?.songId ?? this.status.currentSong?.id ?? null;
    if (stillCurrentSongId !== currentSongId) {
      throw new Error("NetEase playback changed while resolving NEXT; retry the command.");
    }

    this.assertRoomBinding(binding);
    const targetSongId = playlist.displayList[(currentIndex + 1) % playlist.displayList.length];
    return await this.gotoPlayback(targetSongId);
  }

  async enqueueNext(songId: string): Promise<QueueMutationResult> {
    const binding = await this.verifyBoundRoom();
    const targetSongId = songId.trim();
    if (!/^\d+$/.test(targetSongId)) {
      throw new Error("NetEase target songId must be numeric.");
    }
    if (this.queueMutationPending) {
      throw new Error("NetEase queue mutation already pending.");
    }
    if (!this.roomId) throw new Error("NetEase Listen Together is not currently in a room.");

    const currentSongId = this.latestPlaying?.songId ?? this.status.currentSong?.id ?? null;
    if (!currentSongId) throw new Error("NetEase current playback state is unavailable.");
    if (targetSongId === currentSongId) {
      throw new Error("NetEase ENQUEUE_NEXT target cannot be the currently playing song.");
    }

    const accountId = this.status.accountId;
    if (!accountId) throw new Error("NetEase account identity is unavailable.");

    this.queueMutationPending = true;
    try {
      const roomId = this.roomId;
      const playlist = await this.client.getTogetherPlaylist(roomId);
      if (playlist.playMode !== "ORDER_LOOP") {
        throw new Error(`Unsupported NetEase Together playMode for ENQUEUE_NEXT: ${playlist.playMode ?? "unknown"}`);
      }
      if (!playlist.displayList.length) {
        throw new Error("NetEase Together displayList is empty.");
      }

      const currentIndex = playlist.displayList.indexOf(currentSongId);
      if (currentIndex < 0) {
        throw new Error(`Current NetEase song is missing from displayList: ${currentSongId}`);
      }

      const ownVersion = playlist.versions.find((entry) => entry.userId === accountId)?.version ?? 0;
      const nextVersion = ownVersion + 1;
      const nextDisplayList = playlist.displayList.filter((id) => id !== targetSongId);
      const currentIndexAfterRemoval = nextDisplayList.indexOf(currentSongId);
      if (currentIndexAfterRemoval < 0) {
        throw new Error(`Current NetEase song disappeared while building queue: ${currentSongId}`);
      }
      nextDisplayList.splice(currentIndexAfterRemoval + 1, 0, targetSongId);

      const stillCurrentSongId = this.latestPlaying?.songId ?? this.status.currentSong?.id ?? null;
      if (stillCurrentSongId !== currentSongId) {
        throw new Error("NetEase playback changed while resolving ENQUEUE_NEXT; retry the command.");
      }

      this.assertRoomBinding(binding);
      await this.client.replaceTogetherPlaylist({
        roomId,
        userId: accountId,
        version: nextVersion,
        displayList: nextDisplayList,
        randomList: playlist.randomList,
      });
      console.log(
        `NetEase queue mutation reported: action=ENQUEUE_NEXT afterSongId=${currentSongId} songId=${targetSongId} version=${nextVersion}`,
      );

      const timeoutMs = this.options.playbackControlTimeoutMs ?? 8_000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(250);
        const confirmed = await this.client.getTogetherPlaylist(roomId);
        this.assertRoomBinding(binding);
        const confirmedCurrentIndex = confirmed.displayList.indexOf(currentSongId);
        const confirmedNext = confirmedCurrentIndex >= 0
          ? confirmed.displayList[(confirmedCurrentIndex + 1) % confirmed.displayList.length]
          : null;
        const confirmedVersion = confirmed.versions.find(
          (entry) => entry.userId === accountId,
        )?.version ?? 0;
        if (confirmedNext === targetSongId && confirmedVersion >= nextVersion) {
          console.log(
            `NetEase queue mutation confirmed: action=ENQUEUE_NEXT afterSongId=${currentSongId} songId=${targetSongId} version=${confirmedVersion}`,
          );
          return {
            ok: true,
            confirmed: true,
            action: "ENQUEUE_NEXT",
            roomId,
            songId: targetSongId,
            afterSongId: currentSongId,
            version: confirmedVersion,
            confirmedAt: new Date().toISOString(),
          };
        }
      }

      throw new Error(
        `NetEase ENQUEUE_NEXT timed out waiting for playlist confirmation: target=${targetSongId} version=${nextVersion}`,
      );
    } finally {
      this.queueMutationPending = false;
    }
  }

  start(): void {
    if (this.running || !this.options.enabled) return;
    this.running = true;
    void this.run();
  }

  private async validateAccountSession(): Promise<void> {
    const profile = await this.client.getAccountProfile();
    if (profile.id === this.options.inviterUid) throw new SafeOperationError("same_account_configuration", "Ash and inviter must use different accounts.");
    this.accountProfile = profile;
    this.status.accountId = profile.id;
  }

  async searchSongs(query: string, limit: number) {
    return await this.client.searchSongs(query, limit);
  }

  private async run(): Promise<void> {
    try {
      await this.validateAccountSession();
      this.status.phase = "waiting_invite";
      console.log(`NetEase Together worker ready for account ${this.status.accountId}`);
    } catch (error) {
      this.recordError(error, "Cookie validation failed");
    }

    while (this.running) {
      const startedAt = Date.now();
      try {
        if (!this.status.accountId) await this.validateAccountSession();
        await this.pollOnce();
        this.errorStreak = 0;
        this.status.lastError = null;
      } catch (error) {
        if (error instanceof NeteaseApiError && error.code === 488) {
          this.leaveRoom("房间已经结束了。一起听已退出，继续等待下一次邀请。");
        } else {
          this.recordError(error, "Together poll failed");
        }
      }

      const base = this.options.pollIntervalMs ?? 4000;
      const backoff = this.errorStreak > 0
        ? Math.min(60_000, base * 2 ** Math.min(this.errorStreak, 4))
        : base;
      await sleep(Math.max(250, backoff - (Date.now() - startedAt)));
    }
  }

  private async pollOnce(): Promise<void> {
    this.status.lastPollAt = new Date().toISOString();
    const remote = await this.client.getRoomStatus();

    if (remote.inRoom && remote.roomId) {
      if (!this.boundRoom || remote.roomId !== this.boundRoom.roomId) {
        this.leaveRoom("Unbound Together room detected.");
        throw new SafeOperationError("unbound_room", "Unbound Together room detected; exit it and send a fresh invitation.");
      }
      if (remote.chatRoomId && this.boundRoom.chatRoomId && remote.chatRoomId !== this.boundRoom.chatRoomId) {
        this.leaveRoom("Together ChatRoom changed.");
        throw new Error("Together ChatRoom changed; send a fresh invitation.");
      }
      if (remote.chatRoomId) {
        this.chatRoomId = remote.chatRoomId;
        this.boundRoom.chatRoomId = remote.chatRoomId;
        await this.ensureRealtime(remote.roomId, remote.chatRoomId);
      }
    } else if (this.roomId) {
      this.leaveRoom("一起听已经结束了。我会继续等你的下一次邀请。");
    }

    if (!this.roomId) {
      this.status.phase = "waiting_invite";
      const invite = await this.findInvite();
      if (!invite) return;
      await this.acceptInvite(invite);
    }

    if (!this.roomId) return;
    this.status.phase = "listening";

    const now = Date.now();
    const realtimeConnected = this.realtime.getStatus().connected;
    let playbackHandling = Promise.resolve();
    if (this.shouldReconcilePlayback(now, realtimeConnected)) {
      const expected = this.boundRoom;
      const playing = await this.client.getPlaying(this.roomId);
      if (!expected || !this.isCurrentReplyTarget(expected)) return;
      const observedAtMs = Date.now();
      this.lastPlaybackReconcileAt = observedAtMs;
      playbackHandling = this.applyPlayback(playing, observedAtMs, "http");
    }

    await this.maybeHeartbeat();
    await playbackHandling;
  }

  private async ensureRealtime(roomId: string, chatRoomId: string): Promise<void> {
    if (!this.boundRoom || this.boundRoom.roomId !== roomId || this.boundRoom.chatRoomId !== chatRoomId) {
      throw new Error("Realtime connection requires a trusted room binding.");
    }
    const binding = { ...this.boundRoom };
    const realtimeStatus = this.realtime.getStatus();
    if (
      realtimeStatus.connected
      && realtimeStatus.roomId === roomId
      && realtimeStatus.chatRoomId === chatRoomId
    ) return;

    const now = Date.now();
    if (now - this.lastRealtimeAttemptAt < 10_000) return;
    this.lastRealtimeAttemptAt = now;

    try {
      const credentials = await this.client.getRealtimeCredentials();
      this.assertRoomBinding(binding);
      console.log(
        `NetEase NIM realtime credentials acquired for account ${this.status.accountId ?? "unknown"}; addresses=${credentials.addresses.length}`,
      );
      if (!this.accountProfile) await this.validateAccountSession();
      const profile = this.accountProfile;
      if (!profile) throw new Error("Account validation required.");
      this.assertRoomBinding(binding);
      await this.realtime.connect({
        roomId,
        chatRoomId,
        credentials,
        memberProfile: {
          userId: profile.id,
          ...(profile.nickname ? { nick: profile.nickname } : {}),
          ...(profile.avatarUrl ? { avatar: profile.avatarUrl } : {}),
          ...(profile.gender !== null ? { gender: profile.gender } : {}),
        },
      });
      if (!this.isCurrentReplyTarget(binding)) {
        await this.realtime.disconnect();
        return;
      }
      console.log(`NetEase NIM realtime connected: roomId=${roomId} chatRoomId=${chatRoomId}`);
    } catch (error) {
      this.realtime.recordConnectionError(error);
      const detail = safeError(error);
      console.error(`NetEase NIM realtime connect failed: ${detail}`);
    }
  }

  private async findInvite(): Promise<TogetherInvite | null> {
    const ownId = this.status.accountId;
    if (!ownId) return null;
    if (!this.options.inviterUid) throw new Error("No allowed inviter configured.");
    const contactIds = [this.options.inviterUid];

    for (const uid of contactIds) {
      const history = await this.client.getPrivateHistory(uid);
      const invite = parseLatestInvite(history, uid);
      if (invite && invite.inviterId === this.options.inviterUid
        && invite.messageTime >= this.inviteNotBeforeMs
        && !this.handledInvites.has(invite.roomId + ":" + invite.messageTime)) return invite;
    }
    return null;
  }

  private async acceptInvite(invite: TogetherInvite): Promise<void> {
    if (!this.options.inviterUid || invite.inviterId !== this.options.inviterUid) {
      throw new Error("Invitation sender is not allowed.");
    }
    this.status.phase = "joining";
    const inviteKey = invite.roomId + ":" + invite.messageTime;
    this.handledInvites.add(inviteKey);
    if (this.handledInvites.size > 50) {
      const oldest = this.handledInvites.values().next().value as string | undefined;
      if (oldest) this.handledInvites.delete(oldest);
    }
    try {
      const accepted = await this.client.acceptInvite(invite.roomId, invite.inviterId);
      if (!accepted.inRoom || accepted.roomId !== invite.roomId) {
        throw new Error("Accepted room does not match the allowed invitation.");
      }
      const remote = await this.client.getRoomStatus();
      if (!remote.inRoom || remote.roomId !== invite.roomId) {
        throw new Error("Invitation acceptance was not confirmed.");
      }
      this.enterRoom(invite.roomId, remote.chatRoomId ?? accepted.chatRoomId);
      if (this.chatRoomId) await this.ensureRealtime(invite.roomId, this.chatRoomId);
    } catch (error) {
      this.handledInvites.delete(inviteKey);
      throw error;
    }
  }

  private enterRoom(roomId: string, chatRoomId: string | null = null): void {
    const changedRoom = this.roomId !== roomId;
    if (changedRoom) {
      this.rejectPendingPlaybackControl("NetEase Listen Together room changed before playback control confirmation.");
      void this.realtime.disconnect();
      this.nextPlaybackClientSeq = 1;
    }
    this.boundRoom = { roomId, chatRoomId: chatRoomId ?? "", bindingId: randomUUID() };
    this.roomId = roomId;
    this.chatRoomId = chatRoomId;
    this.previousSongId = null;
    this.previousPlayStatus = "UNKNOWN";
    this.currentLyricsModelContext = null;
    this.joinedPending = true;
    this.lastHeartbeatAt = 0;
    this.lastRealtimeAttemptAt = 0;
    this.lastPlaybackServerSeq = null;
    this.lastPlaybackReconcileAt = 0;
    this.latestPlaying = null;
    this.latestPlaybackObservedAtMs = 0;
    this.status.roomId = roomId;
    this.status.currentSong = null;
    this.status.playStatus = "UNKNOWN";
    this.status.phase = "listening";
    this.updateState((sink) => sink.enterRoom(roomId));
  }

  private leaveRoom(message: string): void {
    const wasInRoom = Boolean(this.roomId);
    this.rejectPendingPlaybackControl("NetEase Listen Together ended before playback control confirmation.");
    this.boundRoom = null;
    this.roomId = null;
    this.chatRoomId = null;
    this.previousSongId = null;
    this.previousPlayStatus = "UNKNOWN";
    this.currentLyricsModelContext = null;
    this.joinedPending = false;
    this.lastHeartbeatAt = 0;
    this.lastRealtimeAttemptAt = 0;
    this.lastPlaybackServerSeq = null;
    this.lastPlaybackReconcileAt = 0;
    this.latestPlaying = null;
    this.latestPlaybackObservedAtMs = 0;
    this.status.roomId = null;
    this.status.currentSong = null;
    this.status.playStatus = "UNKNOWN";
    this.status.phase = "waiting_invite";
    void this.realtime.disconnect();
    this.updateState((sink) => sink.leaveRoom());
    if (wasInRoom) this.options.onEvent("netease.together", message);
  }

  private currentPlaybackProgressMs(nowMs = Date.now()): number {
    const playing = this.latestPlaying;
    if (!playing) return 0;

    const elapsedMs = playing.playStatus === "PLAY"
      ? Math.max(0, nowMs - this.latestPlaybackObservedAtMs)
      : 0;
    let progressMs = Math.max(0, playing.progress + elapsedMs);
    const currentSong = this.status.currentSong;
    if (currentSong && currentSong.id === playing.songId) {
      progressMs = Math.min(progressMs, currentSong.durationMs);
    }
    return progressMs;
  }

  private async controlPlayback(
    commandType: "PLAY" | "PAUSE" | "GOTO",
    requestedTargetSongId?: string,
  ): Promise<PlaybackControlResult> {
    const binding = await this.verifyBoundRoom();
    if (this.pendingPlaybackControl) {
      throw new Error(
        `NetEase playback control already pending: ${this.pendingPlaybackControl.commandType}`,
      );
    }
    if (!this.roomId) throw new Error("NetEase Listen Together is not currently in a room.");

    const realtimeStatus = this.realtime.getStatus();
    if (!realtimeStatus.connected) {
      throw new Error("NetEase realtime is not connected; refusing unconfirmed playback control.");
    }

    const senderId = this.status.accountId;
    if (!senderId) throw new Error("NetEase account identity is unavailable.");

    const playing = this.latestPlaying;
    const currentSongId = playing?.songId ?? this.status.currentSong?.id ?? null;
    if (!playing || !currentSongId) throw new Error("NetEase current playback state is unavailable.");

    const targetSongId = commandType === "GOTO"
      ? requestedTargetSongId ?? null
      : currentSongId;
    if (!targetSongId) throw new Error("NetEase target songId is unavailable.");

    const expectedPlayStatus: "PLAY" | "PAUSE" = commandType === "PAUSE" ? "PAUSE" : "PLAY";
    const progressMs = commandType === "GOTO" ? 0 : this.currentPlaybackProgressMs();
    const roomId = this.roomId;
    const clientSeq = this.nextPlaybackClientSeq++;
    const baselineServerSeq = this.lastPlaybackServerSeq;
    const timeoutMs = this.options.playbackControlTimeoutMs ?? 8_000;

    let resolveConfirmation!: (result: PlaybackControlResult) => void;
    let rejectConfirmation!: (error: Error) => void;
    const confirmation = new Promise<PlaybackControlResult>((resolve, reject) => {
      resolveConfirmation = resolve;
      rejectConfirmation = reject;
    });

    const timeout = setTimeout(() => {
      if (this.pendingPlaybackControl?.clientSeq !== clientSeq) return;
      this.pendingPlaybackControl = null;
      rejectConfirmation(new Error(
        `NetEase playback control timed out waiting for realtime confirmation: ${commandType} clientSeq=${clientSeq}`,
      ));
    }, timeoutMs);

    this.pendingPlaybackControl = {
      commandType,
      roomId,
      songId: targetSongId,
      clientSeq,
      senderId,
      expectedPlayStatus,
      baselineServerSeq,
      timeout,
      resolve: resolveConfirmation,
      reject: rejectConfirmation,
    };

    try {
      this.assertRoomBinding(binding);
      await this.client.reportPlaybackCommand({
        roomId,
        commandType,
        progress: progressMs,
        playStatus: expectedPlayStatus,
        formerSongId: currentSongId,
        targetSongId,
        clientSeq,
      });
      console.log(
        `NetEase playback control reported: command=${commandType} formerSongId=${currentSongId} targetSongId=${targetSongId} progressMs=${Math.floor(progressMs)} clientSeq=${clientSeq}`,
      );
    } catch (error) {
      if (this.pendingPlaybackControl?.clientSeq === clientSeq) {
        clearTimeout(this.pendingPlaybackControl.timeout);
        this.pendingPlaybackControl = null;
      }
      throw error;
    }

    return await confirmation;
  }

  private confirmPendingPlaybackControl(event: RealtimePlaybackEvent): void {
    const pending = this.pendingPlaybackControl;
    if (!pending) return;
    if (event.clientSeq !== pending.clientSeq) return;
    if (event.senderId !== pending.senderId) return;
    if (event.commandType !== pending.commandType) return;
    if (event.songId !== pending.songId) return;
    if (event.playStatus !== pending.expectedPlayStatus) return;
    if (event.serverSeq === null) return;
    if (
      pending.baselineServerSeq !== null
      && event.serverSeq <= pending.baselineServerSeq
    ) return;

    clearTimeout(pending.timeout);
    this.pendingPlaybackControl = null;
    const result: PlaybackControlResult = {
      ok: true,
      confirmed: true,
      commandType: pending.commandType,
      roomId: pending.roomId,
      songId: pending.songId,
      playStatus: event.playStatus,
      progressMs: event.progressMs,
      clientSeq: pending.clientSeq,
      serverSeq: event.serverSeq,
      confirmedAt: new Date(event.receivedAtMs).toISOString(),
    };
    console.log(
      `NetEase playback control confirmed: command=${result.commandType} songId=${result.songId} clientSeq=${result.clientSeq} serverSeq=${result.serverSeq}`,
    );
    pending.resolve(result);
  }

  private rejectPendingPlaybackControl(message: string): void {
    const pending = this.pendingPlaybackControl;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingPlaybackControl = null;
    pending.reject(new Error(message));
  }

  private shouldReconcilePlayback(nowMs: number, realtimeConnected: boolean): boolean {
    if (!this.latestPlaying) return true;
    if (!realtimeConnected) return true;
    const interval = this.options.playbackReconcileIntervalMs ?? 30_000;
    return nowMs - this.lastPlaybackReconcileAt >= interval;
  }

  private async maybeHeartbeat(): Promise<void> {
    const playing = this.latestPlaying;
    if (!this.roomId || !playing) return;

    const interval = this.options.heartbeatIntervalMs ?? 10_000;
    const nowMs = Date.now();
    if (nowMs - this.lastHeartbeatAt < interval) return;

    const progressMs = this.currentPlaybackProgressMs(nowMs);
    await this.client.sendHeartbeat(
      this.roomId,
      playing.songId,
      playing.playStatus === "PLAY",
      progressMs,
    );
    this.lastHeartbeatAt = Date.now();
    this.status.lastHeartbeatAt = new Date(this.lastHeartbeatAt).toISOString();
  }

  private applyPlayback(
    playing: PlayingState,
    observedAtMs: number,
    origin: "http" | "realtime",
  ): Promise<void> {
    const serverSeq = playing.serverSeq;
    if (
      serverSeq !== undefined
      && this.lastPlaybackServerSeq !== null
      && serverSeq < this.lastPlaybackServerSeq
    ) {
      console.log(
        `Together stale playback ignored: origin=${origin} serverSeq=${serverSeq} latest=${this.lastPlaybackServerSeq}`,
      );
      return Promise.resolve();
    }
    if (serverSeq !== undefined) this.lastPlaybackServerSeq = serverSeq;

    this.latestPlaying = { ...playing };
    this.latestPlaybackObservedAtMs = observedAtMs;

    this.updateState((sink) => sink.updatePlayback({
      songId: playing.songId,
      playStatus: playing.playStatus,
      progressMs: playing.progress,
      observedAtMs,
      ...(serverSeq === undefined ? {} : { serverSeq }),
    }));

    const binding = this.boundRoom;
    const handling = this.playbackHandlingTail.then(() => {
      if (binding && this.isCurrentReplyTarget(binding)) return this.handlePlaying(playing);
    });
    this.playbackHandlingTail = handling.catch(() => {});
    return handling;
  }

  private handleRealtimePlaybackEvent(event: RealtimePlaybackEvent): void {
    if (!this.roomId || !this.boundRoom) return;

    const knownStatus = this.status.playStatus;
    const playStatus = event.playStatus === "UNKNOWN" && knownStatus !== "UNKNOWN"
      ? knownStatus
      : event.playStatus;
    const songId = event.songId ?? this.status.currentSong?.id ?? this.previousSongId;
    const playing: PlayingState = {
      songId,
      playStatus,
      progress: event.progressMs,
      ...(event.serverSeq === null ? {} : { serverSeq: event.serverSeq }),
    };

    void this.applyPlayback(playing, event.receivedAtMs, "realtime")
      .then(() => {
        this.confirmPendingPlaybackControl(event);
      })
      .catch((error) => {
        const detail = error instanceof NeteaseApiError
          ? `${error.operation}${error.code === null ? "" : ` code=${error.code}`}`
          : safeError(error);
        console.error(`Together realtime playback handling failed: ${detail}`);
      });
  }

  private async handlePlaying(playing: PlayingState): Promise<void> {
    const binding = this.boundRoom;
    if (!binding) return;
    this.status.playStatus = playing.playStatus;
    const statusChanged = this.previousPlayStatus !== playing.playStatus;

    if (playing.songId && playing.songId !== this.previousSongId) {
      const song = await this.client.getSongDetails(playing.songId);
      if (!this.isCurrentReplyTarget(binding)) return;
      this.previousSongId = playing.songId;
      this.currentLyricsModelContext = null;
      this.status.currentSong = song;
      this.updateState((sink) => sink.updateSong(song));
      const lyricsContext = await this.loadLyrics(song);
      if (!this.isCurrentReplyTarget(binding)) return;

      if (playing.playStatus === "PLAY") {
        const prefix = this.joinedPending
          ? "你把我拉进一起听啦。现在播放"
          : "你换到了";
        this.emitRoomEvent(
          "netease.music_changed",
          `${prefix}《${song.name}》— ${song.artist}。请结合我们的对话自然回应；如果没必要点评，也可以只安静陪听。`,
          lyricsContext,
        );
        this.joinedPending = false;
      }
    } else if (statusChanged && this.previousPlayStatus !== "UNKNOWN") {
      if (playing.playStatus === "PAUSE") {
        this.emitRoomEvent(
          "netease.playback",
          "一起听暂停了。",
          this.currentLyricsModelContext ?? undefined,
        );
      } else if (playing.playStatus === "PLAY") {
        const song = this.status.currentSong;
        this.emitRoomEvent(
          "netease.playback",
          song
            ? `一起听继续播放：《${song.name}》— ${song.artist}。`
            : "一起听继续播放了。",
          this.currentLyricsModelContext ?? undefined,
        );
        this.joinedPending = false;
      }
    }

    this.previousPlayStatus = playing.playStatus;
  }

  private handleRealtimeChatMessage(message: RealtimeChatRoomMessage): void {
    if (!this.boundRoom || message.senderId !== this.options.inviterUid) return;
    if (message.category !== "text" || !message.text) return;
    const ownAccountId = this.status.accountId;
    if (ownAccountId && message.senderId === ownAccountId) return;

    const roomKey = this.roomId ?? "no-room";
    const messageKey = message.messageId
      ? roomKey + ":" + message.messageId
      : roomKey + ":" + (message.senderId ?? "unknown") + ":" + String(message.timetagMs ?? message.receivedAtMs) + ":" + message.text;
    if (this.handledChatMessageKeys.has(messageKey)) {
      const suffix = message.messageId ? "***" + message.messageId.slice(-6) : "unknown";
      console.warn("NetEase duplicate ChatRoom message suppressed: messageId=" + suffix);
      return;
    }
    this.handledChatMessageKeys.add(messageKey);
    while (this.handledChatMessageKeys.size > 512) {
      const oldest = this.handledChatMessageKeys.values().next().value;
      if (!oldest) break;
      this.handledChatMessageKeys.delete(oldest);
    }

    this.emitRoomEvent(
      "netease.chatroom",
      message.text,
      this.currentLyricsModelContext ?? undefined,
    );
  }

  private async loadLyrics(song: SongDetails): Promise<string | undefined> {
    const binding = this.boundRoom;
    try {
      const lyrics = await this.client.getLyrics(song.id);
      if (!binding || !this.isCurrentReplyTarget(binding)) return undefined;
      this.updateState((sink) => sink.updateLyrics(song.id, lyrics));
      const modelContext = buildFullLyricsModelContext(song, lyrics);
      this.currentLyricsModelContext = modelContext;
      if (modelContext) {
        console.log(
          `Together full lyrics context ready: songId=${song.id} payloads=${countAvailableLyricPayloads(lyrics)} contextChars=${modelContext.length}`,
        );
      }
      return modelContext ?? undefined;
    } catch (error) {
      if (!binding || !this.isCurrentReplyTarget(binding)) return undefined;
      this.currentLyricsModelContext = null;
      const detail = error instanceof NeteaseApiError
        ? `${error.operation}${error.code === null ? "" : ` code=${error.code}`}`
        : safeError(error);
      console.error(`Together lyrics load failed: ${detail}`);
      return undefined;
    }
  }

  private updateState(update: (sink: PlaybackStateSink) => void): void {
    if (!this.options.stateSink) return;
    try {
      update(this.options.stateSink);
    } catch (error) {
      const detail = safeError(error);
      console.error(`Together state update failed: ${detail}`);
    }
  }

  private recordError(error: unknown, prefix: string): void {
    this.errorStreak += 1;
    this.status.phase = this.errorStreak >= 3 ? "error" : "backoff";
    const detail = error instanceof NeteaseApiError
      ? `${error.operation}${error.code === null ? "" : ` code=${error.code}`}`
      : safeError(error);
    this.status.lastError = `${prefix}: ${detail}`;
    console.error(this.status.lastError);
  }
}

export function createTogetherWorker(
  onEvent: EventSink,
  stateSink?: PlaybackStateSink,
  env: NodeJS.ProcessEnv = process.env,
): TogetherWorker {
  const cookie = env.NETEASE_COOKIE?.trim() ?? "";
  const explicitlyDisabled = /^(0|false|off|no)$/i.test(
    env.TOGETHER_ENABLED?.trim() ?? "",
  );
  const enabled = !explicitlyDisabled;
  const parseInterval = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value >= 1000 ? value : fallback;
  };

  if (enabled && !/(?:^|;\s*)MUSIC_U=[^;\s]+/.test(cookie)) {
    throw new Error("NETEASE_COOKIE must contain a nonempty MUSIC_U session.");
  }
  if (enabled && !/^\d+$/.test(env.NETEASE_INVITER_UID?.trim() ?? "")) {
    throw new Error("NETEASE_INVITER_UID is required.");
  }

  return new TogetherWorker({
    cookie,
    enabled,
    inviterUid: env.NETEASE_INVITER_UID?.trim() || undefined,
    pollIntervalMs: parseInterval("TOGETHER_POLL_INTERVAL_MS", 4000),
    heartbeatIntervalMs: parseInterval("TOGETHER_HEARTBEAT_INTERVAL_MS", 10_000),
    playbackReconcileIntervalMs: parseInterval("TOGETHER_PLAYBACK_RECONCILE_INTERVAL_MS", 30_000),
    playbackControlTimeoutMs: parseInterval("TOGETHER_PLAYBACK_CONTROL_TIMEOUT_MS", 8_000),
    onEvent,
    stateSink,
  });
}
