/**
 * What a skill APPEARS to need, read from its own text. Detection only: nothing here connects a service,
 * switches one on, grants a tool or installs a dependency. Installing a skill changes none of that, and
 * the Skills tab says so; this tells the user what to connect if they want the skill to be useful.
 *
 * Three sources, in decreasing order of confidence:
 *   1. `allowed-tools` in the skill's frontmatter (the skill's own request for tools). The installer REMOVES
 *      that key, but it is read first, so the user can see what was asked for. `mcp__mosbius-<id>__…` names an
 *      integration of this app exactly; another `mcp__<server>__…` names a server the user would have to add.
 *   2. Words in the skill's text that name a provider this app offers (suggestions only, shown as such).
 *   3. Files it ships that could install or run something (reported by skillGuard, copied here).
 * Pure functions over strings.
 */
import { MCP_CATALOG } from '../shared/mcpCatalog';
import { PROVIDERS } from '../shared/providers';

export interface SkillDeps {
  /** Catalogue ids the skill asks for by name through `allowed-tools`: machine-detected, not a guess. */
  integrations: string[];
  /** Provider ids the text merely mentions: a suggestion, never shown as a requirement. */
  suggested: string[];
  /** Every tool the skill asked to pre-approve, as written (bounded). Never granted. */
  tools: string[];
}

export const EMPTY_DEPS: SkillDeps = Object.freeze({ integrations: [], suggested: [], tools: [] }) as SkillDeps;

const MAX_TOOLS = 60;
const MCP_TOOL = /\bmcp__[A-Za-z0-9_.-]+(?:__[A-Za-z0-9_.*-]+)?/g;

/** The value of a frontmatter key as written: inline, a flow list, or the indented lines under it. */
export function frontmatterValue(md: string, key: string): string | undefined {
  const text = md.startsWith('﻿') ? md.slice(1) : md;
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!fm) return undefined;
  const lines = fm[1].split(/\r?\n/);
  const re = new RegExp(`^["']?${key.replace(/[-_]/g, '[-_]')}["']?\\s*:\\s*(.*)$`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    let value = m[1];
    for (let j = i + 1; j < lines.length && (/^\s+\S/.test(lines[j]) || /^-\s/.test(lines[j]) || lines[j].trim() === ''); j++) value += ` ${lines[j].trim()}`;
    return value.trim();
  }
  return undefined;
}

const providerWords = (): Array<{ id: string; re: RegExp }> =>
  PROVIDERS.filter((p) => p.category !== 'ai' && p.category !== 'local' && p.category !== 'custom')
    .map((p) => ({ id: p.id, re: new RegExp(`\\b${p.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }));

/** `mcp__mosbius-github__create_issue` → `github`; anything else → undefined. */
export function integrationOfTool(tool: string): string | undefined {
  const m = /^mcp__mosbius-([a-z0-9-]+)__/.exec(tool) ?? /^mcp__mosbius-([a-z0-9-]+)$/.exec(tool);
  return m && MCP_CATALOG.some((e) => e.id === m[1]) ? m[1] : undefined;
}

export function detectSkillDeps(files: ReadonlyArray<{ path: string; text: string }>): SkillDeps {
  const tools = new Set<string>();
  const integrations = new Set<string>();
  const suggested = new Set<string>();
  const words = providerWords();
  for (const f of files) {
    if (!/\.(md|markdown|mdx)$/i.test(f.path)) continue;
    const asked = frontmatterValue(f.text, 'allowed-tools');
    if (asked) for (const t of asked.match(MCP_TOOL) ?? []) { if (tools.size < MAX_TOOLS) tools.add(t); const id = integrationOfTool(t); if (id) integrations.add(id); }
    // a skill that names the tools it wants outside frontmatter (in prose) is a suggestion at most
    const body = f.text.replace(/^---[\s\S]*?\n---[ \t]*\r?\n/, '');
    for (const t of body.match(MCP_TOOL) ?? []) { const id = integrationOfTool(t); if (id && !integrations.has(id)) suggested.add(providerIdOfEntry(id)); }
    for (const w of words) if (w.re.test(body)) suggested.add(w.id);
  }
  for (const id of integrations) suggested.delete(providerIdOfEntry(id));
  return { integrations: [...integrations].sort(), suggested: [...suggested].sort(), tools: [...tools].sort() };
}

/** The provider a catalogue entry belongs to, by id (the entry id itself when no provider lists it). */
export function providerIdOfEntry(entryId: string): string {
  return PROVIDERS.find((p) => p.mcp.includes(entryId))?.id ?? entryId;
}
