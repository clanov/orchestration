# Antigravity adapter

Uses agy's official headless JSON interface rather than scraping the TUI.

New task:

```bash
agy -p "..." --output-format json --model <model>
```

Follow-up:

```bash
agy -p "..." --output-format json --conversation <conversation-id>
```

File/shell mutation is opt-in through `allowMutations` because it maps to agy's `--dangerously-skip-permissions`.

Reference: https://antigravity.google/docs/cli/headless/
