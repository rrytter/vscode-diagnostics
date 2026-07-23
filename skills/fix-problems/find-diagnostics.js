#!/usr/bin/env node
/**
 * Locates and prints the Claude Diagnostics Bridge snapshot for the current
 * directory.
 *
 * Rather than recomputing the workspace hash (which is wrong whenever Claude is
 * invoked from a subdirectory), this scans ~/.claude/diagnostics and matches on
 * the `workspaceRoot` recorded inside each snapshot, preferring the deepest
 * match so nested projects resolve correctly.
 *
 * Output is plain text for a human/model to read. Exit code is always 0; the
 * first line is a status token so failure modes are unambiguous.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dir = path.join(os.homedir(), '.claude', 'diagnostics');
const cwd = path.resolve(process.argv[2] || process.cwd());

function loadSnapshots() {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const out = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) {
            continue;
        }
        const file = path.join(dir, name);
        try {
            const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (snapshot && typeof snapshot.workspaceRoot === 'string') {
                out.push({ file, snapshot, root: path.resolve(snapshot.workspaceRoot) });
            }
        } catch {
            // Truncated mid-write, or not one of ours. Skip it.
        }
    }
    return out;
}

const all = loadSnapshots();
if (all.length === 0) {
    console.log('STATUS: NO_BRIDGE');
    console.log(`No snapshots found in ${dir}`);
    console.log('The Claude Diagnostics Bridge extension is not running, or has');
    console.log('never written. Reload the VS Code window, then check its status bar.');
    process.exit(0);
}

// Deepest matching root wins, so a nested project beats its parent.
const matches = all
    .filter((c) => cwd === c.root || cwd.startsWith(c.root + path.sep))
    .sort((a, b) => b.root.length - a.root.length);

if (matches.length === 0) {
    console.log('STATUS: NO_MATCH');
    console.log(`No snapshot covers ${cwd}`);
    console.log('Known workspaces:');
    for (const c of all) {
        console.log(`  ${c.root}  ->  ${c.file}`);
    }
    console.log('Open this project as a VS Code workspace folder, or run');
    console.log('"Claude Diagnostics: Write Snapshot Now" from the command palette.');
    process.exit(0);
}

const { file, snapshot, root } = matches[0];
const ageSeconds = Math.round((Date.now() - new Date(snapshot.generatedAt).getTime()) / 1000);

console.log('STATUS: OK');
console.log(`file:          ${file}`);
console.log(`workspaceRoot: ${root}`);
console.log(`generatedAt:   ${snapshot.generatedAt}  (${ageSeconds}s ago)`);
console.log(`minSeverity:   ${snapshot.minSeverity}`);
console.log(`mode:          ${snapshot.mode ?? 'live'}`);
console.log(`total:         ${snapshot.total}`);
console.log(
    `counts:        ` +
        ['error', 'warning', 'information', 'hint']
            .map((s) => `${s}=${snapshot.counts?.[s] ?? 0}`)
            .join(' '),
);
if (snapshot.truncated) {
    console.log(`WARNING: export truncated at ${snapshot.problems.length} of ${snapshot.total}`);
}
if (snapshot.warmup) {
    const w = snapshot.warmup;
    console.log(
        `warmup:        ${w.fileCount} file(s) analysed at ${w.completedAt}` +
            (w.timedOut ? ' (TIMED OUT - may under-report)' : '') +
            (w.cancelled ? ' (CANCELLED - partial coverage)' : ''),
    );
}
// A live snapshot only covers files a language server currently holds open, so
// "no problems" there usually means "nobody looked", not "nothing is wrong".
if ((snapshot.mode ?? 'live') === 'live' && snapshot.total === 0) {
    console.log(
        'NOTE: mode=live and no problems reported. This covers only files open in ' +
            'the editor, not the project. Run "Claude Diagnostics: Warm Up Project ' +
            'Diagnostics" before concluding the project is clean.',
    );
}
if (ageSeconds > 300) {
    console.log(`WARNING: snapshot is ${Math.round(ageSeconds / 60)} minutes old; it may be stale.`);
}
console.log('');

if (!snapshot.problems || snapshot.problems.length === 0) {
    console.log('(no problems at or above the exported severity)');
    process.exit(0);
}

for (const p of snapshot.problems) {
    const code = p.code ? `${p.source}:${p.code}` : p.source;
    console.log(`${p.file}:${p.line}:${p.column}  [${p.severity}]  (${code})  ${p.message}`);
}
