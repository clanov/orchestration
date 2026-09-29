import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import * as path from "node:path";
import { AntigravityWorker } from "@clanov/orchestration-adapter-antigravity";
import { CommandCodeWorker } from "@clanov/orchestration-adapter-command-code";
import { OpenCodeWorker } from "@clanov/orchestration-adapter-opencode";
import type { WorkerAdapter } from "@clanov/orchestration-core";

export function loadEnvironment(): string | undefined {
  const envFile =
    process.env.ORCHESTRATION_ENV_FILE ??
    path.resolve(process.cwd(), ".env");

  if (!existsSync(envFile)) return undefined;

  loadEnvFile(envFile);
  return envFile;
}

export function createWorkersFromEnv(): WorkerAdapter[] {
  const workers: WorkerAdapter[] = [];

  const openCodeProvider = process.env.ORCHESTRATION_OPENCODE_PROVIDER;
  const openCodeModel = process.env.ORCHESTRATION_OPENCODE_MODEL;

  if (openCodeProvider && openCodeModel) {
    workers.push(
      new OpenCodeWorker({
        baseUrl:
          process.env.ORCHESTRATION_OPENCODE_URL ??
          "http://127.0.0.1:4096",
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
    const effort = parseAgyEffort(
      process.env.ORCHESTRATION_ANTIGRAVITY_EFFORT,
    );

    workers.push(
      new AntigravityWorker({
        command:
          process.env.ORCHESTRATION_ANTIGRAVITY_COMMAND ?? "agy",
        model: antigravityModel,
        ...(effort ? { effort } : {}),
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
          process.env.ORCHESTRATION_COMMAND_CODE_COMMAND ?? "cmd",
        model: commandCodeModel,
        effort:
          process.env.ORCHESTRATION_COMMAND_CODE_EFFORT ?? "high",
        allowMutations:
          process.env.ORCHESTRATION_COMMAND_CODE_ALLOW_MUTATIONS === "1",
        timeoutMs: parsePositiveInt(
          process.env.ORCHESTRATION_COMMAND_CODE_TIMEOUT_MS,
          600_000,
        ),
      }),
    );
  }

  return workers;
}

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
