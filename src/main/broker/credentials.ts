/**
 * Where a route gets the credential it injects upstream.
 *
 * A route never touches a secret store or a token cache directly: it asks a
 * CredentialProvider for the headers to add. Today there is one implementation,
 * `StaticSecretProvider` (the REST integrations' stored secrets). A refreshing
 * OAuth provider plugs in here later without any route changing.
 *
 * Contract: a provider returns headers or a typed failure. It never throws a
 * message that could contain secret material, and a route never logs or echoes
 * what it gets back.
 */
import {
  type IntegrationRecord,
  authTypeNeedsSecret,
  buildAuthHeaders
} from '../../shared/integrations';

export type CredentialFailure = 'no_secret' | 'sign_in_required' | 'unavailable';

export type CredentialResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; code: CredentialFailure };

export interface CredentialProvider<S> {
  accessHeaders(subject: S): CredentialResult | Promise<CredentialResult>;
  /**
   * Optional. The upstream answered 401 to a request that carried `used` (the
   * headers `accessHeaders` returned). A provider that can get a newer credential
   * marks the old one rejected, so the next `accessHeaders` call returns a fresh
   * one and the route may replay the request once. Providers of fixed secrets leave
   * it out, and the route then passes the upstream's answer through unchanged.
   */
  rejected?(subject: S, used: Record<string, string>): void;
}

/** The REST integrations' stored secrets, injected the way `buildAuthHeaders` says. */
export class StaticSecretProvider implements CredentialProvider<IntegrationRecord> {
  constructor(private readonly getSecret: (secretRef: string | undefined) => string | undefined) {}

  accessHeaders(rec: IntegrationRecord): CredentialResult {
    let secret: string | undefined;
    if (authTypeNeedsSecret(rec.authType)) {
      secret = this.getSecret(rec.secretRef);
      if (!secret) return { ok: false, code: 'no_secret' };
    }
    return { ok: true, headers: buildAuthHeaders(rec.authType, rec.authHeader, secret) };
  }
}
