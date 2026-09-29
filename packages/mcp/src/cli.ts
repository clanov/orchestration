#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { OpenCodeWorker } from "@clanov/orchestration-adapter-opencode";
import { createOrchestrationServer } from "./index.js";

const providerID = process.env.ORCHESTRATION_OPENCODE_PROVIDER;
const modelID = process.env.ORCHESTRATION_OPENCODE_MODEL;

if (!providerID || !modelID) {
  console.error(
    [
      "orchestration-mcp requires an OpenCode worker configuration.",
      "Set ORCHESTRATION_OPENCODE_PROVIDER and ORCHESTRATION_OPENCODE_MODEL.",
    ].join("\n"),
  );
  process.exit(1);
}

const worker = new OpenCodeWorker({
  baseUrl:
    process.env.ORCHESTRATION_OPENCODE_URL ?? "http://127.0.0.1:4096",
  providerID,
  modelID,
  ...(process.env.ORCHESTRATION_OPENCODE_AGENT
    ? { agent: process.env.ORCHESTRATION_OPENCODE_AGENT }
    : {}),
});

void serveStdio(() =>
  createOrchestrationServer({
    workers: [worker],
  }),
);

console.error("orchestration MCP server running on stdio");
