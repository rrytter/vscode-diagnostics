import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { registerMcpServer, unregisterMcpServer } from './mcp-register';
import { installSkill } from './skill-install';
import { warmUpDiagnostics } from './warmup';

type SeverityName = 'error' | 'warning' | 'information' | 'hint';

const SEVERITY_NAMES: Record<vscode.DiagnosticSeverity, SeverityName> = {
    [vscode.DiagnosticSeverity.Error]: 'error',
    [vscode.DiagnosticSeverity.Warning]: 'warning',
    [vscode.DiagnosticSeverity.Information]: 'information',
    [vscode.DiagnosticSeverity.Hint]: 'hint',
};

const SEVERITY_ORDER: SeverityName[] = ['error', 'warning', 'information', 'hint'];

interface ExportedProblem {
    file: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    severity: SeverityName;
    source: string;
    code: string | null;
    message: string;
}

interface Snapshot {
    generatedAt: string;
    workspaceRoot: string;
    minSeverity: SeverityName;
    counts: Record<SeverityName, number>;
    total: number;
    truncated: boolean;
    problems: ExportedProblem[];
}

type DisplayMode = 'counts' | 'mode' | 'icon' | 'hidden';

const PAUSED_KEY = 'claudeDiagnostics.paused';

/**
 * Consent state for editing the user's global `~/.claude.json`. Stored in
 * globalState (per-machine) because the file itself is per-machine and
 * deliberately not shared into devcontainers.
 *   undefined -> never asked
 *   'granted' -> may upsert on activate
 *   'denied'  -> leave the file alone
 */
const MCP_CONSENT_KEY = 'claudeDiagnostics.mcpConsent';

let timer: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let state: vscode.Memento;
let globalState: vscode.Memento;
/** Stashed for menu handlers that need the extension install path. */
let currentContext: vscode.ExtensionContext;

/** Last write outcome, surfaced in the status bar. */
let lastError: string | undefined;
let lastWrittenAt: Date | undefined;
let lastCounts: Record<SeverityName, number> = {
    error: 0,
    warning: 0,
    information: 0,
    hint: 0,
};

export function activate(context: vscode.ExtensionContext) {
    output = vscode.window.createOutputChannel('Claude Diagnostics Bridge');
    state = context.workspaceState;
    globalState = context.globalState;
    currentContext = context;

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'claudeDiagnostics.showMenu';

    context.subscriptions.push(
        output,
        statusBar,
        vscode.languages.onDidChangeDiagnostics(() => schedule()),
        vscode.commands.registerCommand('claudeDiagnostics.writeNow', () => write()),
        vscode.commands.registerCommand('claudeDiagnostics.showMenu', () => showMenu()),
        vscode.commands.registerCommand('claudeDiagnostics.togglePaused', () => togglePaused()),
        vscode.commands.registerCommand('claudeDiagnostics.registerMcp', () =>
            registerMcpCommand(context),
        ),
        vscode.commands.registerCommand('claudeDiagnostics.unregisterMcp', () =>
            unregisterMcpCommand(),
        ),
        vscode.commands.registerCommand('claudeDiagnostics.installSkill', () =>
            installSkill(context, output),
        ),
        vscode.commands.registerCommand('claudeDiagnostics.warmUp', () =>
            warmUpDiagnostics(output),
        ),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('claudeDiagnostics')) {
                render();
                schedule();
            }
        }),
    );

    render();
    schedule();
    void ensureMcpRegistered(context);
}

/**
 * On activate: if the user has already consented, refresh our entry in
 * `~/.claude.json` (the path changes on version bumps). If they have never been
 * asked, prompt once — non-modally, so startup is never blocked. A prior "deny"
 * is respected silently; they can still opt in later via the command.
 */
async function ensureMcpRegistered(context: vscode.ExtensionContext) {
    const consent = globalState.get<'granted' | 'denied'>(MCP_CONSENT_KEY);

    if (consent === 'granted') {
        try {
            await registerMcpServer(context, output);
        } catch (err) {
            output.appendLine(`MCP registration failed: ${err}`);
        }
        return;
    }
    if (consent === 'denied') {
        return;
    }

    const choice = await vscode.window.showInformationMessage(
        'Register the Claude Diagnostics MCP server so Claude Code (CLI and ' +
            'VS Code) can read this workspace’s Problems panel? This adds one ' +
            'entry to your ~/.claude.json.',
        'Register',
        'Not now',
    );
    if (choice === 'Register') {
        await globalState.update(MCP_CONSENT_KEY, 'granted');
        await registerMcpCommand(context);
    } else if (choice === 'Not now') {
        // Not persisted as a hard "denied": leaving it unset means we ask again
        // on a future session, which is friendlier than a one-shot refusal.
    }
}

async function registerMcpCommand(context: vscode.ExtensionContext) {
    try {
        const wrote = await registerMcpServer(context, output);
        await globalState.update(MCP_CONSENT_KEY, 'granted');
        vscode.window.showInformationMessage(
            wrote
                ? 'Claude Diagnostics MCP server registered. Restart Claude Code to pick it up.'
                : 'Claude Diagnostics MCP server already registered and up to date.',
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Could not register MCP server: ${err}`);
        output.appendLine(`MCP registration failed: ${err}`);
    }
}

async function unregisterMcpCommand() {
    try {
        const removed = await unregisterMcpServer(output);
        await globalState.update(MCP_CONSENT_KEY, 'denied');
        vscode.window.showInformationMessage(
            removed
                ? 'Claude Diagnostics MCP server removed from ~/.claude.json.'
                : 'Claude Diagnostics MCP server was not registered.',
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Could not remove MCP server: ${err}`);
        output.appendLine(`MCP unregistration failed: ${err}`);
    }
}

export function deactivate() {
    if (timer) {
        clearTimeout(timer);
    }
}

function config() {
    return vscode.workspace.getConfiguration('claudeDiagnostics');
}

/**
 * Where the snapshot is written.
 *
 * Default (empty `outputPath`): namespaced under the user's home directory, so
 * repositories stay clean and two projects never collide. The name is the
 * workspace basename plus a hash of its absolute path — the MCP server derives
 * the identical name from the same path.
 *
 * An absolute `outputPath` is used verbatim; a relative one resolves against the
 * workspace folder (kept for back-compat with the old in-repo default).
 */
function resolveTarget(root: vscode.WorkspaceFolder): vscode.Uri {
    const configured = config().get<string>('outputPath', '').trim();
    if (configured) {
        return path.isAbsolute(configured)
            ? vscode.Uri.file(configured)
            : vscode.Uri.joinPath(root.uri, ...configured.split('/'));
    }
    return vscode.Uri.file(defaultSnapshotPath(root.uri.fsPath));
}

/** Home-dir namespaced path; mirrored byte-for-byte in mcp/server.js. */
function defaultSnapshotPath(rootPath: string): string {
    const normalized = path.resolve(rootPath);
    const base = path.basename(normalized);
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
    return path.join(os.homedir(), '.claude', 'diagnostics', `${base}-${hash}.json`);
}

function isPaused(): boolean {
    return state.get<boolean>(PAUSED_KEY, false);
}

async function togglePaused() {
    const paused = !isPaused();
    await state.update(PAUSED_KEY, paused);
    render();
    if (!paused) {
        schedule();
    }
}

function render() {
    const display = config().get<DisplayMode>('statusBarDisplay', 'counts');
    if (display === 'hidden') {
        statusBar.hide();
        return;
    }

    const paused = isPaused();
    const minSeverity = config().get<SeverityName>('minSeverity', 'warning');

    // A failure or a pause overrides the display mode: those states must stay
    // legible even when the user picked icon-only.
    let text: string;
    if (lastError) {
        // $(alert), not $(error): $(error) is a problem count below, and a broken
        // bridge must not read as "your code has one error".
        text = '$(alert) write failed';
    } else if (paused) {
        text = '$(debug-pause) paused';
    } else if (display === 'mode') {
        text = `$(broadcast) ${minSeverity}`;
    } else if (display === 'icon') {
        text = '$(broadcast)';
    } else {
        // counts: the $(error)/$(warning) icons carry the meaning on their own.
        text = `$(error) ${lastCounts.error} $(warning) ${lastCounts.warning}`;
    }
    statusBar.text = text;

    statusBar.backgroundColor = lastError
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;

    const root = vscode.workspace.workspaceFolders?.[0];
    const written = lastWrittenAt ? lastWrittenAt.toLocaleTimeString() : 'not yet';

    let statusLine: string;
    if (lastError) {
        statusLine = `$(alert) ${lastError}`;
    } else if (paused) {
        statusLine = 'Status: paused';
    } else {
        statusLine = 'Status: running';
    }

    statusBar.tooltip = new vscode.MarkdownString(
        [
            '**Claude Diagnostics Bridge**',
            '',
            statusLine,
            '',
            `Exporting: **${minSeverity}** and above`,
            `Last written: ${written}`,
            `Problems: ${lastCounts.error} error, ${lastCounts.warning} warning`,
            root ? `Writes to: \`${resolveTarget(root).fsPath}\`` : 'No workspace open.',
            '',
            '_Click for options._',
        ].join('\n'),
        true,
    );

    // Status bar items are created hidden; nothing renders without this.
    statusBar.show();
}

async function showMenu() {
    const paused = isPaused();
    const minSeverity = config().get<SeverityName>('minSeverity', 'warning');
    const display = config().get<DisplayMode>('statusBarDisplay', 'counts');

    interface Item extends vscode.QuickPickItem {
        run: () => void | Promise<void>;
    }

    const items: Item[] = [
        {
            label: paused ? '$(debug-start) Resume' : '$(debug-pause) Pause',
            description: paused
                ? 'Start writing snapshots again'
                : 'Stop writing snapshots for this workspace',
            run: togglePaused,
        },
        {
            label: '$(save) Write snapshot now',
            description: 'Force an immediate export',
            run: write,
        },
        {
            label: '$(search) Warm up project diagnostics',
            description: 'Load project files so linters report on all of them',
            run: () => warmUpDiagnostics(output),
        },
        {
            label: '$(filter) Minimum severity',
            description: `currently: ${minSeverity}`,
            run: pickSeverity,
        },
        {
            label: '$(layout-statusbar) Status bar display',
            description: `currently: ${display}`,
            run: pickDisplay,
        },
        {
            label: '$(json) Open snapshot file',
            run: openSnapshot,
        },
        {
            label: '$(clippy) Copy snapshot path',
            run: copyPath,
        },
        {
            label: '$(plug) Register MCP server',
            description: 'Add the diagnostics MCP server to ~/.claude.json',
            run: () => registerMcpCommand(currentContext),
        },
        {
            label: '$(debug-disconnect) Unregister MCP server',
            description: 'Remove it from ~/.claude.json',
            run: unregisterMcpCommand,
        },
        {
            label: '$(book) Install fix-problems skill',
            description: 'Copy the skill into this workspace’s .claude/skills/',
            run: () => installSkill(currentContext, output),
        },
        {
            label: '$(output) Show log',
            run: () => output.show(),
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Claude Diagnostics Bridge',
        placeHolder: paused ? 'Paused' : 'Running',
    });
    await picked?.run();
}

async function pickSeverity() {
    const current = config().get<SeverityName>('minSeverity', 'warning');
    const picked = await vscode.window.showQuickPick(
        SEVERITY_ORDER.map((severity) => ({
            label: severity,
            description: severity === current ? '$(check) current' : undefined,
            detail: `Export ${severity} and above`,
            severity,
        })),
        { title: 'Minimum severity to export' },
    );
    if (picked) {
        await config().update(
            'minSeverity',
            picked.severity,
            vscode.ConfigurationTarget.Workspace,
        );
    }
}

async function pickDisplay() {
    const current = config().get<DisplayMode>('statusBarDisplay', 'counts');
    const options: Array<{ value: DisplayMode; detail: string }> = [
        { value: 'counts', detail: 'Error and warning counts, e.g. "1  5"' },
        { value: 'mode', detail: 'Icon plus the current minimum severity' },
        { value: 'icon', detail: 'Icon only' },
        { value: 'hidden', detail: 'No status bar item' },
    ];
    const picked = await vscode.window.showQuickPick(
        options.map((o) => ({
            label: o.value,
            description: o.value === current ? '$(check) current' : undefined,
            detail: o.detail,
            value: o.value,
        })),
        { title: 'Status bar display' },
    );
    if (picked) {
        await config().update(
            'statusBarDisplay',
            picked.value,
            vscode.ConfigurationTarget.Workspace,
        );
    }
}

function targetOrWarn(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
        vscode.window.showWarningMessage('Claude Diagnostics: no workspace folder open.');
        return undefined;
    }
    return resolveTarget(root);
}

async function openSnapshot() {
    const target = targetOrWarn();
    if (!target) {
        return;
    }
    try {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    } catch {
        vscode.window.showWarningMessage(
            `No snapshot at ${target.fsPath} yet. Try "Write snapshot now".`,
        );
    }
}

async function copyPath() {
    const target = targetOrWarn();
    if (!target) {
        return;
    }
    await vscode.env.clipboard.writeText(target.fsPath);
    vscode.window.showInformationMessage(`Copied: ${target.fsPath}`);
}

function schedule() {
    if (timer) {
        clearTimeout(timer);
    }
    if (isPaused()) {
        return;
    }
    timer = setTimeout(() => void write(), config().get<number>('debounceMs', 1500));
}

/**
 * Diagnostics arrive for every open document, including ones outside the
 * workspace (git diff views, settings.json, node_modules). Only files under a
 * workspace folder are worth reporting, and paths are emitted relative to that
 * folder so they stay stable and clickable.
 */
function resolveRelative(uri: vscode.Uri, root: vscode.WorkspaceFolder): string | null {
    if (uri.scheme !== 'file') {
        return null;
    }
    const relative = path.relative(root.uri.fsPath, uri.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }
    return relative.split(path.sep).join('/');
}

function codeToString(code: vscode.Diagnostic['code']): string | null {
    if (code === undefined || code === null) {
        return null;
    }
    if (typeof code === 'string' || typeof code === 'number') {
        return String(code);
    }
    return String(code.value);
}

async function write() {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
        return;
    }

    const minSeverity = config().get<SeverityName>('minSeverity', 'warning');
    const maxProblems = config().get<number>('maxProblems', 2000);
    const threshold = SEVERITY_ORDER.indexOf(minSeverity);

    const counts: Record<SeverityName, number> = {
        error: 0,
        warning: 0,
        information: 0,
        hint: 0,
    };
    const problems: ExportedProblem[] = [];

    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
        const file = resolveRelative(uri, root);
        if (file === null) {
            continue;
        }
        for (const diagnostic of diagnostics) {
            const severity = SEVERITY_NAMES[diagnostic.severity];
            if (SEVERITY_ORDER.indexOf(severity) > threshold) {
                continue;
            }
            counts[severity]++;
            problems.push({
                file,
                // VS Code positions are zero-based; editors and humans are not.
                line: diagnostic.range.start.line + 1,
                column: diagnostic.range.start.character + 1,
                endLine: diagnostic.range.end.line + 1,
                endColumn: diagnostic.range.end.character + 1,
                severity,
                source: diagnostic.source ?? 'unknown',
                code: codeToString(diagnostic.code),
                message: diagnostic.message,
            });
        }
    }

    problems.sort((a, b) => {
        const bySeverity =
            SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
        if (bySeverity !== 0) {
            return bySeverity;
        }
        return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
    });

    const total = problems.length;
    const truncated = total > maxProblems;

    const snapshot: Snapshot = {
        generatedAt: new Date().toISOString(),
        workspaceRoot: root.uri.fsPath,
        minSeverity,
        counts,
        total,
        truncated,
        problems: truncated ? problems.slice(0, maxProblems) : problems,
    };

    const target = resolveTarget(root);

    try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
        await vscode.workspace.fs.writeFile(
            target,
            Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8'),
        );
        lastError = undefined;
        lastWrittenAt = new Date();
        lastCounts = counts;
    } catch (err) {
        lastError = `Failed to write ${target.fsPath}: ${err}`;
        output.appendLine(lastError);
    }
    render();
}
