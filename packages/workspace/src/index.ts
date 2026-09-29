import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export interface WorktreeLease {
  taskId: string;
  repoRoot: string;
  sourceCwd: string;
  worktreeRoot: string;
  workerCwd: string;
  baseCommit: string;
  sourceWasDirty: boolean;
}

export interface WorktreeSnapshot {
  changedFiles: string[];
  untrackedFiles: string[];
  diffStat: string;
  patch: string;
  patchTruncated: boolean;
}

export interface GitWorktreeManagerOptions {
  rootDir?: string;
}

export class GitWorktreeManager {
  private readonly rootDir: string;

  constructor(options: GitWorktreeManagerOptions = {}) {
    this.rootDir =
      options.rootDir ??
      process.env.ORCHESTRATION_WORKTREE_ROOT ??
      path.join(tmpdir(), "orchestration", "worktrees");
  }

  async prepare(taskId: string, cwd: string): Promise<WorktreeLease> {
    const sourceCwd = path.resolve(cwd);
    const repoRoot = (
      await runGit(["rev-parse", "--show-toplevel"], sourceCwd)
    ).stdout.trim();

    if (!repoRoot) {
      throw new Error(`Could not resolve git repository for ${sourceCwd}.`);
    }

    const baseCommit = (
      await runGit(["rev-parse", "HEAD"], repoRoot)
    ).stdout.trim();

    const status = (
      await runGit(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        repoRoot,
      )
    ).stdout.trim();

    const sourceWasDirty = Boolean(status);

    // Capture the source worktree at delegation time. This includes tracked
    // staged + unstaged changes and non-ignored untracked files, without
    // mutating/stashing the Lead's checkout.
    const trackedPatch = (
      await runGit(["diff", "--binary", "HEAD", "--"], repoRoot)
    ).stdout;

    const untrackedFiles = splitLines(
      (
        await runGit(
          ["ls-files", "--others", "--exclude-standard"],
          repoRoot,
        )
      ).stdout,
    );

    const repoKey = createHash("sha256")
      .update(repoRoot)
      .digest("hex")
      .slice(0, 12);

    const repoName = path.basename(repoRoot).replace(/[^a-zA-Z0-9._-]/g, "_");
    const worktreeRoot = path.join(
      this.rootDir,
      `${repoName}-${repoKey}`,
      taskId,
    );

    await mkdir(path.dirname(worktreeRoot), { recursive: true });

    try {
      await runGit(
        ["worktree", "add", "--detach", worktreeRoot, baseCommit],
        repoRoot,
      );

      if (trackedPatch.trim()) {
        await runGit(
          ["apply", "--whitespace=nowarn", "-"],
          worktreeRoot,
          trackedPatch,
        );
      }

      await copyUntrackedFiles(repoRoot, worktreeRoot, untrackedFiles);
    } catch (error) {
      await runGit(
        ["worktree", "remove", "--force", worktreeRoot],
        repoRoot,
      ).catch(() => undefined);
      await rm(worktreeRoot, { recursive: true, force: true });
      throw error;
    }

    const relativeCwd = path.relative(repoRoot, sourceCwd);
    const workerCwd = relativeCwd
      ? path.join(worktreeRoot, relativeCwd)
      : worktreeRoot;

    return {
      taskId,
      repoRoot,
      sourceCwd,
      worktreeRoot,
      workerCwd,
      baseCommit,
      sourceWasDirty,
    };
  }

  async inspect(
    lease: WorktreeLease,
    maxPatchChars = 40_000,
  ): Promise<WorktreeSnapshot> {
    const tracked = splitLines(
      (
        await runGit(
          ["diff", "--name-only", lease.baseCommit, "--"],
          lease.worktreeRoot,
        )
      ).stdout,
    );

    const untrackedFiles = splitLines(
      (
        await runGit(
          ["ls-files", "--others", "--exclude-standard"],
          lease.worktreeRoot,
        )
      ).stdout,
    );

    const changedFiles = [...new Set([...tracked, ...untrackedFiles])].sort();

    const diffStat = (
      await runGit(
        ["diff", "--stat", lease.baseCommit, "--"],
        lease.worktreeRoot,
      )
    ).stdout.trim();

    const patchRaw = (
      await runGit(
        ["diff", "--binary", "--no-ext-diff", lease.baseCommit, "--"],
        lease.worktreeRoot,
      )
    ).stdout;

    const patchTruncated =
      maxPatchChars >= 0 && patchRaw.length > maxPatchChars;
    const patch =
      maxPatchChars < 0
        ? patchRaw
        : patchRaw.slice(0, Math.max(0, maxPatchChars));

    return {
      changedFiles,
      untrackedFiles,
      diffStat,
      patch,
      patchTruncated,
    };
  }

  async remove(lease: WorktreeLease): Promise<void> {
    try {
      await runGit(
        ["worktree", "remove", "--force", lease.worktreeRoot],
        lease.repoRoot,
      );
    } finally {
      await rm(lease.worktreeRoot, { recursive: true, force: true });
      await runGit(["worktree", "prune"], lease.repoRoot).catch(() => undefined);
    }
  }
}

async function copyUntrackedFiles(
  repoRoot: string,
  worktreeRoot: string,
  files: string[],
): Promise<void> {
  const worktreePrefix = path.resolve(worktreeRoot) + path.sep;

  for (const relativePath of files) {
    const source = path.resolve(repoRoot, relativePath);
    const destination = path.resolve(worktreeRoot, relativePath);

    if (
      destination !== path.resolve(worktreeRoot) &&
      !destination.startsWith(worktreePrefix)
    ) {
      throw new Error(
        `Refusing to copy untracked path outside worktree: ${relativePath}`,
      );
    }

    const stat = await lstat(source);
    await mkdir(path.dirname(destination), { recursive: true });

    if (stat.isSymbolicLink()) {
      const target = await readlink(source);
      await symlink(target, destination);
      continue;
    }

    if (stat.isFile()) {
      await copyFile(source, destination);
      await chmod(destination, stat.mode);
    }
  }
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  args: string[],
  cwd: string,
  input?: string,
): Promise<ProcessResult> {
  const result = await runProcess("git", args, cwd, input);

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `git ${args.join(" ")} failed with exit code ${result.exitCode}.`,
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  input?: string,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
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
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr || error.message,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.stdin.end(input);
  });
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
