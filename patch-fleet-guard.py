#!/usr/bin/env python3
"""
Patch Fleet Guard for the Fleet Supervisor UI work.

Applies four changes to payload/src/fleet-guard.mjs:

  1. appVersion on the DaemonClient. Without it the daemon treats Fleet Guard as
     a pre-0.1.45 client and hides every provider outside {claude, codex,
     opencode}, so fetchAgent throws "Agent not found" for cursor/copilot/ACP
     agents and Council reviews fail before any reviewer spawns.
  2. Subscription-cap awareness, so the UI can tell Fable (weekly-capped, may
     hand off to another Claude model) from uncapped Claude models.
  3. A cached provider/model catalog read from the daemon's provider snapshot.
  4. Config read/write plus a small router, so the settings surface can load and
     save the fallback tree, per-model roles, and the Council roster.

Idempotent: re-running detects already-applied changes and skips them.
"""

import re
import sys
from pathlib import Path

APP_VERSION_OLD = '''    clientType: "cli",
    reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 5000 },'''

APP_VERSION_NEW = '''// @fleet:app-version
    clientType: "cli",
    // Without appVersion the daemon treats this as a pre-0.1.45 client and hides
    // every provider outside {claude, codex, opencode}: fetchAgent then throws
    // "Agent not found" for cursor/copilot/ACP agents and Council reviews fail.
    appVersion: FLEET_CLIENT_APP_VERSION,
    reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 5000 },'''

CONST_ANCHOR = 'const BRIDGE_PORT = 47641;'

CONST_NEW = '''// @fleet:constants
const BRIDGE_PORT = 47641;
// Reported to the Paseo daemon so it exposes every provider, not just the
// legacy {claude, codex, opencode} set. See connectAndWatch.
const FLEET_CLIENT_APP_VERSION = "0.4.0";
const CATALOG_TTL_MS = 60_000;
// Models whose subscription allowance runs out separately from the rest of the
// plan. Only these can usefully hand off to another model from the same
// provider; everything else exhausts the whole plan at once.
const SUBSCRIPTION_CAPPED_MODEL_PATTERNS = [/(^|[-_/])fable/i];'''

CATALOG_ANCHOR = 'function readRequestJson(request) {'

CATALOG_NEW = '''// @fleet:catalog-helpers
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
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\\n`, "utf8");
  config = merged;
  await log("Fleet Supervisor configuration updated from the settings surface.");
  return merged;
}

function readRequestJson(request) {'''

ROUTER_OLD = '''  if (request.method === "GET" && request.url === "/v1/status") {
    sendBridgeJson(response, 200, { ready: Boolean(client), councilMembers: councilMembers().length });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/council") {
    sendBridgeJson(response, 404, { error: "Not found." });
    return;
  }'''

ROUTER_NEW = '''// @fleet:router
  const route = String(request.url ?? "").split("?")[0];
  if (request.method === "GET" && route === "/v1/status") {
    sendBridgeJson(response, 200, { ready: Boolean(client), councilMembers: councilMembers().length });
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
  }'''

STATE_OLD = 'let bridgeToken = null;'
STATE_NEW = '''// @fleet:catalog-state
let bridgeToken = null;
let catalogCache = null;'''

AUTOHANDOFF_DEFAULT_OLD = '''  council: {
    enabled: true,
    members: [],
    maxContextCharacters: 32000,
  },'''

AUTOHANDOFF_DEFAULT_NEW = '''// @fleet:autohandoff-default
  council: {
    enabled: true,
    members: [],
    maxContextCharacters: 32000,
  },
  // Automatic handoff on quota exhaustion. Separate from `enabled`, which
  // decides whether Fleet Supervisor runs at all: this can be switched off from
  // Paseo's toolbar mid-session and back on again, and leaves Council reviews
  // — a manual action — working either way.
  autoHandoff: true,'''

AUTOHANDOFF_GUARD_OLD = '''async function detectAndHandleLatestQuota(rootId, source) {
  if (handling.has(rootId)) return false;'''

AUTOHANDOFF_GUARD_NEW = '''// @fleet:autohandoff-guard
async function detectAndHandleLatestQuota(rootId, source) {
  if (config.autoHandoff === false) return false;
  if (handling.has(rootId)) return false;'''

STATUS_OLD = '''    sendBridgeJson(response, 200, { ready: Boolean(client), councilMembers: councilMembers().length });'''

STATUS_NEW = '''// @fleet:status
    sendBridgeJson(response, 200, {
      ready: Boolean(client),
      councilMembers: councilMembers().length,
      autoHandoff: config.autoHandoff !== false,
      councilEnabled: config.council?.enabled !== false,
    });'''

AUTOHANDOFF_ROUTE_OLD = '''  if (request.method === "GET" && route === "/v1/config") {'''

AUTOHANDOFF_ROUTE_NEW = '''// @fleet:autohandoff-route
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
  if (request.method === "GET" && route === "/v1/config") {'''

SINGLETON_OLD = """  try { await startBridge(); }
  catch (error) {
    await log(`Fleet Supervisor bridge could not start: ${error?.stack ?? error}`);
  }
"""

SINGLETON_NEW = """// @fleet:singleton
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
    await log(`Fleet Supervisor bridge could not start: ${error?.stack ?? error}`);
  }
"""

PIDFILE_EARLY_OLD = """await fs.mkdir(HANDOFF_DIR, { recursive: true });
await fs.writeFile(PID_FILE, String(process.pid), "utf8");"""

PIDFILE_EARLY_NEW = """// @fleet:pidfile-early
await fs.mkdir(HANDOFF_DIR, { recursive: true });
// The pid file is written once the bridge port is won (see main), not here:
// an instance that loses the port must not overwrite the winner's pid."""

PIDFILE_LATE_OLD = """    await log(`Fleet Supervisor bridge could not start: ${error?.stack ?? error}`);
  }
"""

PIDFILE_LATE_NEW = """// @fleet:pidfile-late
    await log(`Fleet Supervisor bridge could not start: ${error?.stack ?? error}`);
  }
  try { await fs.writeFile(PID_FILE, String(process.pid), "utf8"); } catch {}
"""

MANUAL_HELPER_ANCHOR = 'async function detectAndHandleLatestQuota(rootId, source) {'

MANUAL_HELPER_NEW = """// @fleet:manual-handoff
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

async function detectAndHandleLatestQuota(rootId, source) {"""

MANUAL_ROUTE_OLD = """  if (request.method === "GET" && route === "/v1/config") {"""

MANUAL_ROUTE_NEW = """  // @fleet:manual-route
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
  if (request.method === "GET" && route === "/v1/config") {"""

STATUS_OLD2 = """      autoHandoff: config.autoHandoff !== false,
      councilEnabled: config.council?.enabled !== false,"""

STATUS_NEW2 = """      autoHandoff: config.autoHandoff !== false,
      councilEnabled: config.council?.enabled !== false,
      // @fleet:status-fallbacks
      fallbacks: config.fallbackOrder.map((worker) => ({ id: String(worker?.id ?? ""), provider: String(worker?.provider ?? worker?.kind ?? "") })),"""

LOGLINE_OLD = """    await log(`Quota failure confirmed for Claude agent ${rootId} (${root.title ?? rootId}). Continuation mode=${policy.mode}, nudges=${policy.sameAgentNudges}, reuseSessions=${policy.reuseSessions}.`);"""

LOGLINE_NEW = """    // @fleet:logline
    await log(`${record.source === "manual" ? "Manual handoff started" : "Quota failure confirmed"} for ${root.provider ?? "Claude"} agent ${rootId} (${root.title ?? rootId}). Continuation mode=${policy.mode}, nudges=${policy.sameAgentNudges}, reuseSessions=${policy.reuseSessions}.`);"""

ACP_HELPERS_ANCHOR = 'async function createPaseoChild(root, worker, prompt, onSession) {'

ACP_HELPERS_NEW = '''// @fleet:directive-helpers
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
  return { systemPrompt: undefined, prompt: `${text}\\n\\n---\\n\\n${prompt}` };
}

async function createPaseoChild(root, worker, prompt, onSession) {'''

WORKER_CHILD_OLD = '''  const provider = providerConfig(worker);
  const child = await client.createAgent({
    provider: provider.provider,
    model: provider.model,
    modeId: worker.modeId,
    featureValues: worker.featureValues,
    systemPrompt: workerSystemPrompt(worker),
    cwd: root.cwd,
    workspaceId: root.workspaceId,
    callerAgentId: root.id,
    initialPrompt: prompt,'''

WORKER_CHILD_NEW = '''// @fleet:worker-directive
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
    initialPrompt: directive.prompt,'''

COUNCIL_CHILD_OLD = '''    modeId: member.modeId,
    thinkingOptionId: member.thinkingOptionId,
    featureValues: member.featureValues,
    systemPrompt: councilSystemPrompt(member),
    cwd: root.cwd,
    workspaceId: root.workspaceId,
    callerAgentId: root.id,
    initialPrompt: prompt,'''

COUNCIL_CHILD_NEW = '''// @fleet:council-child
    modeId: member.modeId,
    thinkingOptionId: member.thinkingOptionId,
    featureValues: member.featureValues,
    systemPrompt: councilDirective.systemPrompt,
    cwd: root.cwd,
    workspaceId: root.workspaceId,
    callerAgentId: root.id,
    initialPrompt: councilDirective.prompt,'''

COUNCIL_PREAMBLE_OLD = '''async function createCouncilChild(root, member, prompt, attachments, images, reviewId) {
  const provider = providerConfig(member);'''

COUNCIL_PREAMBLE_NEW = '''// @fleet:council-directive
async function createCouncilChild(root, member, prompt, attachments, images, reviewId) {
  const provider = providerConfig(member);
  const councilDirective = applyDirective(provider.provider, councilSystemPrompt(member), prompt);'''

CORS_ANCHOR = 'function bridgeAuthorized(request) {'

CORS_NEW = '''// @fleet:cors
/**
 * Origins the Paseo renderer can legitimately present. Electron serves the app
 * from a custom scheme or, in development, a loopback dev server. Nothing else
 * is accepted, so a hostile web page cannot read bridge responses.
 */
const RENDERER_ORIGIN_PATTERNS = [
  /^paseo:\\/\\//i,
  /^file:\\/\\//i,
  /^https?:\\/\\/localhost(?::\\d+)?$/i,
  /^https?:\\/\\/127\\.0\\.0\\.1(?::\\d+)?$/i,
  /^https?:\\/\\/\\[::1\\](?::\\d+)?$/i,
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

function bridgeAuthorized(request) {'''

HANDSHAKE_ANCHOR = '''async function handleBridgeRequest(request, response) {
  if (!bridgeAuthorized(request)) {'''

HANDSHAKE_NEW = '''// @fleet:handshake
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
  if (!bridgeAuthorized(request)) {'''


def apply(text: str, old: str, new: str, name: str, sentinel: str) -> str:
    """
    Each patch carries a sentinel: a short comment that exists in the file only
    once that patch has been applied. This is unambiguous, unlike inferring
    state from anchors (later patches may edit inside earlier output) or from
    the full replacement text (same reason).
    """
    if sentinel in text:
        print(f"  = {name}: already applied")
        return text
    if old not in text:
        print(f"  ! {name}: ANCHOR NOT FOUND", file=sys.stderr)
        raise SystemExit(1)
    if sentinel not in new:
        print(f"  ! {name}: sentinel missing from replacement", file=sys.stderr)
        raise SystemExit(1)
    print(f"  + {name}")
    return text.replace(old, new, 1)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-fleet-guard.py <path to fleet-guard.mjs>")
    path = Path(sys.argv[1])
    text = path.read_text(encoding="utf8")
    print(f"Patching {path}")

    # The appVersion fix may already be present from an earlier manual edit.
    if "appVersion: FLEET_CLIENT_APP_VERSION" not in text:
        text = re.sub(
            r'    clientType: "cli",\n(?:    //[^\n]*\n)*    appVersion: "0\.4\.0",\n',
            '    clientType: "cli",\n',
            text,
        )
        text = apply(text, APP_VERSION_OLD, APP_VERSION_NEW, "appVersion on DaemonClient", "// @fleet:app-version")
    else:
        print("  = appVersion on DaemonClient: already applied")

    text = apply(text, CONST_ANCHOR, CONST_NEW, "catalog + subscription-cap constants", "// @fleet:constants")
    text = apply(text, STATE_OLD, STATE_NEW, "catalog cache state", "// @fleet:catalog-state")
    text = apply(text, CATALOG_ANCHOR, CATALOG_NEW, "catalog + config helpers", "// @fleet:catalog-helpers")
    text = apply(text, ROUTER_OLD, ROUTER_NEW, "bridge router: /v1/catalog, /v1/config", "// @fleet:router")
    text = apply(text, CORS_ANCHOR, CORS_NEW, "renderer origin allowlist + CORS", "// @fleet:cors")
    text = apply(text, HANDSHAKE_ANCHOR, HANDSHAKE_NEW, "preflight, JSON guard, /v1/handshake", "// @fleet:handshake")
    text = apply(text, AUTOHANDOFF_DEFAULT_OLD, AUTOHANDOFF_DEFAULT_NEW, "autoHandoff default", "// @fleet:autohandoff-default")
    text = apply(text, AUTOHANDOFF_GUARD_OLD, AUTOHANDOFF_GUARD_NEW, "autoHandoff runtime guard", "// @fleet:autohandoff-guard")
    text = apply(text, STATUS_OLD, STATUS_NEW, "status reports toggle state", "// @fleet:status")
    text = apply(text, AUTOHANDOFF_ROUTE_OLD, AUTOHANDOFF_ROUTE_NEW, "POST /v1/auto-handoff", "// @fleet:autohandoff-route")
    text = apply(text, SINGLETON_OLD, SINGLETON_NEW, "exit when another instance owns the bridge", "// @fleet:singleton")
    text = apply(text, PIDFILE_EARLY_OLD, PIDFILE_EARLY_NEW, "defer pid file until lock is won", "// @fleet:pidfile-early")
    text = apply(text, PIDFILE_LATE_OLD, PIDFILE_LATE_NEW, "write pid file after winning the lock", "// @fleet:pidfile-late")
    text = apply(text, MANUAL_HELPER_ANCHOR, MANUAL_HELPER_NEW, "manual handoff helper", "// @fleet:manual-handoff")
    text = apply(text, LOGLINE_OLD, LOGLINE_NEW, "log line names the trigger", "// @fleet:logline")
    text = apply(text, MANUAL_ROUTE_OLD, MANUAL_ROUTE_NEW, "POST /v1/handoff", "// @fleet:manual-route")
    text = apply(text, STATUS_OLD2, STATUS_NEW2, "status lists fallbacks", "// @fleet:status-fallbacks")
    text = apply(text, ACP_HELPERS_ANCHOR, ACP_HELPERS_NEW, "systemPrompt routing helpers", "// @fleet:directive-helpers")
    text = apply(text, WORKER_CHILD_OLD, WORKER_CHILD_NEW, "handoff worker directive routing", "// @fleet:worker-directive")
    text = apply(text, COUNCIL_PREAMBLE_OLD, COUNCIL_PREAMBLE_NEW, "council directive resolution", "// @fleet:council-directive")
    text = apply(text, COUNCIL_CHILD_OLD, COUNCIL_CHILD_NEW, "council member directive routing", "// @fleet:council-child")

    path.write_text(text, encoding="utf8")
    print("Done.")


if __name__ == "__main__":
    main()
