# Architecture

## Purpose

orchestration pairs a frontier Lead with one persistent native coding-agent Sidekick.

The Lead owns planning, ambiguity, architecture, judgment, final review, and integration approval. The Sidekick keeps its own implementation context and isolated worktree across repeated handoffs.

Dynamic model switching at compaction boundaries remains intentionally out of scope.

## Design basis

This shape follows the public Devin Fusion material more closely than a generic worker-pool design:

- Fusion is described as two parallel agents with separate persistent contexts and tools: a frontier Lead plus one cost-effective Sidekick.
- The Lead and Sidekick exchange briefs, results, and feedback rather than full transcripts.
- Cognition's 3,000-run analysis describes roughly three handoffs per run to the same persistent Sidekick, including exploration, implementation, and review feedback.
- Cognition separately warns that parallel writers fragment implicit decisions; its broader multi-agent guidance favors single-threaded writes unless work is genuinely independent.

Primary references:

- https://cognition.com/blog/devin-fusion
- https://cognition.com/blog/local-fusion
- https://cognition.com/blog/making-fable-cheaper-than-opus
- https://cognition.com/blog/multi-agents-working

## Session topology

```text
User
  |
  v
Lead
  |
  | first delegable handoff
  | (lazy create)
  v
Persistent Sidekick
same native session + same isolated worktree
  |
  +-- handoff: explore
  |      |
  |      +--> result
  |
  +-- handoff: implement / test
  |      |
  |      +--> result
  |
  +-- handoff: Lead review feedback
         |
         +--> revised result
```

A Lead should not map each bug, file, or CI failure to a fresh worker. The persistent Sidekick is the unit of collaboration.

The MCP process selects one reachable runtime before exposing the Sidekick. Runtime choice is therefore configuration, not a per-handoff Lead decision. A native Sidekick session/worktree is created only on the first `handoff`, so short or serial judgment-heavy work can remain entirely with the Lead.

## Initial snapshot

The source checkout may already contain uncommitted work. The first handoff captures a complete non-ignored repository snapshot without stashing or changing the Lead checkout.

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

All Sidekick diffs and verifier checks compare against `snapshotCommit`, not the original `baseCommit`. Pre-existing Lead edits are therefore not attributed to the Sidekick.

Every later `handoff` continues from this same worktree. The Sidekick delta is cumulative across the session.

## Handoff loop

The collaboration loop is intentionally small:

1. Lead decides there is actually delegable work and sends a brief with outcome, constraints, and success criteria. The first handoff lazily creates the persistent Sidekick.
2. Sidekick explores/implements/tests in its own context and worktree.
3. Sidekick leaves its changes uncommitted, returns the relevant result/diff, or asks a material judgment question.
4. Harness verifies the work independently.
5. Lead reviews the result/diff.
6. Lead either sends another `handoff`, answers with `reply_to_sidekick`, or prepares integration.

This lets the Lead remain expensive where judgment matters while avoiding repeated Lead-side implementation and rereading.

## Native subagents

Runtime-native subagents are not the primary orchestration layer.

By default the Sidekick is instructed to keep writes single-threaded. Native subagents may be useful for clean-context read-only exploration or verification, but parallel writing agents require an explicit Lead decision.

This avoids turning the Sidekick itself into another unmanaged worker swarm.

## Verification

After every successful Sidekick turn:

1. run explicit `verificationCommands`
2. run `git diff --check <snapshotCommit>`
3. capture the cumulative Sidekick delta
4. enforce `protectedPaths`

The Sidekick's own "tests passed" statement does not affect verifier state.

A failed verifier result keeps the same native session and worktree available for `handoff`.

## Guarded integration

Integration remains two-phase.

### prepare_apply

Allowed only when:

```text
task.state == completed
verification.status == passed
```

The workspace layer creates a synthetic result commit from the current Sidekick worktree and computes:

```text
Sidekick delta =
  diff(snapshotCommit, resultCommit)
```

The Lead workspace is fingerprinted with:

```text
sourceHead
sourceTree
sourceDirty
```

Preflight runs `git apply --check` against the current Lead working tree and returns a one-use plan id.

No Lead file changes during preflight.

### apply_to_lead

Applying requires:

```text
taskId
planId
confirm=true
```

Before mutation, orchestration recomputes both sides. It rejects the operation if the Sidekick delta, Lead HEAD, Lead content fingerprint, or apply preflight changed.

If guards still match, orchestration applies the patch to the Lead checkout. It does not stage, commit, or push.

## Durable state and restart recovery

State is persisted in SQLite after every state/event transition:

```text
~/.orchestration/state.sqlite
```

Persisted state includes the selected runtime name, task brief, native session id, worktree lease, verification history, event history, and guarded-apply plan. Runtime credentials are not persisted.

An active session restored after MCP restart becomes `interrupted`. `resume_task` reuses the preserved worktree and the native runtime session id when it was already known.

## State model

```text
queued
  -> preparing_workspace
  -> running
       -> waiting_for_lead
            -> running
       -> verifying
            -> completed
                 -> handoff -> running
                 -> prepare_apply -> applied
            -> verification_failed
                 -> handoff -> running
       -> failed
            -> handoff -> running
       -> cancelled

active state + process restart
  -> interrupted
       -> resume_task
            -> running / verifying
```

## MCP surface

- `sidekick_status`
- `list_tasks`
- `handoff` (lazy create + subsequent feedback)
- `get_events`
- `get_result`
- `get_diff`
- `reply_to_sidekick`
- `resume_task`
- `prepare_apply`
- `apply_to_lead`
- `cancel`
- `cleanup`
- `forget_task`

## Safety invariants

1. Lead and Sidekick never share a writable checkout.
2. One Lead workspace has one persistent writing Sidekick by default.
3. A Sidekick delta is measured from the exact initial snapshot.
4. Verification is harness-owned.
5. Only verified work may enter apply preflight.
6. Preflight does not mutate the Lead workspace.
7. Apply requires explicit matching approval.
8. Lead/Sidekick changes after preflight invalidate that approval.
9. Sidekick does not commit, push, merge, or rewrite history; final git integration stays with the Lead/human.
10. Apply never commits, stages, or pushes automatically.
11. Runtime credentials stay outside durable orchestration state.
12. Compaction-time model switching is deferred.

## Planned layers

1. native streaming and subagent telemetry
2. rule-based escalation and compaction-time routing
3. execution telemetry and Lead-rework metrics
4. explicit higher-level fan-out for genuinely independent work
