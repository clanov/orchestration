# Architecture

## Purpose

orchestration coordinates a frontier Lead with one or more persistent native coding-agent Sidekicks.

The Lead owns planning, ambiguity, architectural judgment, final review, and integration approval. Sidekicks execute bounded work in isolated git worktrees, can use native subagents, and can ask the Lead when judgment is required.

Dynamic model switching at compaction boundaries remains intentionally out of scope.

## Delegation snapshot

The source checkout may already contain uncommitted work. Delegation therefore captures a complete non-ignored repository snapshot without stashing or changing the Lead checkout.

```text
Lead HEAD + tracked dirty + untracked
                  |
                  v
          isolated worktree
                  |
                  v
        synthetic snapshot commit
```

The synthetic commit is created with an alternate temporary git index. It never changes the Lead branch or staging area.

All Sidekick diffs and verifier checks compare against `snapshotCommit`, not the original `baseCommit`. Therefore edits that already existed at delegation time are not attributed to the Sidekick.

## Concurrent topology

```text
                         Lead
                plan / judgment / review
                 /                  \
        delegate task A        delegate task B
              |                     |
              v                     v
      Worktree A snapshot     Worktree B snapshot
          Sidekick A              Sidekick B
           /     \                   |
      subagent subagent           subagent
              |
        lead question
              |
              +--------------------> Lead
```

Each task snapshots the Lead independently. Sidekick A and B may therefore begin from different source states if the Lead changed files between the two delegations.

## Verification

After a successful Sidekick turn:

1. run explicit `verificationCommands`
2. run `git diff --check <snapshotCommit>`
3. capture the final Sidekick delta
4. enforce `protectedPaths`

The worker's own "tests passed" statement does not affect verifier state.

A failed verifier result keeps the same Sidekick session and worktree available for `follow_up`.

## Guarded integration

Integration is a two-phase protocol.

### prepare_apply

Allowed only when:

```text
task.state == completed
verification.status == passed
```

The workspace layer creates a synthetic result commit from the Sidekick's current files and computes:

```text
Sidekick delta =
  diff(snapshotCommit, resultCommit)
```

This delta includes new/untracked files because the synthetic result commit is built from the whole non-ignored working tree.

The Lead workspace is fingerprinted with another temporary-index tree object:

```text
sourceHead
sourceTree
sourceDirty
```

Preflight then runs:

```text
git apply --check
```

against the Lead's current working tree.

The preview also reports:

- `headDiverged` — current Lead HEAD differs from delegation base HEAD
- `sourceChangedSinceDelegation` — current Lead content tree differs from the delegation snapshot
- `canApply`
- conflict reason, when present
- patch hash and affected files

No Lead file is changed during preflight.

### apply_to_lead

`prepare_apply` returns a random plan id. Applying requires:

```text
taskId
planId
confirm=true
```

Before mutation, orchestration recomputes both sides.

The operation is rejected if:

- task is no longer verified/completed
- Sidekick delta changed
- Lead `HEAD` changed
- Lead content fingerprint changed
- preflight no longer passes

This closes the review-to-apply race.

If guards still match, orchestration runs `git apply` against the Lead checkout.

It intentionally does **not** stage or commit the result. The Lead/human keeps ownership of the final git history.

## Durable state and restart recovery

Task state is persisted in SQLite after every state/event transition. The default database is:

```text
~/.orchestration/state.sqlite
```

Persisted state includes the worker name/model, task brief, native session id, worktree lease, verification history, event history, and guarded-apply plan. Worker secrets and API keys are never written into the database.

On process startup, completed/waiting/failed/applied tasks are restored as-is. A task that was active when the process stopped is restored as `interrupted` with its prior active state recorded in `interruptedFrom`.

`resume_task` then uses the preserved worktree. If a native session id was already known, it continues that same session. If the process died before a session id was recorded but the worktree exists, recovery can start a new native session in that preserved worktree. If no durable worktree was recorded, recovery refuses to silently take a new snapshot and the Lead must delegate a fresh task.

## State model

```text
queued
  -> preparing_workspace
  -> running
       -> waiting_for_lead
            -> running
       -> verifying
            -> completed
                 -> prepare_apply
                 -> applied
            -> verification_failed
                 -> running
       -> failed
       -> cancelled

active state + process restart
  -> interrupted
       -> resume_task
            -> running / verifying
```

`prepare_apply` itself leaves the state at `completed`; it only creates a one-use approval plan.

## Native subagents

- OpenCode: native subagents, nesting controlled by runtime permissions/configuration.
- Antigravity: parallel native subagents; exact nesting remains runtime-defined.
- Command Code: parallel native subagents, one level deep.

All child agents operate under the Sidekick runtime's isolated working directory.

## MCP surface

- `list_workers`
- `list_tasks`
- `delegate`
- `get_events`
- `get_result`
- `get_diff`
- `resume_task`
- `reply_to_worker`
- `follow_up`
- `prepare_apply`
- `apply_to_lead`
- `cancel`
- `cleanup`
- `forget_task`

## Safety invariants

1. Lead and Sidekick never share a writable checkout.
2. A Sidekick delta is measured from the exact delegation snapshot.
3. Verification is harness-owned.
4. Only verified tasks may enter apply preflight.
5. Preflight does not mutate the Lead workspace.
6. Apply requires an explicit, matching approval plan.
7. Lead/Sidekick changes after preflight invalidate that plan.
8. Apply never commits or stages automatically.
9. Provider credentials remain outside orchestration state.
10. Compaction-time model switching is deferred.

## Runtime readiness

Node 22.5+ is required for the built-in `node:sqlite` state store. `npm run doctor` checks Node/Git, the SQLite state database, configured native runtimes, and provider credential presence. CI builds the full TypeScript project and runs a smoke test that exercises dirty-source snapshotting, Sidekick-only diffs, guarded apply, and SQLite persistence.

## Planned layers

1. native streaming and subagent telemetry
2. rule-based routing and automatic escalation
3. execution telemetry and Lead-rework metrics
4. adaptive routing based on observed outcomes
