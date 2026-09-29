# Architecture

## Purpose

orchestration is a local coordination layer between a lead coding agent and one or more native worker runtimes.

The project does **not** try to turn every model into the same chat-completions API. A worker is an agent runtime with its own tools, repository state, permissions, caches, and persistent conversation ID.

## Control flow

```text
User
  |
  v
Lead agent (for example Claude Code)
  |
  | MCP: delegate / follow_up / get_result / cancel
  v
orchestration
  |
  +--> worker adapter --> native runtime --> repository
  |
  +--> session registry
  |
  +--> verifier (planned)
  |
  +--> worktree manager (planned)
```

The lead owns judgment: planning, ambiguity, architectural decisions, and final review.

Workers own bounded execution: repository exploration, implementation, tests, refactors, and other well-specified tasks.

## Core invariants

1. **Native session continuity.** A follow-up must resume the same underlying worker session when the runtime supports it.
2. **No transcript mirroring by default.** Workers receive a typed brief, not the lead's entire conversation history.
3. **Worker self-reports are not proof.** Completion claims will eventually be paired with harness-owned verification receipts.
4. **Critical safety is enforced mechanically.** Worktree isolation, protected paths, destructive-command policy, and merge gates must live in code rather than only prompts.
5. **The lead remains authoritative.** A worker cannot decide that its own change is ready to merge.
6. **Adapters preserve runtime semantics.** An OpenCode adapter should use OpenCode sessions; an Antigravity adapter should use agy conversations. Avoid flattening them into a fake common model API.

## v0.1 state model

The first implementation is synchronous on purpose.

```text
delegate
  -> create native worker session
  -> execute one turn
  -> store orchestration session mapping
  -> return result

follow_up
  -> resolve orchestration session
  -> resume native worker session
  -> execute one turn
  -> return result
```

The MCP package keeps the orchestration-to-native session mapping in memory for now. Durable SQLite state and restart-safe jobs are planned after the contract is stable.

## Worker contract

Every adapter implements the same small interface:

```ts
interface WorkerAdapter {
  readonly name: string
  isAvailable(): Promise<boolean>
  start(input: StartWorkerInput): Promise<WorkerStartResult>
  followUp(session: WorkerSession, message: string): Promise<WorkerRunResult>
  getResult(session: WorkerSession): Promise<WorkerRunResult>
  cancel(session: WorkerSession): Promise<void>
}
```

The common contract intentionally does not expose provider-specific token knobs. Runtime-specific configuration belongs in each adapter's constructor.

## OpenCode adapter

OpenCode exposes a headless HTTP server and an official TypeScript SDK. v0.1 connects to an already-running server and uses session creation, persistent session IDs, prompt messages, session messages, and abort.

Reference: https://opencode.ai/docs/sdk/

## Antigravity adapter

Planned next.

agy has a machine-readable headless mode with JSON/NDJSON output and explicit conversation resume via `--conversation`. That is the intended integration point instead of scraping the TUI.

Reference: https://antigravity.google/docs/cli/headless/

## MCP surface

The initial MCP surface stays deliberately small:

- `delegate`
- `follow_up`
- `get_result`
- `cancel`

The MCP server uses stdio because the lead agent launches it as a local child process.

Reference: https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server.md

## Planned layers

1. git worktree isolation
2. verifier-owned test/lint/diff receipts
3. SQLite session/job persistence
4. async jobs and streaming progress
5. agy adapter
6. rule-based routing
7. execution telemetry and lead-rework metrics
8. adaptive routing based on observed task outcomes

Routing comes after instrumentation. The project should learn from completed work rather than inventing a complex router before it has data.
