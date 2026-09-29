import { spawn } from "node:child_process";
import type { TaskBrief } from "@clanov/orchestration-core";
import {
  GitWorktreeManager,
  type WorktreeLease,
} from "@clanov/orchestration-workspace";

export interface VerificationReceipt {
  name: string;
  command: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface VerificationReport {
  status: "passed" | "failed";
  startedAt: string;
  completedAt: string;
  changedFiles: string[];
  untrackedFiles: string[];
  diffStat: string;
  protectedPathViolations: string[];
  checks: VerificationReceipt[];
}

export interface VerifierOptions {
  commandTimeoutMs?: number;
  outputTailChars?: number;
}

export class WorktreeVerifier {
  private readonly workspace: GitWorktreeManager;
  private readonly commandTimeoutMs: number;
  private readonly outputTailChars: number;

  constructor(
    workspace: GitWorktreeManager,
    options: VerifierOptions = {},
  ) {
    this.workspace = workspace;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 300_000;
    this.outputTailChars = options.outputTailChars ?? 6_000;
  }

  async verify(
    lease: WorktreeLease,
    brief: TaskBrief,
  ): Promise<VerificationReport> {
    const startedAt = new Date().toISOString();
    const checks: VerificationReceipt[] = [];

    // Explicit project checks may themselves generate or update files, so they
    // run before the final diff snapshot/protected-path inspection.
    for (const command of brief.verificationCommands ?? []) {
      checks.push(
        await runShellCheck(
          command,
          lease.workerCwd,
          this.commandTimeoutMs,
          this.outputTailChars,
        ),
      );
    }

    checks.push(
      await runExecutableCheck(
        "git diff --check",
        "git",
        ["diff", "--check", lease.baseCommit, "--"],
        lease.worktreeRoot,
        this.commandTimeoutMs,
        this.outputTailChars,
      ),
    );

    const snapshot = await this.workspace.inspect(lease, 0);

    const protectedPathViolations = findProtectedPathViolations(
      snapshot.changedFiles,
      brief.protectedPaths ?? [],
    );

    return {
      status:
        checks.every((check) => check.passed) &&
        protectedPathViolations.length === 0
          ? "passed"
          : "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      changedFiles: snapshot.changedFiles,
      untrackedFiles: snapshot.untrackedFiles,
      diffStat: snapshot.diffStat,
      protectedPathViolations,
      checks,
    };
  }
}

async function runExecutableCheck(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  outputTailChars: number,
): Promise<VerificationReceipt> {
  const started = Date.now();
  const result = await runProcess(command, args, cwd, timeoutMs, false);

  return {
    name,
    command: [command, ...args].join(" "),
    exitCode: result.exitCode,
    passed: result.exitCode === 0 && !result.timedOut,
    durationMs: Date.now() - started,
    ...(tail(result.stdout, outputTailChars)
      ? { stdoutTail: tail(result.stdout, outputTailChars) }
      : {}),
    ...(tail(result.stderr, outputTailChars)
      ? { stderrTail: tail(result.stderr, outputTailChars) }
      : {}),
  };
}

async function runShellCheck(
  command: string,
  cwd: string,
  timeoutMs: number,
  outputTailChars: number,
): Promise<VerificationReceipt> {
  const started = Date.now();
  const result = await runProcess(command, [], cwd, timeoutMs, true);

  return {
    name: command,
    command,
    exitCode: result.exitCode,
    passed: result.exitCode === 0 && !result.timedOut,
    durationMs: Date.now() - started,
    ...(tail(result.stdout, outputTailChars)
      ? { stdoutTail: tail(result.stdout, outputTailChars) }
      : {}),
    ...(tail(result.stderr, outputTailChars)
      ? { stderrTail: tail(result.stderr, outputTailChars) }
      : {}),
  };
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  shell: boolean,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
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
        timedOut,
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
        timedOut,
      });
    });
  });
}

function findProtectedPathViolations(
  changedFiles: string[],
  protectedPaths: string[],
): string[] {
  if (protectedPaths.length === 0) return [];

  const normalizedProtected = protectedPaths
    .map(normalizeRepoPath)
    .filter(Boolean);

  return changedFiles.filter((file) => {
    const normalizedFile = normalizeRepoPath(file);

    return normalizedProtected.some(
      (protectedPath) =>
        normalizedFile === protectedPath ||
        normalizedFile.startsWith(`${protectedPath}/`),
    );
  });
}

function normalizeRepoPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

function tail(value: string, maxChars: number): string {
  if (!value) return "";
  if (value.length <= maxChars) return value.trim();
  return value.slice(value.length - maxChars).trim();
}
