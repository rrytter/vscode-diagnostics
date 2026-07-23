import * as vscode from 'vscode';
import * as path from 'node:path';

/**
 * Accumulated diagnostics.
 *
 * The Problems panel is a live view of what language servers currently hold, and
 * they hold results only for open documents. Warm-up opens files without editor
 * tabs, VS Code closes them again, and the servers retract on close — so reading
 * the panel after a warm-up gives back a fraction of what the warm-up actually
 * found. The panel is not a record; it is a window.
 *
 * This module keeps the record. While accumulating, every diagnostic that
 * arrives is stored per-file and survives the panel forgetting it. The snapshot
 * is then written from the accumulation rather than from a `getDiagnostics()`
 * call that may have drained minutes ago.
 *
 * Live mode is the original behaviour: the snapshot mirrors the panel exactly,
 * which is what you want while working normally in the editor.
 */

export type SeverityName = 'error' | 'warning' | 'information' | 'hint';

export interface ExportedProblem {
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

export interface WarmupInfo {
    completedAt: string;
    fileCount: number;
    cancelled: boolean;
    timedOut: boolean;
}

const SEVERITY_NAMES: Record<vscode.DiagnosticSeverity, SeverityName> = {
    [vscode.DiagnosticSeverity.Error]: 'error',
    [vscode.DiagnosticSeverity.Warning]: 'warning',
    [vscode.DiagnosticSeverity.Information]: 'information',
    [vscode.DiagnosticSeverity.Hint]: 'hint',
};

/**
 * Everything seen since accumulation began, keyed by workspace-relative path.
 * Per-file rather than a flat list so a file can be replaced wholesale when it
 * is re-analysed — see `absorb`.
 */
let accumulated = new Map<string, ExportedProblem[]>();

/** False while accumulating: the snapshot then reflects the record, not the panel. */
let live = true;

let warmupInfo: WarmupInfo | undefined;
let listener: vscode.Disposable | undefined;

/**
 * Called whenever the mode changes, so the status bar reflects it at the moment
 * it happens rather than at the next debounced write.
 */
let onModeChange: (() => void) | undefined;

export function setModeChangeListener(callback: () => void): void {
    onModeChange = callback;
}

/**
 * True only while the warm-up pass is running, as distinct from `!isLive()`,
 * which stays true for the whole fixing session afterwards. Used to keep UI out
 * of the way of the progress notification.
 */
let warmingUp = false;

export function isWarmingUp(): boolean {
    return warmingUp;
}

export function setWarmingUp(value: boolean): void {
    warmingUp = value;
    onModeChange?.();
}

export function isLive(): boolean {
    return live;
}

export function getWarmupInfo(): WarmupInfo | undefined {
    return warmupInfo;
}

export function accumulatedFileCount(): number {
    return accumulated.size;
}

/**
 * Switch to accumulating and start capturing. Any previous accumulation is
 * discarded: a new warm-up is a new pass over the project, and merging it into
 * a stale one would resurrect problems from code that has since changed.
 */
export function beginAccumulating(): void {
    accumulated = new Map();
    warmupInfo = undefined;
    live = false;

    listener?.dispose();
    // Capture on every change, not just during the warm-up loop: while frozen,
    // this is also what picks up fixes as they land.
    listener = vscode.languages.onDidChangeDiagnostics((event) => {
        for (const uri of event.uris) {
            absorb(uri);
        }
    });

    onModeChange?.();
}

/** Return to mirroring the panel, and drop the record. */
export function resumeLive(): void {
    live = true;
    accumulated = new Map();
    warmupInfo = undefined;
    listener?.dispose();
    listener = undefined;
    onModeChange?.();
}

export function noteFilesAnalysed(
    files: string[],
    outcome: { cancelled: boolean; timedOut: boolean },
): void {
    warmupInfo = {
        completedAt: new Date().toISOString(),
        fileCount: files.length,
        cancelled: outcome.cancelled,
        timedOut: outcome.timedOut,
    };
}

/**
 * Take the current diagnostics for one file into the record.
 *
 * The merge rule is replace-per-file, not union. A union would be wrong in the
 * common case: Claude fixes `index.php:13`, the server republishes the file
 * without that problem, and a union keeps the fixed problem forever — sending
 * Claude back to a line that is already correct.
 *
 * The exception is retraction to empty. A file going silent because its document
 * was closed is byte-for-byte identical, at this API, to a file that just became
 * clean. Treating both as "clean" would delete real findings as VS Code evicts
 * warm-up documents — the original bug, moved one layer up. So an empty result
 * only counts when the document is still open, which is exactly the case where
 * the server had a reason to speak. Otherwise the previous findings stand.
 */
function absorb(uri: vscode.Uri): void {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root || uri.scheme !== 'file') {
        return;
    }
    const file = relativeTo(uri, root);
    if (file === null) {
        return;
    }

    const current = vscode.languages.getDiagnostics(uri);

    if (current.length === 0) {
        const stillOpen = vscode.workspace.textDocuments.some(
            (doc) => doc.uri.toString() === uri.toString(),
        );
        if (!stillOpen) {
            return; // Eviction, not a fix. Keep what we already have.
        }
        accumulated.delete(file); // Genuinely clean now.
        return;
    }

    accumulated.set(
        file,
        current.map((diagnostic) => toExported(file, diagnostic)),
    );
}

function toExported(file: string, diagnostic: vscode.Diagnostic): ExportedProblem {
    return {
        file,
        // VS Code positions are zero-based; editors and humans are not.
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        endLine: diagnostic.range.end.line + 1,
        endColumn: diagnostic.range.end.character + 1,
        severity: SEVERITY_NAMES[diagnostic.severity],
        source: diagnostic.source ?? 'unknown',
        code: codeToString(diagnostic.code),
        message: diagnostic.message,
    };
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

/**
 * Diagnostics arrive for every open document, including ones outside the
 * workspace (git diff views, settings.json, node_modules). Only files under a
 * workspace folder are worth reporting, and paths are emitted relative to that
 * folder so they stay stable and clickable.
 */
export function relativeTo(uri: vscode.Uri, root: vscode.WorkspaceFolder): string | null {
    if (uri.scheme !== 'file') {
        return null;
    }
    const relative = path.relative(root.uri.fsPath, uri.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }
    return relative.split(path.sep).join('/');
}

/**
 * The problems to export: the live panel, or the accumulated record while
 * frozen. Callers do not need to know which mode is active.
 */
export function currentProblems(root: vscode.WorkspaceFolder): ExportedProblem[] {
    if (live) {
        const problems: ExportedProblem[] = [];
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
            const file = relativeTo(uri, root);
            if (file === null) {
                continue;
            }
            for (const diagnostic of diagnostics) {
                problems.push(toExported(file, diagnostic));
            }
        }
        return problems;
    }
    return [...accumulated.values()].flat();
}

export function dispose(): void {
    listener?.dispose();
    listener = undefined;
}
