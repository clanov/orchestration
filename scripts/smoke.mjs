import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SqliteStateStore } from "../packages/state/dist/index.js";
import { GitWorktreeManager } from "../packages/workspace/dist/index.js";

const root = mkdtempSync(path.join(tmpdir(), "orchestration-smoke-"));
const repo = path.join(root, "repo");
const worktrees = path.join(root, "worktrees");
mkdirSync(repo, { recursive: true });

try {
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "smoke@example.com"], repo);
  git(["config", "user.name", "Smoke Test"], repo);

  writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(["add", "a.txt"], repo);
  git(["commit", "-m", "base"], repo);

  writeFileSync(path.join(repo, "a.txt"), "lead dirty\n");
  writeFileSync(path.join(repo, "lead.txt"), "lead-only\n");

  const manager = new GitWorktreeManager({ rootDir: worktrees });
  const lease = await manager.prepare("smoke-task", repo);

  assert.equal(lease.sourceWasDirty, true);

  const initial = await manager.inspect(lease);
  assert.deepEqual(initial.changedFiles, []);

  writeFileSync(path.join(lease.worktreeRoot, "a.txt"), "sidekick\n");
  writeFileSync(path.join(lease.worktreeRoot, "new.txt"), "new\n");

  const diff = await manager.inspect(lease);
  assert.deepEqual(diff.changedFiles, ["a.txt", "new.txt"]);
  assert.equal(diff.patchTruncated, false);

  const preview = await manager.prepareApply(lease);
  assert.equal(preview.canApply, true);
  assert.equal(preview.sourceChangedSinceDelegation, false);

  const applied = await manager.applyPrepared(lease, {
    patchHash: preview.patchHash,
    sourceHead: preview.sourceHead,
    sourceTree: preview.sourceTree,
  });

  assert.equal(applied.applied, true);
  assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "sidekick\n");
  assert.equal(readFileSync(path.join(repo, "lead.txt"), "utf8"), "lead-only\n");
  assert.equal(readFileSync(path.join(repo, "new.txt"), "utf8"), "new\n");

  const dbPath = path.join(root, "state.sqlite");
  const state = new SqliteStateStore({ path: dbPath });
  state.put("task", JSON.stringify({ ok: true }));
  assert.equal(state.list().length, 1);
  assert.equal(state.list()[0]?.id, "task");
  state.delete("task");
  assert.equal(state.list().length, 0);
  state.close();

  await manager.remove(lease);

  console.log("orchestration smoke test: OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function git(args, cwd) {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
  });
}
