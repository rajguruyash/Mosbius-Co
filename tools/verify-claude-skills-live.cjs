#!/usr/bin/env node
'use strict';

/**
 * Does the real `claude` CLI list a skill the app installed? Model-free: Claude Code announces its skills in the
 * `system/init` event of its stream-json output before it asks a model anything, and this tool stops the process the
 * moment that event arrives.
 *
 *   node tools/verify-claude-skills-live.cjs [--evidence evidence/claude/claude-skills-live]
 *
 * What it does: writes a probe skill into a PROJECT folder (<tmp>/.claude/skills/<name>/SKILL.md, the folder the
 * app installs into for a project) and starts `claude` there. Your own ~/.claude/skills is not written: the
 * user-level folder is read by the same loader, but proving it would mean changing your own skills, so that
 * folder is reported as documented, not run.
 *
 * It uses your Claude sign-in only because the CLI insists on one before it starts; no model call is awaited.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const evidenceBase = flag('--evidence');

let version = '';
try { version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(); } catch { console.error('BLOCKED: `claude` is not on PATH'); process.exit(2); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mosbius-claude-skills-'));
const NAME = 'mosbius-probe-claude';
const dir = path.join(ROOT, '.claude', 'skills', NAME);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${NAME}\ndescription: A probe used to see whether Claude Code lists a project skill.\n---\n\nSay hello.\n`);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

function runInit() {
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', 'hi', '--output-format', 'stream-json', '--verbose', '--max-turns', '1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; let settled = false;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => finish(null), 60_000);
    child.stdout.on('data', (c) => {
      buf += c; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'system' && e.subtype === 'init') return finish(e);
      }
    });
    child.on('close', () => finish(null));
  });
}

(async () => {
  console.log(`${version} · ${process.platform}/${process.arch}\n`);
  const init = await runInit();
  check('the CLI announced itself (system/init) before any model reply', !!init);
  const skills = (init?.skills ?? []).map(String);
  check('the probe skill in <project>/.claude/skills is listed as a skill', skills.some((s) => s.includes(NAME)), `${skills.length} skills listed`);
  check('and is available as a slash command', (init?.slash_commands ?? []).map(String).some((s) => s.includes(NAME)));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (evidenceBase) {
    const outJson = path.resolve(`${evidenceBase}.json`);
    fs.mkdirSync(path.dirname(outJson), { recursive: true });
    fs.writeFileSync(outJson, JSON.stringify({
      tool: 'tools/verify-claude-skills-live.cjs', date: new Date().toISOString(), claude: version, platform: `${process.platform}/${process.arch}`,
      folder_run: '<project>/.claude/skills',
      folder_not_run: '~/.claude/skills (same loader; not written to, so the user\'s own skills are untouched)',
      model_called: false, results
    }, null, 2));
    fs.writeFileSync(path.resolve(`${evidenceBase}.txt`), `${[`${version} · ${process.platform}/${process.arch} · ${new Date().toISOString()}`, '', ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`), '', `${results.length - failed.length}/${results.length} checks passed`].join('\n')}\n`);
    console.log(`evidence written: ${outJson}`);
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed.length ? 1 : 0);
})();
