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

test("uses the exact configured model and highest-priority behavior prompt", async () => {
  const rootId = "root-model-prompt";
  const mock = mockClient({ rootId, childResults: [verdict("complete")] });
  const key = "failure-model-prompt";
  guard.__setFleetGuardTestRuntime({
    client: mock.api,
    config: {
      fallbackOrder: [{
        id: "codex-sol",
        kind: "paseo",
        provider: "codex/gpt-5.6-sol",
        modeId: "auto-review",
        useFor: "bug-checking",
        systemPrompt: "Pay special attention to concurrency regressions.",
      }],
      continuationPolicy: { mode: "single-pass", sameAgentNudges: 0, verifyCompletion: false },
    },
    state: { version: 2, handled: { [key]: { rootAgentId: rootId, handledAt: new Date().toISOString(), status: "handling" } } },
  });

  await guard.performFailover(rootId, "quota", key);
  assert.equal(mock.calls.createOptions[0].provider, "codex");
  assert.equal(mock.calls.createOptions[0].model, "gpt-5.6-sol");
  assert.match(mock.calls.createOptions[0].systemPrompt, /MODEL-SPECIFIC DIRECTIVE \(highest priority/);
  assert.match(mock.calls.createOptions[0].systemPrompt, /dedicated bug checker/i);
  assert.match(mock.calls.createOptions[0].systemPrompt, /concurrency regressions/i);
});

test("runs configured council models independently and returns their digest request to the source", async () => {
  const rootId = "root-council";
  const review = (summary) => ({
    status: "idle",
    error: null,
    lastMessage: JSON.stringify({
      summary,
      strengths: ["clear intent"],
      risks: ["missing evidence"],
      recommendations: ["add a focused test"],
      confidence: "high",
    }),
  });
  const mock = mockClient({ rootId, childResults: [review("Sol review"), review("Opus review")] });
  const imagePath = path.join(testHome, "council-image.png");
  await fs.writeFile(imagePath, Buffer.from("fleet-image"));
  guard.__setFleetGuardTestRuntime({
    client: mock.api,
    config: {
      council: {
        enabled: true,
        members: [
          { id: "sol", provider: "codex/gpt-5.6-sol", lens: "bug-checking" },
          { id: "opus", provider: "claude/claude-opus", lens: "skepticism" },
        ],
      },
    },
    state: { version: 2, handled: {} },
  });

  await guard.runCouncilReview({
    scope: "message",
    agentId: rootId,
    role: "user",
    text: "Ship this design as-is.",
    attachments: [{ type: "uploaded_file", name: "brief.pdf", path: "C:/brief.pdf" }],
    images: [{ storageType: "desktop-file", storageKey: imagePath, mimeType: "image/png" }],
  }, "review-test");

  assert.equal(mock.calls.create, 2);
  assert.deepEqual(mock.calls.createOptions.map((options) => [options.provider, options.model]), [
    ["codex", "gpt-5.6-sol"],
    ["claude", "claude-opus"],
  ]);
  assert.ok(mock.calls.createOptions.every((options) => /independent reviewer/i.test(options.systemPrompt)));
  assert.ok(mock.calls.createOptions.every((options) => options.attachments?.[0]?.name === "brief.pdf"));
  assert.ok(mock.calls.createOptions.every((options) => options.images?.[0]?.mimeType === "image/png"));
  assert.equal(mock.calls.messages.at(-1).id, rootId);
  assert.match(mock.calls.messages.at(-1).text, /INDEPENDENT REVIEWS/);
  assert.match(mock.calls.messages.at(-1).text, /Sol review/);
  assert.match(mock.calls.messages.at(-1).text, /Opus review/);
});

test.after(async () => {
  await fs.rm(testHome, { recursive: true, force: true });
});
