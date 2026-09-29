#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AntigravityWorker } from "@clanov/orchestration-adapter-antigravity";
import { CommandCodeWorker } from "@clanov/orchestration-adapter-command-code";
import { OpenCodeWorker } from "@clanov/orchestration-adapter-opencode";
import type { WorkerAdapter } from "@clanov/orchestration-core";
import { detectProviderCredentials } from "@clanov/orchestration-providers";
import { createOrchestrationServer } from "./index.js";

const workers: WorkerAdapter[] = [];

const openCodeProvider = process.env.ORCHESTRATION_OPENCODE_PROVIDER;
const openCodeModel = process.env.ORCHESTRATION_OPENCODE_MODEL;

if (openCodeProvider && openCodeModel) {
  workers.push(
    new OpenCodeWorker({
      baseUrl:
        process.env.ORCHESTRATION_OPENCODE_URL ?? "http://127.0.0.1:4096",
      providerID: openCodeProvider,
      modelID: openCodeModel,
      ...(process.env.ORCHESTRATION_OPENCODE_AGENT
        ? { agent: process.env.ORCHESTRATION_OPENCODE_AGENT }
        : {}),
    }),
  );
}

const antigravityModel = process.env.ORCHESTRATION_ANTIGRAVITY_MODEL;
if (antigravityModel) {
  workers.push(
    new AntigravityWorker({
      command: process.env.ORCHESTRATION_ANTIGRAVITY_COMMAND ?? "agy",
      model: antigravityModel,
      ...(parseAgyEffort(process.env.ORCHESTRATION_ANTIGRAVITY_EFFORT)
        ? {
            effort: parseAgyEffort(
              process.env.ORCHESTRATION_ANTIGRAVITY_EFFORT,
            )!,
          }
        : {}),
      allowMutations:
        process.env.ORCHESTRATION_ANTIGRAVITY_ALLOW_MUTATIONS === "1",
      timeoutMs: parsePositiveInt(
        process.env.ORCHESTRATION_ANTIGRAVITY_TIMEOUT_MS,
        600_000,
      ),
    }),
  );
}

const commandCodeModel = process.env.ORCHESTRATION_COMMAND_CODE_MODEL;
if (commandCodeModel) {
  workers.push(
    new CommandCodeWorker({
      command:
        process.env.ORCHESTRATION_COMMAND_CODE_COMMAND ?? "command-code",
      model: commandCodeModel,
      effort: process.env.ORCHESTRATION_COMMAND_CODE_EFFORT ?? "high",
      allowMutations:
        process.env.ORCHESTRATION_COMMAND_CODE_ALLOW_MUTATIONS === "1",
      timeoutMs: parsePositiveInt(
        process.env.ORCHESTRATION_COMMAND_CODE_TIMEOUT_MS,
        600_000,
      ),
    }),
  );
}

if (workers.length === 0) {
  console.error(
    [
      "orchestration-mcp has no configured workers.",
      "Configure at least one native runtime:",
      "  OpenCode: ORCHESTRATION_OPENCODE_PROVIDER + ORCHESTRATION_OPENCODE_MODEL",
      "  Antigravity: ORCHESTRATION_ANTIGRAVITY_MODEL",
      "  Command Code: ORCHESTRATION_COMMAND_CODE_MODEL",
    ].join("\n"),
  );
  process.exit(1);
}

const providerStatus = detectProviderCredentials();
for (const provider of providerStatus) {
  console.error(
    `provider ${provider.id}: ${provider.configured ? "credential detected" : "not configured"}`,
  );
}

void serveStdio(() =>
  createOrchestrationServer({
    workers,
  }),
);

console.error(
  `orchestration MCP server running on stdio; workers: ${workers
    .map((worker) => worker.name)
    .join(", ")}`,
);

function parseAgyEffort(
  value: string | undefined,
): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
