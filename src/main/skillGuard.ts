/**
 * What a third-party skill may carry in with it (Stage B, instruction 6).
 *
 * Installing a skill copies someone else's instructions into a folder an agent reads. The files can
 * carry more than instructions: Claude Code reads a few frontmatter keys as GRANTS or as THINGS TO
 * RUN, and a skill body can run shell commands when it is loaded. A skill is therefore never
 * allowed to:
 *
 *   • grant tools     `allowed-tools` pre-approves tools while the skill is active;
 *                     `permissionMode` picks the permission mode of an agent a file defines;
 *   • run something   `hooks` runs commands on lifecycle events; `mcpServers` starts servers;
 *                     a body's  !`command`  or ```!  fence is executed when the skill loads;
 *   • bring configuration with it   `.mcp.json`, `settings.json`, `hooks.json`, plugin manifests.
 *
 * So at install these are REMOVED from the copy on disk, the removal is reported, and nothing about
 * the skill's instructions otherwise changes. The skill still works; it just works inside the
 * permissions the user has given the agent, and everything it asks the agent to do stays visible.
 * What a skill can then do is exactly what its words persuade an agent to do under that agent's own
 * rules, and under the broker's grants for anything it reaches through MCP or REST: a skill has no
 * way to touch a grant.
 *
 * Nothing here executes anything, and the installer never installs a dependency: a file that looks
 * like a dependency manifest or a script is only NOTED, so the user can see what the skill ships.
 *
 * Pure functions over strings, so each rule is tested with hostile inputs and no filesystem.
 */

export type StrippedWhat = 'allowed-tools' | 'permission-mode' | 'hooks' | 'mcp-servers' | 'dynamic-command';
export interface Stripped { file: string; what: StrippedWhat; detail?: string }

const BLOCKED_KEYS: Record<string, StrippedWhat> = {
  'allowed-tools': 'allowed-tools', allowed_tools: 'allowed-tools', allowedtools: 'allowed-tools',
  hooks: 'hooks',
  mcpservers: 'mcp-servers', 'mcp-servers': 'mcp-servers', mcp_servers: 'mcp-servers',
  permissionmode: 'permission-mode', 'permission-mode': 'permission-mode', permission_mode: 'permission-mode'
};

const normKey = (raw: string): string => raw.trim().replace(/^["']|["']$/g, '').toLowerCase();

/** `key:` at column 0 (a top-level YAML key), quoted or not. Not a list item, not indented. */
const TOP_KEY = /^(?!\s|-\s|-$|#)("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*:(?:\s|$)/;

/**
 * Remove the grant-and-run keys from a markdown file's frontmatter and the shell-injection syntax
 * from its body. Everything else is returned byte for byte.
 */
export function sanitizeSkillMarkdown(md: string, file = 'SKILL.md'): { text: string; removed: Stripped[] } {
  const removed: Stripped[] = [];
  const bom = md.startsWith('﻿') ? '﻿' : '';
  let rest = bom ? md.slice(1) : md;
  let head = '';

  const fm = /^---[ \t]*\r?\n/.exec(rest);
  if (fm) {
    const afterOpen = rest.slice(fm[0].length);
    const close = /^---[ \t]*\r?$/m.exec(afterOpen);
    if (close) {
      const block = afterOpen.slice(0, close.index);
      const tail = afterOpen.slice(close.index);
      const lines = block.split(/(?<=\n)/);
      const kept: string[] = [];
      let dropping: StrippedWhat | null = null;
      for (const line of lines) {
        const bare = line.replace(/\r?\n$/, '');
        const key = TOP_KEY.exec(bare);
        if (key) {
          const blocked = BLOCKED_KEYS[normKey(key[1])];
          if (blocked) { dropping = blocked; removed.push({ file, what: blocked, detail: normKey(key[1]) }); continue; }
          dropping = null;
        } else if (dropping !== null) {
          // a value continued on the following lines (indented, a list item, a block scalar, a blank line)
          continue;
        }
        kept.push(line);
      }
      head = fm[0] + kept.join('');
      rest = tail;
    }
  }

  // The body: `!`command`` runs a command when the skill is loaded; so does a ```! fence.
  const body = rest.split(/(?<=\n)/).map((line) => {
    let out = line;
    const fence = /^(\s*)(`{3,}|~{3,})[ \t]*!/.exec(out);
    if (fence) {
      removed.push({ file, what: 'dynamic-command', detail: 'fenced command block' });
      out = out.replace(/^(\s*)(`{3,}|~{3,})[ \t]*!/, '$1$2');
    }
    return defuseInlineCommands(out, () => removed.push({ file, what: 'dynamic-command', detail: 'inline command' }));
  });

  return { text: bom + head + body.join(''), removed };
}

/**
 * Drop the `!` in front of every backtick span on a line, whatever the length of the backtick run
 * (a span opened with two backticks may contain single ones), and even when the span is never closed.
 * A scan rather than a regular expression, because a pattern that assumes the span has no backtick
 * inside is exactly the one a crafted skill would step around.
 */
function defuseInlineCommands(line: string, report: () => void): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '!' && line[i + 1] === '`') {
      let j = i + 1;
      while (line[j] === '`') j++;
      const width = j - (i + 1);
      report();
      // keep the span (so its text stays visible), without the bang
      let k = j;
      let close = -1;
      while (k < line.length) {
        if (line[k] === '`') {
          let e = k;
          while (line[e] === '`') e++;
          if (e - k === width) { close = e; break; }
          k = e;
        } else k++;
      }
      if (close >= 0) { out += line.slice(i + 1, close); i = close; } else { out += line.slice(i + 1, j); i = j; }
      continue;
    }
    out += line[i];
    i++;
  }
  return out;
}

const BLOCKED_FILE = new Set([
  '.mcp.json', 'mcp.json', 'settings.json', 'settings.local.json', 'hooks.json', 'plugin.json',
  'marketplace.json', '.claude.json', 'claude_desktop_config.json'
]);

/** A file the installer will not write at all: configuration that would arm hooks or servers. */
export function isBlockedSkillFile(relPath: string): boolean {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return true;
  const base = parts[parts.length - 1].toLowerCase();
  if (BLOCKED_FILE.has(base)) return true;
  return parts.some((seg) => /^\.git/i.test(seg) || seg.toLowerCase() === '.claude-plugin' || seg.toLowerCase() === '.claude' || seg.toLowerCase() === '.vscode');
}

const NOTED: Array<[RegExp, string]> = [
  [/(^|\/)package\.json$/i, 'package.json (npm dependencies)'],
  [/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|pipfile|setup\.py|setup\.cfg)$/i, 'Python dependency or build files'],
  [/(^|\/)(gemfile|go\.mod|cargo\.toml|composer\.json|pom\.xml|build\.gradle)$/i, 'a dependency manifest'],
  [/(^|\/)(makefile|dockerfile|docker-compose\.ya?ml)$/i, 'a build or container file'],
  [/\.(sh|bash|zsh|ps1|bat|cmd)$/i, 'a shell script'],
  [/\.(js|mjs|cjs|ts|py|rb|pl)$/i, 'a script']
];

/** Things the skill ships that could install or run something if an agent chose to. Only noted. */
export function noteShippedCode(relPaths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of relPaths) {
    for (const [re, label] of NOTED) {
      if (re.test(p)) { out.add(`${p}: ${label}`); break; }
    }
  }
  return [...out].slice(0, 20);
}

export const isMarkdownFile = (relPath: string): boolean => /\.(md|markdown|mdx)$/i.test(relPath);
