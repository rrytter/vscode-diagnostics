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

Download the latest `.vsix` from the
[**Releases**](https://github.com/rrytter/vscode-diagnostics/releases/latest)
page, then either:

```bash
code --install-extension claude-diagnostics-bridge-0.1.0.vsix
```

or, in VS Code: **Extensions → ⋯ (top right) → Install from VSIX…**

Reload the window (`Developer: Reload Window`). On first activation the extension
offers to register its MCP server — see
[Registering the server](#registering-the-server-once-per-machine). Verify the
bridge itself with `Claude Diagnostics: Write Snapshot Now` from the command
palette, then `Copy snapshot path` from the status bar menu to see where the
snapshot landed.

> **Devcontainers:** install the extension *inside* the container (add it to
> `devcontainer.json`'s `extensions`, or install the `.vsix` in the running
> window). Nothing needs to be mounted — see
> [devcontainer behaviour](#why-claudejson-and-how-it-behaves-in-devcontainers).

### Building from source

```bash
git clone https://github.com/rrytter/vscode-diagnostics.git
cd vscode-diagnostics
npm install && cd mcp && npm install && cd ..
npm run compile && npm run bundle-mcp
```

Press <kbd>F5</kbd> to launch an Extension Development Host, or package a `.vsix`
of your own with `npx @vscode/vsce package`.

## Project-wide diagnostics (warm-up)

Language servers only report problems for files they have actually analysed —
in practice, files that have been opened. A freshly opened window therefore has a
near-empty Problems panel, and a snapshot of it reads as *"this project is
clean"* when in truth nobody has looked yet. That false-clean result is precisely
what this bridge exists to prevent.

**Claude Diagnostics: Warm Up Project Diagnostics** (also in the status bar menu)
forces the issue: it loads the project's files so every language server analyses
them, then the snapshot reflects the whole project rather than the tabs you
happen to have open.

Files are loaded with `openTextDocument`, which registers them with the language
servers **without opening editor tabs** — your tab bar is untouched even for a
few thousand files.

The pass is genuinely expensive (every linter analyses every file), so it is a
deliberate command rather than something that runs at startup, and it shows a
**cancellable** progress notification. Above `warmupMaxFiles` it asks first
rather than silently analysing a subset.

### `.gitignore` is honoured

VS Code's file search does **not** read `.gitignore` — it honours `files.exclude`
and `search.exclude`, which are different settings that merely tend to overlap.
Left alone, a warm-up therefore loads build output, caches, and vendored trees
and reports their problems as if they were yours. Generated PHP is the worst
case: it is real code, so linters produce real, plausible findings for files
nobody should ever edit, and handing those to Claude invites edits to generated
files.

So the warm-up applies `.gitignore` itself (plus nested ignore files and
`.git/info/exclude`), matching gitignore(5) semantics: anchoring, negation,
directory-only rules, and `*`/`?`/`**` wildcards. Git is never shelled out to,
so this works in folders that are not repositories. Skipped files are reported in
the log and the completion summary.

Set `claudeDiagnostics.warmupRespectGitignore` to `false` to analyse ignored
files too.

### Why the warm-up switches to accumulating

Those documents do not stay open. VS Code closes anything no editor references,
and on close a language server may retract everything it published for that file
— Intelephense and SonarLint both do. So the Problems panel *drains* as the pass
proceeds, and reading it afterwards gives back a fraction of what was found.

The panel is a window, not a record. So a warm-up switches the bridge into
**accumulated mode**: every problem is kept as it is published and survives the
panel forgetting it. The snapshot then describes the project rather than your
editor session.

While accumulating:

- Fixes still land. When a file is re-analysed its entries are **replaced**, so a
  problem you fix disappears instead of haunting the snapshot.
- A file going silent because VS Code evicted it is *not* treated as clean —
  otherwise eviction would quietly delete real findings. Entries are only cleared
  when the file is still open, i.e. when the server genuinely had something to say.
- The status bar bullet is **hollow** (`○`), and `mode` in the snapshot reads
  `accumulated`.

Run **Claude Diagnostics: Resume Live Updates** (status bar menu, or the command
palette) when you are done fixing. That discards the record and goes back to
mirroring the panel, with a **filled** bullet (`●`). Expect the counts to drop
sharply — that is the honest live reading, since most files are no longer open.

Language servers work asynchronously, so the pass waits for them to fall quiet
before finishing, up to `warmupSettleTimeoutMs`. A timeout is reported rather
than hidden.

| Setting | Default | Meaning |
| --- | --- | --- |
| `claudeDiagnostics.warmupInclude` | `**/*` | Files to load. Narrow to your linted languages (e.g. `**/*.{php,ts,js}`) to speed the pass up a lot. |
| `claudeDiagnostics.warmupExclude` | `node_modules`, `vendor`, `.git`, `dist`, … | Excluded on top of your `files.exclude` / `search.exclude`, which are always honoured. |
| `claudeDiagnostics.warmupRespectGitignore` | `true` | Skip `.gitignore`d files. VS Code's search does not do this on its own. |
| `claudeDiagnostics.warmupMaxFiles` | `2000` | Count above which it asks before proceeding. |
| `claudeDiagnostics.warmupSettleTimeoutMs` | `120000` | Upper bound on waiting for language servers to finish after the last file is loaded. |

> **Note:** the accumulated record lives in memory. Reloading the window drops it
> and you will need to warm up again.

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
| `claudeDiagnostics.warmupInclude` | `**/*` | Files loaded by the [warm-up pass](#project-wide-diagnostics-warm-up). |
| `claudeDiagnostics.warmupExclude` | `node_modules`, `vendor`, … | Excluded from the warm-up pass. |
| `claudeDiagnostics.warmupMaxFiles` | `2000` | Warm-up count above which it asks first. |
| `claudeDiagnostics.warmupRespectGitignore` | `true` | Skip files matched by `.gitignore` during the warm-up. |
| `claudeDiagnostics.warmupSettleTimeoutMs` | `120000` | How long the warm-up waits for language servers to fall quiet. |

Only the first workspace folder is exported, and only `file://` URIs inside it —
diffs, settings editors, and files outside the workspace are skipped.

## Status bar

A status bar item on the right shows what the bridge is doing:

| Appearance | Meaning |
| --- | --- |
| `● $(error) 1 $(warning) 5` | **Live**, following the panel; last snapshot had 1 error, 5 warnings. |
| `○ $(error) 12 $(warning) 40` | **Accumulated**, holding warm-up results until you resume. |
| `● warning` | Live (`mode` / `icon` display); exporting warnings and up. |
| `$(debug-pause) paused` | Not writing. Diagnostics changes are ignored. |
| `$(alert) write failed` | Last write errored; the log has details. Highlighted. |

The leading bullet is the mode: **filled** (`●`) means live, **hollow** (`○`)
means accumulated. It shows in every display mode, because mistaking a frozen
snapshot for a live one is the error that actually costs you. Counts use
`$(error)` and `$(warning)`, matching the Problems panel. Write failures use
`$(alert)` rather than `$(error)` so a broken bridge never reads as "your code
has one error".

The tooltip shows the mode, the last warm-up, and the exact output path. It is
suppressed while a warm-up is running, since it shares a corner with the progress
notification and would cover it.

Click it for a menu: pause/resume, write now, warm up project diagnostics, resume
live updates (only while accumulating), change
minimum severity, change the status bar display, register/unregister the MCP
server, install the fix-problems skill, open the snapshot, copy its path, show the
log. Severity and display changes
are written to workspace settings; **pause is per-workspace and survives reloads**,
so a paused bridge stays paused until you resume it.

Pause only stops the automatic debounced writes. "Write snapshot now" still works
while paused, which is the intended escape hatch for a one-off export.

Set `statusBarDisplay` to `hidden` to remove the item entirely. Note that `icon`
mode still shows text for the paused and failed states — silently hiding a broken
bridge would defeat the point.

## MCP tools

Two tools:

- **`get_diagnostics_summary`** — counts by severity, source, and file. Start here
  on a noisy codebase.
- **`get_diagnostics`** — the problem list, filterable by `severity`, `file`,
  `source`, and `limit`.

Both report the snapshot's age and warn when it is over five minutes old, so a
stale export is visible rather than silently misleading.

### Registering the server (once per machine)

The extension can register the MCP server for you, so installing the extension is
the whole setup. The **first time it activates** it asks once; choosing *Register*
adds a single `diagnostics` entry to your **`~/.claude.json`** under user scope.
Both the Claude Code CLI and the Claude VS Code extension read that file, so one
registration covers both. Restart Claude Code afterwards to pick it up.

Two palette commands (also in the status-bar menu) manage it explicitly:

- **Claude Diagnostics: Register MCP Server** — add / refresh the entry.
- **Claude Diagnostics: Unregister MCP Server** — remove it. Use this to clean up:
  VS Code does not reliably run extension cleanup on uninstall, so removing the
  extension does **not** delete the entry on its own.

The write is idempotent and atomic. Only the `diagnostics` key is touched — any
other MCP servers in `~/.claude.json` are left untouched — and the entry is
refreshed on each activate so it survives the install-path change that comes with
a version bump.

Prefer to register it yourself instead? Decline the prompt and either add an
`mcpServers.diagnostics` entry to `~/.claude.json` by hand, or keep a project-scope
`.mcp.json`. (Note: MCP servers can only be *defined* in `~/.claude.json` or a
project `.mcp.json` — `settings.json` cannot define them, only allow/deny them.)

### Installing the fix-problems skill

The MCP server tells Claude *what* is wrong; the `fix-problems` **skill** carries
the *conventions* for fixing it — which findings are mechanical versus judgement
calls, and the verify-after-edit discipline. The extension bundles the skill and
can drop it into a workspace on demand:

- **Claude Diagnostics: Install Fix-Problems Skill** copies it into
  **`<workspace>/.claude/skills/fix-problems/`**.

Unlike the MCP registration, the skill is installed at **project scope**, not into
`~/.claude/`. It is opinionated workflow you may want to edit, version, or commit,
and project scope means it rides into a devcontainer with the mounted project and
never collides with a global skill tuned for another project. The trade-off: it is
per-project — run the command once in each workspace where you want it.

It is **command-only** (no first-run prompt) and **never overwrites**: if a
`fix-problems` skill already exists in the workspace, you are offered *Open it* or
*Overwrite* rather than silently clobbering edits you may have made.

### Why `~/.claude.json`, and how it behaves in devcontainers

`~/.claude.json` is a **per-machine** file that sits *beside* — not inside — the
`~/.claude/` directory. That separation is deliberate and is what makes the
devcontainer story work with **nothing mounted**:

- Install the extension **in the container** (add it to `devcontainer.json`'s
  extensions, or install it in the running window). On activate it writes the
  snapshot to the container's own `~/.claude/diagnostics/…` and registers the
  container's own `server.js` path into the container's own `~/.claude.json`.
- The Claude Code CLI / extension **inside the container** reads those
  container-local files. Everything stays in the container — no host mount needed.

Conversely, do **not** mount the host's `~/.claude.json` into the container: it
records the *host's* `server.js` path, which does not exist in the container, and
would break the server there. Mounting the `~/.claude/` directory alone is fine —
it holds no machine-specific server paths.

The requirement is simply that the extension is **installed on whichever machine
runs the language servers** (host for a local workspace, container for a
devcontainer). Each machine self-registers with a path valid for that machine.

## Enterprise note

The MCP server is **stdio only**: a local subprocess, spawned by Claude Code,
communicating over stdin/stdout. It opens no ports, makes no network calls, and
sends nothing outside the machine. Its sole input is a JSON file in your own
workspace.

This distinction matters because policies restricting "MCP servers" are usually
aimed at remote or third-party ones that transmit code externally. If that
distinction is not available to you, skip registration (or run *Unregister MCP
Server*) and keep layer 1 — Claude reads the JSON file directly (the path is in
`CLAUDE.md`) and the workflow still works.

The default output lives under `~/.claude/diagnostics/`, outside any repository,
so there is nothing to `.gitignore`. If you point `outputPath` back inside a repo,
ignore that file — it is machine-local and embeds absolute paths.
