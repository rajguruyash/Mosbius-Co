'use strict';

/**
 * Live verification of the in-app OAuth engine — the part no stand-in can prove.
 *
 * EVERYTHING in the test suite runs against a stand-in provider. None of it says
 * that Google or Slack accept this exact flow. This tool is how that gets found
 * out, with the user's own accounts. Until it has been run, and passed, for an
 * integration, that integration must not be called verified.
 *
 *   node tools/verify-oauth-live.cjs --check-metadata
 *       Credential-free. Fetches the providers' PUBLISHED authorization-server
 *       metadata and compares it with the endpoints pinned in the catalogue
 *       (endpoints, S256, client_secret_post, iss, revocation). Detects drift only;
 *       it does not sign anyone in.
 *
 *   npx electron tools/verify-oauth-live.cjs <gmail|google-calendar|google-drive|slack>
 *                [--user-data <dir>] [--refresh] [--call <tool> --args '<json>'] [--disconnect]
 *       The real thing, inside Electron so the encrypted store works. It uses the OAuth
 *       client you entered in the app's Settings (never typed here, never in chat),
 *       opens your browser for the real consent screen, then — only if you ask —
 *       forces a refresh, makes ONE read-only MCP call (initialize + tools/list, or the
 *       single tool you name), and can disconnect. It prints codes, counts and booleans:
 *       never a token, a code or a secret. Run with production rules: https only.
 *
 * What a pass means: only the steps that ran and passed. Each line says what it
 * exercised. The tool does not infer.
 */

const MCP_PROTOCOL = '2025-03-26';

// ─── 1. endpoint drift (public metadata) ────────────────────────────────────

/**
 * @param {{ fetchFn: Function, catalogue: Array<any> }} p
 * @returns {Promise<Array<{check: string, ok: boolean, detail: string}>>}
 */
async function checkMetadata({ fetchFn, catalogue }) {
  const out = [];
  const add = (check, ok, detail = '') => out.push({ check, ok: !!ok, detail });
  const byIssuer = new Map();
  for (const e of catalogue) {
    if (e.spec.transport !== 'bridge' || !e.spec.oauth) continue;
    const list = byIssuer.get(e.spec.oauth.issuer) ?? [];
    list.push(e);
    byIssuer.set(e.spec.oauth.issuer, list);
  }
  for (const [issuer, entries] of byIssuer) {
    const o = entries[0].spec.oauth;
    let meta = null;
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      try {
        const r = await fetchFn(issuer + p, { redirect: 'error' });
        if (r.status === 200) { meta = await r.json(); add(`${issuer}: metadata published`, true, p); break; }
      } catch { /* try the next */ }
    }
    if (!meta) { add(`${issuer}: metadata published`, false, 'could not be fetched'); continue; }
    add(`${issuer}: issuer matches`, String(meta.issuer).replace(/\/$/, '') === issuer, `published ${meta.issuer}`);
    add(`${issuer}: authorization endpoint`, meta.authorization_endpoint === o.authorizationEndpoint, `published ${meta.authorization_endpoint}`);
    add(`${issuer}: token endpoint`, meta.token_endpoint === o.tokenEndpoint, `published ${meta.token_endpoint}`);
    add(`${issuer}: PKCE S256 supported`, (meta.code_challenge_methods_supported ?? []).includes('S256'), JSON.stringify(meta.code_challenge_methods_supported));
    add(`${issuer}: client_secret_post supported`, (meta.token_endpoint_auth_methods_supported ?? []).includes('client_secret_post'), JSON.stringify(meta.token_endpoint_auth_methods_supported));
    add(`${issuer}: refresh_token grant supported`, (meta.grant_types_supported ?? []).includes('refresh_token'), '');
    const sendsIss = meta.authorization_response_iss_parameter_supported === true;
    add(`${issuer}: iss policy fits what is published`, o.issParameter === 'required' ? sendsIss : true,
      `catalogue says ${o.issParameter}; provider says iss ${sendsIss ? 'is sent' : 'is not declared'}`);
    for (const e of entries) {
      const rv = e.spec.revoke;
      if (rv && meta.revocation_endpoint) add(`${e.id}: revocation endpoint`, meta.revocation_endpoint === rv.url, `published ${meta.revocation_endpoint}`);
      else if (rv) add(`${e.id}: revocation endpoint`, true, 'the provider publishes none; the catalogue uses its documented call (UNVERIFIED without a real token)');
    }
  }
  return out;
}

// ─── 2. the real sign-in ────────────────────────────────────────────────────

/**
 * The live run, on a controller already wired to the real store and browser.
 * Returns a list of {step, ok, detail}; never a secret.
 */
async function liveCheck({ controller, entry, fetchFn, doRefresh, call, doDisconnect, disconnect, log = () => {} }) {
  const id = entry.id;
  const steps = [];
  const add = (step, ok, detail = '') => { steps.push({ step, ok: !!ok, detail }); log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`); return ok; };

  add(`${id}: OAuth client present in the app's store`, controller.status(id) !== 'unconfigured', `status ${controller.status(id)}`);
  if (controller.status(id) === 'unconfigured') return steps;

  const before = controller.status(id);
  const res = before === 'connected' ? { ok: true } : await controller.signIn(id);
  if (!add(`${id}: real sign-in in the browser`, res.ok, res.ok ? 'tokens stored (encrypted)' : `failed: ${res.error}`)) return steps;
  add(`${id}: status is "connected"`, controller.status(id) === 'connected', `status ${controller.status(id)}`);
  const held = controller.provider.tokens(id);
  add(`${id}: a refresh token was issued`, !!held.refreshToken, held.refreshToken ? 'yes' : 'NO — the sign-in will lapse when the access token expires');

  const headers = await controller.provider.accessHeaders({ id });
  if (!add(`${id}: the engine produces an Authorization header`, headers.ok, headers.ok ? 'yes' : headers.code)) return steps;

  const url = entry.spec.url;
  const rpc = async (method, params, idn) => {
    const h = await controller.provider.accessHeaders({ id });
    if (!h.ok) return { error: h.code };
    try {
      const r = await fetchFn(url, {
        method: 'POST', redirect: 'error',
        headers: { ...h.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: idn, method, ...(params ? { params } : {}) })
      });
      const text = await r.text();
      let body = null;
      for (const chunk of [text, ...text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5))]) { try { body = JSON.parse(chunk); break; } catch { /* next */ } }
      return { status: r.status, body };
    } catch (e) { return { error: 'network' }; }
  };

  const init = await rpc('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'mosbius-verify', version: '1' } }, 1);
  add(`${id}: the MCP server accepts the token (initialize)`, init.status === 200 && !!init.body?.result, init.error ?? `HTTP ${init.status}`);
  if (init.status === 401) controller.provider.markRejected(id);
  const list = await rpc('tools/list', undefined, 2);
  const tools = list.body?.result?.tools;
  add(`${id}: a read-only MCP call succeeds (tools/list)`, Array.isArray(tools), Array.isArray(tools) ? `${tools.length} tools` : (list.error ?? `HTTP ${list.status}`));
  if (Array.isArray(tools)) {
    for (const x of tools) log(`      tool ${x.name}  annotations ${JSON.stringify(x.annotations ?? {})}`);
    const noHints = tools.filter((x) => !x.annotations || (x.annotations.readOnlyHint === undefined && x.annotations.destructiveHint === undefined));
    add(`${id}: tools carry annotations the permission model can use`, noHints.length === 0, noHints.length ? `${noHints.length} without hints → they would be treated as destructive` : 'all annotated');
  }
  if (call) {
    const r = await rpc('tools/call', { name: call.tool, arguments: call.args ?? {} }, 3);
    add(`${id}: the one tool call you asked for (${call.tool})`, r.status === 200 && !!r.body?.result && !r.body?.result?.isError, r.error ?? `HTTP ${r.status}${r.body?.result?.isError ? ' (tool error)' : ''}`);
  }

  if (doRefresh) {
    const rtBefore = controller.provider.tokens(id).refreshToken;
    const atBefore = controller.provider.tokens(id).accessToken;
    controller.provider.markRejected(id, atBefore);
    const r = await controller.provider.accessHeaders({ id });
    const after = controller.provider.tokens(id);
    add(`${id}: a real refresh works`, r.ok && after.accessToken !== atBefore, r.ok ? 'new access token' : r.code);
    add(`${id}: refresh-token rotation observed`, true, after.refreshToken !== rtBefore ? 'the provider ROTATED the refresh token (it was saved first)' : 'the provider kept the same refresh token');
    const again = await rpc('tools/list', undefined, 4);
    add(`${id}: the refreshed token is accepted by the MCP server`, Array.isArray(again.body?.result?.tools), again.error ?? `HTTP ${again.status}`);
  }

  if (doDisconnect) {
    const d = await disconnect();
    add(`${id}: disconnect`, d.ok, d.ok ? (d.revoked ? 'revoked at the provider and wiped' : 'wiped locally; the provider did NOT confirm revocation') : d.error);
    const gone = await rpc('tools/list', undefined, 5);
    add(`${id}: after disconnect the engine refuses to produce a credential`, gone.error === 'no_secret' || gone.error === 'sign_in_required', gone.error ?? `HTTP ${gone.status}`);
  }
  return steps;
}

// ─── command line ───────────────────────────────────────────────────────────

function printReport(title, rows, key) {
  console.log(`\n${title}`);
  for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r[key]}${r.detail ? `\n        ${r.detail}` : ''}`);
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - bad}/${rows.length} checks passed.`);
  return bad === 0;
}

function parseArgs(argv) {
  const a = { positional: [], flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) {
      const name = x.slice(2);
      if (['user-data', 'call', 'args'].includes(name)) a.values[name] = argv[++i];
      else a.flags.add(name);
    } else a.positional.push(x);
  }
  return a;
}

async function main() {
  const path = require('node:path');
  const loadTs = require('../test/load-ts.cjs');
  const args = parseArgs(process.argv.slice(process.versions.electron ? 2 : 2));
  const { MCP_CATALOG, mcpCatalogEntry, mcpRedirectUri } = loadTs('src/shared/mcpCatalog.ts');

  if (args.flags.has('check-metadata')) {
    const rows = await checkMetadata({ fetchFn: (u, i) => fetch(u, i), catalogue: MCP_CATALOG });
    process.exit(printReport('Pinned endpoints vs what the providers publish (public, no credentials)', rows, 'check') ? 0 : 1);
  }

  const id = args.positional[0];
  const entry = id ? mcpCatalogEntry(id) : undefined;
  if (!entry || entry.spec.transport !== 'bridge' || !entry.spec.oauth) {
    console.error('usage: node tools/verify-oauth-live.cjs --check-metadata\n       npx electron tools/verify-oauth-live.cjs <gmail|google-calendar|google-drive|slack> [--user-data <dir>] [--refresh] [--call <tool> --args \'<json>\'] [--disconnect]');
    process.exit(2);
  }
  if (!process.versions.electron) {
    console.error('The sign-in needs Electron (the encrypted store). Run:  npx electron tools/verify-oauth-live.cjs ' + id);
    process.exit(2);
  }

  const { app, shell } = require('electron');
  const pkg = require('../package.json');
  app.setName(pkg.productName);                          // the same name = the same user-data folder and the same keychain entry as the app
  if (args.values['user-data']) app.setPath('userData', path.resolve(args.values['user-data']));
  await app.whenReady();
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const integrations = loadTs('src/main/integrations.ts');
  const { OAuthController } = loadTs('src/main/oauth/controller.ts');
  const { safeLog } = loadTs('src/main/oauth/types.ts');
  const { disconnectBridged } = loadTs('src/main/mcpDisconnect.ts');
  const { McpAuthVault } = loadTs('src/main/mcpAuthVault.ts');

  console.log(`user data: ${app.getPath('userData')}`);
  console.log(`redirect URI to register with the provider: ${mcpRedirectUri(entry.spec.callbackPort)}`);
  console.log(`scopes requested: ${entry.spec.oauth.scope ?? entry.spec.scope ?? '(none)'}\n`);

  const controller = new OAuthController({
    entry: mcpCatalogEntry,
    secrets: { get: integrations.getSecret, set: integrations.setSecret, has: integrations.hasSecret, readable: integrations.secretStoreReadable },
    fetch: (u, i) => fetch(u, i),
    openUrl: async (url) => { if (!/^https:\/\//i.test(url)) throw new Error('refused'); await shell.openExternal(url); },
    now: () => Date.now(),
    log: safeLog((line) => console.log('[oauth]', line))
  });

  const vault = new McpAuthVault(() => path.join(app.getPath('userData'), 'mcp-auth'), { get: integrations.getSecret, set: integrations.setSecret, delete: integrations.deleteSecret });
  const steps = await liveCheck({
    controller, entry, fetchFn: (u, i) => fetch(u, i),
    doRefresh: args.flags.has('refresh'),
    call: args.values.call ? { tool: args.values.call, args: args.values.args ? JSON.parse(args.values.args) : {} } : undefined,
    doDisconnect: args.flags.has('disconnect'),
    disconnect: () => disconnectBridged({
      cancelSignIn: (x) => controller.cancel(x), vault,
      revoke: async () => ({ attempted: 0, confirmed: 0 }),
      secrets: { delete: integrations.deleteSecret, has: integrations.hasSecret },
      broker: { hasTokens: (x) => controller.hasTokens(x), revoke: (x) => controller.revoke(x), forget: (x) => controller.forget(x) }
    }, entry),
    log: (l) => console.log(l)
  });
  const ok = printReport(`Live check: ${entry.label}`, steps, 'step');
  console.log(ok
    ? '\nOnly the steps listed above were exercised. Anything not listed is still unverified.'
    : '\nSome steps failed. Nothing is verified until they pass.');
  controller.dispose();
  app.exit(ok ? 0 : 1);
}

module.exports = { checkMetadata, liveCheck, parseArgs };

// Under Electron the entry script is NOT `require.main`, so that check alone would
// leave the app idling with no window and nothing to do. Recognise the entry by path too.
const isEntry = require.main === module
  || (!!process.versions.electron && require('node:path').resolve(process.argv[1] || '') === __filename);
if (isEntry) {
  const fail = (e) => { console.error('verify-oauth-live failed:', e && e.message); process.exit(1); };
  if (process.versions.electron) {
    // a hung browser or provider must not leave an invisible Electron process behind
    setTimeout(() => { console.error('verify-oauth-live: gave up after 15 minutes'); process.exit(1); }, 15 * 60_000).unref();
  }
  main().catch(fail);
}
