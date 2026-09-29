# Antigravity adapter

Planned for the next vertical slice.

The integration target is agy's official headless interface rather than TUI scraping:

```bash
agy -p "..." --output-format stream-json
agy -p "follow up" --conversation <conversation-id>
```

The adapter should preserve `conversation_id`, stream machine-readable events, and expose the same `WorkerAdapter` contract as OpenCode.

Reference: https://antigravity.google/docs/cli/headless/
