import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
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
  snapshotCommit: string;
  sourceWasDirty: boolean;
}

export interface WorktreeSnapshot {
  changedFiles: string[];
  untrackedFiles: string[];
  diffStat: string;
  patch: string;
  patchTruncated: boolean;
}

export interface ApplyPreview {
  resultCommit: string;
  patchHash: string;
  patchBytes: number;
  changedFiles: string[];
  diffStat: string;
  sourceHead: string;
  sourceTree: string;
  sourceDirty: boolean;
  headDiverged: boolean;
  sourceChangedSinceDelegation: boolean;
  canApply: boolean;
  conflictReason?: string;
}

export interface ApplyGuard {
  patchHash: string;
  sourceHead: string;
  sourceTree: string;
}

export interface ApplyResult {
  applied: boolean;
  changedFiles: string[];
  patchHash: string;
  sourceHeadBefore: string;
  sourceTreeBefore: string;
  sourceTreeAfter: string;
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

    // Capture tracked staged + unstaged changes relative to HEAD.
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

      // This synthetic commit is never checked out. It gives us an immutable
      // tree for the exact Lead snapshot at delegation time, including dirty
      // and untracked files, without touching the Lead's index or branch.
      const snapshot = await captureWorkingTree(
        worktreeRoot,
        baseCommit,
        `orchestration snapshot ${taskId}`,
      );

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
        snapshotCommit: snapshot.commit,
        sourceWasDirty,
      };
    } catch (error) {
      await runGit(
        ["worktree", "remove", "--force", worktreeRoot],
        repoRoot,
      ).catch(() => undefined);
      await rm(worktreeRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async inspect(
    lease: WorktreeLease,
    maxPatchChars = 40_000,
  ): Promise<WorktreeSnapshot> {
    const result = await captureWorkingTree(
      lease.worktreeRoot,
      lease.snapshotCommit,
      `orchestration result ${lease.taskId}`,
    );

    const changedFiles = splitLines(
      (
        await runGit(
          [
            "diff",
            "--name-only",
            lease.snapshotCommit,
            result.commit,
            "--",
          ],
          lease.worktreeRoot,
        )
      ).stdout,
    );

    const currentlyUntracked = new Set(
      splitLines(
        (
          await runGit(
            ["ls-files", "--others", "--exclude-standard"],
            lease.worktreeRoot,
          )
        ).stdout,
      ),
    );

    const untrackedFiles = changedFiles.filter((file) =>
      currentlyUntracked.has(file),
    );

    const diffStat = (
      await runGit(
        [
          "diff",
          "--stat",
          lease.snapshotCommit,
          result.commit,
          "--",
        ],
        lease.worktreeRoot,
      )
    ).stdout.trim();

    const patchRaw = (
      await runGit(
        [
          "diff",
          "--binary",
          "--no-ext-diff",
          lease.snapshotCommit,
          result.commit,
          "--",
        ],
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

  async prepareApply(lease: WorktreeLease): Promise<ApplyPreview> {
    const material = await this.buildApplyMaterial(lease);
    return material.preview;
  }

  async applyPrepared(
    lease: WorktreeLease,
    guard: ApplyGuard,
  ): Promise<ApplyResult> {
    const material = await this.buildApplyMaterial(lease);
    const preview = material.preview;

    if (
      preview.patchHash !== guard.patchHash ||
      preview.sourceHead !== guard.sourceHead ||
      preview.sourceTree !== guard.sourceTree
    ) {
      throw new Error(
        "Apply plan is stale: the Lead workspace or Sidekick result changed after prepare_apply. Run prepare_apply again.",
      );
    }

    if (!preview.canApply) {
      throw new Error(
        preview.conflictReason ??
          "Sidekick patch does not apply cleanly to the current Lead workspace.",
      );
    }

    if (material.patch.length === 0) {
      return {
        applied: false,
        changedFiles: [],
        patchHash: preview.patchHash,
        sourceHeadBefore: preview.sourceHead,
        sourceTreeBefore: preview.sourceTree,
        sourceTreeAfter: preview.sourceTree,
      };
    }

    // Recheck immediately before mutation.
    const preflight = await runProcess(
      "git",
      ["apply", "--check", "--whitespace=nowarn", "-"],
      lease.repoRoot,
      material.patch,
    );

    if (preflight.exitCode !== 0) {
      throw new Error(
        preflight.stderr.trim() ||
          "Sidekick patch no longer applies cleanly to the Lead workspace.",
      );
    }

    await runGit(
      ["apply", "--whitespace=nowarn", "-"],
      lease.repoRoot,
      material.patch,
    );

    const after = await captureSourceState(lease.repoRoot);

    return {
      applied: true,
      changedFiles: preview.changedFiles,
      patchHash: preview.patchHash,
      sourceHeadBefore: preview.sourceHead,
      sourceTreeBefore: preview.sourceTree,
      sourceTreeAfter: after.tree,
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

  private async buildApplyMaterial(
    lease: WorktreeLease,
  ): Promise<{ preview: ApplyPreview; patch: string }> {
    const result = await captureWorkingTree(
      lease.worktreeRoot,
      lease.snapshotCommit,
      `orchestration apply result ${lease.taskId}`,
    );

    const patch = (
      await runGit(
        [
          "diff",
          "--binary",
          "--no-ext-diff",
          lease.snapshotCommit,
          result.commit,
          "--",
        ],
        lease.worktreeRoot,
      )
    ).stdout;

    const changedFiles = splitLines(
      (
        await runGit(
          [
            "diff",
            "--name-only",
            lease.snapshotCommit,
            result.commit,
            "--",
          ],
          lease.worktreeRoot,
        )
      ).stdout,
    );

    const diffStat = (
      await runGit(
        [
          "diff",
          "--stat",
          lease.snapshotCommit,
          result.commit,
          "--",
        ],
        lease.worktreeRoot,
      )
    ).stdout.trim();

    const source = await captureSourceState(lease.repoRoot);
    const snapshotTree = (
      await runGit(
        ["rev-parse", `${lease.snapshotCommit}^{tree}`],
        lease.repoRoot,
      )
    ).stdout.trim();

    const patchHash = createHash("sha256").update(patch).digest("hex");

    let canApply = true;
    let conflictReason: string | undefined;

    if (patch.length > 0) {
      const preflight = await runProcess(
        "git",
        ["apply", "--check", "--whitespace=nowarn", "-"],
        lease.repoRoot,
        patch,
      );

      canApply = preflight.exitCode === 0;
      if (!canApply) {
        conflictReason =
          preflight.stderr.trim() ||
          "git apply --check rejected the Sidekick patch.";
      }
    }

    return {
      preview: {
        resultCommit: result.commit,
        patchHash,
        patchBytes: Buffer.byteLength(patch),
        changedFiles,
        diffStat,
        sourceHead: source.head,
        sourceTree: source.tree,
        sourceDirty: source.dirty,
        headDiverged: source.head !== lease.baseCommit,
        sourceChangedSinceDelegation: source.tree !== snapshotTree,
        canApply,
        ...(conflictReason ? { conflictReason } : {}),
      },
      patch,
    };
  }
}

interface WorkingTreeCapture {
  tree: string;
  commit: string;
}

interface SourceState {
  head: string;
  tree: string;
  dirty: boolean;
}

async function captureSourceState(repoRoot: string): Promise<SourceState> {
  const head = (
    await runGit(["rev-parse", "HEAD"], repoRoot)
  ).stdout.trim();

  const status = (
    await runGit(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      repoRoot,
    )
  ).stdout.trim();

  const capture = await captureWorkingTree(
    repoRoot,
    head,
    `orchestration source fingerprint ${randomUUID()}`,
  );

  return {
    head,
    tree: capture.tree,
    dirty: Boolean(status),
  };
}

async function captureWorkingTree(
  cwd: string,
  parentCommit: string,
  message: string,
): Promise<WorkingTreeCapture> {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), "orchestration-index-"),
  );
  const indexFile = path.join(tempDir, "index");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: "orchestration",
    GIT_AUTHOR_EMAIL: "orchestration@localhost",
    GIT_COMMITTER_NAME: "orchestration",
    GIT_COMMITTER_EMAIL: "orchestration@localhost",
  };

  try {
    await runGitWithEnv(["read-tree", parentCommit], cwd, env);
    await runGitWithEnv(["add", "-A", "--", "."], cwd, env);

    const tree = (
      await runGitWithEnv(["write-tree"], cwd, env)
    ).stdout.trim();

    const commit = (
      await runGitWithEnv(
        ["commit-tree", tree, "-p", parentCommit, "-m", message],
        cwd,
        env,
      )
    ).stdout.trim();

    return { tree, commit };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function copyUntrackedFiles(
  repoRoot: string,
  worktreeRoot: string,
  files: string[],
): Promise<void> {
  const worktreeResolved = path.resolve(worktreeRoot);
  const worktreePrefix = worktreeResolved + path.sep;

  for (const relativePath of files) {
    const source = path.resolve(repoRoot, relativePath);
    const destination = path.resolve(worktreeRoot, relativePath);

    if (
      destination !== worktreeResolved &&
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

async function runGitWithEnv(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  const result = await runProcess("git", args, cwd, undefined, env);

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
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
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
