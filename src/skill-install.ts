import * as vscode from 'vscode';
import * as path from 'node:path';

/**
 * Installs the bundled `fix-problems` skill into the *project's* `.claude/skills/`
 * directory — not the user-global `~/.claude/skills/`.
 *
 * Project scope is deliberate: unlike the MCP registration (per-machine, global
 * infrastructure), a skill is opinionated workflow the user may version, edit, or
 * commit. Living under the workspace means it rides into a devcontainer with the
 * mounted project, needs no home-dir write, and never clobbers a global skill the
 * user tuned for another project. The trade-off is that it is per-project: run
 * the command once in each workspace where you want it.
 *
 * On demand only (a command), and never overwrites: an existing skill may carry
 * the user's own edits.
 */

const SKILL_NAME = 'fix-problems';

/** Bundled source of the skill inside the extension. */
function skillSource(context: vscode.ExtensionContext): vscode.Uri {
    return vscode.Uri.file(context.asAbsolutePath(path.join('skills', SKILL_NAME)));
}

/** Target under the first workspace folder. */
function skillTarget(root: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(root.uri, '.claude', 'skills', SKILL_NAME);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

/** Recursive copy via the VS Code FS API so it also works over remote/virtual FS. */
async function copyTree(source: vscode.Uri, dest: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(dest);
    for (const [name, type] of await vscode.workspace.fs.readDirectory(source)) {
        const from = vscode.Uri.joinPath(source, name);
        const to = vscode.Uri.joinPath(dest, name);
        if (type === vscode.FileType.Directory) {
            await copyTree(from, to);
        } else {
            await vscode.workspace.fs.copy(from, to, { overwrite: true });
        }
    }
}

export async function installSkill(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
        vscode.window.showWarningMessage(
            'Claude Diagnostics: open a workspace folder before installing the skill.',
        );
        return;
    }

    const source = skillSource(context);
    const target = skillTarget(root);

    if (!(await exists(source))) {
        vscode.window.showErrorMessage(
            `Bundled skill not found at ${source.fsPath}. Is the extension packaged correctly?`,
        );
        return;
    }

    if (await exists(target)) {
        // Never silently clobber: the user may have tuned this skill.
        const choice = await vscode.window.showWarningMessage(
            `A "${SKILL_NAME}" skill already exists in this workspace.`,
            { modal: true },
            'Open it',
            'Overwrite',
        );
        if (choice === 'Open it') {
            await vscode.commands.executeCommand(
                'revealInExplorer',
                vscode.Uri.joinPath(target, 'SKILL.md'),
            );
            return;
        }
        if (choice !== 'Overwrite') {
            return; // Cancel / dismissed
        }
    }

    try {
        await copyTree(source, target);
        output.appendLine(`Installed "${SKILL_NAME}" skill to ${target.fsPath}`);
        vscode.window.showInformationMessage(
            `Installed the "${SKILL_NAME}" skill into ${vscode.workspace.asRelativePath(target)}.`,
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Could not install skill: ${err}`);
        output.appendLine(`Skill install failed: ${err}`);
    }
}
