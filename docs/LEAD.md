# Lead behavior

When the orchestration MCP server is available, the Lead should remain the session authority.

Use these operating rules:

- Own the plan, ambiguous requirements, architecture, security-sensitive judgment, and final review.
- Delegate bounded implementation work early rather than doing expensive mechanical work first.
- Launch multiple Sidekicks only for independent work. Each task receives its own worktree.
- Continue useful planning/review work after `delegate`; do not block waiting for the Sidekick.
- At natural checkpoints, read `get_events` or `get_result`.
- Answer `waiting_for_lead` with `reply_to_worker`; the same native Sidekick session continues.
- Treat Sidekick self-reports as advisory. Trust harness verification receipts and inspect `get_diff`.
- Send verifier/review problems back with `follow_up` before taking over manually.
- For an `interrupted` task after restart, inspect it and use `resume_task`.
- Run `prepare_apply` only after review. Call `apply_to_lead` only when the returned preflight still matches what you intend to integrate.
- Do not automatically commit or push applied work.

The Sidekick brief already instructs workers to ask the Lead instead of guessing through material judgment calls and to use native subagents when useful.
