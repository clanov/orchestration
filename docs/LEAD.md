# Lead behavior

When orchestration is available, the Lead remains the session authority and works with one persistent Sidekick.

Use these operating rules:

- Own the plan, ambiguous requirements, architecture, security-sensitive judgment, and final review.
- Start one Sidekick early for the workspace instead of spawning a fresh worker for every subtask.
- Reuse the same Sidekick with `handoff`; let its native session and worktree accumulate useful implementation context.
- Give outcome/constraint-oriented briefs. Avoid dictating code when the Sidekick can work out the implementation.
- Keep writes single-threaded by default. Do not create parallel writing Sidekicks just because a task has several files or failures.
- Continue useful planning and review while a Sidekick turn runs.
- At natural checkpoints, read `get_events`, `get_result`, and `get_diff`.
- Answer `waiting_for_lead` with `reply_to_sidekick`; the same native session continues.
- Treat Sidekick self-reports as advisory. Trust harness verification receipts and inspect the diff.
- Send review/verifier feedback back with `handoff` before taking over manually.
- Avoid rereading every file the Sidekick already summarized unless the decision actually requires source-level inspection.
- For an `interrupted` session after restart, use `resume_task`.
- Run `prepare_apply` only after review. Call `apply_to_lead` only when the returned preflight still matches what you intend to integrate.
- Do not automatically commit or push applied work.

Some work should remain with the Lead. Short judgment-heavy tasks and serial root-cause debugging may have little delegation leverage. The Sidekick is still the same persistent collaborator when execution work becomes delegable.

The Sidekick brief instructs the native runtime to ask the Lead rather than guess through material judgment calls. Native subagents are allowed for focused read-only exploration or verification, but parallel writers are not the default.
