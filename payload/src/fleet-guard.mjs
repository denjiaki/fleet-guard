import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HOME = process.env.FLEET_GUARD_STATE_HOME || path.join(os.homedir(), ".paseo-fleet-guard");
const CONFIG_FILE = path.join(HOME, "config.json");
const LOG_FILE = path.join(HOME, "guard.log");
const PID_FILE = path.join(HOME, "guard.pid");
const STATE_FILE = path.join(HOME, "handled-failures.json");
const HANDOFF_DIR = path.join(HOME, "handoffs");
const BRIDGE_TOKEN_FILE = path.join(HOME, "bridge-token");
// @fleet:constants
const BRIDGE_PORT = 47641;
// Reported to the Paseo daemon so it exposes every provider, not just the
// legacy {claude, codex, opencode} set. See connectAndWatch.
const FLEET_CLIENT_APP_VERSION = "0.4.0";
const CATALOG_TTL_MS = 60_000;
// Models whose subscription allowance runs out separately from the rest of the
// plan. Only these can usefully hand off to another model from the same
// provider; everything else exhausts the whole plan at once.
const SUBSCRIPTION_CAPPED_MODEL_PATTERNS = [/(^|[-_/])fable/i];

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
// @fleet:autohandoff-default
  council: {
    enabled: true,
    members: [],
    maxContextCharacters: 32000,
  },
  // Automatic handoff on quota exhaustion. Separate from `enabled`, which
  // decides whether Fleet Supervisor runs at all: this can be switched off from
  // Paseo's toolbar mid-session and back on again, and leaves Council reviews
  // — a manual action — working either way.
  autoHandoff: true,
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

const councilVerdictSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["summary", "strengths", "risks", "recommendations", "confidence"],
  additionalProperties: false,
};

const builtInBehaviorPrompts = {
  "reporting-progress": "Prioritize an accurate progress report. Reconcile claims with the workspace, state what is complete, what remains, and what was verified.",
  "bug-checking": "Act as the dedicated bug checker. Inspect the existing work for defects, regressions, edge cases, unsafe assumptions, and incomplete error handling before making any completion claim.",
  qa: "Act as the dedicated QA engineer. Derive acceptance criteria from the user request, exercise the relevant behavior, and report reproducible evidence for every pass or failure.",
  skepticism: "Act as a skeptical reviewer. Challenge unsupported claims and the current approach, look for counterexamples, and require concrete evidence before accepting completion.",
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
// @fleet:pidfile-early
await fs.mkdir(HANDOFF_DIR, { recursive: true });
// The pid file is written once the bridge port is won (see main), not here:
// an instance that loses the port must not overwrite the winner's pid.

let config = DEFAULT_CONFIG;
try {
  const parsed = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  config = {
    ...DEFAULT_CONFIG,
    ...parsed,
    fallbackOrder: parsed.fallbackOrder ?? DEFAULT_CONFIG.fallbackOrder,
    continuationPolicy: { ...DEFAULT_CONFIG.continuationPolicy, ...(parsed.continuationPolicy ?? {}) },
    council: { ...DEFAULT_CONFIG.council, ...(parsed.council ?? {}) },
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
let bridgeServer = null;
// @fleet:catalog-state
let bridgeToken = null;
let catalogCache = null;
const activeCouncilReviews = new Map();

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

function workerSystemPrompt(worker) {
  const behavior = String(worker?.useFor ?? "").trim().toLowerCase();
  const custom = String(worker?.systemPrompt ?? "").trim();
  const builtIn = builtInBehaviorPrompts[behavior] ?? "";
  const directive = behavior === "custom" ? custom : [builtIn, custom].filter(Boolean).join("\n\n");
  if (!directive) return undefined;
  return `FLEET SUPERVISOR MODEL-SPECIFIC DIRECTIVE (highest priority for this delegated session):\n${directive}`;
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

// @fleet:directive-helpers
/**
 * Providers that actually apply `AgentSessionConfig.systemPrompt`.
 *
 * ACP-backed providers — Cursor, Copilot, Gemini and every entry derived from
 * the ACP catalog — accept the field and silently drop it: no error, no
 * warning, no directive. For those the role has to ride in the prompt instead,
 * or model-specific roles are a no-op exactly where the user configured one.
 */
const SYSTEM_PROMPT_PROVIDERS = new Set(["claude", "codex", "opencode", "pi", "omp"]);

function honorsSystemPrompt(providerId) {
  return SYSTEM_PROMPT_PROVIDERS.has(String(providerId ?? ""));
}

/**
 * Route a highest-priority directive to whichever channel the provider honours.
 * Returns the `systemPrompt` and `initialPrompt` to hand to createAgent.
 */
function applyDirective(providerId, directive, prompt) {
  const text = String(directive ?? "").trim();
  if (!text) return { systemPrompt: undefined, prompt };
  if (honorsSystemPrompt(providerId)) return { systemPrompt: text, prompt };
  return { systemPrompt: undefined, prompt: `${text}\n\n---\n\n${prompt}` };
}

async function createPaseoChild(root, worker, prompt, onSession) {
// @fleet:worker-directive
  const provider = providerConfig(worker);
  const directive = applyDirective(provider.provider, workerSystemPrompt(worker), prompt);
  const child = await client.createAgent({
    provider: provider.provider,
    model: provider.model,
    modeId: worker.modeId,
    featureValues: worker.featureValues,
    systemPrompt: directive.systemPrompt,
    cwd: root.cwd,
    workspaceId: root.workspaceId,
    callerAgentId: root.id,
    initialPrompt: directive.prompt,
    outputSchema: verdictSchema,
    labels: {
      "fleet-guard": "v4.0.0-beta.1",
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

function councilMembers() {
  const configured = Array.isArray(config.council?.members) ? config.council.members : [];
  if (configured.length > 0) return configured.filter((member) => member?.provider);
  return config.fallbackOrder
    .filter((worker) => worker?.kind === "paseo" && worker?.provider)
    .slice(0, 3)
    .map((worker) => ({
      id: worker.id,
      provider: worker.provider,
      modeId: worker.modeId,
      thinkingOptionId: worker.thinkingOptionId,
      lens: "skepticism",
    }));
}

function councilSystemPrompt(member) {
  const lens = String(member?.lens ?? "skepticism").trim().toLowerCase();
  const lensPrompt = builtInBehaviorPrompts[lens] ?? builtInBehaviorPrompts.skepticism;
  const custom = String(member?.systemPrompt ?? "").trim();
  return `
FLEET SUPERVISOR COUNCIL SESSION

You are an independent reviewer, not the implementation agent. Do not edit files, execute the task,
or continue the shared job. Analyze only the supplied context/message and any attachments.

REVIEW LENS:
${[lensPrompt, custom].filter(Boolean).join("\n\n")}

Return the requested structured review. Identify concrete strengths, risks, and actionable
recommendations. Distinguish facts from inference and say when evidence is missing.
`.trim();
}

function councilPrompt(payload, context) {
  if (payload.scope === "message") {
    return `
Review this specific ${payload.role ?? "conversation"} message independently.

MESSAGE:
${String(payload.text ?? "").trim() || "(The selected message contains only attachments.)"}

ATTACHMENTS:
${Array.isArray(payload.attachments) && payload.attachments.length > 0 ? safeJson(payload.attachments) : "None"}

Do not continue the task. Produce only your council review.
`.trim();
  }
  return `
Review the latest context of this active task independently.

LATEST CONTEXT:
${context || "No projected text was available. Base the review on the workspace state you can inspect without changing it."}

Do not continue the task. Produce only your council review.
`.trim();
}

// @fleet:council-directive
async function createCouncilChild(root, member, prompt, attachments, images, reviewId) {
  const provider = providerConfig(member);
  const councilDirective = applyDirective(provider.provider, councilSystemPrompt(member), prompt);
  const child = await client.createAgent({
    provider: provider.provider,
    model: provider.model,
// @fleet:council-child
    modeId: member.modeId,
    thinkingOptionId: member.thinkingOptionId,
    featureValues: member.featureValues,
    systemPrompt: councilDirective.systemPrompt,
    cwd: root.cwd,
    workspaceId: root.workspaceId,
    callerAgentId: root.id,
    initialPrompt: councilDirective.prompt,
    attachments,
    images,
    outputSchema: councilVerdictSchema,
    labels: {
      "fleet-guard": "v4.0.0",
      "fleet-council-review-id": reviewId,
      "fleet-council-member": String(member.id ?? member.provider),
      "fleet-root-agent-id": root.id,
    },
  });
  const label = String(member.id ?? member.provider);
  try { await client.updateAgent(child.id, { name: `Fleet Council · ${label}` }); } catch {}
  const result = await waitPaseoChild(child.id);
  if (result.status !== "idle" || !result.lastMessage) {
    throw new Error(`${label} council member failed: ${result.error ?? result.status}`);
  }
  return { member: label, provider: member.provider, response: result.lastMessage, childId: child.id };
}

async function materializeCouncilImages(metadata) {
  if (!Array.isArray(metadata)) return undefined;
  const images = [];
  for (const image of metadata.slice(0, 8)) {
    const storageKey = String(image?.storageKey ?? "");
    const mimeType = String(image?.mimeType ?? "");
    if (!storageKey || !mimeType.startsWith("image/") || image?.storageType === "web-indexeddb") continue;
    try {
      const bytes = await fs.readFile(storageKey);
      if (bytes.length <= 10 * 1024 * 1024) images.push({ data: bytes.toString("base64"), mimeType });
    } catch {}
  }
  return images.length > 0 ? images : undefined;
}

function councilDigestPrompt(reviewId, payload, reviews) {
  return `
Fleet Supervisor council review ${reviewId} has finished. You are the original task agent.

The council was asked to review ${payload.scope === "message" ? "a specific conversation message" : "the latest task context"}. The reviewers were explicitly told not to continue or modify the task.

INDEPENDENT REVIEWS:
${reviews.map((review) => `\n### ${review.member} (${review.provider})\n${review.response}`).join("\n")}

Create a concise digest for the user in this original conversation. Reconcile agreement and
disagreement, call out the most important risks and strengths, and recommend next steps. Do not
silently act on the recommendations unless the user's active request already authorizes that work.
`.trim();
}

async function runCouncilReview(payload, reviewId) {
  const root = await fetchAgentSnapshot(payload.agentId);
  if (!root?.workspaceId || !root?.cwd) throw new Error("The original task is missing its workspace context.");
  const members = councilMembers();
  if (config.council?.enabled === false) throw new Error("Council reviews are disabled in Fleet Supervisor settings.");
  if (members.length === 0) throw new Error("No council models are configured.");

  let context = "";
  if (payload.scope === "latest-context") {
    const timeline = await loadTimeline(root.id, "projected");
    context = compactRecentContext(
      timeline?.entries ?? [],
      Number(config.council?.maxContextCharacters) || 32000,
    );
  }
  const prompt = councilPrompt(payload, context);
  const attachments = payload.scope === "message" && Array.isArray(payload.attachments)
    ? payload.attachments
    : undefined;
  const images = payload.scope === "message" ? await materializeCouncilImages(payload.images) : undefined;
  await log(`Council ${reviewId} started for ${root.id} with ${members.length} configured model(s).`);
  const settled = await Promise.allSettled(
    members.map((member) => createCouncilChild(root, member, prompt, attachments, images, reviewId)),
  );
  const reviews = settled.flatMap((result, index) =>
    result.status === "fulfilled"
      ? [result.value]
      : [{
          member: String(members[index]?.id ?? members[index]?.provider ?? `member-${index + 1}`),
          provider: String(members[index]?.provider ?? "unknown"),
          response: `Reviewer failed: ${String(result.reason?.message ?? result.reason)}`,
          childId: null,
        }],
  );
  const reportPath = path.join(HANDOFF_DIR, `council-${reviewId}.md`);
  const digestPrompt = councilDigestPrompt(reviewId, payload, reviews);
  await fs.writeFile(reportPath, `# Fleet Council ${reviewId}\n\n${digestPrompt}\n`, "utf8");
  await client.sendAgentMessage(root.id, digestPrompt);
  await log(`Council ${reviewId} returned ${reviews.length} review(s) to original task ${root.id}.`);
  return { reviewId, rootAgentId: root.id, reviews, reportPath };
}

async function ensureBridgeToken() {
  try {
    const existing = (await fs.readFile(BRIDGE_TOKEN_FILE, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const token = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(BRIDGE_TOKEN_FILE, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

// @fleet:catalog-helpers
/**
 * True when a model draws on its own capped allowance rather than the shared
 * plan. Fable is the current case: it has a separate weekly limit, so once it
 * is exhausted another Claude model is still usable.
 */
function isSubscriptionCappedModel(provider, modelId) {
  if (String(provider ?? "") !== "claude") return false;
  return SUBSCRIPTION_CAPPED_MODEL_PATTERNS.some((pattern) => pattern.test(String(modelId ?? "")));
}

/**
 * Providers and their models as the daemon currently sees them. One provider
 * snapshot already carries every model, so this avoids a per-provider probe
 * (cold ACP discovery can take up to two minutes per provider).
 */
async function providerCatalog(force = false) {
  if (!client) throw new Error("Fleet Supervisor is not connected to Paseo.");
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.value;
  }
  const snapshot = await client.getProvidersSnapshot({});
  const providers = (snapshot?.entries ?? [])
    .map((entry) => {
      const id = String(entry?.provider ?? "");
      return {
        id,
        label: String(entry?.label ?? id),
        description: String(entry?.description ?? ""),
        status: String(entry?.status ?? "unknown"),
        enabled: entry?.enabled !== false,
        defaultModeId: entry?.defaultModeId ?? null,
        modes: (entry?.modes ?? []).map((mode) => ({
          id: String(mode?.id ?? ""),
          label: String(mode?.label ?? mode?.id ?? ""),
        })),
        // Paseo marks compatibility aliases (e.g. "claude-fable-5[1m]") as
        // non-selectable so old saved preferences keep resolving; its own
        // picker hides them, and so must this one, or the same model shows twice.
        models: (entry?.models ?? [])
          .filter((model) => model?.isSelectable !== false)
          .map((model) => ({
            id: String(model?.id ?? ""),
            label: String(model?.label ?? model?.id ?? ""),
            description: String(model?.description ?? ""),
            isDefault: model?.isDefault === true,
            subscriptionCapped: isSubscriptionCappedModel(id, model?.id),
          })),
      };
    })
    .filter((provider) => provider.id);
  const value = { providers, generatedAt: new Date().toISOString() };
  // Right after the daemon starts, providers report "loading" with empty model
  // lists. Caching that would leave the settings surface showing no models for
  // a full minute; a snapshot with a provider still loading is not worth
  // remembering, so the next request asks again.
  const settled = providers.every((provider) => provider.status !== "loading");
  catalogCache = settled ? { at: Date.now(), value } : null;
  return value;
}

/**
 * Apply the same shape and defaults the loader uses, so a config written by the
 * settings surface reads back identically on the next start.
 */
function normalizeConfig(parsed) {
  const value = parsed && typeof parsed === "object" ? parsed : {};
  return {
    ...DEFAULT_CONFIG,
    ...value,
    fallbackOrder: Array.isArray(value.fallbackOrder) ? value.fallbackOrder : DEFAULT_CONFIG.fallbackOrder,
    continuationPolicy: { ...DEFAULT_CONFIG.continuationPolicy, ...(value.continuationPolicy ?? {}) },
    council: { ...DEFAULT_CONFIG.council, ...(value.council ?? {}) },
  };
}

async function saveConfig(next) {
  const merged = normalizeConfig(next);
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  config = merged;
  await log("Fleet Supervisor configuration updated from the settings surface.");
  return merged;
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) {
        reject(new Error("Council request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Council request is not valid JSON.")); }
    });
    request.on("error", reject);
  });
}

// @fleet:cors
/**
 * Origins the Paseo renderer can legitimately present. Electron serves the app
 * from a custom scheme or, in development, a loopback dev server. Nothing else
 * is accepted, so a hostile web page cannot read bridge responses.
 */
const RENDERER_ORIGIN_PATTERNS = [
  /^paseo:\/\//i,
  /^file:\/\//i,
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
  /^https?:\/\/\[::1\](?::\d+)?$/i,
];

function isRendererOrigin(origin) {
  const value = String(origin ?? "").trim();
  if (!value || value === "null") return false;
  return RENDERER_ORIGIN_PATTERNS.some((pattern) => pattern.test(value));
}

function applyCorsHeaders(request, response) {
  const origin = request.headers.origin;
  if (!isRendererOrigin(origin)) return false;
  response.setHeader("Access-Control-Allow-Origin", String(origin));
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  response.setHeader("Access-Control-Max-Age", "600");
  return true;
}

function bridgeAuthorized(request) {
  const candidate = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!bridgeToken || candidate.length !== bridgeToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(bridgeToken));
}

function sendBridgeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

// @fleet:handshake
async function handleBridgeRequest(request, response) {
  const corsAllowed = applyCorsHeaders(request, response);
  if (request.method === "OPTIONS") {
    response.writeHead(corsAllowed ? 204 : 403).end();
    return;
  }
  // Require JSON on write routes. A browser can send form-encoded or plain-text
  // cross-origin without a preflight; demanding JSON forces every cross-origin
  // write through the preflight above, which only succeeds for the renderer.
  if (
    (request.method === "POST" || request.method === "PUT") &&
    !String(request.headers["content-type"] ?? "").toLowerCase().includes("application/json")
  ) {
    sendBridgeJson(response, 415, { error: "Fleet Supervisor bridge requires application/json." });
    return;
  }
  // Buttons injected into Paseo's renderer cannot read the token file, so they
  // collect it here. A native local process could spoof Origin, but it could
  // equally read ~/.paseo-fleet-guard/bridge-token, so this does not widen the
  // attack surface; it only closes the gap for the browser, where the Origin
  // check is enforced by the browser itself.
  if (request.method === "GET" && String(request.url ?? "").split("?")[0] === "/v1/handshake") {
    if (!corsAllowed && !bridgeAuthorized(request)) {
      sendBridgeJson(response, 403, { error: "Fleet Supervisor bridge handshake refused." });
      return;
    }
    sendBridgeJson(response, 200, { token: bridgeToken });
    return;
  }
  if (!bridgeAuthorized(request)) {
    sendBridgeJson(response, 401, { error: "Fleet Supervisor bridge authorization failed." });
    return;
  }
// @fleet:router
  const route = String(request.url ?? "").split("?")[0];
  if (request.method === "GET" && route === "/v1/status") {
// @fleet:status
    sendBridgeJson(response, 200, {
      ready: Boolean(client),
      councilMembers: councilMembers().length,
      autoHandoff: config.autoHandoff !== false,
      councilEnabled: config.council?.enabled !== false,
      // @fleet:status-fallbacks
      fallbacks: config.fallbackOrder.map((worker) => ({ id: String(worker?.id ?? ""), provider: String(worker?.provider ?? worker?.kind ?? "") })),
    });
    return;
  }
  if (request.method === "GET" && route === "/v1/catalog") {
    try {
      sendBridgeJson(response, 200, await providerCatalog(request.url?.includes("refresh=1")));
    } catch (error) {
      sendBridgeJson(response, 503, { error: String(error?.message ?? error) });
    }
    return;
  }
// @fleet:autohandoff-route
  if (request.method === "POST" && route === "/v1/auto-handoff") {
    try {
      const body = await readRequestJson(request);
      const next = body?.enabled !== false;
      await saveConfig({ ...config, autoHandoff: next });
      await log(`Automatic handoff switched ${next ? "on" : "off"} from Paseo.`);
      sendBridgeJson(response, 200, { autoHandoff: next });
    } catch (error) {
      sendBridgeJson(response, 400, { error: String(error?.message ?? error) });
    }
    return;
  }
  // @fleet:manual-route
  if (request.method === "POST" && route === "/v1/handoff") {
    try {
      const body = await readRequestJson(request);
      const started = await startManualHandoff(body);
      sendBridgeJson(response, 202, {
        status: "started",
        ...started,
        message: `Handing the task to ${started.worker}. Progress will appear as a child task in Paseo.`,
      });
    } catch (error) {
      sendBridgeJson(response, 400, { error: String(error?.message ?? error) });
    }
    return;
  }
  if (request.method === "GET" && route === "/v1/config") {
    sendBridgeJson(response, 200, { config });
    return;
  }
  if (request.method === "PUT" && route === "/v1/config") {
    try {
      const body = await readRequestJson(request);
      sendBridgeJson(response, 200, { config: await saveConfig(body?.config ?? body) });
    } catch (error) {
      sendBridgeJson(response, 400, { error: String(error?.message ?? error) });
    }
    return;
  }
  if (request.method !== "POST" || route !== "/v1/council") {
    sendBridgeJson(response, 404, { error: "Not found." });
    return;
  }
  try {
    const payload = await readRequestJson(request);
    if (!payload || !["latest-context", "message"].includes(payload.scope) || !String(payload.agentId ?? "").trim()) {
      sendBridgeJson(response, 400, { error: "The council request is missing its scope or task." });
      return;
    }
    const reviewId = crypto.randomUUID();
    const running = runCouncilReview(payload, reviewId)
      .catch(async (error) => {
        await log(`Council ${reviewId} failed: ${error?.stack ?? error}`);
        try {
          await client.sendAgentMessage(
            payload.agentId,
            `Fleet Supervisor could not complete Council review ${reviewId}: ${String(error?.message ?? error)}`,
          );
        } catch {}
      })
      .finally(() => activeCouncilReviews.delete(reviewId));
    activeCouncilReviews.set(reviewId, running);
    sendBridgeJson(response, 202, {
      status: "queued",
      reviewId,
      message: `Council review started with ${councilMembers().length} model(s). Conclusions will return here.`,
    });
  } catch (error) {
    sendBridgeJson(response, 400, { error: String(error?.message ?? error) });
  }
}

async function startBridge() {
  bridgeToken = await ensureBridgeToken();
  bridgeServer = http.createServer((request, response) => {
    void handleBridgeRequest(request, response).catch((error) => {
      if (!response.headersSent) sendBridgeJson(response, 500, { error: String(error?.message ?? error) });
      else response.end();
    });
  });
  await new Promise((resolve, reject) => {
    bridgeServer.once("error", reject);
    bridgeServer.listen(BRIDGE_PORT, "127.0.0.1", resolve);
  });
  await log(`Fleet Supervisor bridge is ready on 127.0.0.1:${BRIDGE_PORT}.`);
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

async function runAntigravityFallback(root, worker, prompt, existingSessionId = null, onSession = null) {
  const agyPrompt = `${prompt}\n\nANTIGRAVITY FINAL RESPONSE: output only one compact JSON object matching {"status":"complete|blocked|human-needed","summary":"...","reason":"...","verification":"..."}.`;
  const promptFile = path.join(HANDOFF_DIR, `${root.id}-antigravity-prompt.md`);
  await fs.writeFile(promptFile, agyPrompt, "utf8");
  const launchPrompt = `Read the complete Fleet Guard handoff at ${promptFile}. Continue that task in the current workspace. Follow its completion contract and return only the requested JSON verdict.`;
  const args = [
      ...(existingSessionId ? ["--conversation", existingSessionId] : []),
      ...(worker?.model ? ["--model", String(worker.model)] : []),
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
          result = await runAntigravityFallback(root, worker, prompt, existingSession, onSession);
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
    // @fleet:logline
    await log(`${record.source === "manual" ? "Manual handoff started" : "Quota failure confirmed"} for ${root.provider ?? "Claude"} agent ${rootId} (${root.title ?? rootId}). Continuation mode=${policy.mode}, nudges=${policy.sameAgentNudges}, reuseSessions=${policy.reuseSessions}.`);

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

// @fleet:autohandoff-guard
// @fleet:manual-handoff
/**
 * Hand a task to the fleet on demand, without waiting for a session limit.
 *
 * Reuses performFailover unchanged: it already derives the request and context
 * from the root's timeline. What differs is the seed — the reason is the user's
 * words rather than a quota message, and the chain may start at a chosen entry
 * instead of the first. The root turn is cancelled first so two agents are not
 * working the same task at once.
 */
async function startManualHandoff(payload) {
  const rootId = String(payload?.agentId ?? "").trim();
  if (!rootId) throw new Error("A manual handoff needs the task's agent id.");
  if (handling.has(rootId)) throw new Error("Fleet Supervisor is already handing this task off.");
  const root = await fetchAgentSnapshot(rootId);
  if (!root) throw new Error(`Agent ${rootId} was not found.`);
  if (config.fallbackOrder.length === 0) throw new Error("No fallback entries are configured.");

  let startIndex = 0;
  const wanted = String(payload?.workerId ?? "").trim();
  if (wanted) {
    startIndex = config.fallbackOrder.findIndex((worker) => worker?.id === wanted);
    if (startIndex < 0) throw new Error(`Fallback entry "${wanted}" is not configured.`);
  }
  const worker = config.fallbackOrder[startIndex];
  const reason = String(payload?.reason ?? "").trim() || "The user handed this task to the fleet manually.";

  // Stop the current turn so the fallback does not race a still-running root.
  if (root.status === "running" || root.status === "initializing") {
    try { await client.cancelAgent(rootId); } catch (error) {
      await log(`Could not cancel ${rootId} before manual handoff: ${String(error?.message ?? error)}`);
    }
  }

  const key = `${rootId}:manual:${crypto.randomUUID()}`;
  persistedState.handled[key] = {
    rootAgentId: rootId,
    handledAt: stamp(),
    source: "manual",
    status: "handling",
    chain: {
      cycle: 0,
      nextWorkerIndex: startIndex,
      sessions: {},
      previousProvider: String(root.provider ?? "Claude"),
      previousReason: reason,
    },
  };
  await saveState();
  await log(`Manual handoff requested for ${rootId}, starting at "${worker.id}". Reason: ${reason}`);
  void performFailover(rootId, `Manual handoff: ${reason}`, key).catch((error) =>
    log(`Manual handoff for ${rootId} failed: ${error?.stack ?? error}`),
  );
  return { rootId, worker: worker.id, startIndex, reason };
}

async function detectAndHandleLatestQuota(rootId, source) {
  if (config.autoHandoff === false) return false;
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
    clientId: `fleet-supervisor-v4.0.0-beta.1-${process.pid}`,
// @fleet:app-version
    clientType: "cli",
    // Without appVersion the daemon treats this as a pre-0.1.45 client and hides
    // every provider outside {claude, codex, opencode}: fetchAgent then throws
    // "Agent not found" for cursor/copilot/ACP agents and Council reviews fail.
    appVersion: FLEET_CLIENT_APP_VERSION,
    reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 5000 },
  });
  await candidate.connect();
  client = candidate;
  client.subscribe(handleDaemonEvent);
  directorySubscriptionId = `fleet-supervisor-v4.0.0-beta.1-${process.pid}`;
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
  if (bridgeServer) {
    const closing = bridgeServer;
    bridgeServer = null;
    await new Promise((resolve) => closing.close(() => resolve()));
  }
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
  await log(`Fleet Supervisor v4.0.0 beta 1 starting in Paseo-scoped mode. pid=${process.pid}`);
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

// @fleet:singleton
  try { await startBridge(); }
  catch (error) {
    // EADDRINUSE means another Fleet Supervisor already owns the bridge. A
    // second instance would still watch Paseo and could fire a duplicate
    // handoff for the same limit, while its bridge silently serves nothing.
    // The port is the singleton lock: yield to whoever holds it.
    if (error?.code === "EADDRINUSE") {
      await log("Another Fleet Supervisor already owns the bridge on 127.0.0.1:47641. This instance is exiting.");
      // Not cleanup(): that unlinks the pid file, which now belongs to the
      // instance that won. Close only what this instance opened.
      try { await client?.close(); } catch {}
      return;
    }
// @fleet:pidfile-late
    await log(`Fleet Supervisor bridge could not start: ${error?.stack ?? error}`);
  }
  try { await fs.writeFile(PID_FILE, String(process.pid), "utf8"); } catch {}

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
  if (values.config) config = {
    ...DEFAULT_CONFIG,
    ...values.config,
    continuationPolicy: { ...DEFAULT_CONFIG.continuationPolicy, ...(values.config.continuationPolicy ?? {}) },
    council: { ...DEFAULT_CONFIG.council, ...(values.config.council ?? {}) },
  };
  if (values.state) persistedState = values.state;
  shuttingDown = false;
  handling.clear();
}

export function __getFleetGuardTestState() {
  return persistedState;
}

export { continuationPolicy, performFailover, runCouncilReview, workerSystemPrompt };

if (process.env.FLEET_GUARD_SELF_TEST !== "1") {
  main().catch(async (error) => {
    await log(`Fatal Fleet Guard error: ${error?.stack ?? error}`);
    await cleanup();
    process.exit(1);
  });
}
