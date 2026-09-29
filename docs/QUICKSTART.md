# Quick start

This guide gets a local Lead + persistent Sidekick running on Node 22.5+.

## 1. Clone and build

```bash
git clone https://github.com/clanov/orchestration.git
cd orchestration
npm install
npm run build
cp .env.example .env
```

## 2. Configure one Sidekick

Minimal Antigravity example:

```env
ORCHESTRATION_SIDEKICK=antigravity
ORCHESTRATION_SIDEKICK_MODEL=gemini-3.8-flash-high
ORCHESTRATION_SIDEKICK_ALLOW_MUTATIONS=1
```

OpenCode:

```env
ORCHESTRATION_SIDEKICK=opencode
ORCHESTRATION_SIDEKICK_MODEL=provider/model
# ORCHESTRATION_SIDEKICK_URL=http://127.0.0.1:4096
```

Command Code:

```env
ORCHESTRATION_SIDEKICK=command-code
ORCHESTRATION_SIDEKICK_MODEL=<model-id>
ORCHESTRATION_SIDEKICK_ALLOW_MUTATIONS=1
```

Optional tuning uses the generic `ORCHESTRATION_SIDEKICK_*` variables in `.env.example`.

Native runtime authentication remains owned by that runtime.

## 3. Check it

```bash
npm run smoke
npm run doctor
```

A healthy setup ends with one selected runtime:

```text
Node                 v22.x.x
Git                  git version ...
SQLite state         OK: ...
Environment          .../.env
Runtime antigravity  OK
Selected Sidekick    antigravity
```

If legacy runtime-specific variables configure several runtimes, `doctor` shows each candidate and the first reachable one becomes the Sidekick.

## 4. Connect over MCP

### Linux / WSL Lead

```bash
node packages/mcp/dist/cli.js
```

The process automatically loads `.env` from its working directory.

### Windows app -> WSL Ubuntu

A small wrapper avoids Windows/JSON/shell quoting problems:

```bash
cat > run-mcp.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:$PATH"
export ORCHESTRATION_ENV_FILE="$HOME/orchestration/.env"
export NODE_NO_WARNINGS=1

cd "$HOME/orchestration"
exec /usr/bin/node packages/mcp/dist/cli.js
EOF

chmod +x run-mcp.sh
```

Then point the MCP client at:

```json
{
  "orchestration": {
    "command": "wsl.exe",
    "args": [
      "-d",
      "Ubuntu",
      "--",
      "/usr/bin/bash",
      "/home/user/orchestration/run-mcp.sh"
    ]
  }
}
```

Replace `/home/user` with the actual WSL home path.

## 5. Lead workflow

The Lead only creates a Sidekick when there is actually delegable work. The first `handoff` creates it lazily, and later handoffs keep reusing it:

```text
sidekick_status
   |
handoff        <- first call creates Sidekick/session/worktree
   |
get_events / get_result
   |
   +-- waiting_for_lead -> reply_to_sidekick
   |
   +-- completed / verification_failed
             |
           get_diff
             |
           handoff
             |
        same native session
        same worktree
             |
            ...
   |
prepare_apply
   |
apply_to_lead(confirm=true)
   |
cleanup
```

Do not force delegation for short or judgment-heavy work. When there is delegable execution work, use `handoff`; later calls automatically continue the same native session and worktree.

## Restart recovery

State is stored by default at:

```text
~/.orchestration/state.sqlite
```

If the process stops during active work:

```text
list_tasks
get_result(taskId)
resume_task(taskId)
```

Recovery keeps the same worktree and reuses the native session id when it was already known.

## Safety behavior

- Lead and Sidekick write to different worktrees.
- Existing dirty Lead changes are included in the initial snapshot.
- Sidekick-only changes are independently diffed and verified.
- A verified result cannot be applied without `prepare_apply` and an explicit matching `planId`.
- Lead or Sidekick changes after preflight make the plan stale.
- Apply never stages, commits, or pushes.
- Runtime-native subagents are not encouraged to create parallel writers by default.
- Compaction-time model switching is not implemented.
