# orchestration

A local-first coordination layer for coding agents.

Keep your strongest model in the lead. Let persistent native coding-agent sidekicks execute in parallel, fan out to their own subagents, ask the lead when judgment is needed, work in isolated git worktrees, and only bring verified changes back through an explicit guarded apply.

> Early alpha. The repository is being bootstrapped in private before its first public release.

## Model

```text
                         Lead
                plan / judgment / review
                    /              \
         async delegate        async delegate
              |                     |
              v                     v
        isolated worktree      isolated worktree
          Sidekick A             Sidekick B
           /     \                  |
      subagent subagent          subagent(s)
              \                     /
               +---- ask lead ------+

Sidekick result
  -> harness verify
  -> Lead review
  -> prepare_apply (no mutation)
  -> explicit Lead approval
  -> apply_to_lead
```

The project is inspired by Cognition's lead/sidekick Fusion pattern, but is independent and not affiliated with Cognition or Devin.

Dynamic model switching during context compaction is deliberately **not implemented yet**.

## What is implemented

- **Asynchronous Lead + Sidekick execution.**
- **Persistent Sidekick sessions.**
- **Sidekick -> Lead questions.**
- **Sidekick -> native Subagents.**
- **Per-task git worktree isolation.**
- **Snapshot-at-delegation**, including tracked staged/unstaged changes and non-ignored untracked files.
- **Sidekick-only diffs.** An immutable synthetic snapshot commit separates pre-existing Lead edits from changes authored after delegation.
- **Harness-owned verification.**
- **Two-phase guarded apply** back into the Lead workspace.
- **Durable SQLite task state.** Sessions, worktrees, verification receipts, apply plans, and event history survive MCP restarts.
- **Restart recovery.** Tasks active during a crash/restart become `interrupted` and can be continued with `resume_task`.

## Guarded apply

Applying a Sidekick result is deliberately two-phase.

### 1. Preflight

```text
prepare_apply(taskId)
```

This does **not** modify the Lead workspace. It:

- requires a completed task with passing harness verification
- computes only the Sidekick delta from the captured delegation snapshot
- fingerprints the current Lead `HEAD` and working-tree contents
- reports whether the Lead diverged since delegation
- runs `git apply --check` against the Lead's current files
- returns a one-use `planId`

Example result:

```text
canApply: true
headDiverged: true
sourceChangedSinceDelegation: true
sourceDirty: true
patchHash: ...
planId: ...
approvalRequired: true
```

Divergence is informational. If the Sidekick touched different lines/files, a patch may still apply cleanly.

### 2. Explicit approval

```text
apply_to_lead(
  taskId,
  planId,
  confirm=true
)
```

Before modifying anything, orchestration recomputes the Sidekick patch and Lead workspace fingerprint.

If either changed after preflight, the plan is rejected as stale and the Lead must run `prepare_apply` again.

Only then does it perform the patch apply. Changes are written into the Lead working tree but are **not automatically committed or staged**.

## Snapshot semantics

At delegation:

```text
Lead state at T0
  ├─ HEAD
  ├─ staged/unstaged tracked files
  └─ non-ignored untracked files
          |
          v
   synthetic snapshot commit
          |
          v
   isolated Sidekick worktree
```

The synthetic snapshot commit is not checked out on the Lead branch. It exists only as an immutable comparison point.

This fixes an important integration problem: if the Lead already had edits before delegation, those edits are not mistaken for Sidekick-authored changes when reviewing or applying the result.

## Verification

Every successful Sidekick turn triggers:

```text
verificationCommands
git diff --check <delegation snapshot>
protectedPaths check
```

A task reaches `completed` only after verification passes.

A verification failure can be returned to the same Sidekick/session/worktree with `follow_up`.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_workers` | Runtime and subagent capabilities |
| `list_tasks` | Durable task history and recovered tasks |
| `delegate` | Start an isolated Sidekick asynchronously |
| `get_events` | Monitor task and verification events |
| `get_result` | Inspect task state |
| `get_diff` | Review Sidekick-only delta |
| `resume_task` | Continue a task interrupted by an MCP restart |
| `reply_to_worker` | Answer a Sidekick judgment question |
| `follow_up` | Continue the same Sidekick |
| `prepare_apply` | Conflict/divergence preflight; no Lead mutation |
| `apply_to_lead` | Explicitly approved guarded apply |
| `cancel` | Cancel and preserve worktree |
| `cleanup` | Remove inactive worktree |
| `forget_task` | Delete cleaned-up durable task history |

## Worktree lifecycle

Worktrees default under:

```text
<tmp>/orchestration/worktrees/<repo>-<hash>/<task-id>
```

Override with:

```bash
ORCHESTRATION_WORKTREE_ROOT=/path/to/worktrees
```

## Supported runtimes

| Runtime | Persistent session | Parallel subagents | Nesting |
| --- | ---: | ---: | --- |
| OpenCode | yes | yes | runtime/config-defined |
| Antigravity / `agy` | yes | yes | runtime-defined |
| Command Code | yes | yes | one level |

## Provider credentials

Detected but not persisted:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run build
npm run typecheck
```

## Status

The current safety boundary is:

```text
Lead workspace != Sidekick workspace
Sidekick claim != verification result
review != apply
preflight != approval
```

State is stored by default in `~/.orchestration/state.sqlite`. Run `npm run doctor` before connecting your Lead, and see [docs/QUICKSTART.md](docs/QUICKSTART.md) for a ready-to-run setup.

Still planned: native streaming/subagent telemetry and automatic routing/escalation policy.

## License

MIT
