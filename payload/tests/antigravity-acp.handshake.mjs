/**
 * Live handshake check for the Antigravity ACP adapter.
 *
 * Uses the same SDK client Paseo uses (`ClientSideConnection`), so the wire
 * format exercised here is the wire format Paseo will speak. This deliberately
 * does NOT send a prompt: `agy` needs quota for that, and the point of this
 * check is the part that can be verified without it — that the adapter speaks
 * ACP, creates a session, and advertises the real Gemini catalogue.
 *
 * Run: node tests/antigravity-acp.handshake.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.join(here, "..", "src", "antigravity-acp.mjs");

const child = spawn(process.execPath, [adapter], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (chunk) => process.stderr.write(`  [adapter] ${chunk}`));

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const connection = new ClientSideConnection(
  () => ({
    async sessionUpdate() {},
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
  }),
  stream,
);

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

try {
  const init = await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  check("initialize returns a protocol version", typeof init.protocolVersion === "number",
    `protocolVersion=${init.protocolVersion}`);
  check("agent declines loadSession (agy cannot replay history)",
    init.agentCapabilities?.loadSession === false);

  const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
  check("newSession returns a session id", typeof session.sessionId === "string",
    session.sessionId);

  const models = session.models?.availableModels ?? [];
  check("advertises models from `agy models`", models.length > 0, `${models.length} model(s)`);
  check("advertises a current model", typeof session.models?.currentModelId === "string",
    session.models?.currentModelId ?? "none");
  const gemini = models.filter((m) => m.modelId.startsWith("gemini"));
  check("catalogue includes Gemini entries", gemini.length > 0,
    gemini.slice(0, 3).map((m) => m.modelId).join(", "));
  for (const model of models.slice(0, 5)) console.log(`        ${model.modelId}  ${model.name}`);

  await connection.unstable_setSessionModel?.({
    sessionId: session.sessionId,
    modelId: models[0]?.modelId,
  });
  check("accepts a model change", true, models[0]?.modelId ?? "n/a");

  await connection.cancel({ sessionId: session.sessionId });
  check("accepts cancel on an idle session", true);
} catch (error) {
  check(`handshake threw: ${error?.message ?? error}`, false);
} finally {
  child.kill();
}

console.log(failures === 0 ? "\nAll handshake checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
