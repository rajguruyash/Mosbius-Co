/**
 * Which addresses a connection may talk to. The catalogue pins HOSTS (not paths): a provider's
 * discovery documents name the rest, and every address they name must be on a pinned host, over https,
 * with no credentials in it. A document that points the token endpoint anywhere else is refused before
 * a single byte (a code, a verifier, a refresh token) is sent there.
 */
import { checkEndpoint, type EndpointPolicy } from '../oauth/endpoints';

export class ConnectRefused extends Error {
  constructor(public readonly what: string) { super(`refused: ${what}`); this.name = 'ConnectRefused'; }
}

export interface HostPolicy {
  /** The parsed address, or a throw of ConnectRefused. */
  check(url: string, what: string): URL;
}

export function makeHostPolicy(hosts: readonly string[], endpointPolicy: EndpointPolicy): HostPolicy {
  return {
    check(url: string, what: string): URL {
      let u: URL;
      try { u = checkEndpoint(url, endpointPolicy, what); } catch { throw new ConnectRefused(what); }
      if (!hosts.includes(u.host) && !hosts.includes(u.hostname)) throw new ConnectRefused(what);
      return u;
    }
  };
}
