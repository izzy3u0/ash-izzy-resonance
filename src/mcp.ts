import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBridgeApp } from "./bridge/registerApp.js";
import { registerBridgeTools } from "./bridge/registerTools.js";
import { registerBridgeWaitTool } from "./bridge/registerWaitTool.js";
import { acceptsProfileSource, buildProfileInstructions, type McpProfile } from "./profiles.js";
import { registerNeteaseSearchTool } from "./netease/accountTools.js";
import { registerNeteaseTogetherTools } from "./netease/registerTogetherTools.js";
import type { PlaybackStateStore } from "./netease/playbackState.js";
import type { TogetherWorker } from "./netease/togetherWorker.js";
import type { BridgeEvent } from "./types.js";
import type { InMemoryEventQueue } from "./queue.js";

export { RESOURCE_URI } from "./bridge/registerApp.js";
export type { McpProfile } from "./profiles.js";

export function createMcpServer(
  queue: InMemoryEventQueue,
  playbackState: PlaybackStateStore,
  togetherWorker: TogetherWorker,
  profile: McpProfile = "default",
): McpServer {
  const server = new McpServer(
    { name: profile === "music" ? "cove-resonance-music" : "cove-resonance", version: "0.2.0" },
    { instructions: buildProfileInstructions(profile) },
  );
  const eventFilter = (event: BridgeEvent) =>
    acceptsProfileSource(profile, event.source)
    && (!event.replyTarget || togetherWorker.isCurrentReplyTarget(event.replyTarget));

  registerNeteaseSearchTool(server, togetherWorker);
  registerBridgeApp(server);
  registerNeteaseTogetherTools(server, playbackState, togetherWorker);
  registerBridgeTools(server, queue, eventFilter, togetherWorker);
  registerBridgeWaitTool(server, queue, eventFilter);

  return server;
}
