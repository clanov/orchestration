#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SqliteStateStore } from "@clanov/orchestration-state";
import {
  createWorkersFromEnv,
  loadEnvironment,
  selectAvailableSidekick,
} from "./config.js";
import { createOrchestrationServer } from "./index.js";

const envFile = loadEnvironment();

let candidates;
try {
  candidates = createWorkersFromEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (candidates.length === 0) {
  console.error(
    [
      "orchestration-mcp has no configured Sidekick.",
      envFile ? `Loaded environment: ${envFile}` : "No .env file was loaded.",
      "Minimal configuration:",
      "  ORCHESTRATION_SIDEKICK=antigravity",
      "  ORCHESTRATION_SIDEKICK_MODEL=gemini-3.8-flash-high",
      "  ORCHESTRATION_SIDEKICK_ALLOW_MUTATIONS=1",
    ].join("\n"),
  );
  process.exit(1);
}

const sidekick = await selectAvailableSidekick(candidates);
if (!sidekick) {
  console.error(
    [
      "No configured Sidekick runtime is reachable.",
      `Tried: ${candidates.map((worker) => worker.name).join(", ")}`,
      "Run npm run doctor for details.",
    ].join("\n"),
  );
  process.exit(1);
}

const stateStore = new SqliteStateStore();

void serveStdio(() =>
  createOrchestrationServer({
    workers: [sidekick],
    stateStore,
  }),
);

console.error(
  [
    `orchestration MCP server running on stdio; sidekick: ${sidekick.name}`,
    `state: ${stateStore.path}`,
    ...(envFile ? [`env: ${envFile}`] : []),
  ].join("\n"),
);
