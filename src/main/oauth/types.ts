/**
 * Shared types for the in-app OAuth engine (src/main/oauth/).
 */

/** The fixed codes a sign-in can fail with. Never free text from a provider or an
 *  exception: those can carry URLs, codes or tokens. The Settings panel already
 *  knows `in-progress`, `port-busy`, `timeout`, `not-stored` and `no-client`; the
 *  rest show its generic "did not complete" message. */
export type SignInError =
  | 'no-client'         // the OAuth client id/secret are not stored
  | 'port-busy'         // something else holds the loopback callback port
  | 'in-progress'       // a sign-in for this integration is already waiting
  | 'timeout'           // the user never finished in the browser
  | 'denied'            // the user (or the provider) refused
  | 'cancelled'         // Disconnect, quit, or another call cancelled it
  | 'provider-error'    // the provider's authorization page reported an error
  | 'invalid-callback'  // the redirect was not the one we were waiting for
  | 'exchange-failed'   // the provider refused the code
  | 'bad-token-response'// the provider answered with something unusable
  | 'not-stored'        // signed in, but the encrypted store refused the tokens
  | 'unavailable'       // the provider or the secret store could not be reached
  | 'no-browser'        // the system browser could not be opened
  | 'failed';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent when the provider gave no lifetime (the token is used until it is refused). */
  expiresAt?: number;
  /** The scopes the provider says it granted (may be fewer than were asked for). */
  scope?: string;
}

/** An OAuth client. A PUBLIC client (one the app registered for itself, or a device-flow or Desktop client)
 *  has no secret, and then nothing ever sends one. */
export interface OAuthClient { clientId: string; clientSecret?: string }

/**
 * What the engine may log. Every field is a code, a count, a flag or a short
 * identifier — never a token, a code, a state, a verifier, a client secret, a
 * URL with a query or any text a provider sent. `safeLog` enforces the shape.
 */
export interface OAuthLogEvent {
  event: string;
  id?: string;
  [field: string]: string | number | boolean | undefined;
}
export type OAuthLogger = (event: OAuthLogEvent) => void;

/** A field name, and the only kind of text a log value may be: a short, lower-case
 *  code (an event, an error code, an integration id, a reason). A mixed-case or long
 *  string — which is what a token, a code, a state or a verifier looks like — is dropped. */
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const SAFE_VALUE = /^[a-z0-9][a-z0-9_.:-]{0,39}$/;

/**
 * Wrap a logger so it can only ever be handed codes, numbers and flags.
 *
 * This is a BACKSTOP, not the control: no call site passes a secret to begin with
 * (test/oauth-security.test.cjs runs every code path with sentinel secrets and scans
 * every line). What this adds is that a mistake cannot become a leak — a value that is
 * not a short lower-case code is replaced, not passed on.
 */
export function safeLog(sink: (line: string) => void): OAuthLogger {
  return (e) => {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(e)) {
      if (v === undefined || !SAFE_KEY.test(k)) continue;
      if (typeof v === 'string') out[k] = SAFE_VALUE.test(v) ? v : '[redacted]';
      else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : 0;
      else if (typeof v === 'boolean') out[k] = v;
    }
    sink(JSON.stringify(out));
  };
}
