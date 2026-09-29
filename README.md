# orchestration

A local-first coordination layer for coding agents.

Keep your strongest model in the lead. Let persistent native coding-agent sidekicks execute in parallel, fan out to their own subagents, ask the lead when judgment is needed, and work in isolated git worktrees that the harness verifies independently.

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
```

The project is inspired by Cognition's lead/sidekick Fusion pattern, but is independent and not affiliated with Cognition or Devin.

Dynamic model switching during context compaction is deliberately **not implemented yet**.

## What is implemented

- **Asynchronous Lead + Sidekick execution.** `delegate` returns a task ID immediately.
- **Persistent sidekick sessions.** Lead replies and follow-ups resume the same native session.
- **Sidekick -> Lead questions.** Material judgment calls can enter `waiting_for_lead`.
- **Sidekick -> native Subagents.** Runtime-native agent hierarchies remain available.
- **Per-task git worktree isolation.** Every delegated task gets its own detached worktree.
- **Snapshot-at-delegation.** Tracked staged/unstaged changes plus non-ignored untracked files are copied into the Sidekick worktree without stashing or mutating the Lead checkout.
- **Harness-owned verification.** Explicit project checks, `git diff --check`, and protected-path checks run outside the sidekick's self-report.
- **Lead diff review.** `get_diff` exposes changed files, untracked files, diff stat, and a bounded patch.
- **Verification repair loop.** A failed verifier result can be sent back with `follow_up` while preserving the same sidekick session and worktree.

## Concurrent snapshot semantics

Delegation captures the Lead's repository state **at that moment**:

```text
Lead worktree at T0
  ├─ HEAD
  ├─ tracked staged/unstaged changes
  └─ non-ignored untracked files
          |
          | snapshot
          v
Sidekick isolated worktree

T1:
Lead keeps editing original checkout
Sidekick keeps editing isolated snapshot
```

This allows a Lead to keep working and to launch additional Sidekicks even when its own checkout has become dirty.

Ignored files such as dependency/build caches are not copied. A Sidekick may need the runtime/project setup step appropriate for a fresh worktree.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_workers` | Runtime and subagent capabilities |
| `delegate` | Start an isolated sidekick asynchronously |
| `get_events` | Monitor task/lead-question/verification events |
| `get_result` | Current task + verification state |
| `get_diff` | Review the sidekick worktree diff |
| `reply_to_worker` | Answer a Sidekick judgment question |
| `follow_up` | Continue the same Sidekick after review or verifier failure |
| `cancel` | Stop a delegated task, preserving its worktree |
| `cleanup` | Remove an inactive isolated worktree |

## Verification

The verifier does not trust a worker saying "tests pass".

Every completed worker turn triggers:

```text
each verificationCommands entry supplied in the brief
git diff --check <base>
protectedPaths check against the final worktree
```

Project checks run first because tests/formatters can themselves update files. The final diff and protected-path inspection happen afterwards.

A task only enters `completed` when these checks pass.

If they fail:

```text
running
  -> verifying
  -> verification_failed
       |
       | Lead reviews receipts
       v
    follow_up
       |
       v
    same Sidekick session/worktree
       |
       v
    verifying again
```

Verification commands are explicit commands supplied in the delegation brief. orchestration does not currently guess a project's test command.

## Worktree lifecycle

Worktrees default under the operating system temp directory:

```text
<tmp>/orchestration/worktrees/<repo>-<hash>/<task-id>
```

Override with:

```bash
ORCHESTRATION_WORKTREE_ROOT=/path/to/worktrees
```

Completed/failed/cancelled worktrees are preserved for review. Call `cleanup` when the Lead no longer needs them.

## Supported runtimes

| Runtime | Persistent session | Parallel subagents | Nesting |
| --- | ---: | ---: | --- |
| OpenCode | yes | yes | runtime/config-defined |
| Antigravity / `agy` | yes | yes | runtime-defined |
| Command Code | yes | yes | one level |

## Provider credentials

The provider registry detects, but does not persist:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`

Authentication remains owned by the native runtime/provider.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run build
npm run typecheck
```

## Status

The current safety boundary is now:

```text
Lead workspace != Sidekick workspace
Sidekick claim != verification result
```

Still planned: durable SQLite task state, native streaming/subagent telemetry, guarded merge/apply, and routing/escalation policy.

## License

MIT
