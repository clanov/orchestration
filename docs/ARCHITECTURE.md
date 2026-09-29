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

## Worktree isolation and snapshots

For each delegated task:

1. Resolve the source git repository.
2. Capture current `HEAD` as an immutable `baseCommit`.
3. Capture tracked staged/unstaged changes as a binary git patch.
4. Capture non-ignored untracked files.
5. Create a detached worktree outside the source repository at `baseCommit`.
6. Apply the tracked patch and copy the untracked files into it.
7. Preserve the caller's relative subdirectory and launch the Sidekick there.

The Lead checkout is never stashed or mutated by this process.

This creates snapshot-at-delegation semantics:

```text
T0 source state ----------> Sidekick worktree A
       |
       | Lead continues editing
       v
T1 source state ----------> Sidekick worktree B
```

A and B can therefore start from different snapshots while the Lead continues working.

Ignored files are intentionally excluded. Dependency caches and build artifacts should be recreated or shared later through an explicit workspace optimization layer.

### Base-relative review

The captured `baseCommit` remains the review baseline. Diffs therefore include both source changes that existed at delegation time and changes subsequently made by the Sidekick. This is intentional: the isolated worktree represents the complete snapshot the Sidekick was asked to work from.

## Verification

After each successful Sidekick turn, orchestration enters `verifying`.

Verification order:

1. explicit `verificationCommands`
2. `git diff --check <baseCommit>`
3. capture the final changed/untracked file set
4. enforce `protectedPaths`

Project checks run before the final snapshot because tests, generators, or formatters may themselves alter the worktree.

Each command produces a receipt with command, exit code, duration, and bounded stdout/stderr tails.

If any command fails or a protected path was changed, state becomes `verification_failed`. The Lead can inspect the report and call `follow_up`; the same native Sidekick session and worktree are reused and then verified again.

## Execution topology

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

## Diff review

`get_diff` compares the current isolated worktree against its captured base commit.

It returns changed files, untracked files, diff stat, bounded patch text, and a truncation flag.

The patch is currently the Git-tracked diff. Untracked file names are reported separately; the Lead can inspect them directly through the returned worktree path.

## Native subagents

- OpenCode: subagents and Task permissions; nesting is configuration/runtime-defined.
- Antigravity: parallel native subagents; exact nesting is runtime-defined.
- Command Code: parallel subagents, one level deep.

All native child agents inherit the Sidekick runtime's isolated working directory semantics.

## Lead-question protocol

A Sidekick can stop its turn with the `orchestration_lead_query` envelope. The task moves to `waiting_for_lead`; `reply_to_worker` resumes the same native session.

## Remaining boundary

Worktree isolation prevents write races, and verifier receipts separate claims from evidence. Approved-change integration is intentionally not automatic yet.

A future apply/merge layer should compare the current Lead checkout against the task's `baseCommit`, surface conflicts, and only mutate the Lead workspace after explicit review.

## Planned layers

1. durable SQLite task/session/worktree registry
2. native streaming and subagent telemetry
3. guarded apply/merge with conflict detection
4. runtime/provider doctor command
5. rule-based routing and automatic escalation
6. execution telemetry and Lead-rework metrics
7. adaptive routing based on observed outcomes

Compaction-time model switching remains deferred.
