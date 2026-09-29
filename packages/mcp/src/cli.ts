#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { detectProviderCredentials } from "@clanov/orchestration-providers";
import { SqliteStateStore } from "@clanov/orchestration-state";
import { createWorkersFromEnv, loadEnvironment } from "./config.js";
import { createOrchestrationServer } from "./index.js";

const envFile = loadEnvironment();
const workers = createWorkersFromEnv();

if (workers.length === 0) {
  console.error(
    [
      "orchestration-mcp has no configured workers.",
      envFile ? `Loaded environment: ${envFile}` : "No .env file was loaded.",
      "Configure at least one native runtime:",
      "  OpenCode: ORCHESTRATION_OPENCODE_PROVIDER + ORCHESTRATION_OPENCODE_MODEL",
      "  Antigravity: ORCHESTRATION_ANTIGRAVITY_MODEL",
      "  Command Code: ORCHESTRATION_COMMAND_CODE_MODEL",
    ].join("\n"),
  );
  process.exit(1);
}

const stateStore = new SqliteStateStore();

for (const provider of detectProviderCredentials()) {
  console.error(
    `provider ${provider.id}: ${provider.configured ? "credential detected" : "not configured"}`,
  );
}

void serveStdio(() =>
  createOrchestrationServer({
    workers,
    stateStore,
  }),
);

console.error(
  [
    `orchestration MCP server running on stdio; workers: ${workers
      .map((worker) => worker.name)
      .join(", ")}`,
    `state: ${stateStore.path}`,
    ...(envFile ? [`env: ${envFile}`] : []),
  ].join("\n"),
);
