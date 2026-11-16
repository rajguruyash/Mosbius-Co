/**
 * Where a bridged MCP server's secrets live, and for how long.
 *
 * `mcp-remote` can only keep its OAuth tokens as plain JSON files, and by
 * default it keeps them in `~/.mcp-auth` for ever. This module puts a lifecycle
 * round that:
 *
 *   • AT REST the tokens exist only inside the OS-encrypted secret store
 *     (Electron `safeStorage`, injected here as `secrets`), under
 *     `mcp:<id>:tokens`.
 *   • WHILE AN AGENT USES THE SERVER they are written to a private runtime
 *     directory (`<base>/<id>`, 0700; files 0600), together with the user's
 *     OAuth client, because mcp-remote reads both from disk. That directory is
 *     the only place either ever appears in plaintext.
 *   • WHEN THE LAST SUCH AGENT ENDS (and at app start and quit, to cover a
 *     crash) whatever mcp-remote wrote — including refreshed tokens — is sealed
 *     back into the encrypted store and the directory is removed.
 *
 * What this does NOT do: hide the plaintext from another process running as the
 * same user during that in-use window. That needs the tokens to stay inside the
 * main process, which mcp-remote cannot offer.
 *
 * Electron-free by design (base directory and secret store are injected), so
 * every rule above is unit-tested without Electron.
 */
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import {
  MCP_CALLBACK_HOST, MCP_REMOTE_PACKAGE, mcpTokenRef, type McpBridgeSpec, type McpRevokeSpec
} from '../shared/mcpCatalog';

export interface VaultSecrets {
  get(ref: string): string | undefined;
  set(ref: string, plaintext: string): { ok: boolean; error?: string };
  /** The real store reports `{ok:false}` when it could not delete. Older stores
   *  returned nothing, so a missing report is never taken as success on its own:
   *  `purge` also checks that the value is really gone. */
  delete(ref: string): void | boolean | { ok: boolean; error?: string };
}

/** What a removal that must not be mistaken for success reports. */
export interface PurgeResult { ok: boolean; error?: string }

export interface BridgePaths {
  /** Handed to mcp-remote as MCP_REMOTE_CONFIG_DIR. */
  configDir: string;
  /** `{client_id, client_secret}`, handed over as `@file`. */
  clientInfoFile: string;
  /** `{scope}`, handed over as `@file`; absent when the service picks scopes. */
  metadataFile?: string;
}

export interface OauthClient { clientId: string; clientSecret: string }
export interface StoredToken { access_token?: string; refresh_token?: string }

/** mcp-remote names its store `<md5 of the server url>_tokens.json`. Nothing
 *  else in the directory is worth keeping: verifiers, discovery state and
 *  leases belong to one sign-in or one refresh. */
const TOKEN_FILE = /^[a-f0-9]{32}_tokens\.json$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STORE_SUBDIR = 'mcp-remote-v1';

/**
 * The one command line the bridge is ever started with — used by the agent
 * spawn and by the sign-in, so the two cannot drift apart.
 *
 * No secret is in it: the OAuth client and the scopes go over as `@file`
 * references into the vault. The package is pinned, the redirect host is
 * pinned, and `--debug` is never passed (mcp-remote's debug log can contain
 * whole token objects).
 */
export function bridgeArgs(spec: McpBridgeSpec, paths: BridgePaths): string[] {
  const args = [
    '-y', MCP_REMOTE_PACKAGE, spec.url, String(spec.callbackPort),
    '--host', MCP_CALLBACK_HOST,
    '--transport', 'http-only',
    '--static-oauth-client-info', `@${paths.clientInfoFile}`
  ];
  if (paths.metadataFile) args.push('--static-oauth-client-metadata', `@${paths.metadataFile}`);
  return args;
}

export class McpAuthVault {
  /** integration id → the agents (pty ids) currently holding it open. */
  private readonly users = new Map<string, Set<string>>();
  /** integrations with a sign-in in flight; never sealed from under it. */
  private readonly signingIn = new Set<string>();

  constructor(
    private readonly baseDir: () => string,
    private readonly secrets: VaultSecrets
  ) {}

  /** The directory agents must never be able to read. */
  root(): string { return this.baseDir(); }

  private dir(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error('bad integration id');
    return join(this.baseDir(), id);
  }

  private plainTokens(id: string): Record<string, string> {
    const out: Record<string, string> = {};
    const store = join(this.dir(id), STORE_SUBDIR);
    let names: string[] = [];
    try { names = readdirSync(store); } catch { return out; }
    for (const name of names) {
      if (!TOKEN_FILE.test(name)) continue;
      try {
        const text = readFileSync(join(store, name), 'utf8');
        if (typeof JSON.parse(text)?.access_token === 'string') out[name] = text;
      } catch { /* half-written or not ours — leave it out */ }
    }
    return out;
  }

  private sealedTokens(id: string): Record<string, string> {
    const raw = this.secrets.get(mcpTokenRef(id));
    if (!raw) return {};
    try {
      const files = JSON.parse(raw)?.files;
      const out: Record<string, string> = {};
      if (files && typeof files === 'object') {
        for (const [name, text] of Object.entries(files)) {
          if (TOKEN_FILE.test(name) && typeof text === 'string') out[name] = text;
        }
      }
      return out;
    } catch { return {}; }
  }

  /** Whether a sign-in has produced tokens that are still held. Says nothing
   *  about whether the provider still honours them. */
  isConnected(id: string): boolean {
    return Object.keys(this.plainTokens(id)).length > 0 || Object.keys(this.sealedTokens(id)).length > 0;
  }

  hasPlainTokens(id: string): boolean {
    return Object.keys(this.plainTokens(id)).length > 0;
  }

  /** Write the runtime directory: the OAuth client, the scopes, and any sealed
   *  tokens that are not already there in a newer plaintext form. */
  private materialise(id: string, client: OauthClient, scope?: string): BridgePaths {
    const dir = this.dir(id);
    const store = join(dir, STORE_SUBDIR);
    // Created with the mode AND chmod-ed: mkdir's mode is masked by the umask
    // and ignored for a directory that already exists. Pre-creating the store
    // keeps mcp-remote from making it 0755 itself.
    for (const d of [this.baseDir(), dir, store]) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
      try { chmodSync(d, 0o700); } catch { /* Windows has no mode */ }
    }
    const write = (file: string, text: string): void => {
      writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
      try { chmodSync(file, 0o600); } catch { /* Windows */ }
    };
    const clientInfoFile = join(dir, 'client.json');
    write(clientInfoFile, JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret }));
    let metadataFile: string | undefined;
    if (scope) {
      metadataFile = join(dir, 'metadata.json');
      write(metadataFile, JSON.stringify({ scope }));
    }
    if (!this.hasPlainTokens(id)) {
      for (const [name, text] of Object.entries(this.sealedTokens(id))) write(join(store, name), text);
    }
    return { configDir: dir, clientInfoFile, ...(metadataFile ? { metadataFile } : {}) };
  }

  /**
   * An agent is about to start with this server. Returns the paths to hand
   * mcp-remote, or undefined — writing nothing — when nobody has signed in yet:
   * a bridge started without tokens would open the user's browser on its own.
   */
  checkout(id: string, agentId: string, client: OauthClient, scope?: string): BridgePaths | undefined {
    if (!client.clientId || !client.clientSecret) return undefined;
    if (!this.isConnected(id)) return undefined;
    const paths = this.materialise(id, client, scope);
    let set = this.users.get(id);
    if (!set) { set = new Set(); this.users.set(id, set); }
    set.add(agentId);
    return paths;
  }

  /** An agent ended. Anything it was the last user of is sealed and wiped. */
  release(agentId: string): void {
    for (const [id, set] of [...this.users]) {
      if (!set.delete(agentId)) continue;
      if (set.size === 0) {
        this.users.delete(id);
        if (!this.signingIn.has(id)) this.seal(id);
      }
    }
  }

  /** Start of a sign-in: the client goes to disk, with no tokens beside it. */
  beginSignIn(id: string, client: OauthClient, scope?: string): BridgePaths {
    this.signingIn.add(id);
    return this.materialise(id, client, scope);
  }

  /** End of a sign-in, successful or not: keep what it produced, encrypted, and
   *  take the plaintext away again unless an agent is using it right now. */
  endSignIn(id: string): boolean {
    this.signingIn.delete(id);
    if (this.users.get(id)?.size) return this.persist(id);
    return this.seal(id);
  }

  /** Copy the plaintext tokens into the encrypted store. False when there were
   *  none, or when the store refused them. */
  persist(id: string): boolean {
    const files = this.plainTokens(id);
    if (Object.keys(files).length === 0) return false;
    return this.secrets.set(mcpTokenRef(id), JSON.stringify({ files })).ok;
  }

  /** Persist, then remove every plaintext file. The removal happens even when
   *  the store refuses the tokens: losing a sign-in is the smaller failure. */
  seal(id: string): boolean {
    let kept = false;
    try { kept = this.persist(id); } catch { kept = false; }
    try { rmSync(this.dir(id), { recursive: true, force: true, maxRetries: 4, retryDelay: 40 }); } catch { /* best-effort */ }
    return kept;
  }

  /** Seal everything on disk. Run at app start (a crash leaves plaintext
   *  behind) and at quit (every agent is about to be killed). */
  sweep(): void {
    this.users.clear();
    this.signingIn.clear();
    let names: string[] = [];
    try { names = readdirSync(this.baseDir()); } catch { return; }
    for (const name of names) {
      const full = join(this.baseDir(), name);
      try {
        if (SAFE_ID.test(name) && statSync(full).isDirectory()) this.seal(name);
        else rmSync(full, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
    try { if (readdirSync(this.baseDir()).length === 0) rmSync(this.baseDir(), { recursive: true, force: true }); } catch { /* fine */ }
  }

  /** MAIN-ONLY. The tokens currently held, newest copy first, so Disconnect
   *  can revoke them at the provider. Never sent over IPC. */
  readTokens(id: string): StoredToken[] {
    const out: StoredToken[] = [];
    for (const src of [this.plainTokens(id), this.sealedTokens(id)]) {
      for (const text of Object.values(src)) {
        try {
          const t = JSON.parse(text);
          out.push({
            ...(typeof t.access_token === 'string' ? { access_token: t.access_token } : {}),
            ...(typeof t.refresh_token === 'string' ? { refresh_token: t.refresh_token } : {})
          });
        } catch { /* skip */ }
      }
    }
    return out;
  }

  /**
   * Forget everything held for this integration: sealed tokens and the whole
   * runtime directory. The OAuth client halves are the caller's to delete.
   *
   * It reports whether the forgetting really happened. A disconnect that leaves
   * a refresh token behind (the store refused the delete, or a plaintext file
   * could not be removed) must not look like a disconnect, so success needs
   * BOTH the sealed copy gone and the directory gone — checked, not assumed.
   */
  purge(id: string): PurgeResult {
    this.users.delete(id);
    this.signingIn.delete(id);
    const dir = this.dir(id);            // validates the id before anything is touched
    const problems: string[] = [];

    const ref = mcpTokenRef(id);
    try {
      const r = this.secrets.delete(ref);
      if (r && typeof r === 'object' && r.ok === false) problems.push(r.error ?? 'the sealed tokens could not be deleted');
    } catch (e) {
      problems.push(e instanceof Error ? e.message : 'the sealed tokens could not be deleted');
    }
    if (problems.length === 0 && this.secrets.get(ref) !== undefined) problems.push('the sealed tokens are still stored');

    // recursive+force+retries also rides out the EBUSY/EPERM a scanner or a
    // still-closing mcp-remote causes on Windows.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 }); } catch { /* checked below */ }
    if (existsSync(dir)) problems.push('the runtime token directory could not be removed');

    return problems.length ? { ok: false, error: problems.join('; ') } : { ok: true };
  }

  /** For tests and status: is anything of this integration on disk in the clear? */
  hasPlaintext(id: string): boolean {
    return existsSync(this.dir(id));
  }
}

type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body?: string; redirect: 'error'; signal?: AbortSignal;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * Ask the provider to forget these tokens. Best-effort, and deliberately
 * narrow: the URL comes from the catalogue (never from discovery metadata a
 * server could have poisoned), must be https, and a redirect is an error — a
 * refresh token is never sent anywhere a response told us to go.
 *
 * Returns how many tokens the provider confirmed revoked (or already dead).
 */
export async function revokeAtProvider(
  revoke: McpRevokeSpec | undefined,
  tokens: StoredToken[],
  fetchFn: FetchLike,
  timeoutMs = 10_000
): Promise<{ attempted: number; confirmed: number }> {
  const result = { attempted: 0, confirmed: 0 };
  if (!revoke || !/^https:\/\//.test(revoke.url)) return result;
  const values = new Set<string>();
  for (const t of tokens) {
    // Google: revoking the refresh token takes its access tokens with it.
    // Slack: auth.revoke kills the token it is called with, so send both.
    if (revoke.style === 'oauth2') { const v = t.refresh_token ?? t.access_token; if (v) values.add(v); }
    else { if (t.access_token) values.add(t.access_token); if (t.refresh_token) values.add(t.refresh_token); }
  }
  for (const token of values) {
    result.attempted++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = revoke.style === 'oauth2'
        ? await fetchFn(revoke.url, {
          method: 'POST', redirect: 'error', signal: ac.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `token=${encodeURIComponent(token)}`
        })
        : await fetchFn(revoke.url, {
          method: 'POST', redirect: 'error', signal: ac.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      if (revoke.style === 'oauth2') {
        // 200 = revoked; 400 = the provider no longer knows it, which is the same outcome.
        if (res.status === 200 || res.status === 400) result.confirmed++;
      } else {
        const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (body?.ok === true || ['token_revoked', 'invalid_auth', 'token_expired'].includes(body?.error ?? '')) result.confirmed++;
      }
    } catch { /* offline, timed out, redirected: not confirmed */ }
    finally { clearTimeout(timer); }
  }
  return result;
}
