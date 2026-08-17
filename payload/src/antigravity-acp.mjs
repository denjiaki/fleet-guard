#!/usr/bin/env node
/**
 * ACP adapter for Antigravity's `agy` CLI.
 * =======================================
 *
 * STATUS: EXPERIMENTAL — the happy path has never been executed.
 * See "Verification status" at the bottom of this comment before trusting it.
 *
 * Why this exists
 * ---------------
 * Paseo drives external agents over the Agent Client Protocol: it spawns a
 * process and speaks JSON-RPC to it (see `acp-agent.ts` in @getpaseo/server).
 * Cursor works in Paseo because `cursor-agent` has an `acp` subcommand.
 * `agy` has no such mode — its subcommands are agent(s), changelog, help,
 * install, models, plugin(s), update — so Paseo cannot address it at all, and
 * an "antigravity" entry in Fleet Supervisor's fallback order is silently dead.
 *
 * This process is the missing half: it speaks ACP to Paseo on stdio, and drives
 * `agy --print --output-format stream-json` underneath.
 *
 * What `agy` gives us
 * -------------------
 * Its stream-json output is three event kinds:
 *
 *   {"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…",…}}
 *   {"event":"step_update","step_update":{"step_index":0,"state":"DONE",
 *                                         "step_type":"agent_response"}}
 *   {"event":"result","result":{"status":"…","response":"…","error":"…",
 *                               "usage":{…}}}
 *
 * The important limitation: `step_update` carries NO text. Only `step_index`,
 * `state` and `step_type`. The assistant's actual words arrive once, at the end,
 * in `result.response`. So this adapter cannot stream tokens — it emits one
 * `agent_message_chunk` when the turn completes. That is a property of the CLI,
 * not something to fix here; if `agy` later emits incremental text events, the
 * `onEvent` switch below is where they would be handled.
 *
 * Model selection
 * ---------------
 * `agy models` lists the Gemini catalogue, and ACP lets an agent advertise
 * models via `NewSessionResponse.models`. Paseo reads that (acp-agent.ts maps
 * `availableModels` into its own model list), which is what makes a real Gemini
 * picker appear in Fleet Supervisor's fallback cards instead of nothing.
 *
 * Verification status
 * -------------------
 * At the time of writing, this machine's Antigravity account was out of quota
 * ("Individual quota reached … Resets in 34h36m34s"), so NO successful `agy`
 * turn could be produced. What has been exercised:
 *
 *   - `agy models` parsing, against real CLI output
 *   - `agy --print --output-format stream-json` event shapes, against a real
 *     (quota-failed) run — init, step_update and result were all observed
 *   - the ACP handshake and session lifecycle against Paseo
 *
 * What has NOT been exercised: a successful turn producing assistant text.
 * `result.response` is populated from the observed schema but has only ever
 * been seen as an empty string on the error path. Treat the happy path as
 * unproven until someone watches a Gemini reply land in Paseo.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

const AGY_BIN = process.env.AGY_BIN ?? "agy";

/** Mirrors how the existing `fleet-cursor` provider runs Cursor with `--yolo`. */
const SKIP_PERMISSIONS =
  process.argv.includes("--skip-permissions") || process.env.AGY_ACP_SKIP_PERMISSIONS === "1";

function log(message) {
  // stdout is the ACP channel; anything human-readable must go to stderr or it
  // corrupts the protocol stream.
  process.stderr.write(`[antigravity-acp] ${message}\n`);
}

function runAgy(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(AGY_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error?.message ?? error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * `agy models` prints `<id><whitespace><label>` per line. Anything that does not
 * match that shape is skipped rather than guessed at.
 */
function parseModels(stdout) {
  const models = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(\S+)\s{2,}(.+)$/.exec(line) ?? /^(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    models.push({ modelId: match[1], name: match[2].trim() });
  }
  return models;
}

async function listModels() {
  const { code, stdout } = await runAgy(["models"]);
  if (code !== 0) {
    log(`\`agy models\` exited ${code}; continuing without a model list.`);
    return [];
  }
  return parseModels(stdout);
}

/** ACP content blocks -> the single string `agy --print` accepts. */
function promptToText(blocks) {
  const parts = [];
  for (const block of blocks ?? []) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "resource" && typeof block.resource?.text === "string") {
      parts.push(block.resource.text);
    }
  }
  return parts.join("\n\n").trim();
}

class AntigravityAgent {
  #connection;
  #sessions = new Map();
  #models = [];

  constructor(connection) {
    this.#connection = connection;
  }

  async initialize(params) {
    const requested = Number(params?.protocolVersion ?? PROTOCOL_VERSION);
    return {
      protocolVersion: Number.isFinite(requested)
        ? Math.min(requested, PROTOCOL_VERSION)
        : PROTOCOL_VERSION,
      agentCapabilities: {
        // `agy` has no way to rehydrate a conversation into a transcript we can
        // replay, so we do not claim loadSession.
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: [],
    };
  }

  /** `agy` owns its own auth; there is nothing for ACP to negotiate. */
  async authenticate() {
    return {};
  }

  async newSession(params) {
    if (this.#models.length === 0) this.#models = await listModels();
    const sessionId = randomUUID();
    this.#sessions.set(sessionId, {
      cwd: params?.cwd ?? process.cwd(),
      conversationId: null,
      modelId: this.#models[0]?.modelId ?? null,
      child: null,
      cancelled: false,
    });

    const response = { sessionId };
    if (this.#models.length > 0) {
      response.models = {
        availableModels: this.#models,
        currentModelId: this.#models[0].modelId,
      };
    }
    return response;
  }

  async unstable_setSessionModel(params) {
    const session = this.#sessions.get(params?.sessionId);
    if (!session) throw new Error(`Unknown session: ${params?.sessionId}`);
    session.modelId = params?.modelId ?? session.modelId;
    return {};
  }

  async cancel(params) {
    const session = this.#sessions.get(params?.sessionId);
    if (!session) return;
    session.cancelled = true;
    if (session.child && session.child.exitCode === null) session.child.kill();
  }

  async prompt(params) {
    const session = this.#sessions.get(params?.sessionId);
    if (!session) throw new Error(`Unknown session: ${params?.sessionId}`);

    const text = promptToText(params?.prompt);
    if (!text) return { stopReason: "end_turn" };

    session.cancelled = false;

    const args = ["--print", text, "--output-format", "stream-json"];
    if (session.modelId) args.push("--model", session.modelId);
    // Reuse the conversation so multi-turn context survives across prompts.
    if (session.conversationId) args.push("--conversation", session.conversationId);
    if (SKIP_PERMISSIONS) args.push("--dangerously-skip-permissions");

    const result = await this.#runTurn(session, params.sessionId, args);

    if (session.cancelled) return { stopReason: "cancelled" };

    if (result.error) {
      // Surfaced as a request error so Paseo shows it, and so Fleet Supervisor's
      // quota detection can see the provider's own wording.
      throw new Error(result.error);
    }

    if (result.response) {
      await this.#connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.response },
        },
      });
    }

    return { stopReason: "end_turn" };
  }

  #runTurn(session, sessionId, args) {
    return new Promise((resolve) => {
      const child = spawn(AGY_BIN, args, { cwd: session.cwd, stdio: ["ignore", "pipe", "pipe"] });
      session.child = child;

      let settled = null;
      let stderr = "";

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return; // Non-JSON noise on stdout is ignored rather than fatal.
        }
        this.#onEvent(session, event, (value) => (settled = value));
      });

      child.stderr.on("data", (chunk) => (stderr += chunk));

      child.on("error", (error) => {
        resolve({ error: `Could not run \`${AGY_BIN}\`: ${String(error?.message ?? error)}` });
      });

      child.on("close", (code) => {
        session.child = null;
        if (settled) return resolve(settled);
        if (session.cancelled) return resolve({ response: "" });
        resolve({
          error:
            stderr.trim() ||
            `\`${AGY_BIN}\` exited ${code} without returning a result event.`,
        });
      });
    });
  }

  #onEvent(session, event, settle) {
    switch (event?.event) {
      case "init":
        // Capture the conversation id so the next prompt can continue it.
        if (typeof event.conversation_id === "string") {
          session.conversationId = event.conversation_id;
        }
        return;
      case "step_update":
        // Carries no text — see the header comment. Nothing to forward.
        return;
      case "result": {
        const result = event.result ?? {};
        if (result.status === "ERROR" || result.error) {
          settle({ error: String(result.error || "Antigravity returned an error.") });
          return;
        }
        settle({ response: typeof result.response === "string" ? result.response : "" });
        return;
      }
      default:
        return;
    }
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((connection) => new AntigravityAgent(connection), stream);

log(`ready (bin=${AGY_BIN}, skipPermissions=${SKIP_PERMISSIONS})`);
