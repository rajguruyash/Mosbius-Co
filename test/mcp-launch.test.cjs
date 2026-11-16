'use strict';

/**
 * F1 — how the app starts a local server, and where each kind of credential goes.
 *
 * The rules: the directory a filesystem or git server may touch is the working directory of the
 * agent that asked and nothing else; the server's environment is a short allow-list plus its OWN
 * credential, so nothing the app or the user has exported (an API key, a cloud token, a GitHub
 * token) is inherited; a server that needs a credential and has none does not start; and the
 * credential provider keeps a hosted server's token in a header the BROKER adds, an app-run
 * server's in its own environment, and never in anything an agent can see.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
const { resolveLaunch, NODE_SECRET_LAUNCHER } = loadTs('src/main/mcpLaunch.ts');
const { localServerEnv, localServerSecrets, serverBaseEnv, createMcpCredentialProvider, SERVER_ENV_ALLOW } = loadTs('src/main/mcpCredentials.ts');

const entry = (id) => MCP_CATALOG.find((e) => e.id === id);
const installed = { command: '/usr/bin/node', args: ['/store/pkg/dist/index.js'] };

test('a filesystem or git server is scoped to the working directory of the agent that asked, and nothing else', () => {
  const fs = resolveLaunch(entry('filesystem'), installed, '/work/agent-a', {});
  assert.deepEqual(fs.args, ['/store/pkg/dist/index.js', '/work/agent-a']);
  assert.deepEqual(fs.roots, ['/work/agent-a']);
  assert.equal(fs.cwd, '/work/agent-a');
  const git = resolveLaunch(entry('git'), installed, '/work/agent-b', {});
  assert.deepEqual(git.args, ['/store/pkg/dist/index.js', '--repository', '/work/agent-b']);
  for (const l of [fs, git]) assert.equal(JSON.stringify(l.args).includes('<cwd>'), false, 'no placeholder left');
});

test('a relative, empty or missing workspace is refused, and a hosted or bridged entry is not launchable at all', () => {
  for (const bad of ['', 'work/agent', './x', '../x', undefined, null, 5]) assert.equal(resolveLaunch(entry('filesystem'), installed, bad, {}), undefined, String(bad));
  assert.equal(resolveLaunch(entry('github'), installed, '/work', {}), undefined);
  assert.equal(resolveLaunch(entry('gmail'), installed, '/work', {}), undefined);
});

test('a server with no <cwd> argument is still given its agent\'s directory as its working directory', () => {
  const t = resolveLaunch(entry('time'), installed, '/work/agent-a', {});
  assert.deepEqual(t.args, ['/store/pkg/dist/index.js']);
  assert.equal(t.cwd, '/work/agent-a');
});

test('the environment is the allow-list: nothing the app or the user exported is inherited', () => {
  const source = {
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://proxy:3128',
    ANTHROPIC_API_KEY: 'sk-ant-LEAK', OPENAI_API_KEY: 'sk-LEAK', GITHUB_TOKEN: 'ghp_LEAK', GH_TOKEN: 'ghp_LEAK2',
    AWS_SECRET_ACCESS_KEY: 'AWS-LEAK', GOOGLE_APPLICATION_CREDENTIALS: '/secret.json', MY_COMPANY_TOKEN: 'LEAK', NPM_TOKEN: 'npm_LEAK',
    NOTION_TOKEN: 'user-exported-notion-token-LEAK', MD_BROKER_TOKEN: 'LEAK', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require /evil.js'
  };
  const env = localServerEnv(entry('time'), source, '/user/login/path');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HTTPS_PROXY', 'LANG', 'PATH']);
  assert.equal(env.PATH, '/user/login/path', 'the user\'s own login-shell PATH, so node, python and git resolve');
  assert.equal(JSON.stringify(env).includes('LEAK'), false);
  for (const k of SERVER_ENV_ALLOW) assert.equal(/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k), false, `${k} looks like a secret holder`);
  assert.equal('NODE_OPTIONS' in env, false, 'a variable that injects code into node is never inherited');
  // and a server that needs a credential still gets an environment with NONE in it, even one the user exported
  const notion = localServerEnv(entry('notion'), source, '');
  assert.equal(JSON.stringify(notion).includes('LEAK'), false);
  assert.equal('NOTION_TOKEN' in notion, false, 'the credential is never in the environment');
  assert.equal(localServerEnv(entry('github'), source, ''), undefined, 'a hosted server has no local environment');
});

test('the credential is returned apart from the environment, under the server\'s own variable name, and a server that needs one does not start without it', () => {
  assert.deepEqual(localServerSecrets(entry('notion'), 'ntn_FROM_THE_VAULT'), { NOTION_TOKEN: 'ntn_FROM_THE_VAULT' });
  assert.deepEqual(localServerSecrets(entry('brave-search'), ' BSA_x '), { BRAVE_API_KEY: 'BSA_x' });
  assert.equal(localServerSecrets(entry('notion'), undefined), undefined);
  assert.equal(localServerSecrets(entry('notion'), '   '), undefined, 'whitespace is not a credential');
  assert.deepEqual(localServerSecrets(entry('time'), 'ignored'), {}, 'a server that needs none is given none');
  assert.equal(localServerSecrets(entry('github'), 'x'), undefined, 'a hosted server is not launched locally');
  assert.equal('BRAVE_API_KEY' in localServerSecrets(entry('notion'), 'x'), false, 'one server\'s credential is never offered to another');
});

test('a server with a credential is started through the in-process launcher: the credential is on the pipe, not in the arguments or the environment', () => {
  const node = { command: '/usr/bin/node', args: ['/store/notion/bin/cli.mjs'], runtime: 'node' };
  const env = { PATH: '/usr/bin' };
  const launch = resolveLaunch(entry('notion'), node, '/work/a', env, { NOTION_TOKEN: 'ntn_SECRET_VALUE' });
  assert.equal(launch.command, '/usr/bin/node');
  assert.deepEqual(launch.args.slice(0, 2), ['-e', NODE_SECRET_LAUNCHER]);
  assert.deepEqual(launch.args.slice(2), ['/store/notion/bin/cli.mjs'], 'then the server, then its own arguments');
  assert.deepEqual(launch.secrets, { NOTION_TOKEN: 'ntn_SECRET_VALUE' });
  assert.equal(JSON.stringify(launch.args).includes('ntn_SECRET_VALUE'), false, 'not in the argument list');
  assert.equal(JSON.stringify(launch.env).includes('ntn_SECRET_VALUE'), false, 'not in the environment the child starts with');
  assert.equal(NODE_SECRET_LAUNCHER.includes('ntn_'), false);
  assert.match(NODE_SECRET_LAUNCHER, /readFileSync\(3,/, 'it reads the pipe');
  // brave keeps its own arguments after the server
  const brave = resolveLaunch(entry('brave-search'), { ...node, args: ['/store/brave/dist/index.js'] }, '/work/a', env, { BRAVE_API_KEY: 'k' });
  assert.deepEqual(brave.args.slice(2), ['/store/brave/dist/index.js', '--transport', 'stdio']);
  // no credential: the plain launch, no pipe
  const plain = resolveLaunch(entry('time'), { command: '/store/time/venv/bin/mcp-server-time', args: [], runtime: 'native' }, '/work/a', env, {});
  assert.equal(plain.secrets, undefined);
  assert.deepEqual(plain.args, []);
});

test('a credential is never put in the environment as a fallback: a server that cannot receive it on the pipe is not started', () => {
  const native = { command: '/store/x/venv/bin/x', args: [], runtime: 'native' };
  assert.equal(resolveLaunch(entry('notion'), native, '/work/a', {}, { NOTION_TOKEN: 'x' }), undefined);
  assert.equal(resolveLaunch(entry('notion'), { command: '/usr/bin/node', args: ['/s.js'] }, '/work/a', {}, { NOTION_TOKEN: 'x' }), undefined, 'a launch of unknown runtime');
  assert.equal(resolveLaunch(entry('notion'), { command: '/usr/bin/node', args: [], runtime: 'node' }, '/work/a', {}, { NOTION_TOKEN: 'x' }), undefined, 'nothing to run');
});

test('the installer gets the same allow-list', () => {
  const env = serverBaseEnv({ PATH: '/p', HOME: '/h', NPM_TOKEN: 'LEAK', ANTHROPIC_API_KEY: 'LEAK' }, '/login');
  assert.deepEqual(env, { PATH: '/login', HOME: '/h' });
});

function provider(over = {}) {
  const calls = [];
  const p = createMcpCredentialProvider({
    entry: (id) => MCP_CATALOG.find((e) => e.id === id),
    token: (id) => over.tokens?.[id],
    oauth: { accessHeaders: (i) => { calls.push(['oauth', i.id]); return { ok: true, headers: { authorization: 'Bearer OAUTH' } }; }, rejected: (i) => calls.push(['rejected', i.id]) }
  });
  return { p, calls };
}

test('GitHub: the token becomes a header on the BROKER\'s request; missing means no_secret', () => {
  const { p } = provider({ tokens: { github: ' ghp_VAULT ' } });
  assert.deepEqual(p.accessHeaders({ id: 'github' }), { ok: true, headers: { Authorization: 'Bearer ghp_VAULT' } });
  assert.deepEqual(provider().p.accessHeaders({ id: 'github' }), { ok: false, code: 'no_secret' });
  assert.deepEqual(provider({ tokens: { github: '  ' } }).p.accessHeaders({ id: 'github' }), { ok: false, code: 'no_secret' });
});

test('an app-run server: no header ever, but the broker insists the credential exists', () => {
  assert.deepEqual(provider({ tokens: { notion: 'ntn_x' } }).p.accessHeaders({ id: 'notion' }), { ok: true, headers: {} });
  assert.deepEqual(provider().p.accessHeaders({ id: 'notion' }), { ok: false, code: 'no_secret' });
  assert.deepEqual(provider().p.accessHeaders({ id: 'time' }), { ok: true, headers: {} }, 'a server with no credential needs none');
});

test('a bridged service goes to the OAuth engine; an unknown id is unavailable; "rejected" reaches only the OAuth engine', () => {
  const { p, calls } = provider({ tokens: { github: 'x' } });
  assert.equal(p.accessHeaders({ id: 'gmail' }).headers.authorization, 'Bearer OAUTH');
  assert.deepEqual(p.accessHeaders({ id: 'nope' }), { ok: false, code: 'unavailable' });
  p.rejected({ id: 'github' }, {});
  p.rejected({ id: 'gmail' }, {});
  assert.deepEqual(calls, [['oauth', 'gmail'], ['rejected', 'gmail']]);
});
