import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  renderTaskBrief,
  type StartWorkerInput,
  type WorkerAdapter,
  type WorkerCapabilities,
  type WorkerRunResult,
  type WorkerSession,
  type WorkerStartResult,
} from "@clanov/orchestration-core";

export interface CommandCodeWorkerOptions {
  command?: string;
  model: string;
  effort?: string;
  allowMutations?: boolean;
  timeoutMs?: number;
  maxTurns?: number;
}

interface CommandCodeResultFrame {
  type?: string;
  subtype?: "success" | "error" | "max_turns";
  sessionId?: string;
  stopReason?: string;
  finalText?: string;
  error?: string;
  usage?: unknown;
  durationMs?: number;
}

export class CommandCodeWorker implements WorkerAdapter {
  readonly name = "command-code";

  readonly capabilities: WorkerCapabilities = {
    persistentSession: true,
    parallelSubagents: true,
    subagents: {
      supported: true,
      nesting: "one-level",
    },
  };

  private readonly options: Required<
    Pick<
      CommandCodeWorkerOptions,
      "command" | "model" | "allowMutations" | "timeoutMs" | "maxTurns"
    >
  > &
    Pick<CommandCodeWorkerOptions, "effort">;

  private readonly last = new Map<string, WorkerRunResult>();

  constructor(options: CommandCodeWorkerOptions) {
    this.options = {
      command: options.command ?? "command-code",
      model: options.model,
      allowMutations: options.allowMutations ?? false,
      timeoutMs: options.timeoutMs ?? 600_000,
      maxTurns: options.maxTurns ?? 100,
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
    const frame = await this.run(
      renderTaskBrief(input.brief),
      input.cwd,
      undefined,
      input.model ?? this.options.model,
    );

    if (!frame.sessionId) {
      throw new Error(
        frame.error ?? "Command Code did not return a sessionId.",
      );
    }

    const session: WorkerSession = {
      id: randomUUID(),
      worker: this.name,
      nativeSessionId: frame.sessionId,
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
    };

    const result = this.toResult(session.id, frame);
    this.last.set(session.nativeSessionId, result);

    return { session, result };
  }

  async followUp(
    session: WorkerSession,
    message: string,
  ): Promise<WorkerRunResult> {
    const frame = await this.run(
      message,
      session.cwd,
      session.nativeSessionId,
      undefined,
    );

    const result = this.toResult(session.id, frame);
    this.last.set(session.nativeSessionId, result);
    return result;
  }

  async getResult(session: WorkerSession): Promise<WorkerRunResult> {
    return (
      this.last.get(session.nativeSessionId) ?? {
        sessionId: session.id,
        status: "failed",
        summary: "No Command Code result is cached for this session.",
      }
    );
  }

  async cancel(_session: WorkerSession): Promise<void> {
    // v0.2 owns process handles in the task runner. The adapter remains session-oriented.
  }

  private async run(
    prompt: string,
    cwd: string,
    sessionId: string | undefined,
    model: string | undefined,
  ): Promise<CommandCodeResultFrame> {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--max-turns",
      String(this.options.maxTurns),
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    if (model) {
      args.push("--model", model);
    }

    if (this.options.effort) {
      args.push("--effort", this.options.effort);
    }

    if (this.options.allowMutations) {
      args.push("--yolo");
    }

    const result = await runProcess(
      this.options.command,
      args,
      cwd,
      this.options.timeoutMs,
    );

    const frame = parseFinalResult(result.stdout);

    if (!frame) {
      return {
        type: "result",
        subtype: "error",
        error:
          result.stderr.trim() ||
          `Command Code exited with code ${result.exitCode} without a result frame.`,
        finalText: "",
      };
    }

    if (result.exitCode !== 0 && frame.subtype === "success") {
      return {
        ...frame,
        subtype: "error",
        error:
          result.stderr.trim() ||
          `Command Code exited with code ${result.exitCode}.`,
      };
    }

    return frame;
  }

  private toResult(
    orchestrationSessionId: string,
    frame: CommandCodeResultFrame,
  ): WorkerRunResult {
    const success = frame.subtype === "success";
    return {
      sessionId: orchestrationSessionId,
      status: success ? "completed" : "failed",
      summary: success ? frame.finalText : frame.error ?? frame.finalText,
      raw: frame,
    };
  }
}

function parseFinalResult(stdout: string): CommandCodeResultFrame | undefined {
  let result: CommandCodeResultFrame | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as CommandCodeResultFrame;
      if (parsed.type === "result") {
        result = parsed;
      }
    } catch {
      // Ignore non-JSON progress output for forward compatibility.
    }
  }

  return result;
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
