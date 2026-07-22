import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';

/**
 * Self-registration of the bundled stdio MCP server into the user-scope Claude
 * Code config (`~/.claude.json`), so installing this extension is the whole
 * setup — both the Claude Code CLI and the Claude VS Code extension read that
 * file.
 *
 * Why `~/.claude.json` and not `~/.claude/settings.json`: MCP servers can only
 * be *defined* in `~/.claude.json` (user scope) or a project `.mcp.json`;
 * `settings.json` only *manages* them (allow/deny). `~/.claude.json` also sits
 * beside — not inside — the `~/.claude/` directory, which is deliberately NOT
 * mounted into devcontainers. That is the behaviour we want: the host extension
 * and a devcontainer-loaded extension each write their own machine-local
 * `server.js` path into their own (separate) `~/.claude.json`, so neither
 * clobbers the other with a path that is wrong on the other machine.
 */

/** Server key we own under `mcpServers`. We only ever touch this one entry. */
const SERVER_NAME = 'diagnostics';

/** Absolute path to `~/.claude.json` on the machine this extension runs on. */
function claudeConfigPath(): string {
    return path.join(os.homedir(), '.claude.json');
}

/**
 * Absolute path to the MCP server to launch, valid on THIS machine only.
 *
 * Prefer the esbuild-bundled single file (`out/mcp-server.js`) that ships in the
 * packaged .vsix — it carries its deps inline, so no `node_modules` is needed.
 * Fall back to the unbundled `mcp/server.js` for local development (F5 from
 * source), where `mcp/node_modules` is present but the bundle has not been built.
 */
function serverEntryPoint(context: vscode.ExtensionContext): string {
    // .mjs so Node always treats it as ESM regardless of the nearest
    // package.json (the extension's own package.json is CommonJS).
    const bundled = context.asAbsolutePath(path.join('out', 'mcp-server.mjs'));
    if (existsSync(bundled)) {
        return bundled;
    }
    return context.asAbsolutePath(path.join('mcp', 'server.js'));
}

/** The stdio server definition we want present in the config. */
function desiredEntry(context: vscode.ExtensionContext) {
    return {
        type: 'stdio' as const,
        // Plain "node" (resolved from PATH), not process.execPath: the latter is
        // VS Code's own Electron binary, which is version-specific and not a
        // general-purpose Node. Claude Code runs the server itself and reliably
        // has node on PATH.
        command: 'node',
        args: [serverEntryPoint(context)],
        // No env needed: server.js falls back to process.cwd() for the workspace
        // root, which the MCP client sets to the project directory.
    };
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
    try {
        const raw = await readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        // A malformed config is not ours to silently rewrite — surface it and
        // bail rather than risk stomping the user's other MCP servers.
        throw new Error(`Could not parse ${file}: ${err}`);
    }
}

/**
 * Write JSON atomically: a crash mid-write must not truncate the user's global
 * config. Write a sibling temp file, then rename over the target.
 */
async function writeConfigAtomic(file: string, data: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.claude-diagnostics.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
}

function entriesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Idempotent upsert of our entry, keyed by SERVER_NAME. Re-run on every
 * activate because the install path changes on version bumps — we always
 * refresh it to the current machine-local path. Returns true if a write
 * happened, false if the config already matched.
 */
export async function registerMcpServer(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<boolean> {
    const file = claudeConfigPath();
    const config = await readConfig(file);

    const servers =
        (config.mcpServers as Record<string, unknown> | undefined) ?? {};
    const wanted = desiredEntry(context);

    if (entriesEqual(servers[SERVER_NAME], wanted)) {
        return false;
    }

    config.mcpServers = { ...servers, [SERVER_NAME]: wanted };
    await writeConfigAtomic(file, config);
    output.appendLine(
        `Registered MCP server "${SERVER_NAME}" -> ${wanted.args[0]} in ${file}`,
    );
    return true;
}

/**
 * Remove our entry. Only deletes the key we own; everything else is preserved.
 * Returns true if something was removed. Uninstall does not reliably run
 * deactivate(), so this is exposed as an explicit command for cleanup.
 */
export async function unregisterMcpServer(
    output: vscode.OutputChannel,
): Promise<boolean> {
    const file = claudeConfigPath();
    const config = await readConfig(file);
    const servers = config.mcpServers as Record<string, unknown> | undefined;

    if (!servers || !(SERVER_NAME in servers)) {
        return false;
    }

    delete servers[SERVER_NAME];
    await writeConfigAtomic(file, config);
    output.appendLine(`Unregistered MCP server "${SERVER_NAME}" from ${file}`);
    return true;
}
