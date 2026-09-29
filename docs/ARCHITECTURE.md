# Architecture

## Purpose

orchestration is a local coordination layer between a frontier lead and one or more native coding-agent sidekicks.

The current architecture implements the core Lead/Sidekick shape:

- Lead owns planning, ambiguity, architectural judgment, and final review.
- Sidekick owns bounded execution.
- Both keep independent persistent contexts.
- Lead and Sidekick run concurrently.
- Sidekick can ask the Lead instead of guessing through a material judgment call.
- Sidekick can use runtime-native subagents.
- Sidekick writes are isolated in per-task git worktrees.
- Completion is checked by a verifier owned by the orchestration harness.

Dynamic model switching at context compaction boundaries remains intentionally out of scope.

## Execution topology

```text
                         Lead
                plan / judgment / review
                 /                  \
        delegate task A        delegate task B
              |                     |
              v                     v
      Worktree A @ base X     Worktree B @ base X
          Sidekick A              Sidekick B
           /     \                   |
      subagent subagent           subagent
              |
        lead question
              |
              +--------------------> Lead
```

The original repository is not the sidekick's working directory.

## Worktree isolation

For each delegated task:

1. Resolve the source git repository.
2. Require a clean source worktree.
3. Capture the current `HEAD` as `baseCommit`.
4. Create a detached git worktree outside the source repository.
5. Preserve the caller's relative subdirectory inside that worktree.
6. Start the native sidekick with the isolated path as its `cwd`.

This means a Lead can continue changing the original worktree without racing the Sidekick's filesystem writes.

The tradeoff is deliberate: uncommitted changes that existed before delegation are not copied. Rather than silently lose that context, delegation fails until the source tree is clean.

### Why detached worktrees

Sidekicks do not need branch ownership yet. The base commit is stored explicitly and every review/verification diff is computed against that immutable base. This remains correct even if a native agent creates commits inside its detached worktree.

A later merge/apply layer can decide how approved work returns to the Lead branch.

## Verification

A Sidekick's "done" message is evidence of intent, not evidence of correctness.

After every successful Sidekick turn, orchestration enters `verifying` and runs:

1. `git diff --check <baseCommit>`
2. protected-path validation over all tracked and untracked changed paths
3. each explicit `verificationCommands` entry from the Lead's task brief

Each command produces a receipt:

```ts
interface VerificationReceipt {
  name: string
  command: string
  exitCode: number
  passed: boolean
  durationMs: number
  stdoutTail?: string
  stderrTail?: string
}
```

The aggregate report includes changed files, untracked files, diff stat, protected-path violations, and the command receipts.

If any check fails, task state becomes `verification_failed` rather than `completed`. The Lead can inspect the receipts and call `follow_up`; the same native Sidekick session and worktree are reused, then verification runs again.

## State model

```text
queued
  -> preparing_workspace
  -> running
       -> waiting_for_lead
            -> running
       -> verifying
            -> completed
            -> verification_failed
                 -> running
       -> failed
       -> cancelled
```

## Lead-question protocol

When a Sidekick needs a material judgment from the Lead, it ends its turn with:

```text
<orchestration_lead_query>
{"question":"...","context":"..."}
</orchestration_lead_query>
```

The harness detects that envelope and moves the task to `waiting_for_lead`.

`reply_to_worker` resumes the same native session with the Lead's answer.

## Diff review

`get_diff` reads the isolated worktree against its captured base commit.

It returns:

- changed files
- untracked files
- diff stat
- bounded patch text
- whether patch text was truncated

The Lead can request up to 200k patch characters. Large or binary/untracked artifacts should be inspected directly in the returned worktree path.

## Native subagents

orchestration preserves rather than reimplements native hierarchies:

- OpenCode: subagents and Task permissions; nesting is configuration/runtime-defined.
- Antigravity: parallel native subagents; exact nesting is runtime-defined.
- Command Code: parallel subagents, one level deep.

All child agents work inside the Sidekick's isolated worktree because the native runtime is launched there.

## Runtime vs provider

```text
Runtime
  OpenCode
  Antigravity / agy
  Command Code

Provider credential
  Gemini API key
  OpenAI API key
  OpenRouter API key
```

Runtime owns the coding-agent loop, tools, subagents, and native session. Provider credentials remain outside orchestration state.

## MCP surface

- `list_workers`
- `delegate`
- `get_events`
- `get_result`
- `get_diff`
- `reply_to_worker`
- `follow_up`
- `cancel`
- `cleanup`

## Remaining boundary

Worktree isolation solves concurrent writes, but **approved-change integration is not implemented yet**.

There is intentionally no automatic `apply` or `merge` tool today. The Lead should review the isolated diff first. A later apply layer should use the stored `baseCommit` to detect divergence/conflicts before touching the Lead worktree.

## Planned layers

1. durable SQLite task/session/worktree registry
2. native streaming and subagent telemetry
3. guarded apply/merge workflow with conflict detection
4. runtime/provider doctor command
5. rule-based routing and automatic escalation
6. execution telemetry and Lead-rework metrics
7. adaptive routing based on observed outcomes

Compaction-time model switching remains deferred.
