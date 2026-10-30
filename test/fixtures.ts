import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTPayload } from "jose";
import { createMcpAccess, MCP_SCOPE, type OAuthConfig } from "../src/auth.js";
import { createHttpServer, type ServerOptions } from "../src/server.js";
import { TogetherWorker } from "../src/netease/togetherWorker.js";
import { PlaybackStateStore } from "../src/netease/playbackState.js";
import { InMemoryEventQueue } from "../src/queue.js";

export const oauthConfig: OAuthConfig = {
  publicOrigin: "https://bridge.example.test",
  issuer: "https://login.example.test/",
  subject: "auth0|fixture-owner",
  clientId: "fixture-chatgpt-client",
};

export async function authFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test", alg: "RS256", use: "sig" };
  const access = createMcpAccess(oauthConfig, createLocalJWKSet({ keys: [jwk] }));
  const sign = async (overrides: JWTPayload = {}) => new SignJWT({
    iss: oauthConfig.issuer,
    aud: oauthConfig.publicOrigin,
    sub: oauthConfig.subject,
    azp: oauthConfig.clientId,
    scope: MCP_SCOPE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);
  return { access, sign, authorization: "Bearer " + await sign() };
}

export async function serverFixture(overrides: Partial<ServerOptions> = {}) {
  const auth = await authFixture();
  const playbackState = overrides.playbackState ?? new PlaybackStateStore();
  const queue = overrides.queue ?? new InMemoryEventQueue();
  const worker = overrides.togetherWorker ?? new TogetherWorker({
    cookie: "", enabled: false, inviterUid: "12345", onEvent: () => {},
  });
  const server = createHttpServer({ access: auth.access, queue, playbackState, togetherWorker: worker, ...overrides });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server address");
  return {
    ...auth, server, queue, worker, playbackState,
    base: "http://127.0.0.1:" + address.port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export function bindFixture(worker: TogetherWorker, roomId = "room", chatRoomId = "123"): void {
  const internals = worker as unknown as {
    enterRoom(roomId: string, chatRoomId: string): void;
    client: { getRoomStatus(): Promise<{ inRoom: boolean; roomId: string; chatRoomId: string }> };
  };
  internals.enterRoom(roomId, chatRoomId);
  internals.client.getRoomStatus = async () => ({ inRoom: true, roomId, chatRoomId });
}
