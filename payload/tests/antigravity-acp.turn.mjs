/**
 * Full prompt round-trip through the Antigravity ACP adapter.
 *
 * This is the check the handshake test deliberately cannot do: it sends a real
 * prompt and asserts that assistant text comes back through ACP. It therefore
 * needs Antigravity quota, which is why the adapter shipped marked
 * experimental — the account used during development was exhausted.
 *
 * Run:  node payload/tests/antigravity-acp.turn.mjs
 * Pass: exit 0 and "TURN VERIFIED" printed.
 *
 * If this passes, the adapter is no longer unproven. Update:
 *   - docs/antigravity-acp.md  (Verification status)
 *   - README.md                (the experimental callout)
 *   - the header comment in payload/src/antigravity-acp.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.join(here, "..", "src", "antigravity-acp.mjs");
const MODEL = process.argv[2] ?? "gemini-3.5-flash-low";

const child = spawn(process.execPath, [adapter], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (chunk) => process.stderr.write(`  [adapter] ${chunk}`));

/** Text streamed back by the agent, in order. */
const chunks = [];
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const connection = new ClientSideConnection(
  () => ({
    async sessionUpdate(params) {
      const update = params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        chunks.push(update.content.text);
      }
    },
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
  }),
  stream,
);

let exitCode = 1;
try {
  await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
  console.log(`session ${session.sessionId}`);

  const available = session.models?.availableModels ?? [];
  if (available.some((m) => m.modelId === MODEL)) {
    await connection.unstable_setSessionModel?.({ sessionId: session.sessionId, modelId: MODEL });
    console.log(`model   ${MODEL}`);
  } else {
    console.log(`model   ${session.models?.currentModelId ?? "provider default"} (${MODEL} not offered)`);
  }

  console.log("prompt  \"Reply with exactly: OK\"");
  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: OK" }],
  });

  const text = chunks.join("").trim();
  console.log(`stop    ${result?.stopReason}`);
  console.log(`text    ${JSON.stringify(text)}`);

  if (!text) {
    console.log("\nFAIL — the turn completed but no assistant text arrived.");
    console.log("If `agy` itself works, the result event shape may have changed;");
    console.log("check the `result` branch of #onEvent in antigravity-acp.mjs.");
  } else {
    console.log("\nTURN VERIFIED — assistant text round-tripped through ACP.");
    exitCode = 0;
  }
} catch (error) {
  // ACP wraps a handler throw as "Internal error" and puts the real text in
  // `data.details`, so the useful message is one level down.
  const details =
    (typeof error?.data?.details === "string" && error.data.details) ||
    error?.message ||
    String(error);
  console.log(`\nFAIL — ${details}`);
  if (/quota/i.test(details)) {
    console.log("\nThat is Antigravity's own quota limit, not an adapter fault —");
    console.log("the provider's message reached us intact, which means the ACP");
    console.log("error path works end to end. Only the success path is untested.");
    console.log("Re-run once the quota resets.");
  }
} finally {
  child.kill();
}

process.exit(exitCode);
