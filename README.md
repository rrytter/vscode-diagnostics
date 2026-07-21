# Claude Diagnostics Bridge

Exposes the VS Code **Problems panel** to Claude Code.

Diagnostics from language-server-based extensions — Intelephense, SonarLint, and
anything else — exist only inside the VS Code process. There is no CLI that
reproduces them. This bridge exports them so Claude can read them.

Two layers, deliberately separable:

1. **VS Code extension** — watches `languages.onDidChangeDiagnostics` and writes a
   snapshot to a per-workspace file under `~/.claude/diagnostics/` (see
   [Output location](#output-location)).
2. **stdio MCP server** — reads that file and exposes it to Claude as tools.

The extension is useful on its own: if MCP is off the table, Claude can read the
JSON file directly. Layer 2 is a convenience, not a dependency. A `CLAUDE.md` at
the project root tells a fresh Claude Code session where the file is, so it works
without prompting.

## Install

```bash
cd vscode-extension && npm install && npm run compile
cd mcp && npm install
```

Link the extension into VS Code so it loads in every window:

```bash
ln -s "$(pwd)" ~/.vscode/extensions/claude-diagnostics-bridge
```

For WSL, use `~/.vscode-server/extensions/` instead. Then reload VS Code
(`Developer: Reload Window`). Verify with
`Claude Diagnostics: Write Snapshot Now` from the command palette, then
`Copy snapshot path` from the status bar menu to see where it landed.

To iterate on the extension instead, open this folder in VS Code and press F5 for
an Extension Development Host.

## Output location

By default the snapshot is written to:

```
~/.claude/diagnostics/<workspace-basename>-<hash>.json
```

The hash is the first 8 hex of `sha1(absolute workspace path)`, so two projects
never collide and no repository is polluted. The MCP server derives the same name
from the same path, and the project's `CLAUDE.md` records the exact path.

`claudeDiagnostics.outputPath` overrides this: an **absolute** path is used as-is,
a **relative** path resolves against the workspace folder (the old in-repo
behaviour). Leave it empty for the home-dir default.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `claudeDiagnostics.outputPath` | `""` | Empty = home-dir namespaced. Absolute or workspace-relative override. |
| `claudeDiagnostics.minSeverity` | `warning` | Lowest severity exported. |
| `claudeDiagnostics.debounceMs` | `1500` | Quiet period after a change before writing. |
| `claudeDiagnostics.maxProblems` | `2000` | Export cap; truncation is flagged in the file. |
| `claudeDiagnostics.statusBarDisplay` | `counts` | `counts`, `mode`, `icon`, or `hidden`. |

Only the first workspace folder is exported, and only `file://` URIs inside it —
diffs, settings editors, and files outside the workspace are skipped.

## Status bar

A status bar item on the right shows what the bridge is doing:

| Appearance | Meaning |
| --- | --- |
| `$(error) 1 $(warning) 5` | Running; last snapshot had 1 error, 5 warnings. |
| `$(broadcast) warning` | Running (`mode` / `icon` display); exporting warnings and up. |
| `$(debug-pause) paused` | Not writing. Diagnostics changes are ignored. |
| `$(alert) write failed` | Last write errored; the log has details. Highlighted. |

Counts use `$(error)` and `$(warning)`, matching the Problems panel. Write
failures use `$(alert)` rather than `$(error)` so a broken bridge never reads as
"your code has one error". The tooltip shows the exact output path.

Click it for a menu: pause/resume, write now, change minimum severity, change the
status bar display, open the snapshot, copy its path, show the log. Severity and display changes
are written to workspace settings; **pause is per-workspace and survives reloads**,
so a paused bridge stays paused until you resume it.

Pause only stops the automatic debounced writes. "Write snapshot now" still works
while paused, which is the intended escape hatch for a one-off export.

Set `statusBarDisplay` to `hidden` to remove the item entirely. Note that `icon`
mode still shows text for the paused and failed states — silently hiding a broken
bridge would defeat the point.

## MCP tools

Registered in `../.mcp.json` at the project root. Two tools:

- **`get_diagnostics_summary`** — counts by severity, source, and file. Start here
  on a noisy codebase.
- **`get_diagnostics`** — the problem list, filterable by `severity`, `file`,
  `source`, and `limit`.

Both report the snapshot's age and warn when it is over five minutes old, so a
stale export is visible rather than silently misleading.

## Enterprise note

The MCP server is **stdio only**: a local subprocess, spawned by Claude Code,
communicating over stdin/stdout. It opens no ports, makes no network calls, and
sends nothing outside the machine. Its sole input is a JSON file in your own
workspace.

This distinction matters because policies restricting "MCP servers" are usually
aimed at remote or third-party ones that transmit code externally. If that
distinction is not available to you, delete `.mcp.json` and keep layer 1 — Claude
reads the JSON file directly (the path is in `CLAUDE.md`) and the workflow still
works.

The default output lives under `~/.claude/diagnostics/`, outside any repository,
so there is nothing to `.gitignore`. If you point `outputPath` back inside a repo,
ignore that file — it is machine-local and embeds absolute paths.
