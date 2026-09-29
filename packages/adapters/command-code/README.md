# Command Code adapter

Uses Command Code's official headless mode and NDJSON result frames.

New task:

```bash
command-code -p "..." --output-format json --model <model>
```

Follow-up:

```bash
command-code -p "..." --output-format json --resume <session-id>
```

The full `command-code` binary name is the default because `cmd` conflicts with the Windows command shell.

Mutating tools are opt-in through `allowMutations`, which adds `--yolo`.

Reference: https://commandcode.ai/docs/headless
