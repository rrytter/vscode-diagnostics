import * as vscode from 'vscode';

/**
 * Project-wide diagnostics warm-up.
 *
 * Language servers only report problems for files they have been asked to
 * analyse — in practice, files that have been opened. A fresh window therefore
 * shows an almost-empty Problems panel, and an exported snapshot of it reads as
 * "this project is clean" when nobody has looked at it yet. That false-clean
 * result is the exact failure this bridge exists to prevent, so we give the user
 * a way to force analysis across the project.
 *
 * `openTextDocument` loads a file into the document layer — enough for language
 * servers to analyse it — WITHOUT opening a visible editor tab. Opening a few
 * thousand real tabs would make VS Code unusable; this does not.
 *
 * The pass is still expensive (every language server analyses every file), so it
 * is a deliberate command, capped, and cancellable.
 */

/** Directories that never carry first-party diagnostics but do carry huge trees. */
const DEFAULT_EXCLUDE =
    '**/{node_modules,vendor,.git,dist,out,build,.next,.venv,__pycache__,coverage}/**';

interface WarmupConfig {
    include: string;
    exclude: string;
    maxFiles: number;
}

function warmupConfig(): WarmupConfig {
    const config = vscode.workspace.getConfiguration('claudeDiagnostics');
    return {
        include: config.get<string>('warmupInclude', '**/*'),
        exclude: config.get<string>('warmupExclude', DEFAULT_EXCLUDE),
        maxFiles: config.get<number>('warmupMaxFiles', 2000),
    };
}

/**
 * `findFiles` with `useDefaultExcludes` honours files.exclude and search.exclude,
 * which is how the user's .gitignore-driven search settings take effect. We add
 * our own exclude glob on top for the directories that are costly regardless.
 */
async function collectFiles(config: WarmupConfig): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles(config.include, config.exclude);
}

export async function warmUpDiagnostics(output: vscode.OutputChannel): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
        vscode.window.showWarningMessage(
            'Claude Diagnostics: open a workspace folder before warming up diagnostics.',
        );
        return;
    }

    const config = warmupConfig();
    const files = await collectFiles(config);

    if (files.length === 0) {
        vscode.window.showInformationMessage(
            'Claude Diagnostics: no files matched the warm-up globs.',
        );
        return;
    }

    // Over the cap, the user chooses: a truncated pass is still a partial view,
    // and silently truncating would reproduce the false-clean problem.
    let targets = files;
    if (files.length > config.maxFiles) {
        const choice = await vscode.window.showWarningMessage(
            `${files.length} files match, above the ${config.maxFiles}-file cap. ` +
                'Analysing all of them can take a while and load every language server.',
            { modal: true },
            `Open first ${config.maxFiles}`,
            'Open all',
        );
        if (choice === `Open first ${config.maxFiles}`) {
            targets = files.slice(0, config.maxFiles);
        } else if (choice === 'Open all') {
            targets = files;
        } else {
            return; // Cancelled.
        }
    }

    let opened = 0;
    let failed = 0;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Claude Diagnostics: warming up project diagnostics',
            cancellable: true,
        },
        async (progress, token) => {
            const total = targets.length;
            // Report at most ~100 times; a per-file increment on a large repo
            // spends more time updating the notification than opening files.
            const step = Math.max(1, Math.floor(total / 100));

            for (let i = 0; i < total; i++) {
                if (token.isCancellationRequested) {
                    break;
                }
                try {
                    await vscode.workspace.openTextDocument(targets[i]);
                    opened++;
                } catch {
                    // Binary files, files deleted mid-pass, files over VS Code's
                    // size limit: all uninteresting for diagnostics.
                    failed++;
                }
                if (i % step === 0 || i === total - 1) {
                    progress.report({
                        increment: (step / total) * 100,
                        message: `${i + 1} / ${total}`,
                    });
                }
            }
        },
    );

    const summary =
        `Warm-up: opened ${opened} file(s)` +
        (failed ? `, skipped ${failed} unreadable` : '') +
        (opened < targets.length ? ' (cancelled early)' : '');
    output.appendLine(summary);

    // Language servers analyse asynchronously; the snapshot is written on its own
    // debounce as diagnostics arrive. Say so, so an immediately-read snapshot is
    // not mistaken for the final result.
    vscode.window.showInformationMessage(
        `${summary}. Language servers are still analysing — the snapshot updates as results arrive.`,
    );
}
