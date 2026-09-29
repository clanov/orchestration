# orchestration

A local-first coordination layer for coding agents.

Keep your strongest model in the lead. Let persistent native coding-agent sidekicks execute in parallel, fan out to their own subagents, and ask the lead when a judgment call is needed.

> Early alpha. The repository is being bootstrapped in private before its first public release.

## Model

```text
                    Lead
             frontier intelligence
            plan / ambiguity / review
                     |
          async delegate / feedback
             +-------+-------+
             |               |
             v               v
        Sidekick A       Sidekick B
        persistent       persistent
          context          context
          /   \              |
         v     v             v
     subagent subagent   subagent(s)

Sidekick -> lead_question -> Lead -> reply -> same sidekick session
```

The project is inspired by Cognition's lead/sidekick Fusion pattern, but is independent and not affiliated with Cognition or Devin.

Dynamic model switching during context compaction is deliberately **not implemented yet**.

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

Provider credentials are not direct workers yet. orchestration does not persist or proxy these keys.

## Fusion-style behavior implemented

- **Frontier lead stays in charge.** Planning, ambiguity, judgment, and final review remain with the lead.
- **Asynchronous delegation.** `delegate` returns immediately with a task ID; the lead keeps working while the sidekick runs.
- **Persistent sidekick context.** Follow-ups and lead replies resume the same native runtime session.
- **Briefs instead of transcript copies.** Objective, constraints, acceptance criteria, and bounded context are handed off.
- **Sidekick -> Lead questions.** A sidekick can stop at a material judgment call, raise `waiting_for_lead`, receive a lead answer, then continue.
- **Sidekick -> native subagents.** OpenCode, Antigravity, and Command Code keep their own native subagent capabilities.
- **Capability discovery.** `list_workers` tells the lead which runtime supports parallel/nested subagents.

## MCP tools

```text
list_workers
delegate          -> returns taskId immediately
get_events        -> lead monitors while doing other work
get_result
reply_to_worker   -> answers waiting_for_lead
follow_up         -> same persistent sidekick session
cancel
```

A typical flow:

```text
Lead: delegate(task A)
  <- taskId immediately

Lead: continues planning task B

Sidekick A: explores + implements + runs native subagents
Sidekick A: needs an architectural choice
  -> lead_question event

Lead: reply_to_worker(task A, "use option B because ...")
Sidekick A: resumes same context and completes

Lead: reviews result
```

## Native subagents

orchestration preserves each runtime's own agent hierarchy rather than emulating it.

- OpenCode: native subagents; nesting depends on runtime permissions/configuration.
- Antigravity: parallel native subagents.
- Command Code: parallel native subagents, one level deep.

Use `subagentPolicy: "auto" | "prefer" | "avoid"` on `delegate` as a delegation hint.

## Design principles

- **Native runtimes, not a model proxy.**
- **Persistent workers.**
- **Frontier intelligence owns judgment.**
- **Sidekicks ask instead of guessing.**
- **Typed briefs, not whole transcripts.**
- **Native subagents remain native.**
- **Verify independently.** Tests, lint, and diffs are evidence; a worker's self-report is not.
- **Credentials stay native.**

## Important concurrency note

Lead and sidekick can now run concurrently, but worktree isolation is not implemented yet. Until it is, avoid having the lead and sidekick write the same delegated files at the same time.

The next safety-critical milestone is isolated git worktrees plus harness-owned verification.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run build
npm run typecheck
```

Copy `.env.example` and configure whichever native runtimes you want.

## Status

Current focus: Fusion-style lead/sidekick coordination and persistent native runtime sessions.

Next: worktree isolation, verifier receipts, SQLite persistence, and richer streaming/subagent telemetry.

## License

MIT
