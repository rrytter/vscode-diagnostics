import * as vscode from 'vscode';

/**
 * `.gitignore` matching for the warm-up pass.
 *
 * `workspace.findFiles` does NOT read `.gitignore`. It honours `files.exclude`
 * and `search.exclude`, which are different settings that merely tend to overlap
 * with ignored paths on a well-configured project. On everything else the
 * warm-up happily loads build output, caches, and vendored trees — then reports
 * their problems as if they were the user's code. Cached or generated PHP is the
 * worst case: it is real code, so linters produce real, plausible-looking
 * findings for files nobody should edit.
 *
 * Git is not shelled out to. The workspace may not be a repository at all (and
 * frequently is not, for a scratch folder), git may not be installed, and
 * spawning a process per file would dominate the cost of the pass. The rules are
 * parsed and applied directly.
 *
 * The supported syntax is the part of gitignore(5) that appears in practice:
 * comments, blank lines, negation with `!`, anchoring with a leading or embedded
 * `/`, directory-only rules with a trailing `/`, and the `*`, `?`, `**` wildcards.
 * Character classes are passed through to the regex engine, which handles the
 * common `[0-9]` style. Not supported: `\` escaping of metacharacters, which is
 * vanishingly rare in real ignore files and whose absence fails safe — an
 * unparsed rule means a file is analysed, never that a real problem is hidden.
 */

interface Rule {
    /** Matches a path relative to the .gitignore's own directory. */
    regex: RegExp;
    negated: boolean;
    directoryOnly: boolean;
}

export interface IgnoreMatcher {
    /** True when `relativePath` (workspace-relative, `/`-separated) is ignored. */
    ignores(relativePath: string): boolean;
    /** Number of rules loaded, for logging. */
    ruleCount: number;
}

/** Matches nothing. Used when a project has no ignore files at all. */
const MATCH_NOTHING: IgnoreMatcher = {
    ignores: () => false,
    ruleCount: 0,
};

/**
 * Translates one gitignore pattern into a regex.
 *
 * The subtle rule is anchoring: a pattern containing a `/` anywhere except at
 * its end is anchored to the ignore file's directory, so `doc/frotz` matches only
 * at the top level. A pattern without one floats, so `cache` matches at any
 * depth. Getting this backwards would either miss real ignores or over-exclude
 * source directories that happen to share a name.
 */
function patternToRegex(pattern: string): RegExp {
    let body = pattern;
    let anchored = false;

    if (body.startsWith('/')) {
        anchored = true;
        body = body.slice(1);
    } else if (body.slice(0, -1).includes('/')) {
        // A slash anywhere but the trailing position anchors the pattern.
        anchored = true;
    }

    if (body.endsWith('/')) {
        body = body.slice(0, -1);
    }

    let regex = '';
    let i = 0;
    while (i < body.length) {
        const token = translateToken(body, i);
        regex += token.regex;
        i += token.length;
    }

    // A matched path is ignored along with everything under it, hence the
    // optional `/...` tail.
    const prefix = anchored ? '^' : '^(?:.*/)?';
    return new RegExp(`${prefix}${regex}(?:/.*)?$`);
}

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Translates the token starting at `index` into regex source, reporting how many
 * characters it consumed. Wildcards and character classes span several
 * characters, so the caller advances by `length` rather than always by one.
 */
function translateToken(body: string, index: number): { regex: string; length: number } {
    const char = body[index];

    if (char === '*') {
        if (body[index + 1] !== '*') {
            return { regex: '[^/]*', length: 1 }; // A single `*` stops at a separator.
        }
        // `**` spans directory separators; a trailing `/**` covers the whole
        // subtree, so it consumes the slash too.
        return body[index + 2] === '/'
            ? { regex: '(?:.*/)?', length: 3 }
            : { regex: '.*', length: 2 };
    }

    if (char === '?') {
        return { regex: '[^/]', length: 1 };
    }

    if (char === '[') {
        // Pass character classes through, but only when the class actually
        // closes — a stray `[` is a literal.
        const close = body.indexOf(']', index + 1);
        if (close !== -1) {
            const cls = body.slice(index, close + 1);
            return {
                // gitignore negates with `!`, regex with `^`.
                regex: cls.startsWith('[!') ? `[^${cls.slice(2)}` : cls,
                length: close - index + 1,
            };
        }
    }

    return { regex: char.replace(REGEX_METACHARACTERS, String.raw`\$&`), length: 1 };
}

/**
 * Whether a directory-only rule matched a *parent* of `path` rather than the
 * full path.
 *
 * `build/` must ignore `build/out.js` but not a file literally named `build`.
 * Since every path checked here is a file, the rule legitimately applies only
 * when some ancestor directory matched. Testing each prefix answers that
 * directly, and avoids inferring it from the regex shape.
 */
function directoryMatched(regex: RegExp, path: string): boolean {
    let index = path.indexOf('/');
    while (index !== -1) {
        if (regex.test(path.slice(0, index))) {
            return true;
        }
        index = path.indexOf('/', index + 1);
    }
    return false;
}

function parseRules(content: string): Rule[] {
    const rules: Rule[] = [];

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (line === '' || line.startsWith('#')) {
            continue;
        }

        let pattern = line;
        let negated = false;
        if (pattern.startsWith('!')) {
            negated = true;
            pattern = pattern.slice(1);
        }
        if (pattern === '') {
            continue;
        }

        rules.push({
            regex: patternToRegex(pattern),
            negated,
            directoryOnly: pattern.endsWith('/'),
        });
    }

    return rules;
}

/**
 * Loads every `.gitignore` in the workspace, plus `.git/info/exclude`.
 *
 * Nested ignore files apply to their own subtree, so each rule set is kept with
 * the directory it came from and only consulted for paths beneath it — a rule in
 * `packages/web/.gitignore` must not silence a match in `packages/api/`.
 */
export async function loadIgnoreMatcher(
    root: vscode.WorkspaceFolder,
    output?: vscode.OutputChannel,
): Promise<IgnoreMatcher> {
    // Bounded so a pathological tree cannot stall the pass before it starts.
    const files = await vscode.workspace.findFiles(
        '**/.gitignore',
        '**/{node_modules,.git}/**',
        1000,
    );

    /** Rule sets keyed by the `/`-terminated directory prefix they apply to. */
    const sets: Array<{ prefix: string; rules: Rule[] }> = [];

    const localExclude = vscode.Uri.joinPath(root.uri, '.git', 'info', 'exclude');
    for (const uri of [localExclude, ...files]) {
        let content: string;
        try {
            content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        } catch {
            continue; // Absent (.git/info/exclude usually is) or unreadable.
        }

        const rules = parseRules(content);
        if (rules.length === 0) {
            continue;
        }

        // `.git/info/exclude` applies to the whole workspace, like a root file.
        const dir = uri.path.endsWith('/.git/info/exclude')
            ? root.uri.path
            : uri.path.slice(0, uri.path.lastIndexOf('/'));

        const relativeDir = dir.slice(root.uri.path.length).replace(/^\//, '');
        sets.push({ prefix: relativeDir === '' ? '' : `${relativeDir}/`, rules });
    }

    if (sets.length === 0) {
        return MATCH_NOTHING;
    }

    // Deepest first: a nested file's rules are more specific and win.
    sets.sort((a, b) => b.prefix.length - a.prefix.length);

    const ruleCount = sets.reduce((sum, set) => sum + set.rules.length, 0);
    output?.appendLine(
        `Warm-up: loaded ${ruleCount} ignore rule(s) from ${sets.length} file(s).`,
    );

    /**
     * Decides one path against the rule sets, treating it as a directory when
     * `isDirectory`. Does not consider ancestors — `ignores` handles those.
     */
    const decide = (relativePath: string, isDirectory: boolean): boolean => {
        for (const set of sets) {
            if (set.prefix !== '' && !relativePath.startsWith(set.prefix)) {
                continue;
            }
            const scoped = relativePath.slice(set.prefix.length);

            // Last matching rule wins, so scan backwards and stop at the first
            // hit — that is what makes `!` un-ignore work.
            for (let i = set.rules.length - 1; i >= 0; i--) {
                const rule = set.rules[i];
                if (!rule.regex.test(scoped)) {
                    continue;
                }
                // A directory-only rule (`build/`) never matches a plain file of
                // the same name, though it does match anything beneath it.
                if (rule.directoryOnly && !isDirectory && !directoryMatched(rule.regex, scoped)) {
                    continue;
                }
                return !rule.negated;
            }
        }
        return false;
    };

    return {
        ruleCount,
        ignores(relativePath: string): boolean {
            // Git never descends into an excluded directory, so a negation
            // cannot resurrect a file inside one: with `vendor/` ignored,
            // `!vendor/keep.php` has no effect. Deciding each ancestor first —
            // and stopping at the first excluded one — reproduces that. Checking
            // only the full path would wrongly re-include such files, which is
            // exactly the noise this filter exists to remove.
            let index = relativePath.indexOf('/');
            while (index !== -1) {
                if (decide(relativePath.slice(0, index), true)) {
                    return true;
                }
                index = relativePath.indexOf('/', index + 1);
            }
            return decide(relativePath, false);
        },
    };
}
