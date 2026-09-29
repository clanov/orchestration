# Architecture

## Purpose

orchestration is a local coordination layer between a frontier lead and one or more native coding-agent sidekicks.

The target interaction model is intentionally close to the useful part of Cognition's Fusion architecture:

- the lead owns planning, ambiguity, architectural judgment, and final review
- a sidekick owns bounded execution
- both keep independent persistent contexts
- they exchange briefs, results, feedback, and explicit judgment questions rather than mirroring whole transcripts
- lead and sidekick run concurrently
- a sidekick may use its native runtime's subagents

Dynamic model switching at compaction boundaries is intentionally **out of scope for now**.

## Hierarchy

```text
User
  |
  v
Lead (frontier model)
  | \
  |  \ keeps planning / monitoring / reviewing
  |   \
  |    +--------------------------+
  |                               |
  | delegate (async)              |
  v                               |
Sidekick (persistent context)     |
  |                               |
  +--> native subagent(s)         |
  |       exploration/tests/etc.  |
  |                               |
  +--> lead question -------------+
        when judgment is needed
```

The lead can delegate several independent sidekick tasks. A sidekick can fan out to native subagents when its runtime supports that capability.

## Lead-question protocol

A sidekick must not silently guess through a material judgment call.

When it needs the lead, it ends its current turn with:

```text
<orchestration_lead_query>
{"question":"...","context":"..."}
</orchestration_lead_query>
```

orchestration detects that envelope and moves the task to `waiting_for_lead`.

The lead sees a `lead_question` event through `get_events` / `get_result`, calls `reply_to_worker`, and orchestration resumes the **same native sidekick session**.

This is a cooperative checkpoint rather than a model-to-model API call: orchestration never needs the lead model's API key.

## Concurrency model

`delegate` is non-blocking from the lead's perspective:

```text
delegate
  -> allocate orchestration task id
  -> start native worker in background
  -> return immediately

lead
  -> continues planning / another task / monitoring

sidekick
  -> works independently
  -> completes, fails, or asks lead
```

The MCP surface exposes `get_events` so the lead can observe sidekick state without occupying the original delegation call.

Until worktree isolation lands, concurrent **writes** to the same files are unsafe. The lead should keep doing judgment/review work and avoid editing the delegated scope while that sidekick is active.

## Runtime vs provider

These remain separate concepts.

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

A runtime owns the coding-agent loop, tools, subagents, and native session. A provider credential only gives a compatible runtime access to a model.

orchestration does not store provider secrets.

## Sidekick -> subagent capabilities

Capabilities are exposed to the lead through `list_workers`.

- **OpenCode:** native subagents supported; nesting is runtime/configuration-defined. OpenCode's Task permissions determine whether a spawned agent may itself invoke another agent.
- **Antigravity:** parallel native subagents supported. The runtime controls the exact hierarchy.
- **Command Code:** parallel native subagents supported, but delegation is one level deep; subagents do not receive the agent-spawning tools.

orchestration does not reimplement these agent systems. It preserves them.

## Core invariants

1. **Frontier lead remains authoritative.**
2. **Native session continuity.**
3. **No whole-transcript mirroring by default.**
4. **Sidekicks may ask instead of guessing.**
5. **Lead and sidekick are concurrent, but writes must be isolated before true concurrent editing is safe.**
6. **Sidekick subagents use the native runtime's semantics and limits.**
7. **Worker self-reports are not proof.** Harness-owned verification receipts are still planned.
8. **Provider secrets are not orchestration state.**
9. **No dynamic compaction-time model switching yet.**

## MCP surface

- `list_workers` — runtime capabilities
- `delegate` — asynchronously start a sidekick
- `get_result` — inspect current task state
- `get_events` — inspect incremental task events
- `reply_to_worker` — answer a sidekick judgment question
- `follow_up` — resume a completed persistent sidekick with feedback
- `cancel` — cancel a task

## State model

```text
queued
  -> running
       -> waiting_for_lead
            -> running
       -> completed
       -> failed
       -> cancelled
```

The current task registry remains in memory. SQLite persistence is still planned.

## Planned layers

1. git worktree isolation
2. verifier-owned test/lint/diff receipts
3. SQLite task/session persistence
4. native streaming/subagent telemetry
5. runtime/provider doctor command
6. rule-based routing and escalation
7. execution telemetry and lead-rework metrics
8. adaptive routing based on observed outcomes

Compaction-time model switching is deliberately deferred.
