# Quick start

This guide gets a local Lead + Sidekick setup running on Node 22.5+.

## 1. Clone and build

```bash
git clone https://github.com/clanov/orchestration.git
cd orchestration
npm install
npm run build
cp .env.example .env
```

Run the built-in checks:

```bash
npm run smoke
npm run doctor
```

`doctor` is expected to report at least one configured and reachable worker before you connect the MCP server.

## 2. Configure a worker

You only need one worker to start.

### OpenCode

Authenticate OpenCode normally, then start its local server:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Put the model OpenCode knows in `.env`:

```env
ORCHESTRATION_OPENCODE_URL=http://127.0.0.1:4096
ORCHESTRATION_OPENCODE_MODEL=provider/model
```

If you prefer separate values:

```env
ORCHESTRATION_OPENCODE_PROVIDER=provider
ORCHESTRATION_OPENCODE_MODEL=model
```

### Antigravity

```env
ORCHESTRATION_ANTIGRAVITY_COMMAND=agy
ORCHESTRATION_ANTIGRAVITY_MODEL=gemini-3.8-flash-high
ORCHESTRATION_ANTIGRAVITY_EFFORT=high
ORCHESTRATION_ANTIGRAVITY_ALLOW_MUTATIONS=1
```

The mutation flag is intentionally opt-in because it maps to Antigravity's unattended mutation mode.

### Command Code

```env
ORCHESTRATION_COMMAND_CODE_COMMAND=cmd
ORCHESTRATION_COMMAND_CODE_MODEL=<model-id>
ORCHESTRATION_COMMAND_CODE_EFFORT=high
ORCHESTRATION_COMMAND_CODE_ALLOW_MUTATIONS=1
```

Use the exact model id shown by Command Code.

## 3. Check everything

```bash
npm run doctor
```

Example:

```text
Node                 v22.x.x
Git                  git version ...
SQLite state         OK: /home/user/.orchestration/state.sqlite
Persisted tasks      0
Environment          /home/user/orchestration/.env
Worker opencode      OK
Worker antigravity   OK
```

Provider API keys are optional unless the native runtime you chose needs them.

## 4. Connect the Lead over MCP

### Lead running inside WSL/Linux

Launch:

```bash
ORCHESTRATION_ENV_FILE="$PWD/.env" node packages/mcp/dist/cli.js
```

Your MCP client's stdio configuration should point to that Node command.

### Windows app -> WSL Ubuntu

If the repository is cloned as `~/orchestration` inside Ubuntu, the MCP entry can use:

```json
{
  "orchestration": {
    "command": "wsl.exe",
    "args": [
      "-d",
      "Ubuntu",
      "--",
      "bash",
      "-lc",
      "cd \"$HOME/orchestration\" && export ORCHESTRATION_ENV_FILE=\"$PWD/.env\" && exec /usr/bin/node packages/mcp/dist/cli.js"
    ]
  }
}
```

The process uses stdio; do not wrap it in a command that writes normal output to stdout.

## 5. Lead workflow

A Lead should normally:

```text
list_workers
   |
delegate          <- returns immediately
   |
Lead keeps planning/reviewing in parallel
   |
get_events / get_result
   |
   +-- waiting_for_lead -> reply_to_worker
   |
   +-- verification_failed -> follow_up
   |
   +-- completed
          |
       get_diff
          |
     prepare_apply
          |
     review preflight
          |
     apply_to_lead(confirm=true)
          |
       cleanup
```

Multiple independent `delegate` calls can run at once. Each receives its own git worktree.

## Restart recovery

Task state is stored by default at:

```text
~/.orchestration/state.sqlite
```

If the MCP process dies while a task is actively running, the next process marks that task `interrupted` instead of losing it.

Use:

```text
list_tasks
get_result(taskId)
resume_task(taskId)
```

`resume_task` reuses the preserved worktree and, when already known, the native runtime session id.

A task that was already `waiting_for_lead`, `completed`, `verification_failed`, `applied`, `failed`, or `cancelled` remains in that state after restart.

## Durable paths

Optional overrides:

```env
ORCHESTRATION_STATE_DB=/home/user/.orchestration/state.sqlite
ORCHESTRATION_WORKTREE_ROOT=/home/user/.orchestration/worktrees
```

Keeping worktrees under a durable directory instead of `/tmp` is recommended if you want restart recovery to survive OS temp cleanup.

## Current safety behavior

- Lead and Sidekick write to different worktrees.
- Existing dirty Lead changes are part of the delegation snapshot.
- Sidekick-only changes are independently diffed and verified.
- A verified result cannot be applied without `prepare_apply` and an explicit matching `planId`.
- If Lead files or the Sidekick result change after preflight, apply is rejected as stale.
- Apply modifies the Lead working tree but never stages, commits, or pushes.
- Compaction-time model switching is not implemented.
