#!/usr/bin/env node
/**
 * Local stdio MCP server exposing the diagnostics snapshot written by the
 * Claude Diagnostics Bridge VS Code extension.
 *
 * Reads a file on disk and nothing else: no network, no ports, no telemetry.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// CLAUDE_PROJECT_DIR is set by Claude Code in the spawned server's environment,
// so it works even when ${...} expansion in .mcp.json does not.
const configuredRoot = process.env.CLAUDE_DIAGNOSTICS_ROOT;
const workspaceRoot =
    configuredRoot && !configuredRoot.startsWith('${')
        ? configuredRoot
        : process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// Must match resolveTarget()/defaultSnapshotPath() in the VS Code extension:
// an explicit CLAUDE_DIAGNOSTICS_PATH wins, otherwise the home-dir namespaced
// default derived from the (normalized) workspace path.
const snapshotPath = resolveSnapshotPath();

function resolveSnapshotPath() {
    const configured = process.env.CLAUDE_DIAGNOSTICS_PATH;
    if (configured && !configured.startsWith('${')) {
        return path.resolve(workspaceRoot, configured);
    }
    const normalized = path.resolve(workspaceRoot);
    const base = path.basename(normalized);
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
    return path.join(os.homedir(), '.claude', 'diagnostics', `${base}-${hash}.json`);
}

const SEVERITIES = ['error', 'warning', 'information', 'hint'];

async function loadSnapshot() {
    let raw;
    try {
        raw = await readFile(snapshotPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            return {
                error:
                    `No diagnostics snapshot at ${snapshotPath}. Is the Claude ` +
                    `Diagnostics Bridge extension installed and a workspace open in VS Code?`,
            };
        }
        throw err;
    }
    try {
        return { snapshot: JSON.parse(raw) };
    } catch {
        // A read that lands mid-write yields truncated JSON; the next call succeeds.
        return { error: `Snapshot at ${snapshotPath} is not valid JSON (possibly mid-write).` };
    }
}

/** Snapshots are written on a debounce, so a stale one silently misleads. */
function staleness(generatedAt) {
    const ageMs = Date.now() - new Date(generatedAt).getTime();
    if (!Number.isFinite(ageMs)) {
        return null;
    }
    const minutes = Math.round(ageMs / 60000);
    return minutes >= 5 ? `Snapshot is ~${minutes} minutes old.` : null;
}

function formatProblem(p) {
    const code = p.code ? `${p.source}:${p.code}` : p.source;
    return `${p.file}:${p.line}:${p.column}  [${p.severity}] (${code}) ${p.message}`;
}

const server = new McpServer({
    name: 'claude-diagnostics',
    version: '0.1.0',
});

server.registerTool(
    'get_diagnostics',
    {
        title: 'Get VS Code diagnostics',
        description:
            'Returns current VS Code Problems panel diagnostics (Intelephense, ' +
            'SonarLint, and any other language server or linter) for the workspace.',
        inputSchema: {
            severity: z
                .enum(SEVERITIES)
                .optional()
                .describe('Only include problems at or above this severity.'),
            file: z
                .string()
                .optional()
                .describe('Only include problems whose path contains this substring.'),
            source: z
                .string()
                .optional()
                .describe('Only include problems from this source, e.g. "intelephense", "sonarqube".'),
            limit: z
                .number()
                .int()
                .positive()
                .optional()
                .describe('Maximum problems to return. Defaults to 100.'),
        },
    },
    async ({ severity, file, source, limit = 100 }) => {
        const { snapshot, error } = await loadSnapshot();
        if (error) {
            return { content: [{ type: 'text', text: error }], isError: true };
        }

        let problems = snapshot.problems ?? [];
        if (severity) {
            const threshold = SEVERITIES.indexOf(severity);
            problems = problems.filter((p) => SEVERITIES.indexOf(p.severity) <= threshold);
        }
        if (file) {
            const needle = file.toLowerCase();
            problems = problems.filter((p) => p.file.toLowerCase().includes(needle));
        }
        if (source) {
            const needle = source.toLowerCase();
            problems = problems.filter((p) => (p.source ?? '').toLowerCase() === needle);
        }

        const matched = problems.length;
        const shown = problems.slice(0, limit);

        const header = [
            `${matched} problem(s) matched` +
                (matched > shown.length ? `, showing first ${shown.length}` : ''),
            `Snapshot written ${snapshot.generatedAt} (min severity: ${snapshot.minSeverity})`,
            snapshot.truncated
                ? `NOTE: the extension truncated its own export at ${snapshot.problems.length} of ${snapshot.total} problems.`
                : null,
            staleness(snapshot.generatedAt),
        ]
            .filter(Boolean)
            .join('\n');

        const body = shown.length
            ? shown.map(formatProblem).join('\n')
            : '(no matching problems)';

        return { content: [{ type: 'text', text: `${header}\n\n${body}` }] };
    },
);

server.registerTool(
    'get_diagnostics_summary',
    {
        title: 'Summarize VS Code diagnostics',
        description:
            'Returns problem counts by severity, source, and file without listing ' +
            'every problem. Use this first on a noisy workspace.',
        inputSchema: {},
    },
    async () => {
        const { snapshot, error } = await loadSnapshot();
        if (error) {
            return { content: [{ type: 'text', text: error }], isError: true };
        }

        const problems = snapshot.problems ?? [];
        const bySource = {};
        const byFile = {};
        for (const p of problems) {
            bySource[p.source] = (bySource[p.source] ?? 0) + 1;
            byFile[p.file] = (byFile[p.file] ?? 0) + 1;
        }

        const rank = (obj, n) =>
            Object.entries(obj)
                .sort((a, b) => b[1] - a[1])
                .slice(0, n)
                .map(([key, count]) => `  ${count.toString().padStart(5)}  ${key}`)
                .join('\n') || '  (none)';

        const text = [
            `Snapshot written ${snapshot.generatedAt}`,
            `Total: ${snapshot.total} (min severity: ${snapshot.minSeverity})`,
            '',
            'By severity:',
            ...SEVERITIES.map((s) => `  ${String(snapshot.counts?.[s] ?? 0).padStart(5)}  ${s}`),
            '',
            'By source:',
            rank(bySource, 10),
            '',
            'Top files:',
            rank(byFile, 15),
            staleness(snapshot.generatedAt) ?? '',
        ].join('\n');

        return { content: [{ type: 'text', text }] };
    },
);

await server.connect(new StdioServerTransport());
