import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createMcpAccess, oauthConfigFromEnv, validIngestToken, type McpAccess } from "./auth.js";
import { createMcpServer } from "./mcp.js";
import { buildBridgeEvent } from "./bridge/events.js";
export { buildBridgeEvent } from "./bridge/events.js";
import { MCP_PATHS } from "./profiles.js";
import { listenerWakeHub } from "./listenerWake.js";
import { PlaybackStateStore } from "./netease/playbackState.js";
import { createTogetherWorker, type TogetherWorker } from "./netease/togetherWorker.js";
import { InMemoryEventQueue } from "./queue.js";

export type ServerOptions = {
  access: McpAccess;
  queue: InMemoryEventQueue;
  playbackState: PlaybackStateStore;
  togetherWorker: TogetherWorker;
  ingestToken?: string;
};

export function createRuntime(): ServerOptions {
  // Fail closed before listening or starting any provider connection.
  const access = createMcpAccess(oauthConfigFromEnv());
  const ingestToken = process.env.BRIDGE_INGEST_TOKEN?.trim() ?? "";
  if (ingestToken && ingestToken.length < 32) throw new Error("BRIDGE_INGEST_TOKEN must contain at least 32 characters");
  const queue = new InMemoryEventQueue();
  const playbackState = new PlaybackStateStore();
  const togetherWorker = createTogetherWorker((source, text, context, replyTarget) => {
    const event = buildBridgeEvent(randomUUID(), source, text, new Date().toISOString(), context);
    event.replyTarget = replyTarget;
    if (queue.enqueue(event)) listenerWakeHub.wake(source);
  }, playbackState);
  return { access, ingestToken, queue, playbackState, togetherWorker };
}

const eventInput = z.object({
  eventId: z.string().trim().min(1).max(200).optional(),
  // Generic ingestion must never impersonate a trusted NetEase room.
  source: z.string().trim().min(1).max(80).refine((s) => !s.toLowerCase().startsWith("netease")).default("test"),
  text: z.string().trim().min(1).max(4000),
});

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function createHttpServer(options: ServerOptions = createRuntime()) {
  const { access, queue, playbackState, togetherWorker } = options;
  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) { res.writeHead(400).end(); return; }
    const url = new URL(req.url, "http://localhost");

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
      }).end();
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      writeJson(res, 200, { ok: true, service: "cove-bridge", version: "0.2.0" });
      return;
    }
    if (req.method === "GET" && [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource/mcp/music",
    ].includes(url.pathname)) {
      writeJson(res, 200, access.metadata);
      return;
    }
    if (url.pathname === "/listener/events" && req.method === "GET") {
      const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
      const token = bearer ?? url.searchParams.get("session") ?? "";
      const session = token ? listenerWakeHub.consumeSession(token) : null;
      if (!session) { writeJson(res, 401, { error: "invalid_or_expired_listener_session" }); return; }
      listenerWakeHub.subscribe(res, session.expiresAtMs);
      return;
    }
    if (url.pathname === "/events" && req.method === "POST") {
      if (!options.ingestToken) { writeJson(res, 404, { error: "not_found" }); return; }
      if (!validIngestToken(options.ingestToken, req.headers.authorization)) {
        writeJson(res, 401, { error: "unauthorized" }); return;
      }
      try {
        const parsed = eventInput.safeParse(await readJson(req));
        if (!parsed.success) { writeJson(res, 400, { error: "invalid_event" }); return; }
        const id = parsed.data.eventId ?? randomUUID();
        const created = queue.enqueue(buildBridgeEvent(id, parsed.data.source, parsed.data.text));
        if (created) listenerWakeHub.wake(parsed.data.source);
        writeJson(res, created ? 201 : 200, { ok: true, created, eventId: id });
      } catch { writeJson(res, 400, { error: "invalid_event" }); }
      return;
    }
    const profile = MCP_PATHS.get(url.pathname);
    if (profile) {
      try { await access.verify(req.headers.authorization); }
      catch {
        res.setHeader("WWW-Authenticate", access.challenge);
        writeJson(res, 401, { error: "unauthorized" }); return;
      }
      if (!["POST", "GET", "DELETE"].includes(req.method)) {
        res.writeHead(405, { Allow: "POST, GET, DELETE" }).end(); return;
      }
      const mcp = createMcpServer(queue, playbackState, togetherWorker, profile);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      try { await mcp.connect(transport); await transport.handleRequest(req, res); }
      catch {
        console.error("MCP request failed");
        if (!res.headersSent) writeJson(res, 500, { error: "internal_server_error" });
      }
      return;
    }
    writeJson(res, 404, { error: "not_found" });
  });
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtime = createRuntime();
    const port = Number(process.env.PORT ?? 8787);
    createHttpServer(runtime).listen(port, "0.0.0.0", () => {
      console.log("Cove Resonance listening (authenticated MCP)");
      runtime.togetherWorker.start();
    });
    const socket = process.env.BRIDGE_UNIX_SOCKET?.trim();
    if (socket) {
      if (existsSync(socket)) unlinkSync(socket);
      createHttpServer(runtime).listen(socket, () => chmodSync(socket, 0o600));
    }
  } catch {
    console.error("Startup refused: invalid or missing OAuth/NetEase configuration. See docs/PHASE1.zh-CN.md.");
    process.exitCode = 1;
  }
}
