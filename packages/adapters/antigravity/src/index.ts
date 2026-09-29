import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  renderTaskBrief,
  type StartWorkerInput,
  type WorkerAdapter,
  type WorkerRunResult,
  type WorkerSession,
  type WorkerStartResult,
} from "@clanov/orchestration-core";

export interface AntigravityWorkerOptions {
  command?: string;
  model: string;
  effort?: "low" | "medium" | "high";
  allowMutations?: boolean;
  timeoutMs?: number;
}

interface AgyEnvelope {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  usage?: unknown;
}

export class AntigravityWorker implements WorkerAdapter {
  readonly name = "antigravity";

  private readonly options: Required<
    Pick<AntigravityWorkerOptions, "command" | "model" | "allowMutations" | "timeoutMs">
  > &
    Pick<AntigravityWorkerOptions, "effort">;

  private readonly last = new Map<string, WorkerRunResult>();

  constructor(options: AntigravityWorkerOptions) {
    this.options = {
      command: options.command ?? "agy",
      model: options.model,
      allowMutations: options.allowMutations ?? false,
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.effort ? { effort: options.effort } : {}),
    };
  }

  async isAvailable(): Promise<boolean> {
    const result = await runProcess(
      this.options.command,
      ["--help"],
      process.cwd(),
      5_000,
    );
    return result.exitCode === 0;
  }

  async start(input: StartWorkerInput): Promise<WorkerStartResult> {
    const envelope = await this.run(
      renderTaskBrief(input.brief),
      input.cwd,
      undefined,
      input.model ?? this.options.model,
    );

    if (!envelope.conversation_id) {
      throw new Error(
        envelope.error ?? "Antigravity did not return a conversation_id.",
      );
    }

    const session: WorkerSession = {
      id: randomUUID(),
      worker: this.name,
      nativeSessionId: envelope.conversation_id,
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
    };

    const result = this.toResult(session.id, envelope);
    this.last.set(session.nativeSessionId, result);

    return { session, result };
  }

  async followUp(
    session: WorkerSession,
    message: string,
  ): Promise<WorkerRunResult> {
    const envelope = await this.run(
      message,
      session.cwd,
      session.nativeSessionId,
      this.options.model,
    );
    const result = this.toResult(session.id, envelope);
    this.last.set(session.nativeSessionId, result);
    return result;
  }

  async getResult(session: WorkerSession): Promise<WorkerRunResult> {
    return (
      this.last.get(session.nativeSessionId) ?? {
        sessionId: session.id,
        status: "failed",
        summary: "No Antigravity result is cached for this session.",
      }
    );
  }

  async cancel(_session: WorkerSession): Promise<void> {
    // v0.1 is synchronous. Async job cancellation will own process handles later.
  }

  private async run(
    prompt: string,
    cwd: string,
    conversationId: string | undefined,
    model: string,
  ): Promise<AgyEnvelope> {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--model",
      model,
    ];

    if (this.options.effort) {
      args.push("--effort", this.options.effort);
    }

    if (conversationId) {
      args.push("--conversation", conversationId);
    }

    if (this.options.allowMutations) {
      args.push("--dangerously-skip-permissions");
    }

    const result = await runProcess(
      this.options.command,
      args,
      cwd,
      this.options.timeoutMs,
    );

    const text = result.stdout.trim();
    let envelope: AgyEnvelope = {};

    try {
      envelope = JSON.parse(text) as AgyEnvelope;
    } catch {
      envelope = {
        status: "ERROR",
        error:
          result.stderr.trim() ||
          text ||
          `agy exited with code ${result.exitCode}`,
      };
    }

    if (result.exitCode !== 0 && !envelope.error) {
      envelope.error =
        result.stderr.trim() || `agy exited with code ${result.exitCode}`;
    }

    return envelope;
  }

  private toResult(
    sessionId: string,
    envelope: AgyEnvelope,
  ): WorkerRunResult {
    const success = envelope.status === "SUCCESS";
    return {
      sessionId,
      status: success ? "completed" : "failed",
      summary: success ? envelope.response : envelope.error ?? envelope.response,
      raw: envelope,
    };
  }
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

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
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr || error.message,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
