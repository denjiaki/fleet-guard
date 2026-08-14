import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const client = new DaemonClient({
  url: "ws://127.0.0.1:6767/ws",
  clientId: "fleet-guard-diagnose",
  clientType: "cli",
  reconnect: { enabled: false },
});

try {
  await client.connect();
  const page = await client.fetchAgents({
    scope: "active",
    filter: { includeArchived: false },
    page: { limit: 200 },
  });
  console.log(`Connected to Paseo. Active agents discovered: ${page.entries.length}`);
  for (const entry of page.entries) {
    const agent = entry.agent;
    console.log(JSON.stringify({
      id: agent.id,
      title: agent.title,
      provider: agent.provider,
      model: agent.model,
      workspaceId: agent.workspaceId,
      parentAgentId: agent.parentAgentId ?? agent.labels?.["paseo.parent-agent-id"],
      status: agent.status,
    }, null, 2));
  }
} finally {
  await client.close();
}
