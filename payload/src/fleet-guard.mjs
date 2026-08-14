import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HOME = process.env.FLEET_GUARD_STATE_HOME || path.join(os.homedir(), ".paseo-fleet-guard");
const CONFIG_FILE = path.join(HOME, "config.json");
const LOG_FILE = path.join(HOME, "guard.log");
const PID_FILE = path.join(HOME, "guard.pid");
const STATE_FILE = path.join(HOME, "handled-failures.json");
const HANDOFF_DIR = path.join(HOME, "handoffs");

const DEFAULT_CONFIG = {
  enabled: true,
  daemonUrl: "ws://127.0.0.1:6767/ws",
  watchProviderPrefixes: ["claude/", "claude"],
  onlyRootClaudeAgents: true,
  recentTimelineEntries: 100,
  recentContextCharacters: 28000,
  catchUpWindowMinutes: 240,
  continuationPolicy: {
    mode: "return-to-source",
    sameAgentNudges: 1,
    verifyCompletion: true,
    reuseSessions: true,
    retryDelayMinutes: 15,
    maxCycles: 0,
  },
  fallbackOrder: [
    { id: "codex", kind: "paseo", provider: "codex", modeId: "auto-review" },
    { id: "antigravity", kind: "antigravity" },
    { id: "cursor", kind: "paseo", provider: "fleet-cursor", modeId: "agent" },
    { id: "copilot", kind: "paseo", provider: "copilot", modeId: "allow-all" },
  ],
};

const verdictSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["complete", "blocked", "human-needed"] },
    summary: { type: "string" },
    reason: { type: "string" },
    verification: { type: "string" },
  },
  required: ["status", "summary", "reason", "verification"],
  additionalProperties: false,
};

const quotaPatterns = [
  /usage\s*limit/i,
  /rate\s*limit/i,
  /\bquota\b/i,
  /\b429\b/,
  /too many requests/i,
  /limit\s*(?:has been )?reached/i,
  /you(?:'|’)?ve hit.*limit/i,
  /you(?:'|’)?ve reached.*limit/i,
  /exceeded.*limit/i,
  /insufficient[_\s-]*quota/i,
  /(?:session|usage).*reset/i,
  /reset(?:s)?.*(?:at|in)/i,
  /out of .*tokens/i,
  /maximum .*usage/i,
];

await fs.mkdir(HOME, { recursive: true });
await fs.mkdir(HANDOFF_DIR, { recursive: true });
await fs.writeFile(PID_FILE, String(process.pid), "utf8");

let config = DEFAULT_CONFIG;
try {
  const parsed = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  config = {
    ...DEFAULT_CONFIG,
    ...parsed,
    fallbackOrder: parsed.fallbackOrder ?? DEFAULT_CONFIG.fallbackOrder,
    continuationPolicy: { ...DEFAULT_CONFIG.continuationPolicy, ...(parsed.continuationPolicy ?? {}) },
  };
} catch {}

let persistedState = { version: 1, handled: {} };
try {
  const parsed = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  if (parsed?.handled && typeof parsed.handled === "object") persistedState = parsed;
} catch {}

const watched = new Map();
const handling = new Set();
const activeExternalControllers = new Set();
let client = null;
let directorySubscriptionId = null;
let shuttingDown = false;

function stamp() { return new Date().toISOString(); }
async function log(message) {
  try { await fs.appendFile(LOG_FILE, `[${stamp()}] ${message}\n`, "utf8"); } catch {}
}
function safeJson(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}
function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}
function providerOf(agent) {
  return String(agent?.provider ?? agent?.config?.provider ?? agent?.runtimeInfo?.provider ?? "").toLowerCase();
}
function parentOf(agent) {
  return agent?.parentAgentId ?? agent?.parentId ?? agent?.labels?.["paseo.parent-agent-id"] ?? null;
}
function isClaude(agent) {
  const provider = providerOf(agent);
  return config.watchProviderPrefixes.some((prefix) => provider.startsWith(String(prefix).toLowerCase()));
}
function isQuota(value) {
  return quotaPatterns.some((pattern) => pattern.test(String(value ?? "")));
}
function continuationPolicy() {
  const value = config.continuationPolicy ?? {};
  const modes = new Set(["single-pass", "cycle", "return-to-source"]);
  return {
    mode: modes.has(value.mode) ? value.mode : "single-pass",
    sameAgentNudges: Math.max(0, Math.min(5, Number(value.sameAgentNudges) || 0)),
    verifyCompletion: value.verifyCompletion !== false,
    reuseSessions: value.reuseSessions !== false,
    retryDelayMinutes: Math.max(0, Number(value.retryDelayMinutes) || 0),
    maxCycles: Math.max(0, Number(value.maxCycles) || 0),
  };
}
function isPersistentPolicy() {
  return continuationPolicy().mode !== "single-pass";
}
function isRetryableHandledStatus(status) {
  return ["handling", "interrupted", "waiting-retry", "exhausted", "chain-error-recorded"].includes(String(status));
}
async function pauseUntil(timestamp) {
  while (!shuttingDown && Date.now() < timestamp) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(25, timestamp - Date.now()))));
  }
  return !shuttingDown;
}
function entryItem(entry) {
  return entry?.item ?? entry?.event?.item ?? entry?.event ?? null;
}
function entryText(entry) {
  const item = entryItem(entry);
  return item?.text ?? item?.content?.text ?? (typeof item?.content === "string" ? item.content : "");
}
function isDirectQuotaEntry(entry) {
  const item = entryItem(entry);
  const type = String(item?.type ?? "");
  if (type === "assistant_message") return isQuota(entryText(entry));
  if (type === "turn_failed") return isQuota(safeJson(item));
  return false;
}
function textFromTimelineEntry(entry) {
  const item = entryItem(entry);
  const type = String(item?.type ?? "");
  let role = null;
  if (/user_message|user/i.test(type)) role = "USER";
  else if (/assistant_message|assistant/i.test(type)) role = "ASSISTANT";
  else return null;
  const text = entryText(entry);
  return typeof text === "string" && text.trim() ? { role, text: text.trim() } : null;
}
function compactRecentContext(entries, maxChars) {
  const messages = entries.map(textFromTimelineEntry).filter(Boolean);
  let output = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const block = `\n--- ${messages[index].role} ---\n${messages[index].text}\n`;
    if ((block + output).length > maxChars) break;
    output = block + output;
  }
  return output.trim();
}
function parseVerdict(text) {
  const raw = String(text ?? "").trim();
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
  let value = null;
  let parseError = null;
  for (const candidate of candidates) {
    try { value = JSON.parse(candidate); break; }
    catch (error) { parseError = error; }
  }
  if (!value) throw parseError ?? new Error("No JSON verdict found");
  if (!["complete", "blocked", "human-needed"].includes(value?.status)) {
    throw new Error(`Invalid verdict: ${String(text).slice(0, 500)}`);
  }
  return value;
}

async function saveState() {
  const entries = Object.entries(persistedState.handled)
    .sort((a, b) => String(b[1]?.handledAt).localeCompare(String(a[1]?.handledAt)))
    .slice(0, 1000);
  persistedState.handled = Object.fromEntries(entries);
  await fs.writeFile(STATE_FILE, JSON.stringify(persistedState, null, 2) + "\n", "utf8");
}

async function claimFailure(key, rootId, source) {
  const existing = persistedState.handled[key];
  if (existing) {
    if (!isPersistentPolicy() || !isRetryableHandledStatus(existing.status)) return false;
    existing.status = "handling";
    existing.resumedAt = stamp();
    existing.source = source;
    await saveState();
    return true;
  }
  persistedState.handled[key] = { rootAgentId: rootId, handledAt: stamp(), source, status: "handling" };
  await saveState();
  return true;
}

async function finishFailure(key, status) {
  if (!persistedState.handled[key]) return;
  persistedState.handled[key].status = status;
  persistedState.handled[key].finishedAt = stamp();
  await saveState();
}

async function fetchAgentSnapshot(agentId) {
  const result = await client.fetchAgent(agentId);
  return result?.agent ?? null;
}

async function loadTimeline(agentId, projection = "projected") {
  return client.fetchAgentTimeline(agentId, {
    direction: "before",
    limit: Math.min(200, Math.max(20, Number(config.recentTimelineEntries) || 100)),
    projection,
  });
}

async function latestUserRequest(agentId, entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = textFromTimelineEntry(entries[index]);
    if (message?.role === "USER") return message.text;
  }
  try {
    const index = await client.listAgentTimelinePrompts(agentId);
    return index?.prompts?.at(-1)?.preview ?? "";
  } catch {
    return "";
  }
}

function failureKey(agentId, timeline, entry) {
  const seq = entry?.seqEnd ?? entry?.seqStart ?? "unknown";
  const epoch = timeline?.epoch ?? "unknown";
  return `${agentId}:${epoch}:${seq}:${sha1(safeJson(entryItem(entry)))}`;
}

function recentEnough(entry) {
  const timestamp = Date.parse(entry?.timestamp ?? "");
  if (!Number.isFinite(timestamp)) return true;
  return Date.now() - timestamp <= Number(config.catchUpWindowMinutes || 240) * 60_000;
}

function handoffPrompt({ originalRequest, recentContext, previousProvider, previousReason }) {
  return `
You are continuing an existing coding task after ${previousProvider} became unavailable.

IMPORTANT: THIS IS A CONTINUATION, NOT A RESTART.

ACTIVE USER REQUEST:
${originalRequest || "Continue the unfinished task shown in the recent context and current workspace state."}

RECENT RELEVANT CONVERSATION:
${recentContext || "No projected conversation text was available; inspect the repository and existing handoff notes."}

WHY YOU ARE TAKING OVER:
${previousReason}

WORKSPACE CONTINUITY:
- Work in the existing workspace and filesystem exactly as you find them.
- Inspect git status and the current diff before editing.
- Preserve correct work already completed by Claude and its subagents.
- Continue the unfinished work; do not restart the project or repeat completed phases.
- Read only the project instructions, handoff notes, architecture sections, and source files needed now.
- Existing project rules and architecture documents outrank this prompt.

AUTONOMY:
- Proceed through routine inspection, edits, builds, tests, and verification without asking for ceremonial approval.
- Ask the user only when a genuinely important decision or external action cannot be inferred safely.

COMPLETION CONTRACT:
Return the requested structured verdict. Use complete only when the active task is actually finished and verified; blocked when another provider should continue; human-needed only when user input is truly required.
`.trim();
}

async function waitPaseoChild(childId) {
  while (true) {
    if (shuttingDown) throw new Error("Fleet Guard is shutting down with Paseo.");
    const result = await client.waitForFinish(childId, 5000);
    if (result.status === "timeout") continue;
    if (result.status === "permission") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    return result;
  }
}

function providerConfig(worker) {
  const spec = String(worker.provider ?? "");
  const separator = spec.indexOf("/");
  if (separator < 0) return { provider: spec };
  return {
    provider: spec.slice(0, separator),
    model: spec.slice(separator + 1),
  };
}

function interpretPaseoResult(result, sessionId) {
  const combined = `${result?.error ?? ""}\n${result?.lastMessage ?? ""}`;
  if (result.status === "error") {
    return isQuota(combined) ? { outcome: "quota", reason: combined, sessionId } : { outcome: "error", reason: combined, sessionId };
  }
  if (result.status === "idle" && result.lastMessage) {
    try { return { outcome: "verdict", verdict: parseVerdict(result.lastMessage), sessionId }; }
    catch (error) { return { outcome: "error", reason: `Invalid structured verdict: ${error.message}`, sessionId }; }
  }
  return { outcome: "error", reason: `Unexpected child result: ${safeJson(result)}`, sessionId };
}

async function createPaseoChild(root, worker, prompt, onSession) {
  const provider = providerConfig(worker);
  const child = await client.createAgent({
    provider: provider.provider,
    model: provider.model,
    modeId: worker.modeId,
    featureValues: worker.featureValues,
    cwd: root.cwd,
    workspaceId: root.workspaceId,
    callerAgentId: root.id,
    initialPrompt: prompt,
    outputSchema: verdictSchema,
    labels: {
      "fleet-guard": "v3.2.0",
      "fleet-root-agent-id": root.id,
      "fleet-worker": worker.id,
    },
  });
  if (onSession) await onSession(child.id);
  try { await client.updateAgent(child.id, { name: `Fleet Guard · ${worker.id}` }); } catch {}
  await log(`Spawned ${worker.id} child ${child.id} under Claude agent ${root.id}.`);
  return child;
}

async function runPaseoFallback(root, worker, prompt, existingSessionId = null, onSession = null) {
  let child = null;
  if (existingSessionId) {
    try {
      const snapshot = await fetchAgentSnapshot(existingSessionId);
      if (snapshot && snapshot.status !== "closed" && !snapshot.archivedAt) child = snapshot;
    } catch {}
  }

  if (!child) {
    child = await createPaseoChild(root, worker, prompt, onSession);
  } else {
    if (onSession) await onSession(child.id);
    if (child.status !== "running" && child.status !== "initializing") {
      try {
        await client.sendAgentMessage(child.id, prompt);
        await log(`Nudged existing ${worker.id} child ${child.id}.`);
      } catch (error) {
        await log(`Could not resume ${worker.id} child ${child.id}; creating a replacement child. ${String(error?.message ?? error).slice(0, 500)}`);
        child = await createPaseoChild(root, worker, prompt, onSession);
      }
    } else {
      await log(`Reattached to still-running ${worker.id} child ${child.id}.`);
    }
  }

  const result = await waitPaseoChild(child.id);
  return interpretPaseoResult(result, child.id);
}

async function runSourceRetry(root, prompt) {
  const snapshot = await fetchAgentSnapshot(root.id);
  if (!snapshot) return { outcome: "error", reason: "The original Claude task no longer exists.", sessionId: root.id };
  if (snapshot.status !== "running" && snapshot.status !== "initializing") {
    await client.sendAgentMessage(root.id, prompt);
    await log(`Sent a recovery turn to original Claude task ${root.id}.`);
  } else {
    await log(`Original Claude task ${root.id} is already running; waiting for its current turn.`);
  }
  const result = await waitPaseoChild(root.id);
  return interpretPaseoResult(result, root.id);
}

function agyExecutable() { return "agy"; }
function parseOuterJson(text) {
  const value = String(text ?? "").trim();
  try { return JSON.parse(value); } catch {}
  for (const line of value.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line.trim()); } catch {}
  }
  throw new Error("No JSON object found in agy output");
}

async function runAntigravityFallback(root, prompt, existingSessionId = null, onSession = null) {
  const agyPrompt = `${prompt}\n\nANTIGRAVITY FINAL RESPONSE: output only one compact JSON object matching {"status":"complete|blocked|human-needed","summary":"...","reason":"...","verification":"..."}.`;
  const promptFile = path.join(HANDOFF_DIR, `${root.id}-antigravity-prompt.md`);
  await fs.writeFile(promptFile, agyPrompt, "utf8");
  const launchPrompt = `Read the complete Fleet Guard handoff at ${promptFile}. Continue that task in the current workspace. Follow its completion contract and return only the requested JSON verdict.`;
  const args = [
      ...(existingSessionId ? ["--conversation", existingSessionId] : []),
      "-p", launchPrompt,
      "--add-dir", HANDOFF_DIR,
      "--output-format", "json",
      "--json-schema", JSON.stringify(verdictSchema),
      "--dangerously-skip-permissions",
    ];
  const controller = new AbortController();
  activeExternalControllers.add(controller);
  try {
    const result = await execFileAsync(agyExecutable(), args, {
      cwd: root.cwd,
      windowsHide: true,
      shell: false,
      signal: controller.signal,
      timeout: 45 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
      env: process.env,
    });
    const all = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (isQuota(all)) return { outcome: "quota", reason: all, sessionId: existingSessionId };
    const outer = parseOuterJson(result.stdout);
    const sessionId = outer?.conversation_id ?? existingSessionId ?? null;
    if (sessionId && onSession) await onSession(sessionId);
    if (outer?.status !== "SUCCESS") return { outcome: "error", reason: safeJson(outer), sessionId };
    return { outcome: "verdict", verdict: parseVerdict(outer.response), sessionId };
  } catch (error) {
    const text = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? error}`;
    return isQuota(text)
      ? { outcome: "quota", reason: text, sessionId: existingSessionId }
      : { outcome: "error", reason: text, sessionId: existingSessionId };
  } finally {
    activeExternalControllers.delete(controller);
  }
}

async function writeHandoff(rootId, text) {
  await fs.writeFile(path.join(HANDOFF_DIR, `${rootId}.md`), text, "utf8");
}

function nudgePrompt(label, reason) {
  return `
Continue the same active task in this same workspace and session.

Your previous ${label} turn stopped without completing the task:
${reason || "No useful reason was supplied."}

Do not merely summarize or promise future work. Inspect the current filesystem state, continue implementing and testing now, then return the structured Fleet Guard verdict again.
`.trim();
}

function completionAuditPrompt(label, originalRequest, summary) {
  return `
Audit your claim that the shared task is complete before Fleet Guard stops.

ACTIVE REQUEST:
${originalRequest}

YOUR CLAIMED RESULT:
${summary || "No summary was supplied."}

Inspect the actual workspace and diff, run the relevant verification, and compare the result against every material part of the active request. If anything remains, continue the work now. Return complete only after the task is genuinely finished and verified; otherwise return blocked or human-needed using the same structured verdict.
`.trim();
}

function sourceRetryPrompt(originalRequest, handoffPath, previousReason) {
  return `
Fleet Guard is returning this task to its original Claude conversation after a cooldown.

ACTIVE REQUEST:
${originalRequest}

Other providers may have continued the work while Claude was unavailable. Inspect the current workspace and ${handoffPath}; preserve their correct changes and finish the remaining work now.

PREVIOUS CHAIN STATE:
${previousReason}

Do not restart the task. Return only one JSON object matching {"status":"complete|blocked|human-needed","summary":"...","reason":"...","verification":"..."} when this turn ends.
`.trim();
}

async function performFailover(rootId, failureText, handledKey) {
  if (handling.has(rootId)) return;
  handling.add(rootId);
  try {
    const root = await fetchAgentSnapshot(rootId);
    if (!root?.workspaceId || !root?.cwd) {
      throw new Error(`Cannot fail over ${rootId}: workspaceId or cwd is missing.`);
    }

    const projected = await loadTimeline(rootId, "projected");
    const entries = projected?.entries ?? [];
    const detectedRequest = await latestUserRequest(rootId, entries);
    const recentContext = compactRecentContext(entries, Number(config.recentContextCharacters) || 28000);
    const policy = continuationPolicy();
    const record = persistedState.handled[handledKey] ?? { rootAgentId: rootId, handledAt: stamp(), source: "recovered", status: "handling" };
    persistedState.handled[handledKey] = record;
    const chain = record.chain ?? {
      cycle: 0,
      nextWorkerIndex: 0,
      sessions: {},
      previousProvider: "Claude",
      previousReason: "Claude hit a subscription/session usage limit during the active turn.",
      originalRequest: detectedRequest,
    };
    record.chain = chain;
    chain.originalRequest = chain.originalRequest || detectedRequest || "Continue the unfinished task in the shared workspace.";
    chain.sessions ??= {};
    const handoffPath = path.join(HANDOFF_DIR, `${rootId}.md`);
    let note;
    try { note = await fs.readFile(handoffPath, "utf8"); }
    catch { note = `# Fleet Guard handoff for ${rootId}\n\nDetected: ${stamp()}\n\nActive request:\n\n${chain.originalRequest}\n\n`; }

    const persist = async (status = "handling") => {
      record.status = status;
      record.updatedAt = stamp();
      record.chain = chain;
      await saveState();
    };
    const appendResult = async (label, result, phase) => {
      const heading = `Cycle ${Number(chain.cycle) + 1} · ${label}${phase ? ` · ${phase}` : ""}`;
      if (result?.outcome === "verdict") {
        const verdict = result.verdict;
        note += `## ${heading}\n\nStatus: ${verdict.status}\n\nSummary: ${verdict.summary}\n\nVerification: ${verdict.verification}\n\nReason: ${verdict.reason}\n\n`;
      } else {
        note += `## ${heading}\n\n${result?.outcome === "quota" ? "Provider quota/session limit reached." : "Provider failed without proving completion."}\n\n${String(result?.reason ?? "No diagnostic text was returned.").slice(0, 4000)}\n\n`;
      }
      await writeHandoff(rootId, note);
    };
    const executeWorker = async (worker, prompt) => {
      const existingSession = chain.sessions[worker.id] ?? null;
      const onSession = async (sessionId) => {
        chain.sessions[worker.id] = sessionId;
        await persist("handling");
      };
      try {
        let result;
        if (worker.kind === "antigravity") {
          await log(`Starting or resuming external Antigravity for root ${rootId}; progress is recorded in ${HANDOFF_DIR}.`);
          result = await runAntigravityFallback(root, prompt, existingSession, onSession);
        } else {
          await log(`Starting or resuming Paseo fallback ${worker.provider} for root ${rootId}.`);
          result = await runPaseoFallback(root, worker, prompt, existingSession, onSession);
        }
        if (result?.sessionId) chain.sessions[worker.id] = result.sessionId;
        return result;
      } catch (error) {
        const reason = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.stack ?? error}`;
        await log(`${worker.id} fallback threw an exception for root ${rootId}; continuing under the configured policy. ${String(error?.message ?? error).slice(0, 1000)}`);
        return isQuota(reason) ? { outcome: "quota", reason, sessionId: existingSession } : { outcome: "error", reason, sessionId: existingSession };
      }
    };
    const continueAgent = async (label, firstPrompt, run) => {
      let result = await run(firstPrompt);
      let nudges = 0;
      let completionAudited = false;
      let phase = "turn";
      while (!shuttingDown) {
        await appendResult(label, result, phase);
        if (result?.outcome !== "verdict") return result;
        const verdict = result.verdict;
        if (verdict.status === "complete" && policy.verifyCompletion && !completionAudited) {
          completionAudited = true;
          phase = "completion audit";
          result = await run(completionAuditPrompt(label, chain.originalRequest, verdict.summary));
          continue;
        }
        if (verdict.status === "blocked" && nudges < policy.sameAgentNudges) {
          nudges += 1;
          completionAudited = false;
          phase = `nudge ${nudges}`;
          result = await run(nudgePrompt(label, verdict.reason));
          continue;
        }
        return result;
      }
      return { outcome: "error", reason: "Fleet Guard stopped with Paseo." };
    };
    const finishIfTerminal = async (label, result) => {
      if (result?.outcome !== "verdict") return false;
      if (result.verdict.status === "complete") {
        await finishFailure(handledKey, "complete");
        await log(`${label} completed and verified the active request for root ${rootId}. Guard is dormant again.`);
        return true;
      }
      if (result.verdict.status === "human-needed") {
        await finishFailure(handledKey, "human-needed");
        await log(`${label} needs human input for root ${rootId}. Guard will not guess or continue looping.`);
        return true;
      }
      return false;
    };
    const rememberReason = (label, result) => {
      chain.previousProvider = label;
      if (result?.outcome === "verdict") chain.previousReason = `${label} reported blocked: ${result.verdict.reason}`;
      else if (result?.outcome === "quota") chain.previousReason = `${label} hit a provider/session usage limit.`;
      else chain.previousReason = `${label} failed without proving completion. Inspect the workspace and continue cautiously.`;
    };

    await persist("handling");
    await log(`Quota failure confirmed for Claude agent ${rootId} (${root.title ?? rootId}). Continuation mode=${policy.mode}, nudges=${policy.sameAgentNudges}, reuseSessions=${policy.reuseSessions}.`);

    while (!shuttingDown) {
      const retryAt = Date.parse(chain.nextAttemptAt ?? "");
      if (Number.isFinite(retryAt) && retryAt > Date.now()) {
        await persist("waiting-retry");
        await log(`Cycle ${Number(chain.cycle) + 1} for root ${rootId} is waiting until ${new Date(retryAt).toISOString()}.`);
        if (!(await pauseUntil(retryAt))) break;
        delete chain.nextAttemptAt;
        await persist("handling");
      }

      if (policy.mode === "return-to-source" && Number(chain.cycle) > 0 && chain.sourceAttemptedCycle !== chain.cycle) {
        const label = "Claude (original task)";
        const result = await continueAgent(label, sourceRetryPrompt(chain.originalRequest, handoffPath, chain.previousReason), (prompt) => runSourceRetry(root, prompt));
        chain.sourceAttemptedCycle = chain.cycle;
        await persist("handling");
        if (await finishIfTerminal(label, result)) return;
        rememberReason(label, result);
      }

      for (let index = Number(chain.nextWorkerIndex) || 0; index < config.fallbackOrder.length; index += 1) {
        if (shuttingDown) break;
        const worker = config.fallbackOrder[index];
        chain.nextWorkerIndex = index;
        await persist("handling");
        const prompt = handoffPrompt({
          originalRequest: chain.originalRequest,
          recentContext,
          previousProvider: chain.previousProvider,
          previousReason: chain.previousReason,
        });
        const result = await continueAgent(worker.id, prompt, (nextPrompt) => executeWorker(worker, nextPrompt));
        chain.nextWorkerIndex = index + 1;
        await persist("handling");
        if (await finishIfTerminal(worker.id, result)) return;
        rememberReason(worker.id, result);
      }

      if (shuttingDown) break;
      if (policy.mode === "single-pass") {
        await finishFailure(handledKey, "exhausted");
        await log(`All configured fallback providers completed one pass for root ${rootId}; one-pass policy is stopping.`);
        return;
      }

      chain.cycle = Number(chain.cycle) + 1;
      chain.nextWorkerIndex = 0;
      if (!policy.reuseSessions) chain.sessions = {};
      if (policy.maxCycles > 0 && chain.cycle >= policy.maxCycles) {
        await finishFailure(handledKey, "exhausted");
        await log(`Continuation policy reached its ${policy.maxCycles}-cycle limit for root ${rootId}.`);
        return;
      }
      const delayMs = policy.retryDelayMinutes * 60_000;
      chain.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
      await persist("waiting-retry");
      await log(`Fallback cycle ${chain.cycle} ended for root ${rootId}. The same sessions will be retried in ${policy.retryDelayMinutes} minute(s); Paseo shutdown still stops Guard.`);
    }

    await persist("interrupted");
    await log(`Continuation for root ${rootId} paused because Fleet Guard is shutting down with Paseo.`);
  } catch (error) {
    if (shuttingDown || isPersistentPolicy()) {
      const record = persistedState.handled[handledKey];
      if (record) {
        record.status = "interrupted";
        record.lastError = String(error?.stack ?? error).slice(0, 4000);
        await saveState();
      }
    } else {
      delete persistedState.handled[handledKey];
      await saveState();
    }
    await log(`Failover exception for ${rootId}: ${error?.stack ?? error}`);
  } finally {
    handling.delete(rootId);
  }
}

async function detectAndHandleLatestQuota(rootId, source) {
  if (handling.has(rootId)) return false;
  const timeline = await loadTimeline(rootId, "canonical");
  const entries = timeline?.entries ?? [];
  const candidate = [...entries].reverse().find(isDirectQuotaEntry);
  if (!candidate || !recentEnough(candidate)) return false;

  const latestDirectAssistant = [...entries].reverse().find((entry) => String(entryItem(entry)?.type) === "assistant_message");
  if (latestDirectAssistant && latestDirectAssistant !== candidate && !isDirectQuotaEntry(latestDirectAssistant)) return false;

  const key = failureKey(rootId, timeline, candidate);
  if (!(await claimFailure(key, rootId, source))) return false;
  await log(`${source === "startup-catchup" ? "Found an already-recorded" : "Found a live"} Claude quota failure for ${rootId} at seq ${candidate.seqEnd ?? candidate.seqStart ?? "unknown"}; starting handoff.`);
  void performFailover(rootId, safeJson(candidate), key);
  return true;
}

async function refreshTimelineSubscription() {
  await client.setAgentTimelineSubscription([...watched.keys()]);
}

async function attachToClaude(agent) {
  if (!agent?.id || watched.has(agent.id) || !isClaude(agent)) return;
  if (config.onlyRootClaudeAgents && parentOf(agent)) return;
  if (agent.archivedAt) return;
  watched.set(agent.id, agent);
  await refreshTimelineSubscription();
  await log(`Watching Claude agent ${agent.id} (${agent.title ?? agent.id}), workspace=${agent.workspaceId ?? "unknown"}.`);
  void detectAndHandleLatestQuota(agent.id, "startup-catchup").catch((error) => log(`Catch-up scan failed for ${agent.id}: ${error?.stack ?? error}`));
}

async function handleDaemonEvent(event) {
  try {
    if (event.type === "agent_update") {
      const snapshot = await fetchAgentSnapshot(event.agentId);
      if (snapshot) await attachToClaude(snapshot);
      return;
    }
    if (event.type === "agent_deleted") {
      watched.delete(event.agentId);
      await refreshTimelineSubscription();
      return;
    }
    if (event.type === "agent_stream" && watched.has(event.agentId)) {
      const payload = event.event;
      if (String(payload?.type) === "turn_failed" || isDirectQuotaEntry({ item: payload })) {
        await detectAndHandleLatestQuota(event.agentId, "live-timeline");
      }
    }
  } catch (error) {
    await log(`Daemon event handler error: ${error?.stack ?? error}`);
  }
}

async function connectAndWatch() {
  const candidate = new DaemonClient({
    url: config.daemonUrl,
    clientId: `fleet-guard-v3.2.0-${process.pid}`,
    clientType: "cli",
    reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 5000 },
  });
  await candidate.connect();
  client = candidate;
  client.subscribe(handleDaemonEvent);
  directorySubscriptionId = `fleet-guard-v3.2.0-${process.pid}`;
  const page = await client.fetchAgents({
    scope: "active",
    filter: { includeArchived: false },
    page: { limit: 200 },
    subscribe: { subscriptionId: directorySubscriptionId },
  });
  for (const entry of page.entries ?? []) await attachToClaude(entry.agent);
  await log(`Connected to Paseo daemon at ${config.daemonUrl}.`);
}

async function cleanup() {
  try { if (client) await client.setAgentTimelineSubscription([]); } catch {}
  try { await client?.close(); } catch {}
  try { await fs.unlink(PID_FILE); } catch {}
}

function beginShutdown() {
  shuttingDown = true;
  for (const controller of activeExternalControllers) {
    try { controller.abort(); } catch {}
  }
}

async function main() {
  await log(`Fleet Guard v3.2.0 starting in Paseo-scoped mode. pid=${process.pid}`);
  if (!config.enabled) {
    await log("Guard is disabled in config.json; exiting.");
    await cleanup();
    return;
  }

  const startupDeadline = Date.now() + 45_000;
  while (Date.now() < startupDeadline) {
    try { await connectAndWatch(); break; }
    catch (error) {
      try { await client?.close(); } catch {}
      client = null;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  if (!client) {
    await log("Paseo daemon did not appear within 45 seconds. Fleet Guard exiting.");
    await cleanup();
    return;
  }

  await log("Fleet Guard attached to Paseo. It will exit when the Paseo daemon is gone.");
  let daemonMissingSince = null;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      await client.ping({ timeoutMs: 3000 });
      if (daemonMissingSince !== null) {
        await log("Paseo daemon connection recovered during shutdown grace period.");
        daemonMissingSince = null;
      }
    } catch {
      if (daemonMissingSince === null) {
        daemonMissingSince = Date.now();
        await log("Paseo daemon became unavailable; starting 20-second shutdown grace period.");
      }
      if (Date.now() - daemonMissingSince >= 20_000) {
        await log("Paseo daemon remained unavailable for 20 seconds. Fleet Guard exiting completely.");
        beginShutdown();
        break;
      }
    }
  }
  await cleanup();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    await log(`Fleet Guard received ${signal}.`);
    beginShutdown();
    await cleanup();
    process.exit(0);
  });
}

export function __setFleetGuardTestRuntime(values = {}) {
  if (values.client) client = values.client;
  if (values.config) config = { ...DEFAULT_CONFIG, ...values.config, continuationPolicy: { ...DEFAULT_CONFIG.continuationPolicy, ...(values.config.continuationPolicy ?? {}) } };
  if (values.state) persistedState = values.state;
  shuttingDown = false;
  handling.clear();
}

export function __getFleetGuardTestState() {
  return persistedState;
}

export { continuationPolicy, performFailover };

if (process.env.FLEET_GUARD_SELF_TEST !== "1") {
  main().catch(async (error) => {
    await log(`Fatal Fleet Guard error: ${error?.stack ?? error}`);
    await cleanup();
    process.exit(1);
  });
}
