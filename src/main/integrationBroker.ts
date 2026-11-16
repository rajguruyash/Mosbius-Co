/**
 * Loopback secret broker (main process): the facade `index.ts` talks to.
 *
 * A 127.0.0.1-only HTTP proxy. An ephemeral worker calls
 *   <METHOD> http://127.0.0.1:<port>/i/<integrationId>/<path...>
 * authenticating with a PER-WORKER CAPABILITY TOKEN (a handle, NOT any secret) in the
 * `Authorization: Bearer` / `X-MD-Broker-Token` header. The broker validates the token,
 * authorizes the integration, decrypts the integration's real secret, injects it as the
 * upstream auth header, forwards to the integration's baseUrl, and streams the response
 * back. The worker uses the integration WITHOUT EVER SEEING the credential.
 *
 * This file used to hold the whole implementation. It is now a thin composition of
 * the shared broker in `./broker/`:
 *
 *   CapabilityRegistry  who may call, on which channel, for which integrations
 *   BrokerCore          the loopback server, authentication, revocation, containment
 *   RestRoute           `/i/<id>/…` (the original forwarding logic)
 *   McpRoute            `/m/<id>`   (registered ONLY when the caller supplies
 *                       `extras.mcp`; the app does, and the route answers 404 for
 *                       every integration whose engine is not `broker`)
 *
 * The REST API is unchanged: start, stop, running, url, grant, revoke. The MCP
 * channel adds grantMcp, revokeMcp, revokeIntegration and the tool listing the
 * Settings panel reads.
 *
 * DEPENDENCY-FREE of electron by design: `getRecord` + `getSecret` are injected, so this
 * module is unit-testable under plain node. The secret is materialized ONLY at
 * forward-time, and is NEVER logged, NEVER returned to the worker, NEVER echoed in an
 * error.
 *
 * Contract: hive/docs/integrations-spec.md. Design: MCP_BROKER_DESIGN.md.
 */
import type { IntegrationRecord } from '../shared/integrations';
import { CapabilityRegistry } from './broker/capabilities';
import { BrokerCore, type BrokerRoute } from './broker/core';
import { StaticSecretProvider } from './broker/credentials';
import { McpRoute, type DiscoverResult, type McpRouteDeps, type McpToolView } from './broker/mcp-route';
import { RestRoute, type RestRouteDeps } from './broker/rest-route';

export interface IntegrationBrokerDeps {
  /** Resolve an integration record by id (injected — the registry). */
  getRecord: (id: string) => IntegrationRecord | undefined;
  /** Decrypt a secret by ref (injected — the secret store). Main-internal. */
  getSecret: (secretRef: string | undefined) => string | undefined;
}

export interface IntegrationBrokerExtras {
  /** Registers the MCP route. Without it `/m/…` does not exist. */
  mcp?: McpRouteDeps;
  /**
   * Per-agent, per-request grants for the REST route (Stage B). The app always supplies them: a
   * worker then reaches an integration only through a grant that covers the method and path of
   * each request, re-read on every call. Without them the route keeps its original
   * capability-only behaviour, which exists so that behaviour stays testable on its own.
   */
  rest?: Pick<RestRouteDeps, 'grants' | 'audit' | 'now'>;
}

export class IntegrationBroker {
  private readonly registry = new CapabilityRegistry();
  private readonly core: BrokerCore;
  private readonly mcpRoute: McpRoute | undefined;

  constructor(deps: IntegrationBrokerDeps, extras: IntegrationBrokerExtras = {}) {
    const rest = new RestRoute({
      getRecord: deps.getRecord,
      credentials: new StaticSecretProvider(deps.getSecret),
      ...(extras.rest ?? {})
    });
    const routes: BrokerRoute[] = [rest];
    if (extras.mcp) {
      this.mcpRoute = new McpRoute(extras.mcp, this.registry);
      routes.push(this.mcpRoute);
    }
    this.core = new BrokerCore({
      registry: this.registry,
      routes,
      notFoundMessage: 'expected /i/<integrationId>/<path>'
    });
  }

  /** Bind a loopback port (0 ⇒ OS-assigned). Resolves the bound port. */
  start(preferredPort = 0): Promise<{ ok: boolean; port?: number; error?: string }> {
    return this.core.start(preferredPort);
  }

  /** Close the broker. Idempotent and best-effort. Revokes every capability and
   *  cuts every request still running. */
  stop(): void {
    this.core.stop();
    this.registry.clear();
  }

  /** Whether the broker is bound and serving. */
  running(): boolean { return this.core.running(); }

  /** The base URL workers use (only valid while running). */
  url(): string { return this.core.url(); }

  /** Mint a per-worker capability token granting access to `allowedIds` over the
   *  REST channel. Any prior REST token for this worker is revoked first. The token
   *  is a random handle — never a secret, never persisted. */
  grant(workerId: string, allowedIds: string[]): string {
    return this.registry.grant(workerId, 'rest', allowedIds);
  }

  /** Revoke everything a worker holds (called on teardown). Takes effect on the very
   *  next request and cuts any request it is running. Idempotent. */
  revoke(workerId: string): void {
    this.registry.revokeAgent(workerId);
  }

  /** Mint an MCP-channel capability for an agent. Valid only on `/m/<id>`, never on
   *  `/i/…`, and worthless unless the MCP route is registered AND the agent has a
   *  grant (permissions.ts). Any earlier MCP capability for this agent dies first. */
  grantMcp(agentId: string, allowedIds: string[]): string {
    return this.registry.grant(agentId, 'mcp', allowedIds);
  }

  /** Revoke only the agent's MCP capability (its REST one, if any, is left alone).
   *  Takes effect on the next request and cuts the ones running. Idempotent. */
  revokeMcp(agentId: string): boolean {
    return this.registry.revokeChannel(agentId, 'mcp');
  }

  /** Whether an agent currently holds an MCP capability. */
  hasMcp(agentId: string): boolean {
    return this.registry.has(agentId, 'mcp');
  }

  /** The tools an MCP integration is known to offer (names, classes, descriptions). */
  mcpTools(integrationId: string): McpToolView[] {
    return this.mcpRoute?.toolsOf(integrationId) ?? [];
  }

  /** Ask the integration's server for its tool list (as the broker, not as an agent). */
  discoverMcpTools(integrationId: string): Promise<DiscoverResult> {
    return this.mcpRoute ? this.mcpRoute.discover(integrationId) : Promise.resolve({ ok: false, code: 'unknown' });
  }

  /** Forget what was learnt about an integration's tools (it was disconnected). */
  forgetMcpTools(integrationId: string): void {
    this.mcpRoute?.forgetTools(integrationId);
  }

  /** Take one integration away from every agent at once (disconnect, disable). Any
   *  request running against it is cut off. Returns how many capabilities lost it. */
  revokeIntegration(integrationId: string): number {
    return this.registry.revokeIntegration(integrationId);
  }
}
