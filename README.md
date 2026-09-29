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
       +----+----+
       |         |
       v         v
   OpenCode     agy
   DeepSeek     Gemini
```

The project is inspired by the lead/sidekick pattern described by Cognition's Devin Fusion, but is independent and not affiliated with Cognition or Devin.

## Design principles

- **Native runtimes, not a model proxy.** Workers stay inside OpenCode, Antigravity, Codex, or other coding-agent runtimes.
- **Persistent workers.** Follow-ups resume the same native worker session instead of starting from zero.
- **Typed briefs.** The lead sends objective, constraints, acceptance criteria, and bounded context instead of copying its whole transcript.
- **Verify independently.** Tests, lint, and diffs are evidence; a worker's self-report is not.
- **Enforce safety in code.** Critical invariants belong in permissions and workspace isolation, not only prompts.
- **BYOS-friendly.** Reuse authenticated CLI tools and subscriptions where their terms and interfaces allow it.

## v0.1 scope

The first vertical slice is intentionally small:

1. MCP facade for a lead agent.
2. Shared worker/session contracts.
3. OpenCode adapter backed by the official OpenCode server/SDK.
4. Persistent native session IDs.
5. A path toward worktree isolation and verification receipts.

Antigravity/agy support, async jobs, durable state, automatic routing, worktrees, and verification are planned next.

## Repository layout

```text
packages/
  core/                Shared task/session/worker contracts
  mcp/                 MCP facade exposed to lead agents
  adapters/
    opencode/          OpenCode worker adapter
    antigravity/       agy adapter placeholder

docs/
  ARCHITECTURE.md      Architecture and invariants
```

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run build
npm run typecheck
```

For OpenCode-backed workers, start a local OpenCode server:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

The adapter uses OpenCode's official TypeScript SDK and keeps the returned session ID for follow-up turns.

## Status

This is not ready for production use. The current goal is to validate the orchestration contract before adding routing heuristics or a UI.

## License

MIT
