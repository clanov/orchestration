# orchestration

A local-first coordination layer for coding agents.

Keep your strongest model in the lead. Delegate implementation to the coding agents and subscriptions you already use, preserve each worker's native session context, and return verified results instead of trusting "done" messages.

> Early alpha. The repository is being bootstrapped in private before its first public release.

## Why

Most multi-model systems treat models as interchangeable API endpoints. Coding agents are not just models: they have their own session state, tools, permissions, caches, and repository context.

orchestration keeps those native runtimes intact.

```text
Claude Code / another lead
        |
        | MCP
        v
+-------------------------+
|      orchestration      |
| sessions / routing /    |
| verification / policy   |
+-----------+-------------+
            |
    +-------+--------+
    |       |        |
    v       v        v
OpenCode   agy   Command Code
```

The project is inspired by the lead/sidekick pattern described by Cognition's Devin Fusion, but is independent and not affiliated with Cognition or Devin.

## Supported surfaces

Runtime adapters and model providers are intentionally separate.

| Type | Integration | Status |
| --- | --- | --- |
| Runtime | OpenCode | initial adapter |
| Runtime | Antigravity / `agy` | initial adapter |
| Runtime | Command Code | initial adapter |
| Provider credential | Gemini API key | detected via `GEMINI_API_KEY` |
| Provider credential | OpenAI API key | detected via `OPENAI_API_KEY` |
| Provider credential | OpenRouter API key | detected via `OPENROUTER_API_KEY` |

Provider credentials are **not** direct workers yet. They are credentials a native runtime can use. orchestration does not persist or proxy these keys.

## Design principles

- **Native runtimes, not a model proxy.** Workers stay inside OpenCode, Antigravity, Command Code, Codex, or other coding-agent runtimes.
- **Persistent workers.** Follow-ups resume the same native worker session instead of starting from zero.
- **Typed briefs.** The lead sends objective, constraints, acceptance criteria, and bounded context instead of copying its whole transcript.
- **Verify independently.** Tests, lint, and diffs are evidence; a worker's self-report is not.
- **Enforce safety in code.** Critical invariants belong in permissions and workspace isolation, not only prompts.
- **BYOS-friendly.** Reuse authenticated CLI tools and subscriptions where their terms and interfaces allow it.
- **Credentials stay native.** API keys remain in environment variables or the runtime that already owns authentication.

## v0.1 scope

The first vertical slice now includes:

1. MCP facade for a lead agent.
2. Shared worker/session contracts.
3. OpenCode adapter backed by the official OpenCode server/SDK.
4. Antigravity adapter backed by `agy` headless JSON mode.
5. Command Code adapter backed by headless NDJSON mode.
6. Persistent native session IDs across follow-up turns.
7. Provider credential registry for Gemini, OpenAI, and OpenRouter.

Async jobs, durable state, worktree isolation, verification receipts, and routing are planned next.

## Repository layout

```text
packages/
  core/                     Shared task/session/worker contracts
  providers/                Provider credential metadata/probing
  mcp/                      MCP facade exposed to lead agents
  adapters/
    opencode/               OpenCode worker adapter
    antigravity/            agy worker adapter
    command-code/           Command Code worker adapter

docs/
  ARCHITECTURE.md           Architecture and invariants
```

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run build
npm run typecheck
```

Copy `.env.example` and enable whichever native runtimes you want.

For OpenCode-backed workers, start a local OpenCode server:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Then configure the MCP process with the runtime's model/provider values. The MCP server enables only workers with enough configuration to run.

### Credentials

orchestration does not own provider logins.

- OpenCode authentication remains in OpenCode.
- Antigravity authentication remains in `agy`.
- Command Code authentication remains in Command Code.
- Gemini/OpenAI/OpenRouter API keys remain environment variables and can be consumed by the native runtime that supports them.

## Status

This is not ready for production use. The current goal is to validate runtime/session orchestration before adding routing heuristics or a UI.

## License

MIT
