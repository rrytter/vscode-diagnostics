---
name: fix-problems
description: Read the real VS Code Problems panel (Intelephense, SonarQube/SonarLint, and every other language server) via the Claude Diagnostics Bridge, then fix the reported errors and warnings. Use whenever the user asks to fix problems, fix errors or warnings, asks what is wrong in their editor, or refers to the Problems panel — and before claiming a file is clean.
---

# Fix problems from the VS Code Problems panel

These diagnostics live inside the VS Code process. **No CLI reproduces them** —
Intelephense in particular has no command-line equivalent, and `sonar-scanner`
is a different tool from the SonarLint analysis in the panel. Never substitute
`php -l`, a linter, or your own reading of the source for the bridge output.

## 1. Read the snapshot

Run from the project root:

```bash
node .claude/skills/fix-problems/find-diagnostics.js
```

`$CLAUDE_PROJECT_DIR` is **not** set in the Bash tool, so do not rely on it —
use the project-relative path above, adjusting `../` if the shell is in a
subdirectory.

Pass a directory as the first argument to inspect a different workspace.

The first line is a status token:

- **`STATUS: OK`** — problems follow, one per line, most severe first.
- **`STATUS: NO_BRIDGE`** — the extension has never written. Tell the user to
  reload the VS Code window and check for the bridge's status bar item. Do not
  fall back to guessing from source; say plainly that you cannot see the panel.
- **`STATUS: NO_MATCH`** — no snapshot covers this directory. The listed known
  workspaces usually make the cause obvious (wrong project open in VS Code).

Two warnings can appear even under `OK`, and both matter:

- `snapshot is N minutes old` — it may predate the user's latest edit. Say so
  rather than acting on stale data; offer to re-read after they touch the file.
- `export truncated` — you are seeing a subset; report the true total.

Also check `minSeverity`. If it is `warning`, hint-level findings (unused
imports, unused symbols) are **not** in the list. Do not report the file as
completely clean — say what severity you actually verified.

## 2. Show what you found

Before editing, list the problems grouped by file, each with its source, rule
code, and location. Keep it compact. This is the user's confirmation that you are
working from their real panel and not from inference.

If the user scoped the request (`/fix-problems errors`, `/fix-problems index.php`),
filter to that scope but still state the full total, so a narrowed view never
reads as a clean bill of health.

## 3. Fix, splitting mechanical from judgement

**Fix directly** — these have one correct answer:

- Missing trailing newline, whitespace, formatting.
- Unused *local* variable or unused *import* that nothing references.
- Empty function body needing an explanatory comment (e.g. Sonar `S1186`):
  add prose explaining why it is empty. Write a real explanation, not filler,
  and never leave commented-out code — that trips the "commented out code" rule.

**Ask first** — these delete or change meaning, and the linter cannot know intent:

- Removing a **function parameter** (e.g. `S1172`). Grep for callers first. A
  parameter on a public signature may be required by an interface or callback
  contract even when unused in the body.
- Removing **commented-out code** (e.g. `S125`). It may be a deliberate note.
- **Undefined symbol** errors (e.g. Intelephense `P1008`/`P1011`). The fix depends
  entirely on intent: a typo, a missing import, a leftover, or genuinely dead
  code. Propose the reading you think is right and confirm before deleting.
- Anything whose fix is deleting a non-trivial block.

Match the file's existing style — brace placement, indentation, comment voice.
Do not reformat beyond what the diagnostics require, and do not fix things that
were not reported unless you flag them separately as out of scope.

## 4. Verify

The bridge writes on a debounce (~1.5s default). After editing, wait a moment,
then re-run the locator:

```bash
sleep 3 && node .claude/skills/fix-problems/find-diagnostics.js
```

Confirm `generatedAt` has advanced **past your edit** before trusting the new
counts — an unchanged timestamp means you are re-reading the pre-edit snapshot.

Report honestly:

- Which problems are gone, by rule code.
- Anything still present, and why (deferred pending user input, or the fix failed).
- Anything you deliberately left, such as items below `minSeverity`.

If the counts did not drop as expected, say so rather than declaring success.
Fixing one rule sometimes triggers another — removing commented-out code can
leave a function body empty, for instance.
