import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-guard-continuation-"));
process.env.FLEET_GUARD_SELF_TEST = "1";
process.env.FLEET_GUARD_STATE_HOME = testHome;

const guard = await import("../src/fleet-guard.mjs");

function verdict(status, reason = "", summary = "work") {
  return {
    status: "idle",
    error: null,
    lastMessage: JSON.stringify({ status, summary, reason, verification: "tests passed" }),
  };
}

function mockClient({ rootId, childResults = [], rootResults = [], existingAgents = [] }) {
  const calls = { create: 0, createOptions: [], messages: [] };
  const snapshots = new Map([[rootId, { id: rootId, status: "idle", workspaceId: "ws", cwd: testHome, title: "Root Claude" }]]);
  for (const agent of existingAgents) snapshots.set(agent.id, agent);
  return {
    calls,
    api: {
      async fetchAgent(id) { return { agent: snapshots.get(id) ?? null }; },
      async fetchAgentTimeline() {
        return { entries: [{ item: { type: "user_message", text: "Finish the shared task" } }] };
      },
      async listAgentTimelinePrompts() { return { prompts: [] }; },
      async createAgent(options) {
        calls.create += 1;
        calls.createOptions.push(options);
        const id = `child-${calls.create}`;
        const snapshot = { id, status: "idle", workspaceId: options.workspaceId, cwd: options.cwd, title: null };
        snapshots.set(id, snapshot);
        return snapshot;
      },
      async updateAgent() {},
      async sendAgentMessage(id, text) { calls.messages.push({ id, text }); },
      async waitForFinish(id) {
        if (id === rootId) return rootResults.shift() ?? { status: "error", error: "No root result", lastMessage: null };
        return childResults.shift() ?? { status: "error", error: "No child result", lastMessage: null };
      },
    },
  };
}

test("nudges the same child and challenges completion before stopping", async () => {
  const rootId = "root-nudge";
  const mock = mockClient({
    rootId,
    childResults: [
      verdict("blocked", "More implementation remains"),
      verdict("complete", "", "Implementation finished"),
      verdict("complete", "", "Audited and verified"),
    ],
  });
  const key = "failure-nudge";
  guard.__setFleetGuardTestRuntime({
    client: mock.api,
    config: {
      fallbackOrder: [{ id: "copilot", kind: "paseo", provider: "copilot", modeId: "allow-all" }],
      continuationPolicy: { mode: "single-pass", sameAgentNudges: 1, verifyCompletion: true, reuseSessions: true, retryDelayMinutes: 0 },
    },
    state: { version: 2, handled: { [key]: { rootAgentId: rootId, handledAt: new Date().toISOString(), status: "handling" } } },
  });

  await guard.performFailover(rootId, "quota", key);
  const state = guard.__getFleetGuardTestState();
  assert.equal(state.handled[key].status, "complete");
  assert.equal(mock.calls.create, 1, "the same Paseo child should be reused");
  assert.deepEqual(mock.calls.messages.map((entry) => entry.id), ["child-1", "child-1"]);
  assert.match(mock.calls.messages[0].text, /Continue the same active task/);
  assert.match(mock.calls.messages[1].text, /Audit your claim/);
});

test("cycles after quota and returns the work to the original Claude task", async () => {
  const rootId = "root-return";
  const mock = mockClient({
    rootId,
    childResults: [{ status: "error", error: "You've hit your session limit", lastMessage: null }],
    rootResults: [verdict("complete", "", "Claude finished after reset")],
  });
  const key = "failure-return";
  guard.__setFleetGuardTestRuntime({
    client: mock.api,
    config: {
      fallbackOrder: [{ id: "cursor", kind: "paseo", provider: "fleet-cursor", modeId: "agent" }],
      continuationPolicy: { mode: "return-to-source", sameAgentNudges: 0, verifyCompletion: false, reuseSessions: true, retryDelayMinutes: 0, maxCycles: 2 },
    },
    state: { version: 2, handled: { [key]: { rootAgentId: rootId, handledAt: new Date().toISOString(), status: "handling" } } },
  });

  await guard.performFailover(rootId, "quota", key);
  const state = guard.__getFleetGuardTestState();
  assert.equal(state.handled[key].status, "complete");
  assert.equal(state.handled[key].chain.cycle, 1);
  assert.equal(mock.calls.create, 1);
  assert.equal(mock.calls.messages.length, 1);
  assert.equal(mock.calls.messages[0].id, rootId);
  assert.match(mock.calls.messages[0].text, /returning this task to its original Claude conversation/i);
});

test("resumes a saved child ID after Guard itself was interrupted", async () => {
  const rootId = "root-resume";
  const existing = { id: "saved-copilot-child", status: "idle", workspaceId: "ws", cwd: testHome, title: "Fleet Guard · copilot" };
  const mock = mockClient({ rootId, existingAgents: [existing], childResults: [verdict("complete", "", "Resumed child finished")] });
  const key = "failure-resume";
  guard.__setFleetGuardTestRuntime({
    client: mock.api,
    config: {
      fallbackOrder: [{ id: "copilot", kind: "paseo", provider: "copilot", modeId: "allow-all" }],
      continuationPolicy: { mode: "cycle", sameAgentNudges: 0, verifyCompletion: false, reuseSessions: true, retryDelayMinutes: 0, maxCycles: 2 },
    },
    state: {
      version: 2,
      handled: {
        [key]: {
          rootAgentId: rootId,
          handledAt: new Date().toISOString(),
          status: "interrupted",
          chain: {
            cycle: 1,
            nextWorkerIndex: 0,
            sessions: { copilot: existing.id },
            previousProvider: "cursor",
            previousReason: "Cursor hit quota",
            originalRequest: "Finish the shared task",
          },
        },
      },
    },
  });

  await guard.performFailover(rootId, "quota", key);
  const state = guard.__getFleetGuardTestState();
  assert.equal(state.handled[key].status, "complete");
  assert.equal(mock.calls.create, 0, "a replacement child should not be created");
  assert.deepEqual(mock.calls.messages.map((entry) => entry.id), [existing.id]);
});

test("starts a configured local model through the Fleet OpenCode provider", async () => {
  const rootId = "root-local";
  const mock = mockClient({ rootId, childResults: [verdict("complete", "", "Local model finished")] });
  const key = "failure-local";
  guard.__setFleetGuardTestRuntime({
    client: mock.api,
    config: {
      fallbackOrder: [{ id: "local", kind: "paseo", provider: "fleet-local/fleet-local-api/qwen2.5-coder:14b" }],
      continuationPolicy: { mode: "single-pass", sameAgentNudges: 0, verifyCompletion: false, reuseSessions: true, retryDelayMinutes: 0 },
    },
    state: { version: 2, handled: { [key]: { rootAgentId: rootId, handledAt: new Date().toISOString(), status: "handling" } } },
  });

  await guard.performFailover(rootId, "quota", key);
  assert.equal(mock.calls.create, 1);
  assert.equal(mock.calls.createOptions[0].provider, "fleet-local");
  assert.equal(mock.calls.createOptions[0].model, "fleet-local-api/qwen2.5-coder:14b");
  assert.equal(guard.__getFleetGuardTestState().handled[key].status, "complete");
});

test.after(async () => {
  await fs.rm(testHome, { recursive: true, force: true });
});
