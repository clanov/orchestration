# Architecture

## Purpose

orchestration is a local coordination layer between a lead coding agent and one or more native worker runtimes.

The project does **not** try to turn every model into the same chat-completions API. A worker is an agent runtime with its own tools, repository state, permissions, caches, and persistent conversation ID.

## Runtime vs provider

These are different concepts and stay separate in the codebase.

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

A runtime owns the coding-agent loop and native session. A provider credential only gives a compatible runtime access to a model.

orchestration does not store provider secrets. The provider registry only describes expected environment variables and can report whether a credential appears to be configured.

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
6. **Adapters preserve runtime semantics.** OpenCode uses OpenCode sessions, agy uses conversations, and Command Code uses its session IDs.
7. **Provider secrets are not orchestration state.** Keys remain in environment variables or provider-native credential stores.

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

OpenCode exposes a headless HTTP server and an official TypeScript SDK. The adapter connects to an already-running server and uses native session creation, prompt messages, session messages, and abort.

Reference: https://opencode.ai/docs/sdk/

## Antigravity adapter

The agy adapter uses official headless JSON output. New tasks capture `conversation_id`; follow-ups use `--conversation <id>`.

Mutation permission is opt-in because headless automation can execute shell/file tools.

Reference: https://antigravity.google/docs/cli/headless/

## Command Code adapter

The Command Code adapter uses `-p --output-format json`, parses the final NDJSON result frame, and preserves its `sessionId`. Follow-ups resume with `--resume <id>`.

Mutation permission is opt-in. The full binary name `command-code` is the default so Windows does not collide with the built-in `cmd` shell.

Reference: https://commandcode.ai/docs/headless

## Provider registry

The initial provider registry recognizes:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`

It exposes metadata/probing only. Direct provider-backed coding workers are an explicit future layer because implementing them would require orchestration to own an agent tool loop.

## MCP surface

The initial MCP surface stays deliberately small:

- `delegate`
- `follow_up`
- `get_result`
- `cancel`

The MCP server uses stdio because the lead agent launches it as a local child process.

## Planned layers

1. git worktree isolation
2. verifier-owned test/lint/diff receipts
3. SQLite session/job persistence
4. async jobs and streaming progress
5. runtime/provider doctor command
6. rule-based routing
7. execution telemetry and lead-rework metrics
8. adaptive routing based on observed task outcomes

Routing comes after instrumentation. The project should learn from completed work rather than inventing a complex router before it has data.
