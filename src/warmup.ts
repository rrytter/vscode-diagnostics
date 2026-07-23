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
 * Those documents do not stay open. VS Code closes anything no editor
 * references, and on `didClose` a language server is entitled to retract
 * everything it published for that URI — Intelephense and SonarLint both do. So
 * the panel drains as the pass proceeds, and it is normal for warm-up to finish
 * with far fewer problems visible than it actually found.
 *
 * Rather than fight that (holding thousands of documents open to keep the panel
 * populated), the warm-up ACCUMULATES: it records every problem as it is
 * published and keeps it after the panel has forgotten it. See `collector.ts`.
 * Eviction becomes irrelevant, because the snapshot no longer depends on the
 * panel still holding the data at the moment it is written.
 *
 * The pass is still expensive (every language server analyses every file), so it
 * is a deliberate command, capped, and cancellable.
 */

import { beginAccumulating, noteFilesAnalysed, setWarmingUp } from './collector';
import { loadIgnoreMatcher } from './gitignore';

/** Directories that never carry first-party diagnostics but do carry huge trees. */
const DEFAULT_EXCLUDE =
    '**/{node_modules,vendor,.git,dist,out,build,.next,.venv,__pycache__,coverage}/**';

/**
 * How long the Problems panel must stay unchanged before language servers are
 * considered done. Long enough to bridge the gap between a server finishing one
 * file and starting the next; short enough that a quiet project settles quickly.
 */
const QUIET_PERIOD_MS = 4000;

interface WarmupConfig {
    include: string;
    exclude: string;
    maxFiles: number;
    settleTimeoutMs: number;
    respectGitignore: boolean;
}

function warmupConfig(): WarmupConfig {
    const config = vscode.workspace.getConfiguration('claudeDiagnostics');
    return {
        include: config.get<string>('warmupInclude', '**/*'),
        exclude: config.get<string>('warmupExclude', DEFAULT_EXCLUDE),
        maxFiles: config.get<number>('warmupMaxFiles', 2000),
        settleTimeoutMs: config.get<number>('warmupSettleTimeoutMs', 120000),
        respectGitignore: config.get<boolean>('warmupRespectGitignore', true),
    };
}

/**
 * `findFiles` honours `files.exclude` and `search.exclude`, and our own exclude
 * glob on top. It does NOT honour `.gitignore` — a common and costly assumption,
 * because build output, caches, and vendored trees are real code that linters
 * will happily report problems in. Findings from `var/cache/index.php` look
 * exactly like findings from source, so they waste attention and, when handed to
 * Claude, invite edits to generated files.
 *
 * So ignored files are filtered out explicitly, unless the user opts back in.
 */
async function collectFiles(
    config: WarmupConfig,
    root: vscode.WorkspaceFolder,
    output: vscode.OutputChannel,
): Promise<{ files: vscode.Uri[]; ignored: number }> {
    const found = await vscode.workspace.findFiles(config.include, config.exclude);

    if (!config.respectGitignore) {
        return { files: found, ignored: 0 };
    }

    const matcher = await loadIgnoreMatcher(root, output);
    if (matcher.ruleCount === 0) {
        return { files: found, ignored: 0 };
    }

    const files = found.filter(
        (uri) => !matcher.ignores(vscode.workspace.asRelativePath(uri, false)),
    );
    return { files, ignored: found.length - files.length };
}

/**
 * Resolves once diagnostics have stopped arriving for `QUIET_PERIOD_MS`, or once
 * `timeoutMs` elapses. Analysis is asynchronous and unbounded: the last
 * `openTextDocument` returning means the servers have received the work, not
 * that they have finished it.
 */
function waitForDiagnosticsToSettle(
    timeoutMs: number,
    token: vscode.CancellationToken,
): Promise<{ timedOut: boolean }> {
    return new Promise((resolve) => {
        let quietTimer: NodeJS.Timeout;
        let settled = false;

        const finish = (timedOut: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(quietTimer);
            clearTimeout(deadline);
            subscription.dispose();
            cancellation.dispose();
            resolve({ timedOut });
        };

        const restartQuietTimer = () => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(() => finish(false), QUIET_PERIOD_MS);
        };

        const subscription = vscode.languages.onDidChangeDiagnostics(restartQuietTimer);
        const deadline = setTimeout(() => finish(true), timeoutMs);
        const cancellation = token.onCancellationRequested(() => finish(false));

        restartQuietTimer();
    });
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
    const { files, ignored } = await collectFiles(config, root, output);

    if (ignored > 0) {
        output.appendLine(`Warm-up: skipped ${ignored} git-ignored file(s).`);
    }

    if (files.length === 0) {
        vscode.window.showInformationMessage(
            ignored > 0
                ? `Claude Diagnostics: all ${ignored} matching file(s) are git-ignored. ` +
                      'Set claudeDiagnostics.warmupRespectGitignore to false to include them.'
                : 'Claude Diagnostics: no files matched the warm-up globs.',
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

    // Start accumulating BEFORE the first file is opened: the first diagnostics
    // can land while the loop is still running, and anything published before
    // this point would be lost to eviction like it always was.
    beginAccumulating();
    setWarmingUp(true);

    let opened = 0;
    let failed = 0;
    let cancelled = false;
    let timedOut = false;
    const analysed: string[] = [];

    try {
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
                        cancelled = true;
                        break;
                    }
                    try {
                        const doc = await vscode.workspace.openTextDocument(targets[i]);
                        // No reference is kept: VS Code may close this the moment
                        // we move on, and that is fine — whatever the servers
                        // publish is captured by the collector, not the panel.
                        analysed.push(vscode.workspace.asRelativePath(doc.uri, false));
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

                // Opening the last file is not the end of the job — the servers
                // are still working through their queue, and results published
                // after we return here would arrive with nobody watching.
                progress.report({
                    message: `waiting for language servers (${opened} file(s) loaded)`,
                });
                ({ timedOut } = await waitForDiagnosticsToSettle(
                    config.settleTimeoutMs,
                    token,
                ));
            },
        );
    } finally {
        // Must clear even if the pass throws, or the tooltip stays suppressed
        // for the rest of the session.
        setWarmingUp(false);
    }

    noteFilesAnalysed(analysed, { cancelled, timedOut });

    const summary =
        `Warm-up: opened ${opened} file(s)` +
        (ignored ? `, skipped ${ignored} git-ignored` : '') +
        (failed ? `, skipped ${failed} unreadable` : '') +
        (cancelled ? ' (cancelled early)' : '') +
        (timedOut ? ' (language servers still busy at timeout)' : '');

    // Logged, not popped up: the progress notification has just closed, and a
    // second notification landing in the same corner is the interruption the
    // user is trying to avoid. The hollow status bar bullet already says the
    // snapshot is accumulating, and the tooltip carries the detail.
    output.appendLine(
        `${summary}. Accumulating — snapshot holds every problem found until you resume.`,
    );
}
