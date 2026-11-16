/**
 * Default MCP server catalog. A dependency-free, importable-by-both (main +
 * renderer) registry of the MCP servers Mosbius & Co can wire into each agent.
 * Keep it free of electron/UI/node imports.
 *
 * EVERY ENTRY HERE IS VERIFIED. An entry is only allowed in this file when the
 * package (or endpoint) was checked against its own registry and its publisher's
 * own README on the date in `verified`. Four entries were removed on 2026-11-13
 * because that check failed:
 *
 *   @modelcontextprotocol/server-github         npm: DEPRECATED, "archived and
 *                                               unmaintained" → replaced by
 *                                               GitHub's own remote server.
 *   @modelcontextprotocol/server-postgres       npm: DEPRECATED, archived. The
 *                                               generic "Database" entry is gone;
 *                                               no verified generic replacement.
 *   @modelcontextprotocol/server-gsuite         npm: DOES NOT EXIST (never
 *                                               published). The "Email & Calendar"
 *                                               entry could never have started.
 *   @modelcontextprotocol/server-brave-search   npm: DEPRECATED → replaced by
 *                                               Brave's own package.
 *
 * Do not add an entry from memory. Check the registry and the publisher's README,
 * then record the date.
 *
 * ─── Gmail / Calendar / Drive / Slack / Salesforce, retested 2026-11-14 ──────
 *
 * All five now publish a first-party remote server — that part of the note
 * above is out of date. Four of them still cannot be wired up here, and the
 * reason is one specific thing, confirmed by running real `claude -p` sessions
 * against the live endpoints with `--mcp-config` (claude 2.1.319):
 *
 *   A Claude Code agent gets its OAuth client for a remote MCP server by
 *   DYNAMIC CLIENT REGISTRATION (RFC 7591). There is no way to hand it a client
 *   id and secret registered by hand. If the service's auth server does not
 *   support DCR, the agent cannot sign in at all.
 *
 *   gmailmcp.googleapis.com/mcp/v1      handshake CONNECTED, 21 tools listed,
 *   calendarmcp.googleapis.com/mcp/v1   then every call fails with
 *   drivemcp.googleapis.com/mcp/v1      "Incompatible auth server: does not
 *                                       support dynamic client registration".
 *                                       Developer-Preview-only besides, and
 *                                       Google documents Claude support for
 *                                       claude.ai / Desktop connectors, not for
 *                                       Claude Code.
 *   mcp.slack.com/mcp                   server status `failed` at startup.
 *                                       Slack also requires the client to be an
 *                                       admin-approved Marketplace or internal
 *                                       app.
 *   api.salesforce.com/platform/mcp/v1  status `needs-auth` — this one CAN
 *                                       register, so it is the single one of
 *                                       the five that is actually reachable.
 *                                       Not added: developer.salesforce.com
 *                                       refuses automated fetches (403), so the
 *                                       endpoint path and the hosted server
 *                                       names could not be checked against the
 *                                       publisher, and the rule above is not
 *                                       suspended for a promising probe.
 *
 * A `connected` status means the handshake succeeded. It does NOT mean the
 * server works — Gmail listed 21 tools and then refused every one of them. Test
 * a real call before believing an entry.
 *
 * The way in for the four, for whoever builds it: a bridge such as `mcp-remote`
 * holds a client id and secret registered by hand and speaks stdio to the agent.
 * That needs the user's own Google Cloud OAuth client (plus Developer Preview
 * membership), or an admin-approved Slack app — so it cannot ship switched on,
 * and it cannot be tested without those credentials.
 *
 * NOTHING IS ON BY DEFAULT (Stage B, 2026-11-15). Every entry ships with
 * `defaultEnabled:false`, the six local servers included: a server that reaches
 * the internet (fetch, context7), the filesystem (filesystem, git) or a browser
 * (playwright) must never become available to an agent silently. An agent gets
 * a server only when the user (1) switched it on, (2) stored its credential or
 * signed in, where it needs one, AND (3) granted THAT agent access to it.
 *
 * Tiers describe what a server can do. They no longer decide whether it is on:
 *   - 'safe-readonly' → no secret, no destructive write OUTSIDE the agent cwd.
 *                       `filesystem`/`git` are scoped to the agent cwd at merge
 *                       time (never whole-disk).
 *   - 'write'         → can act beyond the workspace.
 *   - 'secret'        → needs an API key / token; skipped unless a real
 *                       credential is stored, and that credential is held by the
 *                       app, never written into an agent's files or environment.
 */

import type { ConnectSpec } from './connect';


export type McpTier = 'safe-readonly' | 'write' | 'secret' | 'oauth-bridge';

/**
 * A third-party package a local server runs from (Stage B, F4). Pinned to ONE exact release:
 * never a range, a tag or "latest". The release's whole dependency tree, with a hash for every
 * file, is committed in `resources/mcp-locks/<id>/` (made by `tools/pin-mcp-packages.cjs`) and
 * the app installs from that lock only, with install scripts switched off, into its own folder.
 * A tarball that does not match its hash is refused, not worked around. See src/main/mcpPackages.ts.
 */
export interface McpPackage {
  manager: 'npm' | 'pypi';
  name: string;
  /** Exact release, e.g. `2.1.1`. */
  version: string;
  /** npm: the key in the package's `bin` map. pypi: the console script's name. */
  bin: string;
}

/**
 * A local server, run BY THE APP (never by the agent's own CLI) and reached by an agent only
 * through the in-app broker. The app starts it from the pinned package below, with the
 * credential it needs in the environment of that one process, so an agent never receives a
 * command line, an environment or a file that carries a secret.
 */
export interface McpStdioSpec {
  transport?: 'stdio';
  package: McpPackage;
  /** Arguments for the package's executable. `<cwd>` becomes the agent's workspace. */
  args: string[];
  /** Names of the env vars this server needs. Values are NEVER stored here —
   *  they come from the encrypted secret store at spawn time. */
  secretEnv?: string[];
  /** Pinned class of each tool, by name (see McpBridgeSpec.toolClasses). A tool not listed
   *  counts as destructive: no preset reaches it. */
  toolClasses?: Readonly<Record<string, McpToolClass>>;
  trustAnnotations?: boolean;
}

/** A hosted server the BROKER speaks to over Streamable HTTP, on an agent's behalf. */
export interface McpHttpSpec {
  transport: 'http';
  url: string;
  /** How a user connects it without pasting a key (see src/shared/connect.ts). A server may offer both
   *  this and `secretHeader`: the sign-in is the way in, the stored token is the fallback. */
  connect?: ConnectSpec;
  toolClasses?: Readonly<Record<string, McpToolClass>>;
  trustAnnotations?: boolean;
  /** Header the credential is sent in, and the prefix it carries
   *  (e.g. `Authorization: Bearer <token>`). The value is supplied at spawn
   *  time from the encrypted secret store. */
  secretHeader?: { name: string; prefix?: string };
}

/**
 * The exact release of `mcp-remote` the bridge launches. Pinned, never "latest":
 * it runs holding the user's OAuth client and, once signed in, their tokens, so a
 * package that can change underneath the app between two spawns is a supply-chain
 * hole. 0.16.6 is the release the 2026-11-14 security audit exercised end to end
 * (sign-in, token exchange, refresh, a tool call) against a stand-in provider.
 * Changing it is a deliberate act: re-run the audit probe first.
 */
export const MCP_REMOTE_VERSION = '0.16.6';
export const MCP_REMOTE_PACKAGE = `mcp-remote@${MCP_REMOTE_VERSION}`;
/** Its lock (resources/mcp-locks/mcp-remote) pins the whole tree; see McpPackage. */
export const MCP_REMOTE_PACKAGE_SPEC: McpPackage = {
  manager: 'npm', name: 'mcp-remote', version: MCP_REMOTE_VERSION, bin: 'mcp-remote'
};

/**
 * How a provider is told to forget a token. Used by "Disconnect": deleting our
 * copy does nothing to a refresh token that is still valid at the provider, so
 * where the provider documents a revocation call we make it first.
 *
 *   'oauth2' — a form POST of `token=<token>` (Google's /revoke, RFC 7009 style);
 *              a 400 `invalid_token` means it was already gone.
 *   'slack'  — Slack's Web API `auth.revoke`, authenticated by the token itself
 *              in an `Authorization: Bearer` header; `{"ok":true,"revoked":true}`.
 */
export interface McpRevokeSpec {
  url: string;
  style: 'oauth2' | 'slack';
}

/**
 * How the APP signs in to a bridged server itself (engine `broker`), with no
 * `mcp-remote` and no token file on disk. Authorization-code flow with PKCE
 * (S256 only), run in the main process; see src/main/oauth/.
 *
 * Every endpoint is PINNED here. They are copied from the provider's own
 * published authorization-server metadata (RFC 8414) and are never discovered at
 * run time: a discovery document that could redirect the sign-in, or the token
 * exchange that carries the user's client secret, to another host is exactly the
 * attack a pinned catalogue removes. `tools/verify-oauth-live.cjs --check-metadata`
 * compares them with what the providers publish today.
 */
export interface McpOauthSpec {
  /** The authorization server's issuer identifier, exactly as it publishes it.
   *  An authorization response carrying a different `iss` is refused (RFC 9207). */
  issuer: string;
  /** https only. The browser is sent here. */
  authorizationEndpoint: string;
  /** https only. The code (and later the refresh token) is exchanged here, with the
   *  user's client secret in the POST body (`client_secret_post`). */
  tokenEndpoint: string;
  /** Scopes the in-app sign-in asks for. Defaults to the bridge's `scope`. */
  scope?: string;
  /** Extra authorization-request parameters the provider needs (Google only issues
   *  a refresh token for `access_type=offline`). May not override the protocol's own. */
  authorizeParams?: Readonly<Record<string, string>>;
  /** Whether a response without `iss` is refused. `required` when the provider's
   *  metadata says it always sends one (RFC 9207); `optional` still refuses a WRONG one. */
  issParameter: 'required' | 'optional';
  /** The shape of the token endpoint's JSON: plain RFC 6749, Slack's `{ok:…}` envelope, or GitHub's
   *  (HTTP 200 whatever happened, with an `error` field when it failed). */
  tokenResponse: 'oauth2' | 'slack' | 'github';
  /** RFC 8707: the resource the token is for, sent with the exchange and every refresh. Self-registered
   *  providers (the MCP authorization specification) expect it. */
  resource?: string;
}

/**
 * A hosted OAuth server the agent cannot register itself with, reached through
 * the `mcp-remote` bridge.
 *
 * Gmail, Calendar, Drive and Slack all refuse dynamic client registration, so a
 * Claude Code agent cannot sign in to them directly (see the retest note at the
 * top of this file). `mcp-remote` sits in between: it holds an OAuth client the
 * USER registered by hand, does the sign-in once, and speaks stdio to the agent
 * from then on.
 *
 * Where the secrets live (see src/main/mcpAuthVault.ts):
 *   • the client id and secret, and the tokens the sign-in produces, are kept in
 *     the OS-encrypted store (Electron `safeStorage`);
 *   • while an agent that uses the server is running they are written to a
 *     private (0700) runtime directory under the app's data folder, because
 *     mcp-remote can only read them from disk — and removed again, with the
 *     tokens sealed back into the encrypted store, when the last such agent ends;
 *   • none of it ever goes into the agent's MCP config file, the hive's git
 *     repository or the agent's argument vector.
 */
/** How much harm a tool can do, least to most: `destructive` covers anything that sends,
 *  posts, deletes or otherwise cannot be taken back. */
export type McpToolClass = 'read' | 'write' | 'destructive';

export interface McpBridgeSpec {
  transport: 'bridge';
  /** The hosted server's Streamable HTTP endpoint. */
  url: string;
  /** The loopback port the sign-in redirects back to. Fixed rather than derived
   *  from the URL: the service only honours a redirect URI the user registered
   *  in advance, so it has to be a port they can be told beforehand and one
   *  that cannot move. */
  callbackPort: number;
  /** Space-separated OAuth scopes, sent as static client metadata. Omitted when
   *  the service decides scopes itself (Slack asks per tool). */
  scope?: string;
  /** How to revoke a token at the provider on Disconnect, when it documents one. */
  revoke?: McpRevokeSpec;
  /** How the app signs in itself, instead of through mcp-remote. Used only for an
   *  integration whose engine is switched to `broker` (default: the bridge). */
  oauth?: McpOauthSpec;
  /**
   * The class a maintainer has checked for each of this server's tools, by tool name.
   * Used by the in-app engine's permission model (a preset reaches `read` tools, or
   * `read` and `write` tools, and never a `destructive` one). EMPTY for all four entries:
   * pinning needs a real tool listing from a signed-in account, which has not been done.
   * Until then every tool is unclassified, which counts as `destructive`, so no preset
   * reaches any tool and the only way in is to name a tool in an allow list.
   */
  toolClasses?: Readonly<Record<string, McpToolClass>>;
  /** Believe the server's own `readOnlyHint` / `destructiveHint`. Off until a live listing has
   *  been read and the hints found trustworthy. Even when on, an annotation can only make a
   *  tool STRICTER than the catalogue says, never looser. */
  trustAnnotations?: boolean;
}

/** Which implementation signs a bridged integration in and keeps its tokens. The
 *  default is always the bridge; `broker` is opt-in, per integration, and the
 *  bridge stays installed as the way back. */
export type McpEngine = 'bridge' | 'broker';

export type McpSpec = McpStdioSpec | McpHttpSpec | McpBridgeSpec;

/** The two halves of an OAuth client, stored separately in the secret store
 *  under `mcp:<id>:<field>`. */
export type McpSecretField = 'client_id' | 'client_secret';
export const MCP_SECRET_FIELDS: McpSecretField[] = ['client_id', 'client_secret'];

/**
 * The host the sign-in redirects back to. Pinned to the IPv4 loopback literal
 * (RFC 8252 section 7.3) on every platform: mcp-remote listens on 127.0.0.1
 * only, while `localhost` may resolve to ::1 first, and left alone mcp-remote
 * picks `localhost` on macOS/Linux but `127.0.0.1` on Windows — so the address
 * the user registered would not have matched there.
 */
export const MCP_CALLBACK_HOST = '127.0.0.1';

/** The redirect URI to register with the service for a bridged server. mcp-remote
 *  listens on exactly this path; the port is the entry's own `callbackPort`. */
export function mcpRedirectUri(port: number): string {
  return `http://${MCP_CALLBACK_HOST}:${port}/oauth/callback`;
}

/** Secret-store ref for the tokens a bridged server's sign-in produced. */
export function mcpTokenRef(id: string): string {
  return `mcp:${id}:tokens`;
}

/** Secret-store ref for the sealed token record the in-app sign-in (engine
 *  `broker`) produced. A different ref from the bridge's, so the two engines can
 *  never read each other's files. */
export function mcpOauthRef(id: string): string {
  return `mcp:${id}:oauth`;
}

export interface McpCatalogEntry {
  /** Stable catalog id (also the consent key in `config.mcpDefaults` and the
   *  secret-store key). The merge step namespaces the written server id
   *  (`mosbius-<id>`) so a server of the same name in the user's own Claude
   *  config is never clobbered. */
  id: string;
  /** Human label for the consent UI. */
  label: string;
  /** One-line description for the consent UI / hire import preview. */
  description: string;
  spec: McpSpec;
  tier: McpTier;
  /** Seed for `config.mcpDefaults[id].enabled`. ALWAYS false: every integration is
   *  opt-in, whatever its tier (a test fails the build if one ships switched on). */
  defaultEnabled: false;
  /** Who publishes it, in their own words — shown in the UI so the user can see
   *  whether a server is first-party before switching it on. */
  publisher: string;
  /** Where it was verified, and when. Both are shown in the UI. */
  source: string;
  verified: string;
  /** What the user has to get hold of, for secret-tier entries. */
  secretLabel?: string;
  secretHelp?: string;
}

/** Google's documented token revocation. Request shape checked against the live
 *  endpoint on 2026-11-14 with a made-up token: a form POST of `token=` answers
 *  400 `invalid_token`. Whether it revokes a token minted for a Workspace MCP
 *  server specifically has NOT been tested — that needs a real sign-in. */
const GOOGLE_REVOKE: McpRevokeSpec = { url: 'https://oauth2.googleapis.com/revoke', style: 'oauth2' };
/** Slack's documented `auth.revoke` (docs.slack.dev/reference/methods/auth.revoke).
 *  Request shape checked live on 2026-11-14 with a made-up token in `test=1`
 *  mode: `{"ok":false,"error":"invalid_auth"}`. Whether it covers a token minted
 *  through Slack's MCP server has NOT been tested. */
const SLACK_REVOKE: McpRevokeSpec = { url: 'https://slack.com/api/auth.revoke', style: 'slack' };

/** Google's sign-in, copied from https://accounts.google.com/.well-known/oauth-authorization-server
 *  (fetched 2026-11-15): S256 supported, `client_secret_post` supported, and
 *  `authorization_response_iss_parameter_supported: true`, so `iss` is required.
 *  `access_type=offline` + `prompt=consent` is what makes Google hand back a refresh
 *  token. The in-app sign-in has NOT been run against Google. */
const GOOGLE_OAUTH: McpOauthSpec = {
  issuer: 'https://accounts.google.com',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  authorizeParams: { access_type: 'offline', prompt: 'consent' },
  issParameter: 'required',
  tokenResponse: 'oauth2'
};
/** Slack's sign-in for its MCP server, copied from
 *  https://mcp.slack.com/.well-known/oauth-authorization-server (fetched 2026-11-15):
 *  S256 only, `client_secret_post` only, no revocation endpoint published (the
 *  documented `auth.revoke` is used instead). The metadata does not say whether `iss`
 *  is sent, so a missing one is tolerated and a wrong one is refused. The scopes are a
 *  READ-ONLY subset of the 30 the server lists: nothing that posts, writes or edits is
 *  asked for until the user opts in to it. The in-app sign-in has NOT been run against
 *  Slack, and the shape of its token response is unverified. */
const SLACK_OAUTH: McpOauthSpec = {
  issuer: 'https://mcp.slack.com',
  authorizationEndpoint: 'https://slack.com/oauth/v2_user/authorize',
  tokenEndpoint: 'https://slack.com/api/oauth.v2.user.access',
  scope: 'search:read.public search:read.private search:read.im search:read.mpim search:read.files search:read.users '
    + 'channels:history channels:read groups:history groups:read im:history im:read mpim:history mpim:read users:read',
  issParameter: 'optional',
  tokenResponse: 'slack'
};

/**
 * Pin the class of each tool of a local server, by name, from a REAL listing: the one the app
 * itself got from each pinned release (`tools/verify-packages-live.cjs --snapshot` writes it to
 * `resources/mcp-locks/<id>/tools.json`, and test/mcp-tool-classes.test.cjs holds these pins to
 * it). The server's own annotations are NOT trusted; each pin is a maintainer's judgement:
 *   read         changes nothing anywhere (a lookup, a listing, a search, a snapshot);
 *   write        changes state that the agent already has the right to change in its own
 *                workspace, or navigates, or appends: a preset of `write` reaches it;
 *   destructive  can lose data, run arbitrary code, or act on a third party's behalf (submit,
 *                delete, send, reset): no preset reaches it, it must be named in an allow list.
 * A tool not pinned here counts as destructive.
 */
function pin(read: string[], write: string[] = [], destructive: string[] = []): Readonly<Record<string, McpToolClass>> {
  const out: Record<string, McpToolClass> = {};
  for (const n of read) out[n] = 'read';
  for (const n of write) out[n] = 'write';
  for (const n of destructive) out[n] = 'destructive';
  return out;
}

/** The MCP catalogue. Every entry is OFF until the user switches it on and grants an
 *  agent access to it; see the note at the top of this file. */
export const MCP_CATALOG: McpCatalogEntry[] = [
  // ─── Local, no secret, scoped to the workspace — shipped OFF ───────────────
  {
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning scratchpad. No I/O, no secrets.',
    spec: { package: { manager: 'npm', name: '@modelcontextprotocol/server-sequential-thinking', version: '2.1.1', bin: 'mcp-server-sequential-thinking' }, args: [],
      // keeps its notes in memory and touches nothing else, though the server's own hint says otherwise
      toolClasses: pin(['sequentialthinking']) },
    tier: 'safe-readonly',
    defaultEnabled: false,
    publisher: 'Model Context Protocol (reference servers)',
    source: 'npm @modelcontextprotocol/server-sequential-thinking 2.1.1',
    verified: '2026-11-13'
  },
  {
    id: 'time',
    label: 'Time',
    description: 'Current time and timezone conversions.',
    // Ships as Python (PyPI), not as an npm package.
    spec: { package: { manager: 'pypi', name: 'mcp-server-time', version: '2026.11.11', bin: 'mcp-server-time' }, args: [],
      toolClasses: pin(['get_current_time', 'convert_time', 'get_time_ago']) },
    tier: 'safe-readonly',
    defaultEnabled: false,
    publisher: 'Anthropic, PBC',
    source: 'PyPI mcp-server-time 2026.11.11',
    verified: '2026-11-13'
  },
  {
    id: 'fetch',
    label: 'Fetch',
    description: 'Fetch a URL and return its content as markdown (read-only HTTP GET).',
    spec: { package: { manager: 'pypi', name: 'mcp-server-fetch', version: '2026.11.11', bin: 'mcp-server-fetch' }, args: [],
      // a GET of a URL the agent chooses; the server itself refuses loopback and private addresses
      toolClasses: pin(['fetch']) },
    tier: 'safe-readonly',
    defaultEnabled: false,
    publisher: 'Anthropic, PBC',
    source: 'PyPI mcp-server-fetch 2026.11.11',
    verified: '2026-11-13'
  },
  {
    id: 'context7',
    label: 'Context7 Docs',
    description: 'Up-to-date library and framework documentation lookups.',
    spec: { package: { manager: 'npm', name: '@upstash/context7-mcp', version: '4.7.0', bin: 'context7-mcp' }, args: [],
      toolClasses: pin(['resolve-library-id', 'query-docs']) },
    tier: 'safe-readonly',
    defaultEnabled: false,
    publisher: 'Upstash',
    source: 'npm @upstash/context7-mcp 4.7.0',
    verified: '2026-11-13'
  },
  {
    id: 'filesystem',
    label: 'Filesystem (workspace)',
    description: 'Read and edit files inside the agent workspace only.',
    // The trailing arg is the allowed root — replaced with the agent cwd at merge
    // time so it is NEVER whole-disk.
    spec: { package: { manager: 'npm', name: '@modelcontextprotocol/server-filesystem', version: '2.3.0', bin: 'mcp-server-filesystem' }, args: ['<cwd>'],
      // scoped to the agent's own workspace, where it can already change files with its own tools
      toolClasses: pin(
        ['read_file', 'read_text_file', 'read_media_file', 'read_multiple_files', 'list_directory', 'list_directory_with_sizes',
          'directory_tree', 'search_files', 'get_file_info', 'list_allowed_directories'],
        ['write_file', 'append_file', 'edit_file', 'create_directory', 'move_file', 'copy_file']
      ) },
    tier: 'safe-readonly',
    defaultEnabled: false,
    publisher: 'Model Context Protocol (reference servers)',
    source: 'npm @modelcontextprotocol/server-filesystem 2.3.0',
    verified: '2026-11-13'
  },
  {
    id: 'git',
    label: 'Git (workspace)',
    description: 'Inspect git status, log and diff for the workspace repo.',
    // Ships as Python; `--repository <cwd>` is scoped at merge time.
    spec: { package: { manager: 'pypi', name: 'mcp-server-git', version: '2026.11.11', bin: 'mcp-server-git' }, args: ['--repository', '<cwd>'],
      toolClasses: pin(
        ['git_status', 'git_diff_unstaged', 'git_diff_staged', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_remote'],
        ['git_add', 'git_commit', 'git_create_branch', 'git_checkout', 'git_merge'],
        ['git_reset']
      ) },
    tier: 'safe-readonly',
    defaultEnabled: false,
    publisher: 'Anthropic, PBC',
    source: 'PyPI mcp-server-git 2026.11.11',
    verified: '2026-11-13'
  },

  // ─── Acts beyond the workspace — shipped OFF, consent-gated ───────────────
  {
    id: 'playwright',
    label: 'Browser (Playwright)',
    description: 'Drive a real browser: open pages, click, type, read the page back.',
    spec: { package: { manager: 'npm', name: '@playwright/mcp', version: '0.0.85', bin: 'playwright-mcp' }, args: [],
      // looking at a page is a read, moving around is a write, and anything that clicks, types, submits,
      // uploads or runs code inside a page (possibly a signed-in one) must be named
      toolClasses: pin(
        ['browser_console_messages', 'browser_find', 'browser_network_requests', 'browser_network_request',
          'browser_take_screenshot', 'browser_snapshot', 'browser_wait_for'],
        ['browser_navigate', 'browser_navigate_back', 'browser_tabs', 'browser_close', 'browser_resize', 'browser_emulate_media', 'browser_hover'],
        ['browser_click', 'browser_type', 'browser_press_key', 'browser_fill_form', 'browser_select_option', 'browser_drag', 'browser_drop',
          'browser_file_upload', 'browser_handle_dialog', 'browser_evaluate', 'browser_run_code_unsafe']
      ) },
    tier: 'write',
    defaultEnabled: false,
    publisher: 'Microsoft',
    source: 'npm @playwright/mcp 0.0.85 (github.com/microsoft/playwright-mcp)',
    verified: '2026-11-13'
  },

  // ─── Hosted servers you sign in to: the app registers itself, no key, no OAuth app of yours ──────────
  //
  // Each publishes OAuth metadata that offers dynamic client registration, a public client and PKCE (read
  // live on 2026-11-15 with `node tools/stage-a-spike.cjs metadata`). NONE has been signed in to yet: the
  // first real sign-in is the owner's to give, so each entry says so and none is called verified. Their
  // tool lists are unknown until then, so no tool is classified: an agent reaches none of them until the
  // user names a tool, or opts in to the server's own read-only hints for that connection.
  {
    id: 'notion-hosted',
    label: 'Notion (sign in)',
    description: 'Read and write the Notion pages you approve, signed in with your own Notion account. No token to paste.',
    spec: { transport: 'http', url: 'https://mcp.notion.com/mcp', connect: { hosts: ['mcp.notion.com'], methods: [{ kind: 'dcr' }] } },
    tier: 'write',
    defaultEnabled: false,
    publisher: 'Notion',
    source: 'mcp.notion.com, Notion\'s hosted server (metadata read 2026-11-15; not yet signed in)',
    verified: '2026-11-15'
  },
  {
    id: 'linear',
    label: 'Linear',
    description: 'Search and read Linear issues and projects, and change them if you allow it.',
    spec: {
      transport: 'http', url: 'https://mcp.linear.app/mcp',
      connect: { hosts: ['mcp.linear.app'], methods: [{ kind: 'dcr' }], scopes: { read: 'read', write: 'read write' } }
    },
    tier: 'write',
    defaultEnabled: false,
    publisher: 'Linear',
    source: 'mcp.linear.app, Linear\'s hosted server (metadata read 2026-11-15; not yet signed in)',
    verified: '2026-11-15'
  },
  {
    id: 'sentry',
    label: 'Sentry',
    description: 'Look into Sentry issues and events, and change them if you allow it.',
    spec: { transport: 'http', url: 'https://mcp.sentry.dev/mcp', connect: { hosts: ['mcp.sentry.dev'], methods: [{ kind: 'dcr' }] } },
    tier: 'write',
    defaultEnabled: false,
    publisher: 'Sentry',
    source: 'mcp.sentry.dev, Sentry\'s hosted server (metadata read 2026-11-15; not yet signed in)',
    verified: '2026-11-15'
  },
  {
    id: 'stripe',
    label: 'Stripe',
    description: 'Look up Stripe customers, payments and products. Payments and refunds are never reached by a preset.',
    spec: { transport: 'http', url: 'https://mcp.stripe.com', connect: { hosts: ['mcp.stripe.com', 'access.stripe.com'], methods: [{ kind: 'dcr' }] } },
    tier: 'write',
    defaultEnabled: false,
    publisher: 'Stripe',
    source: 'mcp.stripe.com, Stripe\'s hosted server; its resource metadata names access.stripe.com/mcp as the authorization server (read 2026-11-15; not yet signed in)',
    verified: '2026-11-15'
  },
  {
    id: 'atlassian',
    label: 'Jira and Confluence',
    description: 'Search and read Jira issues and Confluence pages, and change them if you allow it.',
    spec: {
      transport: 'http', url: 'https://mcp.atlassian.com/v1/mcp',
      // it publishes no resource metadata (checked 2026-11-15): mcp.atlassian.com is itself the authorization server
      connect: { hosts: ['mcp.atlassian.com'], authorizationServer: 'https://mcp.atlassian.com', methods: [{ kind: 'dcr' }] }
    },
    tier: 'write',
    defaultEnabled: false,
    publisher: 'Atlassian',
    source: 'mcp.atlassian.com, Atlassian\'s hosted server (metadata read 2026-11-15; not yet signed in)',
    verified: '2026-11-15'
  },

  // ─── Needs a credential — shipped OFF, consent-gated, skipped without one ──
  {
    id: 'github',
    label: 'GitHub',
    description: 'Read and write GitHub issues, pull requests and repositories.',
    // GitHub's own hosted server. The archived npm package it replaces was
    // deprecated by its publisher with "no security guarantees".
    spec: {
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      secretHeader: { name: 'Authorization', prefix: 'Bearer ' },
      // The device flow needs an app registered at GitHub, whose client id is a public value. None is registered
      // for this project yet, so the method is offered once a client id is supplied (the user's own GitHub App or
      // OAuth App). Whether the hosted server accepts the token such an app mints is NOT yet verified.
      connect: {
        hosts: ['api.githubcopilot.com', 'github.com'],
        methods: [{ kind: 'device', deviceEndpoint: 'https://github.com/login/device/code', tokenEndpoint: 'https://github.com/login/oauth/access_token', scope: 'repo read:org' }]
      }
    },
    tier: 'secret',
    defaultEnabled: false,
    publisher: 'GitHub',
    source: 'github.com/github/github-mcp-server (hosted endpoint)',
    verified: '2026-11-13',
    secretLabel: 'GitHub personal access token',
    secretHelp: 'Create a fine-grained token at github.com/settings/tokens with only the repositories and scopes you want an agent to reach.'
  },
  {
    id: 'notion',
    label: 'Notion',
    description: 'Read and write Notion pages and databases shared with the integration.',
    spec: {
      package: { manager: 'npm', name: '@notionhq/notion-mcp-server', version: '2.6.1', bin: 'notion-mcp-server' },
      args: [],
      secretEnv: ['NOTION_TOKEN'],
      // search and query are POSTs in Notion's API but only read; deleting a block is the one destructive call
      toolClasses: pin(
        ['API-get-user', 'API-get-users', 'API-get-self', 'API-post-search', 'API-get-block-children', 'API-retrieve-a-block',
          'API-retrieve-a-page', 'API-retrieve-a-page-property', 'API-retrieve-a-comment', 'API-query-data-source',
          'API-retrieve-a-data-source', 'API-list-data-source-templates', 'API-retrieve-a-database', 'API-retrieve-page-markdown'],
        ['API-patch-block-children', 'API-update-a-block', 'API-patch-page', 'API-post-page', 'API-create-a-comment',
          'API-update-a-data-source', 'API-create-a-data-source', 'API-move-page', 'API-update-page-markdown'],
        ['API-delete-a-block']
      )
    },
    tier: 'secret',
    defaultEnabled: false,
    publisher: 'Notion',
    source: 'npm @notionhq/notion-mcp-server 2.6.1',
    verified: '2026-11-13',
    secretLabel: 'Notion internal integration token',
    secretHelp: 'notion.so/my-integrations → Internal Integration Secret. Only pages you explicitly share with the integration are reachable.'
  },
  {
    id: 'brave-search',
    label: 'Brave Search',
    description: 'Web search through the Brave Search API.',
    spec: {
      package: { manager: 'npm', name: '@brave/brave-search-mcp-server', version: '2.1.4', bin: 'brave-search-mcp-server' },
      args: ['--transport', 'stdio'],
      secretEnv: ['BRAVE_API_KEY'],
      toolClasses: pin([
        'brave_web_search', 'brave_local_search', 'brave_video_search', 'brave_image_search',
        'brave_news_search', 'brave_summarizer', 'brave_llm_context', 'brave_place_search'
      ])
    },
    tier: 'secret',
    defaultEnabled: false,
    publisher: 'Brave',
    source: 'npm @brave/brave-search-mcp-server 2.1.4',
    verified: '2026-11-13',
    secretLabel: 'Brave Search API key',
    secretHelp: 'brave.com/search/api — the free tier is enough for occasional lookups.'
  },

  // ─── Reached through the mcp-remote bridge, with an OAuth client you ───────
  // ─── register yourself. Shipped OFF; skipped until both halves are stored. ─
  //
  // Each of these publishes a first-party server that an agent cannot sign in
  // to on its own. The bridge is the way in, and it costs the user real setup
  // work, so none of it happens without them doing that work first.
  {
    id: 'gmail',
    label: 'Gmail',
    description: 'Search threads, read messages and draft replies. Cannot send.',
    spec: {
      transport: 'bridge',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      callbackPort: 33101,
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
      revoke: GOOGLE_REVOKE,
      oauth: GOOGLE_OAUTH
    },
    tier: 'oauth-bridge',
    defaultEnabled: false,
    publisher: 'Google',
    source: 'developers.google.com/workspace/guides/configure-mcp-servers (Developer Preview)',
    verified: '2026-11-14',
    secretLabel: 'Your own Google OAuth client',
    secretHelp: 'Needs Google Workspace Developer Preview membership. In Google Cloud: enable gmailmcp.googleapis.com and the Gmail API, then create an OAuth client of type Web application with "Use this client for an AI-powered agent" ticked. Register ' + mcpRedirectUri(33101) + ' as an authorised redirect URI.'
  },
  {
    id: 'google-calendar',
    label: 'Google Calendar',
    description: 'Read calendars and events, and find free time.',
    spec: {
      transport: 'bridge',
      url: 'https://calendarmcp.googleapis.com/mcp/v1',
      callbackPort: 33102,
      scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly '
        + 'https://www.googleapis.com/auth/calendar.events.freebusy '
        + 'https://www.googleapis.com/auth/calendar.events.readonly',
      revoke: GOOGLE_REVOKE,
      oauth: GOOGLE_OAUTH
    },
    tier: 'oauth-bridge',
    defaultEnabled: false,
    publisher: 'Google',
    source: 'developers.google.com/workspace/guides/configure-mcp-servers (Developer Preview)',
    verified: '2026-11-14',
    secretLabel: 'Your own Google OAuth client',
    secretHelp: 'Same Google Cloud client as Gmail can be reused. Enable calendarmcp.googleapis.com and the Calendar API alongside it, and register ' + mcpRedirectUri(33102) + ' as a further redirect URI (each service listens on its own port).'
  },
  {
    id: 'google-drive',
    label: 'Google Drive',
    description: 'Search Drive, read file contents and metadata, upload files.',
    spec: {
      transport: 'bridge',
      url: 'https://drivemcp.googleapis.com/mcp/v1',
      callbackPort: 33103,
      scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file',
      revoke: GOOGLE_REVOKE,
      oauth: GOOGLE_OAUTH
    },
    tier: 'oauth-bridge',
    defaultEnabled: false,
    publisher: 'Google',
    source: 'developers.google.com/workspace/guides/configure-mcp-servers (Developer Preview)',
    verified: '2026-11-14',
    secretLabel: 'Your own Google OAuth client',
    secretHelp: 'Same Google Cloud client as Gmail can be reused. Enable drivemcp.googleapis.com and the Drive API alongside it, and register ' + mcpRedirectUri(33103) + ' as a further redirect URI (each service listens on its own port).'
  },
  {
    id: 'slack',
    label: 'Slack',
    description: 'Search and read Slack messages, channels and threads; post messages.',
    // No `scope`: Slack's own server asks for granular user-token scopes per
    // tool rather than taking a fixed set up front.
    spec: {
      transport: 'bridge',
      url: 'https://mcp.slack.com/mcp',
      callbackPort: 33104,
      revoke: SLACK_REVOKE,
      oauth: SLACK_OAUTH
    },
    tier: 'oauth-bridge',
    defaultEnabled: false,
    publisher: 'Slack',
    source: 'mcp.slack.com/mcp (listed in the MCP connector registry)',
    verified: '2026-11-14',
    secretLabel: 'Your own Slack app credentials',
    secretHelp: 'A workspace admin has to approve a Slack Marketplace or internal app first. Take the Client ID and Client Secret from that app\'s Basic Information page, and register ' + mcpRedirectUri(33104) + ' as a redirect URL. Whether Slack accepts a plain-http loopback address there has not been tested.'
  }
];

/** Look up a catalog entry by id. */
export function mcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

/** Whether an id is a known safe-readonly server (the only tier a hire manifest may
 *  request without surfacing for human consent). */
export function isSafeReadonlyMcp(id: string): boolean {
  return mcpCatalogEntry(id)?.tier === 'safe-readonly';
}

/** The env var names an entry needs, or [] for one that takes no credential. */
export function mcpSecretEnvNames(e: McpCatalogEntry): string[] {
  if (e.spec.transport === 'http') return [];
  // A bridged server takes its OAuth client from a private file, never the environment.
  if (e.spec.transport === 'bridge') return [];
  return e.spec.secretEnv ?? [];
}

/** The pinned package a local server runs from, or undefined for a hosted one. */
export function mcpPackageOf(e: McpCatalogEntry): McpPackage | undefined {
  return e.spec.transport === 'http' || e.spec.transport === 'bridge' ? undefined : e.spec.package;
}

/** Every package the app installs and runs on the user's behalf, with the folder of its lock
 *  under `resources/mcp-locks/`: one per local server, plus the `mcp-remote` bridge. */
export function mcpPinnedPackages(): Array<{ lockId: string; pkg: McpPackage }> {
  const out: Array<{ lockId: string; pkg: McpPackage }> = [];
  for (const e of MCP_CATALOG) {
    const pkg = mcpPackageOf(e);
    if (pkg) out.push({ lockId: e.id, pkg });
  }
  out.push({ lockId: 'mcp-remote', pkg: MCP_REMOTE_PACKAGE_SPEC });
  return out;
}

/** Whether an entry cannot start without a stored credential. */
export function mcpNeedsSecret(e: McpCatalogEntry): boolean {
  if (e.spec.transport === 'http') return !!e.spec.secretHeader;
  if (e.spec.transport === 'bridge') return true;
  return (e.spec.secretEnv?.length ?? 0) > 0;
}

/** Whether an entry needs a client id AND secret rather than a single token. */
export function mcpNeedsOauthClient(e: McpCatalogEntry): boolean {
  return e.spec.transport === 'bridge';
}

/** The secret-store refs an entry reads. One token for a secret-tier server;
 *  the two halves of an OAuth client for a bridged one. Keeping this in one
 *  place stops the writer and the reader drifting onto different keys. */
export function mcpSecretRefs(e: McpCatalogEntry): string[] {
  return mcpNeedsOauthClient(e)
    ? MCP_SECRET_FIELDS.map((f) => `mcp:${e.id}:${f}`)
    : [`mcp:${e.id}`];
}

/** Seed for `DEFAULTS.mcpDefaults` — derived from the catalog so the two never
 *  drift. Every value is `{ enabled: false }`: nothing is on until the user says so. */
export function defaultMcpDefaults(): Record<string, { enabled: boolean }> {
  const out: Record<string, { enabled: boolean }> = {};
  for (const e of MCP_CATALOG) out[e.id] = { enabled: e.defaultEnabled };
  return out;
}
