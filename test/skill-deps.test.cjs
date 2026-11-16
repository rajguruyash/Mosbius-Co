'use strict';

/** What a skill appears to need, read from its text: detection only, never a grant. */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { detectSkillDeps, frontmatterValue, integrationOfTool } = loadTs('src/main/skillDeps.ts');

const skill = (front, body = 'Do the thing.\n') => ({ path: 'SKILL.md', text: `---\nname: x\n${front}\n---\n${body}` });

test('allowed-tools naming this app\'s integrations are detected exactly, in every spelling of the list', () => {
  const inline = detectSkillDeps([skill('allowed-tools: Bash(git:*), mcp__mosbius-github__create_issue, mcp__mosbius-notion-hosted__notion-search')]);
  assert.deepEqual(inline.integrations, ['github', 'notion-hosted']);
  assert.deepEqual(inline.tools, ['mcp__mosbius-github__create_issue', 'mcp__mosbius-notion-hosted__notion-search']);
  const list = detectSkillDeps([skill('allowed-tools:\n  - Read\n  - mcp__mosbius-linear__*\n  - mcp__mosbius-sentry__list_issues')]);
  assert.deepEqual(list.integrations, ['linear', 'sentry']);
  const flow = detectSkillDeps([skill('allowed_tools: [Read, "mcp__mosbius-stripe__list_customers"]')]);
  assert.deepEqual(flow.integrations, ['stripe']);
});

test('a tool of a server this app does not offer is listed as asked for, and names no integration', () => {
  const d = detectSkillDeps([skill('allowed-tools: mcp__somebody-else__do_it, mcp__mosbius-nonexistent__x')]);
  assert.deepEqual(d.integrations, []);
  assert.equal(d.tools.length, 2);
  assert.equal(integrationOfTool('mcp__mosbius-nonexistent__x'), undefined);
  assert.equal(integrationOfTool('mcp__github__create_issue'), undefined);
});

test('words in the text name a provider as a suggestion only, and never as a requirement', () => {
  const d = detectSkillDeps([skill('description: files issues', 'Open a GitHub issue, then post to Slack and update Linear.\n')]);
  assert.deepEqual(d.integrations, []);
  assert.deepEqual(d.suggested, ['github', 'linear', 'slack']);
  const none = detectSkillDeps([skill('description: dates', 'Format a date range.\n')]);
  assert.deepEqual(none, { integrations: [], suggested: [], tools: [] });
});

test('a requirement is not also suggested, and the lists are bounded and sorted', () => {
  const many = Array.from({ length: 100 }, (_, i) => `mcp__tool${i}__x`).join(', ');
  const d = detectSkillDeps([skill(`allowed-tools: mcp__mosbius-github__a, ${many}`, 'Use GitHub.\n')]);
  assert.deepEqual(d.integrations, ['github']);
  assert.deepEqual(d.suggested, []);
  assert.ok(d.tools.length <= 60);
});

test('only markdown is read, and frontmatter is found with a BOM and CRLF', () => {
  assert.deepEqual(detectSkillDeps([{ path: 'run.sh', text: 'allowed-tools: mcp__mosbius-github__x' }]).integrations, []);
  const crlf = { path: 'SKILL.md', text: '﻿---\r\nname: x\r\nallowed-tools: mcp__mosbius-sentry__q\r\n---\r\nBody\r\n' };
  assert.deepEqual(detectSkillDeps([crlf]).integrations, ['sentry']);
  assert.equal(frontmatterValue('no frontmatter', 'allowed-tools'), undefined);
});
