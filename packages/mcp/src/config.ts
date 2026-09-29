import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import * as path from "node:path";
import { AntigravityWorker } from "@clanov/orchestration-adapter-antigravity";
import { CommandCodeWorker } from "@clanov/orchestration-adapter-command-code";
import { OpenCodeWorker } from "@clanov/orchestration-adapter-opencode";
import type { WorkerAdapter } from "@clanov/orchestration-core";

type SidekickRuntime = "opencode" | "antigravity" | "command-code";

export function loadEnvironment(): string | undefined {
  const envFile =
    process.env.ORCHESTRATION_ENV_FILE ??
    path.resolve(process.cwd(), ".env");

  if (!existsSync(envFile)) return undefined;

  loadEnvFile(envFile);
  return envFile;
}

export function createWorkersFromEnv(): WorkerAdapter[] {
  const runtime = process.env.ORCHESTRATION_SIDEKICK?.trim();

  if (runtime) {
    if (!isSidekickRuntime(runtime)) {
      throw new Error(
        `Unknown ORCHESTRATION_SIDEKICK="${runtime}". Use opencode, antigravity, or command-code.`,
      );
    }
    return [createUnifiedSidekick(runtime)];
  }

  // Backward-compatible discovery for pre-0.5 configuration. The MCP process
  // still selects exactly one available runtime before exposing the Sidekick.
  return createLegacyWorkers();
}

export async function selectAvailableSidekick(
  workers: WorkerAdapter[],
): Promise<WorkerAdapter | undefined> {
  for (const worker of workers) {
    try {
      if (await worker.isAvailable()) return worker;
    } catch {
      // Try the next configured runtime.
    }
  }
  return undefined;
}

function createUnifiedSidekick(runtime: SidekickRuntime): WorkerAdapter {
  const model = requiredEnv("ORCHESTRATION_SIDEKICK_MODEL");
  const effort = process.env.ORCHESTRATION_SIDEKICK_EFFORT;
  const command = process.env.ORCHESTRATION_SIDEKICK_COMMAND;
  const timeoutMs = parsePositiveInt(
    process.env.ORCHESTRATION_SIDEKICK_TIMEOUT_MS,
    600_000,
  );
  const allowMutations = parseBoolean(
    process.env.ORCHESTRATION_SIDEKICK_ALLOW_MUTATIONS,
  );

  switch (runtime) {
    case "opencode": {
      const spec = resolveOpenCodeModel(undefined, model);
      if (!spec) {
        throw new Error(
          "ORCHESTRATION_SIDEKICK_MODEL must be provider/model for OpenCode.",
        );
      }

      return new OpenCodeWorker({
        baseUrl:
          process.env.ORCHESTRATION_SIDEKICK_URL ??
          "http://127.0.0.1:4096",
        providerID: spec.providerID,
        modelID: spec.modelID,
        ...(process.env.ORCHESTRATION_SIDEKICK_AGENT
          ? { agent: process.env.ORCHESTRATION_SIDEKICK_AGENT }
          : {}),
      });
    }

    case "antigravity": {
      const agyEffort = parseAgyEffort(effort);
      return new AntigravityWorker({
        ...(command ? { command } : {}),
        model,
        ...(agyEffort ? { effort: agyEffort } : {}),
        allowMutations,
        timeoutMs,
      });
    }

    case "command-code":
      return new CommandCodeWorker({
        ...(command ? { command } : {}),
        model,
        ...(effort ? { effort } : {}),
        allowMutations,
        timeoutMs,
      });
  }
}

function createLegacyWorkers(): WorkerAdapter[] {
  const workers: WorkerAdapter[] = [];

  const openCodeSpec = resolveOpenCodeModel(
    process.env.ORCHESTRATION_OPENCODE_PROVIDER,
    process.env.ORCHESTRATION_OPENCODE_MODEL,
  );

  if (openCodeSpec) {
    workers.push(
      new OpenCodeWorker({
        baseUrl:
          process.env.ORCHESTRATION_OPENCODE_URL ??
          "http://127.0.0.1:4096",
        providerID: openCodeSpec.providerID,
        modelID: openCodeSpec.modelID,
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

function isSidekickRuntime(value: string): value is SidekickRuntime {
  return (
    value === "opencode" ||
    value === "antigravity" ||
    value === "command-code"
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true";
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

function resolveOpenCodeModel(
  provider: string | undefined,
  model: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;

  if (provider) {
    return { providerID: provider, modelID: model };
  }

  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return undefined;
  }

  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}
