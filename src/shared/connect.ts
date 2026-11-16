/**
 * How a hosted MCP server is connected WITHOUT the user pasting a key or registering an OAuth app first.
 * Pure data and pure functions (no Electron, no network), shared by the catalogue, the main process
 * and the Settings page.
 *
 * Three ways, tried in the order a server lists them:
 *
 *   dcr     The app registers a PUBLIC client for itself at the provider (RFC 7591), signs the user in with
 *           PKCE on a loopback address, and keeps no secret at all. Endpoints are discovered (RFC 9728 and
 *           8414) from the provider's own pinned hosts, and every discovered address must be on one.
 *   device  The device authorization grant (RFC 8628): the user types a short code at the provider's page.
 *           Needs an app the provider has registered (its client id is a public value, no secret).
 *   public  Authorization code + PKCE with a client the provider registered (a Desktop client): a public
 *           client id, and a secret only if the provider insists on one.
 *
 * Nothing here is a credential. A client id is public; a token never appears in this file.
 */

export interface ConnectDcr { kind: 'dcr' }

export interface ConnectDevice {
  kind: 'device';
  deviceEndpoint: string;
  tokenEndpoint: string;
  /** Space-separated scopes the device request asks for. */
  scope?: string;
  /** A public client id the project registered. Absent until someone registers an app: the user may then
   *  supply their own (still a public value), and the method is not offered without one. */
  clientId?: string;
}

export interface ConnectPublic {
  kind: 'public';
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  scope: string;
  authorizeParams?: Readonly<Record<string, string>>;
  /** A public client id the project registered; otherwise the user's own. */
  clientId?: string;
  /** Some providers only accept a registered redirect (a Web client): the loopback port to use. */
  redirectPort?: number;
}

export type ConnectMethod = ConnectDcr | ConnectDevice | ConnectPublic;

export interface ConnectSpec {
  /** Every host a sign-in for this server may talk to, matched exactly. A discovered endpoint anywhere else
   *  is refused before anything is sent to it. */
  hosts: readonly string[];
  methods: readonly ConnectMethod[];
  /** For a server that publishes no resource metadata (Atlassian): the authorization server to use. */
  authorizationServer?: string;
  /** What to ask for. A server that decides its own scopes leaves this out. */
  scopes?: { read?: string; write?: string };
}

/** Why a connection did not complete. Fixed codes, never a provider's text. */
export type ConnectError =
  | 'not-available'        // the server has no way to connect this way
  | 'needs-client-id'      // the method needs an app's client id and none was given
  | 'bad-client-id'        // the client id given is not shaped like one
  | 'in-progress'          // a sign-in for this server is already waiting
  | 'port-busy'
  | 'discovery-failed'     // the provider's metadata could not be read, or points somewhere unpinned
  | 'registration-failed'  // the provider would not register a client
  | 'denied'               // the user (or the provider) refused
  | 'cancelled'
  | 'timeout'
  | 'expired'              // a device code ran out
  | 'device-flow-disabled' // the app has not switched the device flow on
  | 'provider-error'
  | 'invalid-callback'     // the redirect was not the one we were waiting for
  | 'exchange-failed'      // the provider refused the code
  | 'bad-token-response'
  | 'not-stored'           // signed in, but the encrypted store refused the tokens
  | 'unavailable'          // the provider or the secret store could not be reached
  | 'no-browser'
  | 'failed';

/** Secret-store ref for the facts of a connection that are not tokens: which client, which endpoints.
 *  Holds a client secret only for a provider that insisted on one, so it is sealed like a token. */
export function connectRef(id: string): string { return `mcp:${id}:conn`; }

export const CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,200}$/;

/** A client id as the user may paste it: public, never a secret. */
export function isPlausibleClientId(v: unknown): v is string {
  return typeof v === 'string' && CLIENT_ID_RE.test(v);
}

/** Which scope string a connection asks for: the tier the user chose, else the provider's default. */
export function scopeFor(spec: ConnectSpec, tier: 'read' | 'write'): string | undefined {
  return spec.scopes?.[tier] ?? spec.scopes?.write ?? spec.scopes?.read;
}

/** What the Settings page shows about one connect method. */
export interface ConnectMethodView {
  kind: ConnectMethod['kind'];
  /** Whether it can be used right now. False when it needs an app's client id nobody has supplied. */
  available: boolean;
  needs?: 'client-id';
}

/** One server's connection, as the page may see it: facts and statuses, never a token or a secret. */
export interface ConnectionSummary {
  id: string;
  status: 'unconfigured' | 'signed-out' | 'connected' | 'needs-signin' | 'unavailable';
  method?: ConnectMethod['kind'];
  connectedAt?: number;
  scope?: string;
  /** When the access token in hand stops working (it is renewed by itself; this is for information). */
  expiresAt?: number;
  hasRefresh?: boolean;
  /** Whether Disconnect can tell the provider to forget the sign-in; if not the user must do it at the provider. */
  canRevoke?: boolean;
  /** A short label for whose account this is, when the provider says. */
  account?: string;
  pending?: { kind: 'browser' } | { kind: 'device'; userCode: string; verificationUri: string; expiresAt: number };
  lastError?: ConnectError;
  methods: ConnectMethodView[];
}
