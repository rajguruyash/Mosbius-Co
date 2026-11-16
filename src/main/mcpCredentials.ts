/**
 * Where the broker gets the credential for each kind of MCP integration (Stage B, F1).
 *
 *   bridged (Gmail, Calendar, Drive, Slack)  the in-app OAuth engine's token provider
 *   hosted HTTP (GitHub)                     the stored token, put into the header the server
 *                                            expects, on the broker's request to the provider
 *   app-run local (Notion, Brave, the rest)  nothing in a header: the credential goes into the
 *                                            ENVIRONMENT of the one process the app starts for
 *                                            it (see `localServerEnv`), but the broker still
 *                                            insists it exists before it lets a request through
 *
 * In none of these does the credential reach an agent: not in a file the agent can read, not in
 * a command line, not in an environment variable of the agent's own process. The agent presents
 * a capability to the broker and that is all it ever holds.
 *
 * Pure: the secret store and the OAuth provider are passed in.
 */
import type { McpCatalogEntry } from '../shared/mcpCatalog';
import type { CredentialProvider, CredentialResult } from './broker/credentials';
import type { McpIntegration } from './broker/mcp-route';
import type { ConnectionState } from './oauth/provider';

export interface McpCredentialDeps {
  entry: (id: string) => McpCatalogEntry | undefined;
  /** The stored token of a single-credential server (`mcp:<id>`). Main-only. */
  token: (id: string) => string | undefined;
  /** The in-app OAuth engine, for the bridged integrations. */
  oauth: CredentialProvider<McpIntegration>;
  /** Servers the user signs in to with an account (src/main/connect/). Asked first for a server that has a
   *  `connect` spec; a stored token is the fallback where the server also takes one. */
  connections?: CredentialProvider<McpIntegration> & { status(id: string): ConnectionState };
}

export function createMcpCredentialProvider(deps: McpCredentialDeps): CredentialProvider<McpIntegration> {
  return {
    accessHeaders(integ): CredentialResult | Promise<CredentialResult> {
      const entry = deps.entry(integ.id);
      if (!entry) return { ok: false, code: 'unavailable' };
      const spec = entry.spec;
      if (spec.transport === 'bridge') return deps.oauth.accessHeaders(integ);
      if (spec.transport === 'http') {
        if (spec.connect && deps.connections) {
          // a sign-in exists (alive, over, or unreadable right now): it is the one asked, and it answers honestly
          const st = deps.connections.status(integ.id);
          if (st === 'connected' || st === 'needs-signin' || st === 'unavailable') return deps.connections.accessHeaders(integ);
          if (!spec.secretHeader || !deps.token(entry.id)?.trim()) return { ok: false, code: spec.secretHeader ? 'no_secret' : 'sign_in_required' };
        }
        const h = spec.secretHeader;
        if (!h) return { ok: true, headers: {} };
        const token = deps.token(entry.id)?.trim();
        return token ? { ok: true, headers: { [h.name]: `${h.prefix ?? ''}${token}` } } : { ok: false, code: 'no_secret' };
      }
      // an app-run local server: the token is not a header. It must exist, though.
      if ((spec.secretEnv?.length ?? 0) > 0 && !deps.token(entry.id)?.trim()) return { ok: false, code: 'no_secret' };
      return { ok: true, headers: {} };
    },
    rejected(integ, used): void {
      const spec = deps.entry(integ.id)?.spec;
      if (spec?.transport === 'bridge') deps.oauth.rejected?.(integ, used);
      else if (spec?.transport === 'http' && spec.connect && deps.connections?.status(integ.id) === 'connected') deps.connections.rejected?.(integ, used);
    }
  };
}

/** Environment variable names an app-run server is allowed to inherit from the app's own
 *  environment: what a program needs to run and reach the network, and nothing else. In
 *  particular no `*_API_KEY`, `*_TOKEN`, `AWS_*`, `GITHUB_*` or anything the user exported. */
export const SERVER_ENV_ALLOW: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'TERM',
  'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramData',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY',
  'PLAYWRIGHT_BROWSERS_PATH'
];

/** The allow-list taken from `source`, with `PATH` replaced by the user's own login-shell PATH.
 *  Used for an installer as well as a server: neither gets the app's whole environment. */
export function serverBaseEnv(source: Record<string, string | undefined>, userPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SERVER_ENV_ALLOW) {
    const v = source[k];
    if (typeof v === 'string' && v) env[k] = v;
  }
  if (userPath) env.PATH = userPath;
  return env;
}

/**
 * The environment of an app-run server: the allow-list and nothing else. Returns undefined when the
 * entry is not an app-run server at all. A server's credential is NOT here: it is returned by
 * `localServerSecrets` and delivered on a private pipe (see mcpLaunch.ts), so it is never in the
 * initial environment that other processes of the same user can read.
 */
export function localServerEnv(
  entry: McpCatalogEntry, source: Record<string, string | undefined>, userPath: string
): Record<string, string> | undefined {
  if (entry.spec.transport === 'http' || entry.spec.transport === 'bridge') return undefined;
  return serverBaseEnv(source, userPath);
}

/**
 * The credential an app-run server needs, under the variable name(s) its catalogue entry declares:
 * `{}` for a server that needs none, undefined when it needs one and none is stored (it must not start).
 */
export function localServerSecrets(entry: McpCatalogEntry, token: string | undefined): Record<string, string> | undefined {
  if (entry.spec.transport === 'http' || entry.spec.transport === 'bridge') return undefined;
  const names = entry.spec.secretEnv ?? [];
  if (names.length === 0) return {};
  const t = token?.trim();
  if (!t) return undefined;
  return Object.fromEntries(names.map((n) => [n, t]));
}
