#!/usr/bin/env node

import { spawn } from "node:child_process";
import { detectProviderCredentials } from "@clanov/orchestration-providers";
import { SqliteStateStore } from "@clanov/orchestration-state";
import { createWorkersFromEnv, loadEnvironment } from "./config.js";

const envFile = loadEnvironment();
const workers = createWorkersFromEnv();
const rows: Array<[string, string]> = [];

rows.push(["Node", process.version]);

const git = await commandOk("git", ["--version"]);
rows.push(["Git", git.ok ? git.output : `FAIL: ${git.output}`]);

try {
  const state = new SqliteStateStore();
  rows.push(["SQLite state", `OK: ${state.path}`]);
  rows.push(["Persisted tasks", String(state.list().length)]);
  state.close();
} catch (error) {
  rows.push([
    "SQLite state",
    `FAIL: ${error instanceof Error ? error.message : String(error)}`,
  ]);
}

rows.push(["Environment", envFile ?? "no .env loaded"]);

const workerAvailability: boolean[] = [];
if (workers.length === 0) {
  rows.push(["Workers", "FAIL: none configured"]);
} else {
  for (const worker of workers) {
    let available = false;
    try {
      available = await worker.isAvailable();
    } catch {
      available = false;
    }
    workerAvailability.push(available);

    rows.push([
      `Worker ${worker.name}`,
      available ? "OK" : "FAIL: configured but unavailable",
    ]);
  }
}

for (const provider of detectProviderCredentials()) {
  rows.push([
    `Provider ${provider.id}`,
    provider.configured ? "credential detected" : "not configured",
  ]);
}

const width = Math.max(...rows.map(([name]) => name.length));
for (const [name, value] of rows) {
  console.log(`${name.padEnd(width)}  ${value}`);
}

if (!git.ok || !workerAvailability.some(Boolean)) {
  process.exitCode = 1;
}

function commandOk(
  command: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, output: error.message });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const output = (stdout || stderr).trim();
      resolve({ ok: code === 0, output });
    });
  });
}
