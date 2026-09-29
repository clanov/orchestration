# orchestration

A local-first Lead + Sidekick harness for coding agents.

Keep the strongest model in the Lead seat. Pair it with one persistent native coding-agent Sidekick that keeps its own context and worktree across handoffs. The Lead owns planning, ambiguity, judgment, and final review; the Sidekick explores, implements, tests, and responds to feedback.

> Early alpha.

## Model

```text
User
  |
  v
Lead
plan / judgment / review
  |
  | start_sidekick once
  v
Persistent Sidekick
same native session + same isolated worktree
  |
  +-- handoff: explore
  |
  +-- handoff: implement + test
  |
  +-- handoff: review feedback / fix
  |
  v
harness verification
  |
  v
Lead review
  |
prepare_apply -> explicit approval -> apply_to_lead
```

The project is inspired by Cognition's Devin Fusion lead/sidekick pattern, but is independent and not affiliated with Cognition or Devin.

The default abstraction is deliberately **not** a worker pool. One Lead workspace gets one persistent Sidekick. Runtime-native subagents may help with read-only exploration or verification, but parallel writers are not encouraged by default.

Dynamic model switching during context compaction is not implemented yet.

## Why one persistent Sidekick

The goal is to preserve two independent, useful contexts:

- the Lead keeps user intent, planning, and review context
- the Sidekick keeps implementation context across multiple handoffs
- only briefs, results, questions, and feedback cross the boundary

This avoids turning every subtask into a fresh agent session and keeps code-writing decisions from fragmenting across multiple workers.

## Minimal configuration

```env
ORCHESTRATION_SIDEKICK=antigravity
ORCHESTRATION_SIDEKICK_MODEL=gemini-3.8-flash-high
ORCHESTRATION_SIDEKICK_ALLOW_MUTATIONS=1
```

Supported runtimes:

| Runtime | `ORCHESTRATION_SIDEKICK` |
| --- | --- |
| OpenCode | `opencode` |
| Antigravity / `agy` | `antigravity` |
| Command Code | `command-code` |

Native runtime authentication stays native. Provider API keys are not required by orchestration itself.

Legacy runtime-specific environment variables are still accepted for compatibility. If multiple legacy runtimes are configured, orchestration selects the first reachable one before starting the MCP server and exposes only that Sidekick to the Lead.

## What is implemented

- one persistent Sidekick per Lead workspace
- automatic runtime selection before MCP startup
- persistent native runtime sessions
- Sidekick -> Lead judgment questions
- repeated Lead -> Sidekick handoffs in the same native session
- isolated git worktree per Sidekick session
- snapshot-at-start, including tracked and non-ignored untracked Lead changes
- Sidekick-only diffs
- harness-owned verification
- guarded two-phase apply back to the Lead workspace
- durable SQLite task/session state
- restart recovery

## MCP workflow

```text
sidekick_status
      |
start_sidekick       <- once for the workspace
      |
Lead keeps planning/reviewing
      |
get_events / get_result
      |
      +-- waiting_for_lead -> reply_to_sidekick
      |
      +-- completed / verification_failed
      |        |
      |      get_diff
      |        |
      |      handoff       <- same Sidekick/session/worktree
      |        |
      |       ...
      |
prepare_apply
      |
apply_to_lead(confirm=true)
      |
cleanup
```

The MCP surface intentionally does not ask the Lead to choose a runtime on every handoff.

## Guarded apply

`prepare_apply(taskId)` does not modify the Lead workspace. It computes only the Sidekick delta, fingerprints the current Lead state, runs `git apply --check`, and returns a one-use `planId`.

`apply_to_lead(taskId, planId, confirm=true)` recomputes both sides and rejects stale plans before applying. It never stages, commits, or pushes automatically.

## Verification

Every successful Sidekick turn triggers:

```text
verificationCommands
git diff --check <snapshotCommit>
protectedPaths check
```

Sidekick self-reports are advisory. The Lead should review the harness verification receipt and `get_diff`.

## Durable state

State is stored by default at:

```text
~/.orchestration/state.sqlite
```

If the MCP process stops during an active turn, the task is restored as `interrupted`. `resume_task` reuses the preserved worktree and, when known, the same native runtime session.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `sidekick_status` | Show the selected persistent Sidekick runtime |
| `list_tasks` | Durable Sidekick session history |
| `start_sidekick` | Start the Sidekick for a Lead workspace |
| `handoff` | Send the next brief or feedback to the same Sidekick |
| `get_events` | Read durable events |
| `get_result` | Inspect state and verification |
| `get_diff` | Review Sidekick-only changes |
| `reply_to_sidekick` | Answer a Sidekick judgment question |
| `resume_task` | Recover after MCP restart |
| `prepare_apply` | Preflight a verified delta |
| `apply_to_lead` | Explicit guarded apply |
| `cancel` | Cancel and preserve the worktree |
| `cleanup` | Remove an inactive worktree |
| `forget_task` | Delete cleaned-up durable history |

## Development

Requires Node.js 22.5+.

```bash
npm install
npm run build
npm run smoke
npm run doctor
```

See [docs/QUICKSTART.md](docs/QUICKSTART.md) for setup and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the state/integration model.

## License

MIT
