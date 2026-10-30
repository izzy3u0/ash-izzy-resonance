import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

// This file intentionally imports the client dynamically after setting a sink,
// so the production console wrapper is tested, not replaced by the test itself.
test("NetEase SDK response logs are suppressed across awaits without hiding unrelated Bridge logs", async () => {
  const captured: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { captured.push(JSON.stringify(args)); };
  console.error = (...args: unknown[]) => { captured.push(JSON.stringify(args)); };
  const require = createRequire(import.meta.url);
  const sdk = require("NeteaseCloudMusicApi") as Record<string, (params: unknown) => Promise<unknown>>;
  const originalAccount = sdk.user_account;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sentinel = "fixture-only-sensitive-response";
  try {
    const { NeteaseClient } = await import("../src/netease/client.js");
    sdk.user_account = async () => {
      console.log("[ERR]", { cookie: [sentinel], body: { verificationCode: sentinel } });
      await gate;
      console.error("[ERR]", { authorization: sentinel });
      return { body: { code: 301, message: sentinel } };
    };
    const pending = new NeteaseClient("MUSIC_U=fixture-only").getAccountProfile();
    console.log("unrelated-bridge-diagnostic");
    release();
    await assert.rejects(pending);
    assert.ok(!captured.join("\n").includes(sentinel));
    assert.ok(captured.join("\n").includes("unrelated-bridge-diagnostic"));
  } finally {
    sdk.user_account = originalAccount;
    console.log = originalLog;
    console.error = originalError;
  }
});
