# In-app MCP/OAuth broker: technical design

**Status (2026-11-15, left as written apart from the word "uncommitted", which is no longer true; the current state of every phase and stage is tracked in [MOSBIUS_PLATFORM_ROADMAP.md](MOSBIUS_PLATFORM_ROADMAP.md)): Phases 0, 1, 2 and 3 are implemented. Phase 4 (the live gate) is STARTED and NOT complete: everything that needs no account has been run against the real endpoints, and nothing has been run with a real account. Phase 5 is NOT started and needs your approval.** The `mcp-remote` bridge is untouched, is still the default, and is still what every integration uses until you switch it. The in-app engine is OFF for every integration; with the switch turned on (Settings, or `mcpEngine` in the config file) an agent can now reach Gmail, Calendar, Drive or Slack through the broker, but only if that integration is switched on, signed in, and granted to that agent, and only the tools you name. **None of it has ever been run against Google or Slack**, and nothing was tried on Windows. See sections 12.1 (Phases 0 and 1), 12.2 (follow-ups, Windows), 12.3 (Phase 2), 12.4 (Phase 3) and 12.5 (Phase 4).

Written 2026-11-14 against a local working tree (HEAD `6c73976` plus the uncommitted work of that day; 1028 tests, 1027 passing, 1 platform skip).

Everything in section 2 was read from the code or measured. Everything about Google's and Slack's servers that I could not check without a real account is collected in section 13 and marked *unverified* where it appears.

---

## 0. Summary and the decisions I need from you

**The proposal in six lines**

1. OAuth runs inside the Electron main process. PKCE, state, callback validation, token exchange, refresh, expiry and revocation become our code, in small electron-free modules with **no new runtime dependency**.
2. Access and refresh tokens exist only in main-process memory and sealed in the OS-encrypted store (`safeStorage`). They are never written to a plain file, an environment variable, an argument list or an MCP config. `mcp-remote`, its `npx` download, its child process and the runtime token folder all go away.
3. Agents talk to a loopback **broker** in the main process using a per-agent **capability token**: a revocable handle, not an OAuth credential. The broker holds the real bearer and injects it upstream.
4. The broker enforces permissions on every JSON-RPC message: per agent, per integration, per tool. The default for every integration is *nobody*. Destructive tools (send, post, delete) can only be granted by naming them, never by a preset.
5. The REST broker and the MCP broker should be **one server, one capability registry, one grant model**, with two route handlers and two credential providers. Two competing loopback servers would double the attack surface and the revocation paths. Share infrastructure, not schema.
6. Migration is a dark launch: a per-integration engine switch (`bridge` or `broker`, default `bridge`), token import so nobody signs in twice, and the bridge stays until all four integrations have passed a real-account check.

**Decisions (my recommendation first)**

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | One shared broker or two separate ones | **One** (section 4) | One revocation path, one registry, one set of guards. The REST broker needs characterization tests first (it has none today). |
| D2 | Default access for a newly connected integration | **Nobody** until you grant it; presets are *read* and *read + write*; destructive tools only by name | Matches audit finding 5. Costs one extra click per integration. |
| D3 | How an agent presents its capability | **`Authorization` header in its 0600, git-ignored `mcp-config.json`**, deleted at teardown | It is the channel the catalogue already uses for HTTP MCP servers, and every alternative I looked at is worse (section 6.2). Residual exposure is stated there. |
| D4 | Bind a capability to the agent's process tree (peer-PID check) | **Defer** to a hardening phase; leave the hook in the design | Strong against stolen capabilities, but needs `lsof`/`/proc` plumbing per platform. |
| D5 | Keep `mcp-remote` as a fallback | **Yes, until all four pass a real-account check**, then delete | Rollback is a switch, not a revert. |
| D6 | Scope of v1 | **Claude Code agents only**, as today | Codex and Gemini do not receive the MCP bundle at all right now. |
| D7 | Activity log | **In-memory ring buffer, metadata only**, shown in Settings | Lets you see what an agent used. No bodies, no tokens. |
| D8 | (information) Google apps in *Testing* status | Refresh tokens expire after **7 days** | You would need to sign in weekly unless the OAuth app is published. Section 5.7. |

---

## 1. Requirements and where each is met

| # | Requirement | Met by |
|---|---|---|
| R1 | Tokens stay in main and the OS-encrypted vault | 5.5, 6.2: `TokenStore` (sealed) plus an in-memory cache; no runtime folder |
| R2 | Nothing secret in agent processes, env, argv or MCP config | 3.2, 6.2: the config carries only a broker URL and a capability handle; OAuth tokens and the client secret never leave main |
| R3 | Authenticated local broker with per-worker capability tokens | 6.1, 4: shared `BrokerCore` and `CapabilityRegistry` |
| R4 | Individual permissions for Gmail, Calendar, Drive, Slack tools | 6.3 to 6.5, 7.3: grant model, tool classes, per-message evaluation |
| R5 | Worker isolation | 6.6: five layers, with the honest limit of each |
| R6 | OAuth state, PKCE, callback validation, refresh, expiry, revocation in the app | 5.1 to 5.8 |
| R7 | Multiple simultaneous agent sessions | 6.7, 7.4: per-agent sessions, single-flight refresh, caps |
| R8 | Preserve the MCP catalogue and Settings UI | 10.4: same entries, same fields; one new "Access" section |
| R9 | Migration path from `mcp-remote` | 12 |
| R10 | Shutdown, crash, termination and revocation safety | 9 |

---

## 2. Starting point (verified in the tree)

### 2.1 The bridge today

- Agent (Claude Code) runs `npx mcp-remote@0.16.6 <url> <port> ...` as a stdio MCP server; `mcp-remote` talks to Google or Slack.
- `src/main/mcpAuthVault.ts` (328 lines): while an agent uses a server, the user's OAuth client (`client.json`) and `mcp-remote`'s token files sit in a private `0700` folder under `<userData>/mcp-auth/<id>`. When the last agent ends, at quit and at the next start, tokens are sealed back into the encrypted store (`mcp:<id>:tokens`) and the folder is removed.
- Sign-in is an app-managed child process with a 5-minute timeout (`mcp:signIn` in `src/main/index.ts`). Disconnect revokes at the provider where documented, then wipes tokens, client and folder.
- Wiring points: `mcpVault.checkout` inside `hive.ensureAgent` options (`mcpBridge`), `mcpVault.release` in `teardownPty`, `mcpVault.sweep` at start and quit, `denyReadPaths` for the sandbox.
- What it cannot do: keep tokens out of plaintext files while an agent uses the server; restrict an agent to some tools; validate OAuth `state` (it relies on PKCE); keep third-party code out of the credential path.

### 2.2 The REST broker today

`src/main/integrationBroker.ts` (311 lines):

- Plain `http` server on `127.0.0.1` only, ephemeral port, started at app ready.
- `grant(workerId, allowedIds)` mints a random 256-bit token held in memory; `revoke(workerId)` deletes it; `teardownPty` calls `revoke`, quit/reset/changeHome call `stop()`.
- Route `/i/<integrationId>/<path>`: checks loopback peer, resolves the token, checks the integration is in the worker's `allowedIds` and enabled, confines the upstream URL to the record's `baseUrl`, decrypts the secret, strips `authorization`/`cookie`/`host`, injects the auth header, forwards with `redirect: 'manual'`, streams the response back. Body cap 10 MB.
- Granularity is **integration-level only**. No per-method, per-path or per-tool control.
- Delivered to **ephemeral workers only**, through the environment: `MD_BROKER_URL` and `MD_BROKER_TOKEN` set in `processSpawnRequest`. Hired (GUI) agents get nothing.
- One 30-second timer covers the *whole* forward including the streamed body, so it would cut a long-lived SSE stream.
- No `Host` or `Origin` check (loopback peer only).
- **No test file references it.** It is untested.

### 2.3 Registry and catalogue

- `config.integrations: IntegrationRecord[]` (kind `github | custom-rest`; auth `none | bearer | header | github`; `secretRef`; `enabled`). Secrets live in `integration-secrets.json`, sealed with `safeStorage`.
- `MCP_CATALOG` plus `config.mcpDefaults[id].enabled` (a global on/off). `McpDefaultsSettings.tsx` is its UI. `hive.ts` writes `agents/<id>/mcp-config.json` for every Claude agent: git-ignored, mine-ignored, `denyRead` for the agent itself.
- The four OAuth entries (`gmail`, `google-calendar`, `google-drive`, `slack`) have fixed redirect URIs `http://127.0.0.1:33101..33104/oauth/callback`.

### 2.4 Gaps in today's code that the broker would lean on

| Gap | Why it matters here | Handling |
|---|---|---|
| `writeSecretBlob` is a plain `writeFileSync` (truncate and write) and `readSecretBlob` turns a parse error into `{}` | Token rotation would write the store *at runtime*; a torn write or a silent reset would lose every secret | Phase 0: atomic write (temp, fsync, rename), keep a `.bak`, never silently reset |
| REST broker has no tests | A shared-core refactor cannot be proven behaviour-preserving | Phase 0: characterization tests written against today's code first |
| REST capability travels in the environment | `ps eww` and child shells can read it | Keep for REST as-is (separate token, section 4.3); MCP capability does not use the environment |
| REST broker's total timeout | Would kill MCP SSE streams | MCP route gets its own idle and absolute timeouts |

---

## 3. Architecture

### 3.1 Diagram

```
                       ┌───────────────────────── Electron MAIN process ──────────────────────────┐
 ┌─────────────┐       │                                                                          │
 │ Agent A     │──┐    │  ┌─────────────── BrokerCore  127.0.0.1:<port> ─────────────────────┐    │
 │ (Claude CLI)│  │    │  │ guards: loopback · Host · Origin · size · rate · concurrency      │    │
 └─────────────┘  │    │  │ CapabilityRegistry   agent ↔ {restToken, mcpToken}  (memory only) │    │
 ┌─────────────┐  │    │  │ GrantStore ──► PermissionEngine   agent × integration × tool      │    │
 │ Agent B     │──┼───▶│  │ ┌─────────────────┐   ┌───────────────────────────────────────┐   │    │
 └─────────────┘  │ MCP│  │ │ RestRoute       │   │ McpRoute   JSON-RPC aware, SSE-safe   │   │    │
 ┌─────────────┐  │ over│ │ │ /i/<id>/…       │   │ /m/<id>    ToolIndex · session binding│   │    │
 │ Worker C    │──┘HTTP │  │ └───────┬─────────┘   └───────────────┬───────────────────────┘   │    │
 └─────────────┘  capability  │      │                             │                           │    │
   handle only    token  │  └───────┼─────────────────────────────┼───────────────────────────┘    │
                         │          ▼                             ▼                                │
                         │  ┌───────────────┐          ┌───────────────────┐   refresh           │
                         │  │ StaticSecret  │          │ OAuthTokenProvider│◄── single-flight    │
                         │  │ Provider      │          │ (cache + refresh) │                      │
                         │  └──────┬────────┘          └─────────┬─────────┘                      │
                         │         ▼                             ▼                                │
                         │  ┌───────────────────────────────────────────────────────────────┐    │
                         │  │ Secret store: safeStorage-sealed integration-secrets.json     │    │
                         │  │   int:<id> · mcp:<id>:client_id/_secret · mcp:<id>:oauth      │    │
                         │  └───────────────────────────────────────────────────────────────┘    │
                         │                                                                          │
                         │  ┌──────────── OAuthFlowManager (sign-in only) ────────────┐             │
                         │  │ discovery · PKCE · state · callback listener            │◄─ 127.0.0.1:3310x
                         │  └───────────────────────────┬──────────────────────────────┘  (open only
                         └──────────────────────────────┼─────────────────────────────── while signing in)
                                                        │ shell.openExternal(https authorize URL)
                        ┌───────────────────────────────▼───┐        HTTPS, bearer injected in main
                        │ System browser → Google / Slack   │        ┌─────────────────────────────┐
                        └───────────────────────────────────┘        │ gmailmcp.googleapis.com …   │
                                                                      │ mcp.slack.com · REST APIs   │
 Renderer (Settings) ◄──IPC──► main: status, sign-in, disconnect,     └─────────────────────────────┘
 grants, tool list, activity. Secrets are write-only over IPC; tokens never cross it.
```

### 3.2 What changes for the agent

`agents/<id>/mcp-config.json` for a connected, granted integration becomes:

```json
{ "mcpServers": { "mosbius-gmail": {
    "type": "http",
    "url": "http://127.0.0.1:<port>/m/gmail",
    "headers": { "Authorization": "Bearer <per-agent capability>" } } } }
```

No OAuth token, no client id, no client secret, no `npx`, no environment variable. The `http` + `headers` shape is the one the catalogue already uses for secret-tier servers, so Claude Code is already known to load it.

### 3.3 Path of one tool call

1. Claude Code POSTs JSON-RPC to `http://127.0.0.1:<port>/m/gmail` with its capability.
2. `BrokerCore` guards: loopback peer, `Host` must be `127.0.0.1:<port>`, any `Origin` header is rejected, body ≤ cap, rate and concurrency caps.
3. `CapabilityRegistry` resolves the token (SHA-256 lookup, constant-time compare) to an agent and checks the token is the `mcp` kind.
4. `McpRoute` parses the JSON-RPC message(s). `PermissionEngine` evaluates each against `agent × integration × tool` using the **current** grants.
5. Allowed: `OAuthTokenProvider.accessToken('gmail')` returns a cached token or refreshes it (single-flight).
6. The request goes to the fixed upstream URL from the catalogue with the injected bearer and an allow-listed header set; on upstream 401 it refreshes once and retries once.
7. The response streams back (SSE passes through; `tools/list` is buffered and filtered). Response headers are allow-listed.
8. An audit record (agent, integration, method, tool, allowed or denied, status, duration) goes to the in-memory ring.

### 3.4 Trust boundaries

| Zone | Trusted with | Not trusted with |
|---|---|---|
| Main process | Tokens, client secret, grants, capability registry | Nothing else runs here |
| Renderer | Showing status; sending write-only secrets and grant edits | Reading any secret. Privileged IPC validates the sender frame |
| Agent process (CLI and its shell) | Its own capability, its own tool results | OAuth tokens, other agents' capabilities, other integrations |
| System browser | The user's consent page | The callback listener only accepts a validated, single-use `state` |
| Google / Slack | Issuing tokens, serving tools | Not trusted for `Location` redirects, discovery hosts outside an allowlist, or tool annotations (see 6.4) |
| Other local processes (same user) | Nothing | Can read 0600 files as the user. Section 8 states what that means |

---

## 4. One broker or two

### 4.1 Comparison

| Concern | REST broker today | MCP broker needs | Shared? |
|---|---|---|---|
| Loopback server, ephemeral port | yes | yes | **Shared** |
| Capability registry, grant, revoke at teardown, stop at quit | yes | yes | **Shared** |
| Request guards, body cap, header stripping, error shape | yes | yes (stricter: Host, Origin) | **Shared** (guards become a common function) |
| Upstream URL confinement | by path under `baseUrl` | single fixed URL | Route-specific |
| Credential | static secret | refreshable OAuth token | **Provider interface**, two implementations |
| Body semantics | opaque bytes | JSON-RPC, SSE, sessions, tool filtering | Route-specific |
| Timeouts | 30 s total | idle plus absolute stream caps | Route-specific |
| Permission granularity | integration | integration, tool | Engine supports both: REST grants have no tool dimension |

### 4.2 Recommendation

One `BrokerCore` hosting two routes:

- `/i/<id>/…` stays byte-compatible. Its handler moves into `RestRoute` unchanged.
- `/m/<id>` is the new `McpRoute`.
- `CredentialProvider { accessHeaders(id): Promise<Record<string,string>> }` with `StaticSecretProvider` (wraps today's `buildAuthHeaders`) and `OAuthTokenProvider`.

`src/main/integrationBroker.ts` stays as a thin facade exporting the same `IntegrationBroker` class with the same `grant`, `revoke`, `start`, `stop`, `running`, `url`, so `index.ts` call sites and any future test of them do not change in the first phase.

**Share infrastructure, not schema.** MCP entries stay in `MCP_CATALOG` and `config.mcpDefaults`; REST records stay in `config.integrations`. A small `IntegrationResolver` returns `{kind:'rest', record}` or `{kind:'mcp', entry}` for an id. No config migration is needed and both Settings screens stay as they are.

### 4.3 One registry, two tokens

An agent gets **two** capability tokens, one per channel (`restToken`, `mcpToken`). Each is valid only on its own route family. The REST token keeps travelling in the environment for ephemeral workers (as today); the MCP token only ever goes into the agent's config file. Sharing one token would let the weaker channel (environment) compromise the stronger one.

### 4.4 Safety net first

Before touching the REST code, Phase 0 writes characterization tests against it as it is now (auth failures, id not granted, disabled integration, path escape attempts, header stripping, injected-auth-wins, body cap, redirect not followed, revoke and stop). The refactor must keep them green unchanged.

---

## 5. OAuth lifecycle

### 5.1 States per integration

```
 not-configured ──save client id+secret──► configured ──Sign in──► signing-in ──ok──► connected
        ▲                                      ▲                       │fail/timeout     │
        │                                      │◄──────────────────────┘                 │ refresh invalid_grant,
        └──── Forget client ◄──── Disconnect ◄─┼──────────── revoking ◄── Disconnect ◄───┤ client rotated,
                                               └──────── needs-signin ◄──────────────────┘ token revoked upstream
```

Status is exposed through the existing `mcp:secretStatus` handler (extended) and pushed to the renderer on change.

### 5.2 Sign-in sequence

1. **Preconditions**: encryption is real (`encryptionIsReal()`), both client halves are stored, no other sign-in for this id is pending. Starting a second sign-in cancels the first.
2. **Endpoints** are resolved in this order: (a) endpoints declared in the catalogue entry (documented provider endpoints), (b) RFC 9728 / RFC 8414 discovery from the MCP server URL, accepted only if every discovered URL is `https` on an allow-listed host for that entry, (c) otherwise fail closed. Discovery is a fallback, never a trust root.
3. **PKCE**: S256 only. Verifier is 64 random bytes, base64url, held in memory only.
4. **State**: 32 random bytes, base64url, stored with `{integrationId, verifier, redirectUri, createdAt}`. TTL 5 minutes. Single use.
5. **Listener**: an `http.Server` bound to `127.0.0.1:<callbackPort>` (strict, no fallback port) created *only now*. Port in use gives a clear error before anything opens.
6. **Authorization URL**: `response_type=code`, `client_id`, `redirect_uri` (exactly `http://127.0.0.1:<port>/oauth/callback`), `scope`, `state`, `code_challenge`, `code_challenge_method=S256`, plus provider extras: Google `access_type=offline` and `prompt=consent` (needed for a refresh token; *unverified here*, see 5.9); RFC 8707 `resource` when the server asks for it.
7. **Browser**: `shell.openExternal` of the URL, only if it is `https` on an allow-listed host. Only the host is logged, never the URL (it contains the state).
8. **Callback** (5.3), then **exchange** (5.4), then **persist** (5.5). The renderer is told `connected` only after the persist succeeded.

### 5.3 Callback validation order

Each check fails *without* aborting the pending sign-in unless stated, so a forged request cannot cancel a real one (today's `mcp-remote` aborts on any forged `error=` or bad code).

| # | Check | On failure |
|---|---|---|
| 1 | Method is `GET` | 405 |
| 2 | Path is exactly `/oauth/callback` (no trailing variants) | 404 |
| 3 | `Host` equals `127.0.0.1:<port>` (DNS-rebinding guard) | 421 |
| 4 | Each of `code`, `state`, `error`, `error_description`, `iss` appears at most once and within length caps (code ≤ 2048, state ≤ 128) | 400 |
| 5 | `state` present, matches a pending flow with `timingSafeEqual`, unexpired, unused | 400 generic page; counter++; **flow stays alive**. After 20 bad hits the flow is aborted with a "something is probing the sign-in port" notice |
| 6 | If `iss` is present it equals the expected issuer (RFC 9207) | abort flow, notice |
| 7 | If `error` is present (only reachable with a valid state) | abort flow, friendly failure page |
| 8 | `code` present | consume the state, close the listener, exchange |

Responses are static HTML with no reflected input, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, no CORS headers. The authorization code never appears in a log, an error or a response.

### 5.4 Token exchange

`POST` form to the token endpoint, HTTPS only, allow-listed host, `redirect: 'error'`, 15-second timeout: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret` (client_secret_post; Basic if the provider requires it), `code_verifier`. The response is validated against a schema: `access_token` string, `token_type` Bearer (case-insensitive), `expires_in` number or absent, optional `refresh_token`, `scope`. A missing refresh token on a provider that should send one is recorded as a warning on the status, not an error.

### 5.5 Storage

One sealed record per integration under `mcp:<id>:oauth` (new ref; the old `mcp:<id>:tokens` is untouched until phase 5):

```ts
interface OAuthTokenRecord {
  v: 1;
  accessToken: string;
  refreshToken?: string;
  tokenType: 'Bearer';
  expiresAt?: number;        // epoch ms; absent = provider says it does not expire
  scope: string;
  issuer: string;
  obtainedAt: number;
  clientFingerprint: string; // first 16 hex of sha256(client_id): detects "you changed the client"
}
```

- Written through `integrations.setSecret` (safeStorage), which this design hardens first (Phase 0: atomic write, `.bak`, no silent reset).
- Held in an in-memory cache for the process lifetime. The cache is cleared on disconnect and on quit.
- **Write-ahead**: a refreshed record is persisted *before* the new access token is used. The one unavoidable window is the milliseconds between the provider rotating a refresh token and our write finishing; a crash inside it means "sign in again", never a leak.
- Never in config.json, never in an environment variable, never in a log, never in the agent's config.

### 5.6 Refresh and expiry

- **Proactive**: `accessToken(id)` returns the cached token if `expiresAt - 120 s > now`; otherwise it refreshes.
- **Reactive**: an upstream 401 triggers exactly one forced refresh and one replay of the buffered request.
- **Single-flight** per integration: concurrent callers await the same promise, so a rotating provider never sees two uses of one refresh token.
- **Success**: persist first, then publish to the cache. If the response omits `refresh_token`, keep the old one.
- **`invalid_grant`, `invalid_client`, `unauthorized_client`**: delete the token record, keep the client, set `needs-signin`, notify the UI, answer in-flight requests with a JSON-RPC error `-32001 "Sign in to Gmail again in Settings"`.
- **Network error or 5xx**: retry 1 s, 2 s, 4 s then give up for this request with a 503-equivalent; keep the tokens.
- Clock skew is covered by the 120-second margin plus the reactive path.

### 5.7 Expiry realities worth telling the user

- A Google OAuth app whose consent screen is **External** and **Testing** issues refresh tokens that **expire after 7 days** (documented by Google). The status line should say "Signed in; Google may ask again after about a week while your app is in Testing" for Google entries. *Unverified here: needs a real account.*
- Slack user tokens do not expire unless token rotation is switched on for the app; with rotation they live about 12 hours and refresh. (From Slack's token-rotation documentation; not checked against Slack's MCP server.)

### 5.8 Revocation and disconnect

`Disconnect` runs these in order and always finishes the local part:

1. State `revoking`; **`revokeIntegration(id)`**: abort every open upstream stream for that integration and make every capability's access to it invalid immediately.
2. Provider revoke (the existing `revokeAtProvider`, moved unchanged): Google form `POST https://oauth2.googleapis.com/revoke`, Slack `auth.revoke`. Fixed catalogue URLs only, `redirect: 'error'`, 10-second timeout. Result recorded as `revoked | already-gone | unsupported | failed`.
3. Delete `mcp:<id>:oauth` and clear the cache.
4. Keep the client id and secret unless the user also chose *Forget client*.
5. State `configured`.

Because no `mcp-remote` process exists, a running agent can no longer open a browser sign-in after a disconnect: its next call simply gets the sign-in-required error. That removes one of today's documented limitations.

### 5.9 Provider notes (to confirm at build time, not now)

- Google: authorization `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, `access_type=offline` and `prompt=consent` for a refresh token. Gmail's read scope is a restricted scope; for personal use the app stays in Testing with you as a test user.
- Slack: user-token OAuth v2; whether Slack accepts an `http://127.0.0.1` redirect URL is untested today.
- Both: the exact endpoints, extra parameters and tool lists must be read from the providers' current docs and from a live run before the catalogue pins them.

---

## 6. Worker authentication and permissions

### 6.1 Identity and capability tokens

- Identity is the **agent id** (for workers it equals the worker id; for hired agents it is the roster id), the same key `teardownPty` already uses.
- `CapabilityRegistry.mint(agentId)` returns `{restToken, mcpToken}`: 32 random bytes each, base64url, memory only, replaced on every (re)spawn.
- Lookup is by SHA-256 of the presented token (O(1)) followed by `timingSafeEqual` on the digests. (Today's registry scans every token.)
- A token is valid on its own route family only. Tokens never appear in logs or error messages.
- Revocation: `revokeAgent(agentId)` at teardown (the call site already exists), `revokeIntegration(id)` on disconnect or disable, `stop()` at quit.

### 6.2 Delivery, and the honest residual

The `mcpToken` goes into `agents/<id>/mcp-config.json` under `headers.Authorization`. That file is `0600`, git-ignored, mine-ignored, denied to *other* agents by sandbox and permission rules (6.6, layer 2), rewritten at each spawn, deleted at teardown, and swept at startup.

Requirement R2 says no *OAuth tokens or client secrets* in agent processes, environment variables, command lines or MCP config files. This design meets that literally. The capability handle is in the config file, and I want that stated plainly:

- It has no value outside this app run: it dies with the agent or the app, works only against `127.0.0.1`, and only within that agent's grants.
- An agent CLI cannot authenticate to anything without presenting *something*. I looked at the alternatives: a Unix socket (Claude Code's HTTP MCP client cannot use one), a stdio shim (it would still need the handle in its own config or arguments), the environment (worse: every child shell inherits it), an inline `--mcp-config` JSON (visible to every user in `ps`), and a helper command that mints headers at connect time (if this Claude Code version supports one; untested here: it would have to authenticate to the broker the same way).
- The strongest mitigation that does not move the secret elsewhere is binding the capability to the agent's **process tree** (D4): the broker looks up which process owns the connecting socket and refuses callers outside that agent's PTY tree. That makes a read-and-reuse by another process useless. It needs per-platform plumbing, so it is a later phase.

### 6.3 Grant model

Persisted in `config.mcpGrants` (non-secret):

```ts
type Preset = 'none' | 'read' | 'write' | 'custom';
interface IntegrationGrant {
  preset: Preset;
  allow?: string[];   // tool names, used by 'custom'; the ONLY way to grant a destructive tool
  deny?: string[];    // always wins
  expiresAt?: number; // optional time-boxed grant
}
interface McpGrants {
  defaults: Record<string /*integrationId*/, IntegrationGrant>; // applies to agents with no override
  agents: Record<string /*agentId*/, Record<string, IntegrationGrant>>;
}
```

- Absent means `none`. Every OAuth integration ships with no defaults.
- `read` allows tools classed *read*. `write` allows read and *write*. **Destructive tools are never included by a preset.** To let an agent send mail or post to Slack, you tick that tool by name in `custom`.
- Grants are evaluated on every request against the live config, so an edit takes effect on the next call without a respawn.

### 6.4 Tool classification

The order is `read < write < destructive`. A tool's class is the **stricter** of two inputs, when both exist: the class the catalogue pins for that tool name, and (only when the entry's `trustAnnotations` is on) the class derived from the server's own annotations. If neither exists, the tool is *destructive* (unclassified).

- Annotation-derived class: `readOnlyHint === true` gives *read*; `destructiveHint === true` gives *destructive*; otherwise *write*.
- The catalogue can pin a class per tool name. The server's own annotations are **not trusted to downgrade** a tool the catalogue calls destructive.
- Until the real tool lists are pinned (needs a live listing; the 2026-11-14 retest saw 21 Gmail tools but I do not have their names here), `trustAnnotations` is `false` for these entries: unpinned tools are unclassified (treated as destructive), so no preset reaches any tool until a maintainer pins them. Fail closed.
- A tool that is not in the index is denied until a `tools/list` has been seen (the broker fetches one itself after sign-in, so the Settings tool checklist can be filled before any agent runs).
- **Amended in Phase 1 after the tests exposed a gap:** a tool whose class is unknown is treated as **`destructive`**, not `write`. With nothing pinned yet (the state of all four entries today), calling unknown tools `write` would have let the write preset reach a send or delete tool. An unclassified tool is reachable only by naming it in `allow`. Annotations follow the MCP spec's own defaults: `readOnlyHint: true` is a read, `destructiveHint: false` is a write, and everything else (including no hints at all) is destructive.

### 6.5 Evaluation algorithm (per JSON-RPC message)

1. Capability valid, route kind matches, integration enabled and connected, grant not expired. Otherwise HTTP 401/403.
2. `grant = agents[agent][id] ?? defaults[id] ?? none`. `none` gives 403.
3. By method:
   - `initialize`, `ping`, `notifications/*`, `logging/*`, `completion/complete`: allowed. (Optionally the broker strips the client `sampling`, `elicitation` and `roots` capabilities from `initialize` to shrink the server-to-client surface.)
   - `tools/list`: allowed; the response is filtered to the permitted tools.
   - `tools/call`: the named tool must be permitted (preset class or `allow`, and not in `deny`). Otherwise the broker answers with a JSON-RPC error `-32003 "Not permitted: <tool> is not granted to this agent"` as HTTP 200 so the model sees a clear message. Nothing goes upstream.
   - `resources/*`, `prompts/*`: allowed only when the preset is at least `read`.
   - JSON-RPC *responses* from the client (to server requests): allowed.
   - Anything else: denied (fail closed; the allow-list of methods is explicit).
4. Batches are evaluated item by item; denied items get errors, allowed items are forwarded.

### 6.6 Isolation layers

| Layer | What it stops | Limit |
|---|---|---|
| 1. Server-side grants keyed by the agent behind the capability | An agent using a tool, integration or method it was not granted | None: this is the enforcement point |
| 2. File isolation: `denyRead` on `<hive>/agents` with `allowRead` for the agent's own folder (sandbox) and matching `Read(...)` permission deny rules | Agent A reading agent B's config and capability through ordinary tools | The sandbox covers the Bash tool; file tools use permission rules (documented, not tested live here); an unsandboxed command bypasses both |
| 3. Session binding: the upstream `Mcp-Session-Id` is bound to the agent that initialized it | Agent A reusing B's session id | Needs the id, which is unguessable |
| 4. Short life: capability replaced at every spawn, revoked at teardown | Reuse after the agent is gone | Live agents keep theirs |
| 5. Optional process-tree binding (D4) | Reuse of a *stolen* capability by a process outside the agent's tree | Needs platform plumbing; not in v1 |

What layers 1 to 4 do **not** give you: if agent A manages to read B's capability, A can act as B *within B's grants*. A can never gain more than some agent already has.

### 6.7 Simultaneous sessions

- Every agent has its own capability, its own upstream session ids and its own stream counters. The OAuth token is shared per integration (one account); the audit log attributes every call to an agent.
- Limits (constants, adjustable): 4 open streams and a 10 req/s sustained, 30 burst token bucket per agent per integration; 100 concurrent upstream requests overall. Over-limit gets HTTP 429.
- One keep-alive `undici` pool per upstream host.
- Refresh is single-flight per integration, so any number of agents cannot cause a refresh storm.

---

## 7. MCP route behaviour

### 7.1 Surface

`POST`, `GET` and `DELETE` on `/m/<id>` (Streamable HTTP). No sub-paths, query string dropped. The upstream URL is fixed in the catalogue: an agent chooses an integration by id and never a host or a path, so there is no SSRF surface.

### 7.2 Headers

- Forwarded to upstream (allow-list): `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`, `last-event-id`, and a fixed `user-agent`. Everything else is dropped, including `authorization`, `cookie`, `origin`, `referer`. `Authorization` is set by the broker.
- Returned to the agent (allow-list): `content-type`, `mcp-session-id`, `mcp-protocol-version`, `cache-control`. Dropped: `set-cookie`, `location`, and **`www-authenticate`**, so Claude Code never starts its own OAuth discovery against the broker (it did exactly that against the Google servers in the retest).
- Requests carrying any `Origin` header are rejected (agent CLIs send none; browsers always do).

### 7.3 `tools/list` and `tools/call`

- `tools/list`: the broker buffers the upstream reply (JSON or an SSE event), finds the response for the request id, filters `result.tools` to the permitted set, refreshes `ToolIndex`, and re-emits it in the same content type. Paginated lists are filtered per page. A small, strict SSE parser handles `data:` lines, multi-line data and ids.
- `tools/call`: pre-checked (6.5); results are passed through untouched. The broker cannot sanitise a tool *result* (see the threat model).
- `notifications/tools/list_changed` from upstream passes through; when a grant changes, the broker injects one on the agent's open stream so the CLI re-lists.

### 7.4 Streaming, timeouts and sessions

- SSE responses are piped through with backpressure; the upstream request is aborted when the agent disconnects.
- Timeouts: connect 10 s, response headers 30 s, SSE idle 5 min, absolute stream cap 30 min (clients resume with `Last-Event-ID`). Request body cap 10 MB (per-integration override for uploads, up to 25 MB).
- Upstream 401: refresh once, replay once; if it still fails, answer 401 with `{"error":"sign_in_required"}` and no `WWW-Authenticate`.
- Upstream 404 for a session id: clear the binding and pass the 404 on, which tells a compliant client to initialize a new session.
- On agent teardown the broker sends a best-effort `DELETE` for each bound upstream session (3-second timeout).

---

## 8. Threat model

**Assets**: OAuth tokens, client secret, capability tokens, the user's mail/calendar/files/messages reachable through tools.

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Prompt-injected agent tries tools it was not granted | Server-side per-message grants; `tools/list` filtering; fail-closed method list | None for ungranted tools |
| T2 | Prompt-injected agent misuses tools it *was* granted (reads mail, then exfiltrates through some other channel) | Default none; read-only presets; destructive only by name; time-boxed grants; rate caps; activity log | **Real and not fully preventable**: the broker cannot see intent |
| T3 | Malicious tool *result* (indirect prompt injection from a mail body or Slack message) | Same as T2; keep grants narrow | Out of the broker's reach |
| T4 | Agent A reads agent B's capability | Layer 2 file isolation; layers 3 and 4; D4 later | Unsandboxed commands; A gets at most B's grants |
| T5 | Other process of the same user reads an agent's config and uses the capability | 0600; deleted at teardown; D4 later | **Real until D4**: same-user code can read user files |
| T6 | Other OS user on the machine reaches the loopback port | 256-bit capability required; no CORS; `Host` and `Origin` checks | Port is visible to local users; useless without a capability |
| T7 | Malicious web page attacks the broker (DNS rebinding, CSRF) | Capability required; `Host` check; any `Origin` rejected; no CORS headers; JSON-only | None known |
| T8 | OAuth callback forgery, code injection, login CSRF | State (single use, constant-time, TTL), PKCE S256, `Host` and path checks, client secret at the token endpoint, `iss` check; forged hits never abort the flow | Depends on the provider enforcing PKCE (Google does; Slack unverified) |
| T9 | Another program squats on the callback port first | Strict port with a pre-check; fails with a clear error. A squatter would still lack the verifier and the client secret | Sign-in fails until the port is free |
| T10 | Token theft at rest | `safeStorage` (OS keychain); refuses the Linux `basic_text` backend | Same-user keychain prompts are the OS's protection |
| T11 | Token theft in memory or on disk through crash dumps and swap | Short-lived access tokens; no plaintext file | Cannot be ruled out; no runtime token files, unlike today |
| T12 | Token theft in transit | HTTPS only, default certificate validation, `redirect: 'error'`, host allow-list | None known |
| T13 | SSRF or open proxy through the broker | Fixed upstream per integration; no path or host input | None |
| T14 | Header or request smuggling | Header allow-lists both ways; Node's strict parser; bodies buffered with caps | None known |
| T15 | Resource exhaustion by an agent | Per-agent and global caps; body, stream and time limits | A busy agent can still slow itself down |
| T16 | Secrets in logs or errors | Structured logs without headers or bodies; fixed error codes; a test scans for token-shaped strings | Discipline plus the test |
| T17 | Supply-chain compromise of `mcp-remote` | Package removed; no new runtime dependency | None |
| T18 | Revoked access still usable by running agents | `revokeIntegration` aborts streams and invalidates at once | In-flight upstream calls may complete |
| T19 | Renderer compromise calls privileged IPC | Secrets write-only; new privileged handlers validate the sender frame; tokens never cross IPC | The existing handlers I read ignore the sender; the new ones will check it |
| T20 | Stale capability left in a config after a crash | Startup sweep removes agents' MCP configs; capabilities are memory-only so they are dead anyway | None |

**Explicit non-goals**: stopping a granted tool from being misused (T2/T3); protecting against code that already runs unsandboxed as the user (T5 until D4); verifying that Google's and Slack's servers behave as documented.

---

## 9. Failure handling

| Event | Behaviour |
|---|---|
| **App crash** | Capabilities are memory-only, so every handle is dead. Tokens are already sealed (written before use). At next start: sweep agents' `mcp-config.json`, no runtime folder to recover. Agents that survived get 401s until respawned. |
| **App quit** | Stop listeners, abort streams, flush the store, clear caches, delete agents' MCP configs. Provider tokens are *not* revoked (quit is not disconnect). |
| **Agent exits or is killed** | `teardownPty` calls `revokeAgent`: capability deleted, its streams aborted, best-effort upstream `DELETE` for its sessions, its config deleted. |
| **Worker finishes** | Same path; the worker's REST and MCP tokens both die together. |
| **Broker cannot bind** | Try the last-used port first (stored in `userData`), then any port. Failure disables broker-backed integrations and shows why; bridge-engine integrations are unaffected. |
| **Broker restarts on a new port while agents run** | Agents hold the old URL. Preferring the last port makes this rare; otherwise those agents reconnect after `/mcp reconnect` or a respawn. |
| **Callback port in use** | Pre-check fails before opening the browser; message names the port. |
| **User closes the browser tab** | 5-minute timeout, listener closed, state discarded, status back to `configured`. |
| **Provider outage or no network** | Retries with backoff; tokens kept; JSON-RPC error "provider unreachable". |
| **Refresh `invalid_grant`** | Tokens deleted, `needs-signin`, UI badge, in-flight requests answered with sign-in-required. |
| **Client secret rotated or wrong** | `invalid_client`: same as above, message points at the client fields. |
| **Refresh-token rotation interrupted** | The ms-wide window described in 5.5; outcome is "sign in again". |
| **`safeStorage` unavailable, decrypt fails, keychain reset** | Sign-in refused (`encryptionIsReal`); a record that cannot be decrypted is treated as signed-out and reported. |
| **Secret store file torn or corrupt** | Atomic writes make it unlikely; if the file does not parse, keep it as `.corrupt-<time>`, restore `.bak`, and say so. Never silently start empty. |
| **Grant edited mid-session** | Effective on the next message; `tools/list_changed` injected so the CLI re-lists. |
| **Integration disabled or disconnected mid-session** | Streams aborted; calls get 403 / sign-in-required. |
| **Upstream session expired** | 404 passed through; client re-initializes. |
| **Migration import fails** | Bridge engine keeps working; nothing is deleted. |

---

## 10. Components and file changes

### 10.1 New modules (all electron-free; dependencies injected so they test under plain Node)

| File | Purpose | Approx. size |
|---|---|---|
| `src/main/broker/core.ts` | HTTP server, guards, routing, limits, error shape | 350 lines |
| `src/main/broker/capabilities.ts` | `CapabilityRegistry`: mint, resolve, revoke by agent or integration | 150 |
| `src/main/broker/rest-route.ts` | Today's forward logic, moved unchanged | 200 |
| `src/main/broker/mcp-route.ts` | Streamable-HTTP proxy, sessions, SSE | 450 |
| `src/main/broker/jsonrpc.ts` | Parse, batch handling, `tools/list` filter, SSE parser | 250 |
| `src/main/broker/permissions.ts` | Grant evaluation, tool classification, `ToolIndex` | 250 |
| `src/main/broker/credentials.ts` | `CredentialProvider`, `StaticSecretProvider` | 80 |
| `src/main/oauth/flow.ts` | PKCE, state, discovery, callback listener, exchange | 450 |
| `src/main/oauth/token-store.ts` | Sealed record, cache, write-ahead | 150 |
| `src/main/oauth/provider.ts` | `OAuthTokenProvider`: single-flight refresh, backoff, status events | 250 |
| `src/main/oauth/revoke.ts` | `revokeAtProvider`, moved from `mcpAuthVault.ts` | 80 |
| `src/main/broker/audit.ts` | In-memory activity ring | 60 |

### 10.2 Changed files

| File | Change |
|---|---|
| `src/main/integrationBroker.ts` | Becomes a facade over `BrokerCore` with the same public API |
| `src/main/integrations.ts` | Atomic write, `.bak`, corruption-safe read (Phase 0) |
| `src/main/hive.ts` | Bridged entries become `http` servers to the broker with the capability, when the integration's engine is `broker`; removes the config at teardown; keeps `denyRead` for other agents' folders |
| `src/main/index.ts` | Create the shared broker; mint capabilities in the Claude-agent spawn path; `revokeAgent` in `teardownPty`; engine-aware `mcp:signIn` / `mcp:disconnect`; new IPC (below); startup sweep and quit hooks |
| `src/shared/mcpCatalog.ts` | `McpBridgeSpec` gains `engine`, `endpoints` (optional), `allowedHosts`, `extraAuthParams`, `toolClasses`, `trustAnnotations`. Existing fields and ids untouched |
| `src/main/config.ts` | `mcpGrants`, `mcpEngine` (per integration, default `bridge`) |
| `src/preload/index.ts` | New calls below |
| `src/renderer/src/components/McpDefaultsSettings.tsx` | Existing fields and buttons stay; add the Access section |
| `src/renderer/src/i18n/locales/{en,zh-CN,ar}.json` | About 30 new strings with the existing parity rules |
| `tools/verify-mcp-live.cjs` | Gains an `--engine broker` mode: a small MCP client that talks to the broker the way an agent would, for the real-account check |

### 10.3 New IPC

`mcp:grants:get`, `mcp:grants:set` (validated, sender-checked), `mcp:tools:list(id)` (names, classes, descriptions only), `mcp:activity(id)` (metadata only), `mcp:status` push events. `mcp:signIn` and `mcp:disconnect` keep their names and result shapes.

### 10.4 What stays the same for the user

Same four catalogue entries, ids, labels, descriptions, redirect URIs and client-id/secret fields; same "Sign in" and "Disconnect" buttons and status chip; same off-by-default tier and consent rules. **New**: an *Access* section per connected integration (who may use it, which preset, a per-tool checklist with destructive tools flagged, recent activity).

### 10.5 Removed only at the end (Phase 5)

`mcp-remote` constants and `bridgeArgs`, the runtime-folder logic in `mcpAuthVault.ts`, `runMcpSignIn`, their tests (replaced by the broker equivalents listed in section 11), and the sealed `mcp:<id>:tokens` blobs.

---

## 11. Test plan

Fixtures are local stand-ins: `test/fixtures/stand-in-idp.cjs` (authorize, token, refresh, revoke, with PKCE, exact redirect, single-use codes and client-secret enforcement, like the one used in the audit) and `test/fixtures/stand-in-mcp.cjs` (bearer-protected Streamable-HTTP server with JSON and SSE replies, sessions, a few tools with annotations). No network.

| Test file | Covers |
|---|---|
| `broker-rest-characterization` (**written first, against today's code**) | auth failures, id not granted, disabled integration, path escape, header stripping, injected auth wins, body cap, no redirect following, revoke, stop |
| `broker-core` | guards (peer, Host, Origin), limits, error shape, 405/404, concurrency caps |
| `broker-capabilities` | mint/resolve/revoke by agent and by integration, two channels not interchangeable, digest lookup, replaced at respawn |
| `oauth-flow` | state generation and single use, TTL, PKCE S256 and verifier never on disk, callback order table (each row), forged hits do not abort, 20-hit abort, `iss`, port-in-use pre-check, exact redirect URI |
| `oauth-token-provider` | proactive refresh, reactive 401 retry, single-flight under 50 concurrent callers, rotation persisted before use, `invalid_grant` path, backoff, expiry margin with a fake clock |
| `oauth-token-store` | sealed at rest (fake cipher), no plaintext anywhere on disk (scan), write-ahead, corrupt store handling |
| `mcp-route` | POST JSON, POST SSE, GET stream, DELETE; header allow-lists both ways; `www-authenticate` stripped; upstream redirect refused; stream abort propagation; timeouts; 404 session passthrough |
| `mcp-permissions` | preset ladder; destructive never via preset; `allow`, `deny`, `expiresAt`; `tools/list` filtering incl. pagination and SSE; `tools/call` denial text; batches; unknown method denied; unknown tool denied until listed; annotation cannot downgrade a catalogue class |
| `broker-isolation` | agent A's capability never works for B's grants; session id bound to its agent; revoked token dead at once; two agents hammering one integration |
| `broker-lifecycle` | teardown, quit, crash-and-restart (new instance with the same store: tokens survive, capabilities do not), disconnect aborts streams, port preference |
| `mcp-broker-wiring` | hive config has `http` entry with the capability and **no** token, client id/secret, env block or `npx`; entry only when connected and granted; config deleted at teardown |
| `mcp-migration` | importer reads an old sealed `mcp:<id>:tokens` blob, writes the new record, leaves the old one, is idempotent; engine switch both ways |
| `security-regression` | scans every file the app writes and every log/error in the tests for any token, secret or capability string |
| existing suites | all 1028 stay green unchanged during Phases 0 to 4 |

Beyond unit tests:

- **Fuzz**: callback query parser, JSON-RPC parser, SSE parser, header handling (malformed, oversized, duplicated).
- **Real-client check** with the installed `claude` CLI: `claude -p --mcp-config` pointing at the broker in front of the stand-in MCP server; assert the init event shows the server connected, the tool list is the filtered one, a granted call works, an ungranted call returns the broker's denial. (Costs a few cents of model use.)
- **Live gate (Phase 4, needs your accounts)**, for each of Gmail, Calendar, Drive and Slack: sign in; the tool list appears; one real read-only call succeeds; an ungranted tool is denied; disconnect revokes (check the provider's account page) and the next call is refused. Until each box is ticked that integration is **not** called verified.

---

## 12. Migration plan

**Principles**: nothing the user has working changes until they opt in; every phase can be reverted by a switch; old and new token stores are separate refs.

| Phase | Content | Exit criteria | Rollback |
|---|---|---|---|
| **0 Safety net** (done) | Characterization tests for the REST broker; atomic, corruption-safe secret store | New tests green on today's code; 1028 still green | Revert the store change |
| **1 Extract the core** (done) | `BrokerCore`, `CapabilityRegistry`, `RestRoute`; `IntegrationBroker` becomes a facade; two-channel tokens (REST token unchanged); the MCP route as an unregistered foundation | Characterization tests pass unchanged | Facade points back at the old class |
| **2 OAuth in main** (done, stand-in only) | `flow`, `token-store`, `provider`, `revoke`, `controller`; engine switch `mcpEngine[id]` (default `bridge`); sign-in and disconnect work for an integration switched to `broker`; no agent wiring yet | Stand-in tests green (they are); **`tools/verify-oauth-live.cjs` signs in and refreshes with your real account (NOT yet run)** | Leave the switch on `bridge` |
| **3 MCP route, permissions, wiring, UI** (done, stand-in only) | `McpRoute` registered, 401 replay, streamed `tools/list`, limits, tool discovery, grants + validated IPC, hive wiring, Access section, engine switch, importer, quit drain | Real-client check passes (it did, against stand-ins); isolation and lifecycle suites green (they are) | Switch back to `bridge`; no data moved |
| **4 Live gate** (started; no real account yet) | `tools/verify-broker-live.cjs` runs the checklist against the real servers through the real broker; you supply the account | All four ticked (or you decide otherwise) | n/a |
| **5 Remove the bridge** | Default flips to `broker`; one release later delete `mcp-remote` code, runtime folders, supervisor, old tests, old sealed blobs | Release with the broker as default and no reports | Previous release |

### 12.1 Phases 0 and 1: what was built and what it found

**Built**

- `src/main/atomicFile.ts`: atomic write (temp file, fsync, rename) and a cross-process, re-entrant lock with dead-holder takeover.
- `src/main/integrations.ts` (secret store only): atomic writes with a `.bak` mirror; a read that fails is **never** an empty store (an unreadable file blocks every save; an unparseable file is set aside as `.corrupt-<time>`, never overwritten, and restored from the backup when there is one); locked read-modify-write; `deleteSecret` now reports failure and removes the backup copy too; `secretStoreStatus()` so the UI can say the store was damaged.
- `src/main/broker/`: `capabilities.ts` (per-agent, per-channel tokens, SHA-256 lookup, synchronous revoke), `core.ts` (loopback server, authentication, channel isolation, immediate revocation, containment), `rest-route.ts` (the original forwarding logic), `credentials.ts` (the provider seam), `http-util.ts`, and the MCP foundation: `mcp-route.ts`, `permissions.ts`, `jsonrpc.ts`.
- `src/main/integrationBroker.ts` is now a 111-line facade with the same public API. The MCP route is registered only when a caller passes `extras.mcp`; `index.ts` does not, so `/m/…` does not exist in the app.
- One line in `index.ts`: the secret store's `.bak` is denied to agents like the main file.

**What the tests found and fixed on the way (each has a test)**

1. A malformed `%`-escape in a REST integration id threw out of the request handler and **would have crashed the main process**; any worker holding a capability could trigger it. Now a 400.
2. An oversize upload reset the connection instead of answering; now a clean 413.
3. Revoking a worker did not stop a request it was already running; now it is cut in the same tick.
4. The first `withFileLock` could leak a lock file if stamping it failed; fixed.
5. The unclassified-tool gap described in 6.4.
6. A JSON-RPC id of `1e999999` parsed as `Infinity` and would have lost its id on the way back; now refused.
7. An event stream that stays silent after its headers would not have shown its headers to the client until the first event; headers are now flushed at once on the MCP route.

**Deliberately not done** (Phase 2 onward): OAuth, token storage, the OAuth credential provider, `tools/list` filtering of a *streamed* list (refused, fail closed, for now), rate limiting, the Settings UI, the importer, process-tree binding.

**Token import (Phase 3)**: for an integration switched to `broker`, if `mcp:<id>:oauth` is missing and a sealed `mcp:<id>:tokens` exists, read the `*_tokens.json` file inside it (`access_token`, `refresh_token`, `expires_at`, `scope`), build an `OAuthTokenRecord` with the stored client's fingerprint, and write it. Copy, never move. If the old tokens carry no refresh token (likely for Google, because the bridge never asked for offline access) the record is imported as short-lived and the status says it will need a sign-in soon.

**What the user sees**: redirect URIs do not change, so no OAuth app needs re-registering; client id and secret stay; one extra *Access* section appears after sign-in; the engine switch is an advanced toggle until Phase 5.

### 12.2 Follow-ups to Phases 0 and 1 (asked for with the Phase 2 approval)

**1. The lock inside the real Electron main process: tested.** `test/electron/main-store.cjs` runs under the Electron binary in `node_modules` (Electron 32.3.3: Node 20.18.1, V8 12.8, macOS arm64) and `test/electron-main-store.test.cjs` asserts on what it reports. In the main process, with other Electron processes contending for the same files:

| Check | Result |
|---|---|
| It really is the main process (`process.type === 'browser'`, `app` ready) | yes |
| `Atomics.wait` (what `sleepSync` stands on) works on its main thread | yes (42 ms for a 40 ms sleep) |
| Main + 3 Electron processes increment one counter under the lock | 160 of 160, none lost |
| A holder killed with SIGKILL while holding the lock | its lock is taken over in under 2 ms (by its pid, not by waiting out the age limit) |
| About 1,500 reads while another Electron process rewrites a 200 KB file | 0 torn |
| 6 writers killed at random moments | 0 torn files |
| 4 Electron processes saving 25 secrets each into the real store | 0 of 100 lost |
| A deleted secret | gone from the store and from the backup |

The same Electron run also drives the **OAuth engine** against the stand-in provider, because several of its guarantees depend on the runtime rather than the logic: a forged redirect is ignored and the real one completes (PKCE verified by the provider); a refresh with rotation; 40 simultaneous callers cause one refresh; a redirect from the token endpoint is **not followed** (Electron's `fetch` with `redirect: 'error'`; zero requests reached the redirect target); a hung token endpoint is abandoned at its timeout (about 1.2 s for a 1.2 s limit); an oversized answer is refused by the streamed reader; and revocation is confirmed. 17 checks in all, all passing.

Mutation check: with the lock turned into a no-op and the atomic write into an in-place write, the same run reports the counter at 28 of 160, 4 torn reads and 34 of 100 secrets lost. **Not exercised:** the real `safeStorage` (Keychain / DPAPI / libsecret). It can raise an OS prompt, so by default the run gives `safeStorage` a stand-in cipher; `MD_ELECTRON_REAL_SAFE_STORAGE=1` uses the real one. The same file also launches `tools/verify-oauth-live.cjs` under Electron, which found a real bug (below).

**2. Windows: hardened and fault-tested, NOT verified on Windows.** There is no Windows machine in this environment, so nothing below has run on one. What was done instead:

- Reviewed against known Windows behaviour and changed (`src/main/atomicFile.ts`, `integrations.ts`, `mcpAuthVault.ts`), all gated so POSIX behaviour is unchanged:
  - a rename blocked by a virus scanner, the search indexer or a backup tool (EPERM / EACCES / EBUSY) is retried for about a second, only on Windows; on every other OS those codes are real permission errors and are raised at once;
  - creating the lock file can fail with EPERM instead of EEXIST when another process deleted it but still holds it open ("delete pending"); that is now waited out, and a genuine permission failure is reported as itself after the timeout rather than disguised as "busy";
  - releasing the lock, reading the secret file and the recursive deletes retry the same transient errors;
  - a directory that cannot be opened for fsync is tolerated (Windows cannot open one).
- **A latent bug, on every OS, found while doing this:** when a dead holder's lock could not be deleted, the waiter looped without sleeping or checking its timeout, for ever. It now falls through to the wait and the timeout. The takeover also re-reads the lock first, so a lock another process has just taken over is not deleted from under it.
- `test/atomic-file-windows.test.cjs` (16 tests) injects those Windows errors through a platform seam, and uses real child processes killed outright (`SIGKILL` is `TerminateProcess` on Windows) for lock takeover and torn writes. Each hazard was confirmed by mutation (removing the retry, the no-spin fix or the re-read each fails a test; the no-spin mutation hangs the file).
- **How to verify on Windows** (the suite is written to run there; POSIX-mode assertions are skipped on `win32`): `npm ci` then `npm run test:store` (the atomic write, the lock, the secret store, disconnect, and the Electron-hosted run), or the whole `npm run test:focused`. For CI, a `windows-latest` job running `npm ci` and `npm run test:focused` would do it; I have not added one, because that changes the workflow that runs on every push.
- **Still unverified on Windows:** that NTFS replaces the destination atomically through Node's rename (relied on, not guaranteed by Microsoft's documentation for every case); an antivirus that holds a file longer than the retry window; a user-data folder on OneDrive or a network drive; process-id reuse after a crash (the lock falls back to its age limit). **Known difference, not a test result:** Windows ignores the POSIX mode `0600`, so there the secret file's protection is the ACL of `%APPDATA%` plus encryption.

**3. Disconnect could report success when the credential was not deleted: fixed.** In Phase 0 `deleteSecret` started returning `{ok:false}` instead of throwing, but several callers still wrote `try { deleteSecret(x); return {ok:true} }`, so a failed delete read as a disconnect. Found and fixed:

- `mcp:disconnect` / `disconnectMcp`, `mcp:clearSecret` ("Forget"), `providerKey:clear`, and `McpAuthVault.purge` (which ignored the result) all dropped it; `removeRecord` removed the integration even when its credential could not be deleted; and three Settings screens (Forget, Clear key, Remove integration) showed "done" whatever the answer was.
- Every removal now goes through `removeSecrets` (`src/main/mcpDisconnect.ts`), which accepts the delete's own word **and** asks the store whether the secret is really gone. `purge` also checks that the runtime directory is gone. `deleteSecret` now also refuses to call a delete done while a copy survives in the `.bak` mirror (which recovery would put back): it refreshes or removes the backup, and says so if it cannot. `removeRecord` deletes the credential first and keeps the record if it cannot. The three screens now show the error.
- A static guard fails the test suite if any code in `src/main` calls `deleteSecret` and drops the result. Mutation check: reverting either half of `removeSecrets` fails 9 and 2 tests.

**4. The REST broker characterization tests are untouched.** `test/broker-rest-characterization.test.cjs` (37 tests) has the same SHA-256 before and after Phase 2 (`fb81ff85…9863`) and passes.

**Two existing tests were adjusted, not weakened:** `test/mcp-bridge-security.test.cjs` (the static check of the disconnect order now reads `mcpDisconnect.ts`, where that code moved, with the same steps in the same order plus the new wiring assertions) and `test/mcp-route.test.cjs` (the Phase 1 guard "nothing in the app mints MCP capabilities" still forbids `grantMcp`; it no longer forbids `revokeIntegration`, because Disconnect must cut agent access at once, and it now pins that `revokeIntegration` appears exactly once, in that one place).

### 12.3 Phase 2: OAuth in the main process

**What it is.** An in-app authorization-code + PKCE (S256) sign-in, a token provider that keeps the access token fresh, provider-side revocation, and an engine switch. As built in Phase 2 it was **off for every integration**, **had no UI** (the switch was `mcpEngine` in the app's config file, e.g. `{"mcpEngine":{"gmail":"broker"}}`; Phase 3 added the Settings switch), and **an integration on `broker` was not usable by agents yet**: `mcpBridge` returns nothing for it, so no `mcp-remote`, no client file, no token file and no MCP entry reach an agent. Wiring it to agents is Phase 3 (section 12.4).

| File | Role |
|---|---|
| `src/main/oauth/pkce.ts` | verifier, S256 challenge, verification (constant time), `state`, constant-time compare, one-way fingerprint |
| `src/main/oauth/endpoints.ts` | the URL policy: https only, no credentials / fragment / query, no loopback or IP literal in production; reserved parameters cannot be overridden |
| `src/main/oauth/flow.ts` | one sign-in: loopback listener, callback validation, single-use state, replay memory, token exchange |
| `src/main/oauth/token-response.ts` | strict reading of a token answer; `permanent` / `rejected` / `transient` / `malformed`, never the provider's free text |
| `src/main/oauth/token-store.ts` | the sealed record `mcp:<id>:oauth` (strict schema, client fingerprint) |
| `src/main/oauth/provider.ts` | the `CredentialProvider` for the MCP route: expiry margin, single-flight refresh, write-ahead rotation, dead grants, disconnect race |
| `src/main/oauth/revoke.ts` | provider-side revocation (Google form style, Slack `auth.revoke`) |
| `src/main/oauth/controller.ts` | what the IPC handlers call: sign-in, status, cancel, forget, dispose |
| `src/main/oauth/http.ts`, `types.ts` | the one HTTP helper (no redirects, timeout, size cap, never throws) and the log backstop |
| `src/main/mcpEngine.ts` | `engineFor`: `bridge` unless explicitly switched, and only for an integration that has an `oauth` spec |
| `src/main/mcpDisconnect.ts` | one disconnect for both engines (section 12.2) |
| `src/shared/mcpCatalog.ts` | `McpOauthSpec` per bridged entry (pinned endpoints), `mcpOauthRef`, `McpEngine` |
| `tools/verify-oauth-live.cjs` | the real-account check (not run) and a credential-free endpoint drift check (run) |

**How it differs from the design in sections 5 and 10**

- **No run-time discovery.** Endpoints are pinned in the catalogue, copied from the providers' published authorization-server metadata (fetched 2026-11-15), not discovered when signing in: a discovery document that could redirect the exchange carrying the client secret is exactly the attack a pinned entry removes. `node tools/verify-oauth-live.cjs --check-metadata` compares the pins with what is published today (20 of 20 match; it checks drift only, not the flow).
- **A bad request never ends a sign-in, however many.** Section 5.3 had "20 bad hits abort". That would have let anything on the machine lock the user out of their own sign-in, which is what requirement 6 forbids. There is no cutoff; bad requests cost a parse and a constant-time compare, and only their logging is throttled.
- **State is single-use, spent when the first request with the right state arrives**, whatever it carries. A local program that has *seen* the state (it is in the browser's address bar and briefly in the argument list of the `open` call) can therefore make one sign-in attempt fail. It cannot obtain tokens (PKCE) or link another account (the provider rejects a code made for another verifier).
- **Google's `iss` is required, Slack's is optional.** Google's metadata declares `authorization_response_iss_parameter_supported: true`; Slack's does not say. A wrong `iss` is always refused. If Google does not in fact send it, sign-in will fail with `invalid-callback` and the fix is one catalogue field.
- **Slack asks for a read-only subset of its 30 scopes** (search, history, read), not the empty set the bridge sends. Nothing that posts or writes is requested until you opt in, so the Slack description's "post messages" will not work through this engine. An explicit upgrade (which write scopes, and when) was NOT built in Phase 3 either: it needs a decision, and it cannot be tested without a Slack workspace.
- **Disconnect covers both engines.** It cuts agent capabilities first (`revokeIntegration`), then revokes at the provider, then deletes and verifies the bridge's sealed tokens, the in-app record and the OAuth client, then drops the in-memory copy. A refresh that was on the wire is aborted and its answer discarded, so a late answer cannot undo a disconnect.
- **`verify-mcp-live --engine broker` became its own tool** (`verify-oauth-live.cjs`), because `verify-mcp-live` is about Claude Code sessions, not OAuth.

**Properties, each pinned by a test** (`test/oauth-*.test.cjs`; the security-critical ones were also mutation-checked: deleting the check makes a test fail, and the list of mutations tried is in the session report)

- *Sign-in.* The authorization request is S256 only and its redirect URI is exactly the registered one. A redirect is refused unless it is a GET to exactly `/oauth/callback` (compared as sent, so `/oauth/../oauth/callback` does not pass), with `Host` exactly `127.0.0.1:<port>`, a browser navigation (not `fetch`, `<img>` or `<iframe>`), parameters appearing once and within size, the right state, and a correct `iss`. A wrong or missing state, a wrong path or method, a rebound Host, a flood of 600 forged requests, another integration's state delivered to the wrong port: none ends the sign-in or reaches the token endpoint, and the real redirect still works afterwards. A replayed callback is exchanged once. A code this app already used is never sent again, under any state. A PKCE mismatch (a challenge swapped in transit) makes the provider refuse and nothing is stored. The code is presented once and never retried, whatever the token endpoint does. Four sign-ins at once finish out of order with their own tokens.
- *Refresh and expiry.* Refresh starts two minutes before expiry. Forty workers asking at once cause one refresh. A rotated refresh token is written before the new access token is handed out; if the store cannot be written the session keeps working from memory and the save is retried. `invalid_grant` and its kin end the sign-in, are remembered across a restart and are not retried; a 5xx, a timeout, a 429, an unknown 4xx, a malformed 200, an oversized answer or a redirect are "unavailable" (backoff, then a cool-down) and never discard a working sign-in. Tokens for a different OAuth client are not sent to the provider with another client's credentials. Malformed, undecryptable and unreadable stored records are `sign_in_required` / `unavailable`, never a crash and never deleted.
- *Revocation.* Google (form `token=`) and Slack (`auth.revoke`) shapes; "already invalid" counts as gone, any other refusal does not; offline, hung, redirected and oversized answers are reported as unreachable, never thrown; a disconnect that could not revoke still wipes, and says it did not revoke.
- *Secrecy.* A scan plants secrets (client secret, code, verifier, state, tokens) and hostile input, drives success and every failure, then searches logs, console output, returned results, browser pages, opened URLs, process spawns, an agent's generated configuration and its spawn arguments: nothing. With the log backstop removed, a deliberately added leak is found by the scan, so the scan is not blind. The engine imports no `fs`, `child_process`, `electron` or `process.env`, makes no request except through the one helper that refuses redirects, and writes no file (watched during a sign-in and a refresh). Tokens exist in one place, the sealed record.
- *With the real store and the real broker.* Against the real encrypted store the record is ciphertext on disk, rotation goes through the atomic write, and an unreadable store makes Disconnect fail loudly. Behind the shared broker: the upstream gets the engine's token, the agent never sees it; capability tokens are unique per agent and per channel; no grant means nothing reaches the upstream, not even `initialize`; revoking an agent or an integration is felt on the next request and cuts one in flight; eight workers with forty requests share one token and cause no refresh.

**What the tests found in this phase's own code** (fixed): a loopback address was accepted as a provider under the production policy; a callback path was normalised before it was compared; a flood of forged requests would have made the listener answer 429 to the real redirect (the lock-out above); a state that could be reused passed every test until the replay test was tightened; `tools/verify-oauth-live.cjs` started under Electron and then idled for ever, because `require.main` is not the entry script there; and a refresh that finished late after a disconnect could evict the newer refresh from the single-flight slot, letting a third caller start a second refresh while one was on the wire.

**Not verified, and not claimed**

- No sign-in, refresh, tool call or revocation has ever been made against Google or Slack with this engine. Whether they accept this exact flow, issue refresh tokens under `access_type=offline`, send `iss`, accept `http://127.0.0.1` as a redirect (Slack, unknown), return the token shape the Slack parser expects (a guess, with a nested-user-token fallback), and honour the documented revocation calls for tokens minted through their MCP servers is unknown. Google apps in *Testing* status expire refresh tokens after 7 days.
- The tool names and annotations the four servers publish (the permission model treats an unannotated tool as destructive); `verify-oauth-live.cjs` lists them.
- **(Phase 2's state; closed in Phase 3, section 12.4.)** Nothing in the app called the provider yet: no MCP route was registered, so the 401-then-refresh replay in the route (`provider.markRejected` existed and was tested) and graceful draining of an in-flight refresh at quit were Phase 3.
- Windows (section 12.2). Two app instances sharing one user-data folder (the provider adopts a rotation another process saved, but that is a mitigation, not a lock). A crash between the provider rotating a refresh token and the save reaching disk (Slack, if it rotates) costs one sign-in.
- **(Phase 2's state; closed in Phase 3, section 12.4.)** The Settings panel had no switch, no per-integration status words, and no Access section.

**Results** (2026-11-15, macOS arm64, Node 22.12 for the suite, Electron 32.3.3 for the Electron-hosted checks)

| Command | Result |
|---|---|
| `npm run test:focused` | **1,468 tests: 1,467 pass, 0 fail, 1 skip** (the existing `resolveCommand finds agy … Windows LOCALAPPDATA` test, which only runs on Windows). The baseline before this work was 1,232. Three consecutive full runs were clean after one racy test of mine was replaced. |
| `npm run typecheck` | exit 0 (node and web) |
| `npm run build` | exit 0; the engine is in the main bundle and the endpoint policy is only ever the frozen production one |
| `node tools/verify-oauth-live.cjs --check-metadata` | 20 of 20 pinned endpoints match what Google and Slack publish (public, credential-free; drift only, not the flow) |
| `test/broker-rest-characterization.test.cjs` | 37 pass; SHA-256 identical to before Phase 2 |

New and extended test files: `oauth-pkce` 8, `oauth-endpoints` 10, `oauth-token-response` 13, `oauth-revoke` 9, `oauth-flow` 49, `oauth-provider` 50, `oauth-disconnect` 12, `oauth-security` 15, `oauth-broker-integration` 13, `oauth-live-tool` 12 (191 for Phase 2); `mcp-disconnect` 22, `atomic-file-windows` 16, `electron-main-store` 2 (17 checks inside Electron), and 5 added to `integration-secret-store` (follow-ups). Fixtures: `oauth-idp.cjs` (the stand-in provider), `oauth-env.cjs`.


### 12.4 Phase 3: the MCP route, permissions, wiring and the Settings panel

**What it is.** The in-app engine from Phase 2 is now reachable by agents, through the broker, when (and only when) all of these hold for that integration and that agent: its engine is `broker` (opt-in per integration, default `bridge`), you switched it ON, you signed in, and you granted **that agent** something. Each is checked again on every request. The agent's MCP config then holds one `http` server per such integration: the broker's own loopback address and the agent's **capability** (a revocable handle for that one agent, 32 random bytes, in memory only), and nothing else. The OAuth tokens and the client secret never leave the main process. The `mcp-remote` bridge is untouched and stays the default.

| File | Role |
|---|---|
| `src/main/broker/mcp-route.ts` | the route: 401 refresh-and-replay, streamed `tools/list`, limits, upstream session close, tool discovery |
| `src/main/broker/sse.ts` | a strict event-stream reader (WHATWG rules, event cap, never throws) |
| `src/main/broker/ratelimit.ts`, `audit.ts` | the token bucket; the in-memory, metadata-only activity ring |
| `src/main/mcpWiring.ts` | pure rules: which integrations the broker serves, which an agent is given, what a grant change may say, which config keys the general update may not touch |
| `src/main/mcpImport.ts` | copy a bridge sign-in into the in-app record (copy, never move, never overwrite) |
| `src/main/ipcSender.ts` | the privileged handlers answer only the app's own top-level page |
| `src/main/hive.ts` | writes the broker entry; `removeMcpConfig`, `sweepMcpConfigs`; denies agents the other agents' MCP configs |
| `src/main/index.ts` | registers the route; mints the capability at spawn and revokes it at teardown; the IPC below; the quit drain; the startup sweep |
| `src/main/oauth/provider.ts`, `controller.ts` | `rejected` (the route's 401 hook), `beginShutdown` / `drain`, `importFromBridge` |
| `src/shared/mcpAccess.ts`, `mcpCatalog.ts` | what main and the panel say to each other (names, classes, grants, activity); `toolClasses` / `trustAnnotations` per entry |
| `McpAccessSection.tsx`, `McpDefaultsSettings.tsx`, locale files | the Access section, the sign-in method switch, the status words (English, Chinese, Arabic) |

**How it differs from sections 6, 7 and 10**

- **Entry only when granted.** Section 6.5 said grants are read live and an edit applies without a respawn. That stays true for narrowing and for widening an entry an agent already has. An agent that had *no* grant when it started has no entry in its config, and a CLI does not pick up a new server mid-session, so widening from nothing reaches an agent started afterwards. The panel says so.
- **Nothing is classified yet, so no preset reaches any tool.** `toolClasses` is empty for all four entries and `trustAnnotations` is off (both need a real listing from a signed-in account). An unclassified tool counts as destructive, so Read and Write allow nothing today and a tool is reachable only when you tick it by name. The panel says that too. This is the design's fail-closed rule working, and it is the one thing you will notice first when you try it.
- **A streamed `tools/list` is filtered, not refused.** Phase 1 refused it "for now". It is read whole (size and time limited), the answer to *this* request id is found in the stream, filtered, and sent back as a single event; everything else in the stream is dropped. An answer that cannot be read, or is for another id, is refused.
- **No per-agent process-tree binding (D4) and no `notifications/tools/list_changed` injection.** Both deferred as the design allowed.
- **Rate limits are the design's numbers**: 10 requests a second sustained, burst 30, 4 open streams per agent per integration, 100 requests at once overall (plus the existing 8 per capability).
- **Tool discovery for the panel** is the broker acting as a client (initialize, initialized, every page of `tools/list`, then closing the session). It runs only when you press "Load tools", needs the integration switched on and signed in, and the descriptions it gets back are shown as plain text, cut short.
- **Slack's write scopes were NOT added** (section 12.3 had said Phase 3 would): which scopes, and when to ask for them, is a decision I should not make for you, and it cannot be tried without a Slack workspace.

**Properties, each pinned by a test**

- *Never on its own.* Without all four conditions an agent gets no entry and no capability (`mcp-wiring`, `mcp-phase3-integration`). Absent consent, a typo'd engine, `"true"` for `true`, a stale sign-in, an expired grant: all mean no.
- *The credential never crosses.* The upstream sees the engine's token and only that; the capability never goes upstream; the agent's config holds the broker URL and the capability and nothing about OAuth, a command, an environment or a provider (`mcp-broker-wiring`). A malformed entry (wrong host, a Google- or Slack-shaped token) is refused by the hive rather than written. One test plants a client secret, access and refresh tokens and a tool argument, drives success and every failure, and searches the agent's config, spawn arguments and environment, every response the agent saw, the activity log, the tool list and grants the panel is shown, the engine's log, the console and every file the hive wrote: nothing, and the scan is shown not to be blind.
- *Capabilities.* Unique per agent and per channel; a REST token is no use on the MCP path and vice versa; a respawn is a new capability and the old process's teardown cannot revoke the new one; ending an agent kills its capability and its config file at once and cuts what it was running.
- *Revocation.* Disconnect ends every agent's access before anything slow happens and cuts open streams; switching an integration off, or back to the bridge, is felt on the next request (and the exposure diff cuts what was open); a grant change is felt on the next request. Disconnect and switching off take the integration out of every running agent's capability **for good**: switching it back on gives it to agents started afterwards, not to the ones that were running. That is the safe way round and it can surprise.
- *What is checked is what is read.* A body with a repeated key anywhere in it is refused (a parser that takes the first value would otherwise act on a different tool name than the one the broker checked), and a `tools/list` inside a JSON-RPC batch is refused with the rest of the batch (its answer could not be filtered). A differential fuzz compares the repeated-key scan with an independent reader on 4,000 generated documents.
- *401.* The provider is told which credential was refused, hands over a newer one, and the request is replayed once with the same bytes; a second refusal, or nothing newer, ends it with "sign in again", no `WWW-Authenticate`, no upstream text, and no loop. A dead grant is asked about once and remembered, and the next spawn gets no entry. A provider of fixed secrets gets the upstream's 401 passed through as before.
- *Streams, limits, sessions.* Described above; a refusal costs the upstream nothing; an upstream session is closed when its agent ends or is respawned, and not at quit or Disconnect.
- *The panel's handlers.* Six privileged handlers check the sender first (top-level app page only); every field of a grant change is validated (integration, agent id, preset, bounded plain-text tool lists, expiry); `config:update` drops `mcpGrants` and `mcpEngine`, so a page that calls it cannot widen anything; the activity log holds metadata only.
- *The importer.* Copies an existing bridge sign-in, marks it expired so the first use refreshes it (proving the grant is alive), never overwrites an in-app record, never touches the bridge's copy, and refuses anything a stored record would refuse.
- *Quit.* A refresh already on the wire gets up to 1.5 s to finish, so a refresh token the provider has rotated is saved rather than lost; nothing new starts once the quit has begun; then the tokens held in memory are dropped.
- *Startup.* Every agent's MCP config from an earlier run is removed before anything spawns.
- *Each security-critical check was removed in turn* (39 mutations across the route, the stream reader, the JSON-RPC reader, the wiring rules, the hive, the importer, the sender check and the provider) and a test failed every time. Three of them first "survived" because the test hung instead of failing; those tests now fail by assertion.

**The real-client check (Phase 3's exit criterion).** `npm run test:real-client` (off by default; it asks a model to use two tools, so it costs a few cents of your Claude usage) runs the installed `claude` CLI (2.1.325) against the broker with a stand-in OAuth provider and a stand-in MCP server. Results (2026-11-15; each of the two checks was run once and passed): the server is `connected` with the capability in its header and no OAuth started by the CLI; the CLI's tool list is the filtered one; when the grant is narrowed after the CLI has listed its tools, a call to `send` comes back as the broker's "Not permitted" and never reaches the upstream, while `search` goes through; the upstream saw only the engine's token; nothing secret appears in the CLI's output. A second check has the server answer `tools/list` as an event stream (no model call): the CLI accepts the broker's re-emitted stream and sees the filtered list. **This is a stand-in server, not Google.**

**Layer 2 checked with the real CLI (one run, 2026-11-15, claude 2.1.325, macOS).** Using the settings the hive writes for agent `a1`, with agent `a2`'s `mcp-config.json` holding a marker: `echo` in the sandboxed shell works (the pattern in `denyRead` does not break the sandbox); `cat` of `a2`'s file is refused ("Permission ... has been denied"); the Read tool on it is refused ("File is in a directory that is denied by your permission settings"); `a1`'s own files still read; the marker appeared nowhere in the output. This is the first time section 6.6's layer 2 has been shown against the real CLI rather than assumed. It is defence in depth, not a boundary: see section 6.6.

**What the tests and the review found in this phase's own code (fixed)**

1. The event-stream reader treated the end of `data: x\n` as the blank line that finishes an event, so an event the server never finished was accepted. Found by the route test; the reader now follows the rule.
2. A `tools/list` answer had no read deadline once its headers had arrived: a server that sent headers and went quiet would have held the request for as long as the agent waited. Now 30 s.
3. Another agent's `mcp-config.json` (which now holds that agent's capability, and for secret-tier servers an API token) was readable by an agent. The hive now denies each agent the others' configs (a pattern for ones that do not exist yet, and every one that does) in the sandbox and in the file tools' rules. Layer 2 of section 6.6 for this file; see the limits below.
4. The general `config:update` handler would have let any page write the access grants or the engine switch. Those two keys are now dropped from it.
5. **A `tools/list` inside a JSON-RPC batch was forwarded and its answer returned unfiltered.** Latent since Phase 1, when nothing registered the route; found on review before it could matter. The batch is now refused.
6. **A repeated JSON key was a parser differential.** The broker checks a message by what its own parser makes of it (the last value wins) and forwarded the original bytes; a server that takes the FIRST value would have run a different tool than the one that was checked. Such a body is refused.
7. Three existing source-scanning tests were arranged around code I touched (generated-docs bootstrap, the spawn telemetry lines); the code was rearranged to keep them true rather than the tests changed.

**Existing tests that had to change, and why (none weakened):** `mcp-route.test.cjs` (the streamed-list test pinned "refused for now": it now pins the filtered stream and keeps the refusals for unreadable ones; the guard that pinned "index.ts registers no route and mints no capability" now pins HOW narrowly it does), `mcp-bridge-security.test.cjs` (the deny-read list gains the pattern for other agents' configs), `oauth-security.test.cjs` (quitting no longer aborts a refresh on the wire: the order is now begin-shutdown, drain, dispose). `broker-rest-characterization.test.cjs` is untouched (same SHA-256).

**Not verified, and not claimed**

- Any sign-in, refresh, tool call or revocation against Google or Slack through this path. What those servers do differently from the stand-in is unknown: whether a POST is answered as JSON or as an event stream (both are handled), whether they offer a GET stream, which tools and annotations they publish (so which are `read`), whether Google sends `iss`, whether Slack accepts a loopback redirect. That is Phase 4.
- That the deny-read rules hold on any platform but the one tried (macOS, claude 2.1.325, one run, above). The sandbox's own OS-level deny of a glob was not separately shown: the refusal came from the permission rules. An unsandboxed command, or a CLI release that reads rules differently, can still read another agent's file. Windows.
- A server that answers a request on a SEPARATE stream (the older HTTP+SSE transport) would deliver a tool list over the GET stream, which is passed through unfiltered. The `/mcp` endpoints these four use are Streamable HTTP, which answers on the request itself, but that is not verified. (The request's own answer, a 202, is refused.)
- Two app instances on one user-data folder; a crash between a provider rotating a refresh token and the save reaching disk.
- Per-agent tool lists are in the data model and the panel (Customize); a per-agent *class* pin is not.
- The Slack write-scope upgrade, process-tree binding, `list_changed` injection, a Windows CI job; README and CHANGELOG are not updated (the engine is opt-in and unverified).


**Results** (2026-11-15, macOS arm64, Node 22.12 for the suite, claude 2.1.325 for the real-client checks)

| Command | Result |
|---|---|
| `npm run test:focused` | **1,574 tests: 1,571 pass, 0 fail, 3 skip.** The skips are the existing Windows-only `resolveCommand finds agy …` test and the two real-client checks, which are off unless `MD_REAL_CLAUDE=1`. Baseline before Phase 3: 1,468; Phase 3 added 106. |
| `MD_REAL_CLAUDE=1 npm run test:real-client` | **2 pass** (stand-in provider and MCP server; the first asks a Haiku-class model to use two tools, a few cents of your Claude usage; the second makes no model call) |
| Layer 2 against the real CLI | one live run, passed (above) |
| Mutation checks | **39 of 39 removed checks were caught** by a test |
| `npm run typecheck`, `npm run build` | exit 0 |
| `node tools/verify-oauth-live.cjs --check-metadata` | 20 of 20 pinned endpoints match what Google and Slack publish (drift only, not the flow) |
| `test/broker-rest-characterization.test.cjs` | SHA-256 identical to before Phase 2 (`fb81ff85…9863`) |

New test files: `mcp-sse` 10, `mcp-route-phase3` 27, `mcp-jsonrpc-strict` 5, `mcp-wiring` 14, `ipc-sender` 5, `mcp-engine-switch` 5, `mcp-import` 9, `mcp-broker-wiring` 9, `mcp-phase3-integration` 20, `real-client` 2 (106). Fixture: `phase3-env.cjs` (the whole assembly, also used by the real-client check).

**To run the Phase 4 checks yourself, in the app:** Settings → MCP → switch the integration ON, store your client id and secret, choose **In-app (new)** as the sign-in method (an existing bridge sign-in is copied, not moved), press **Sign in**; then in **Access** press **Load tools from the service**, choose **Chosen tools**, tick the one read-only tool you want to try, and start a Claude Code agent. To go back, choose **Bridge**: nothing was deleted. `npx electron tools/verify-oauth-live.cjs <id> --refresh --call <tool> --args '<json>'` does the sign-in, refresh and one tool call without an agent (section 12.3).


### 12.5 Phase 4: the live gate (STARTED, NOT COMPLETE: nothing is verified against a real account)

**Rules for this phase (yours):** validation, not features; nothing committed, pushed or published; no integration on by default; deny-by-default unchanged; `mcp-remote` stays; nothing is called verified until it has been tested against a real account; no write grant while testing; a failed security check is reported, not worked around. **No file under `src/` was changed in Phase 4.** What was added is verification tooling and tests.

**Three kinds of result, kept apart throughout.**

| Kind | What the target was | What it can show |
|---|---|---|
| **STAND-IN** | a local OAuth provider and MCP server written for the tests | that the gate and the broker behave; nothing about Google or Slack |
| **REAL, NO ACCOUNT** | the real Google and Slack MCP endpoints, with **no credentials at all** | how the real servers answer, and how the real broker handles those real answers; nothing about signing in |
| **REAL ACCOUNT** | a real signed-in test account | everything in your checklist that involves a token. **NOT RUN.** |

**Why the third kind has not happened.** Nothing in this session can sign in for you: the OAuth client id and secret are yours to enter (never in chat), and the consent screen is yours to click. No client is stored on this machine (the app's data folder has no secret store at all). So the real-account steps are built, tested against stand-ins, and waiting for you (the runbook is at the end of this section).

**The gate** (`tools/verify-broker-live.cjs`, 39 steps). It assembles the real broker (capabilities, grants, the MCP route, the OAuth engine) exactly as the app does and drives it over loopback as an agent's CLI would. Only the target can be a stand-in. It refuses to talk to any host it was not told about; it records names, annotations, counts and codes and **never** a token, a client secret, a capability, a code or anything a tool returned; before it ends it searches everything it kept for every secret it ever held. Account mode defaults to a **throwaway profile** (your real one is not touched), prompts for the client id and secret in the terminal (the secret is not echoed; a test drives a real pseudo-terminal to prove that), grants **one read-only tool to one agent and nothing else**, ends by revoking what it created, and refuses to run while the app holds the same profile (see F1).

#### A. STAND-IN results (the gate itself)

| Check | Result |
|---|---|
| The whole account-mode checklist against a stand-in provider and server | all 39 steps pass, 0 skipped |
| Only the ONE chosen read-only tool is ever called upstream | passes; no write tool is ever called |
| The gate FAILS when the broker is broken | 3 deliberate breakages (ungranted tools let through, "no grant means write", one capability shared by two agents) each turn it red |
| The leak scan is not blind | a secret an agent was shown makes it fail |
| Evidence and output hold no secret | passes (client secret, access and refresh tokens, capabilities) |
| The client-secret prompt does not echo | passes, through a real pseudo-terminal; refuses to run without a terminal |
| A server that streams its tool list | handled and recorded as streamed |
| The gate's account mode under the REAL Electron binary, up to where an account is needed (4 tests) | starts and names its first failed step; refuses a profile another process holds (exit 2); refuses `--prompt-client` without a terminal; leaves no throwaway profile behind, on success or failure |
| The whole suite after Phase 4 | **1,594 tests: 1,590 pass, 0 fail, 3 skip, 1 todo** (the todo is F1, reproduced on purpose). Baseline before Phase 4: 1,574. Typecheck clean. `broker-rest-characterization` unchanged (same SHA-256). |

#### B. REAL ENDPOINTS, NO ACCOUNT (2026-11-15; evidence file kept outside the repository)

| Integration | Passed | Failed | Skipped (needs an account) |
|---|---|---|---|
| Google Calendar | 23 | **0** | 15 |
| Gmail | 23 | **0** | 15 |
| Google Drive | 23 | **0** | 15 |
| Slack | 8 | **0** | 20 (Slack wants an account even for `initialize`) |

What those passes mean, against the REAL servers: the broker loads and filters the real 119 KB / 88 KB / 78 KB tool lists; an agent granted one read tool sees exactly one; with no grant the real provider is never contacted; every other real tool (including 4 Calendar, 17 Gmail and 2 Drive write/destructive ones), look-alike names, a body with a repeated key and a tool list inside a batch are refused **before the provider** (0 upstream tool calls); the provider's real 401 (for no credential and for a deliberately invalid one) reaches the agent as "sign in again", with no `WWW-Authenticate`, no upstream text and no loop (one try and one replay at most); switching the integration off while an agent runs is felt on its next call; a REST token, a second agent's capability and a dead capability are all refused. **They do not mean anything about signing in, tokens, refresh or revocation.**

**What the real servers do (observed, no account):**

| | Google Calendar, Gmail, Drive | Slack |
|---|---|---|
| `initialize` without credentials | 200, `application/json`, `protocolVersion 2025-03-26`, `serverInfo "StatelessServer"`, **no `Mcp-Session-Id`** | 401, JSON `{"error":{"code":-32001,"message":"missing_authorization_header"}}`, `WWW-Authenticate: Bearer resource_metadata=…` |
| `tools/list` without credentials | **200, plain JSON, no streaming, no pagination** (Calendar 119 KB / 9 tools, Gmail 88 KB / 23, Drive 78 KB / 8) | 401 |
| `tools/call` with no token, and with an invalid token | **HTTP 401** with a JSON body (the invalid token gets `WWW-Authenticate: Bearer realm="https://accounts.google.com/", error="invalid_token"`) | 401, `-32001 invalid_token` |
| `GET`, `DELETE`, `OPTIONS` | **405** (no event stream is offered; no session to close) | 401 |
| Protected-resource metadata | published at `/.well-known/oauth-protected-resource/mcp/v1`; `bearer_methods_supported: ["header"]` | published; `["header","form"]` |
| Scopes the catalogue asks for vs the server's `scopes_supported` | **all present** (Calendar 3 of 3, Gmail 2 of 2, Drive 2 of 2) | **all present** (15 of 15 read-only scopes) |
| Authorization server | AS metadata `issuer` is `https://accounts.google.com`, `authorization_response_iss_parameter_supported: true`; **but the MCP servers' own metadata lists the authorization server as `https://accounts.google.com/` with a trailing slash** (see R2) | `https://mcp.slack.com`, identical to the pin |

**The error answers the engine depends on, from the real endpoints with made-up credentials (2026-11-15, no account):**

| Request | Real answer | What the engine does with it |
|---|---|---|
| Google `/revoke` with a made-up token | `400 {"error":"invalid_token"}` | "already invalid", counted as gone |
| Slack `auth.revoke?test=1` with a made-up token | `200 {"ok":false,"error":"invalid_auth"}` | same |
| Google token endpoint, unknown client | **`401 invalid_client`** ("The OAuth client was not found.") | a permanent failure: the sign-in is over, remembered, not retried |
| Slack token endpoint, made-up code | `200 {"ok":false,"error":"invalid_code"}` (HTTP 200 with Slack's envelope) | read through the Slack envelope as a refusal |

Consequences: the broker's 401 refresh-and-replay is triggered by what Google really sends (an HTTP 401, not a 200 with a JSON-RPC error); the streamed-list code path and the upstream session close are never exercised by Google (JSON, stateless); and Gmail now lists **23** tools (the 2026-11-14 retest saw 21), so any pin in the catalogue would drift and needs a refresh process.

#### C. The real tools discovered, and how they are classified (Google, from the public listing, 2026-11-15)

Every tool carries explicit `readOnlyHint` and `destructiveHint` annotations. **Today the broker classifies all 40 as unclassified (= destructive)**: nothing is pinned and annotations are not trusted, so no preset reaches any of them (the gate checks this on the real lists). For information, what each tool's own annotations imply under the broker's rules, were they trusted:

- **Google Calendar (9):** read (5) `list_events`, `get_event`, `list_calendars`, `suggest_time`, `search_events` · write (3) `create_event`, `update_event`, `respond_to_event` · destructive (1) `delete_event`.
- **Gmail (23):** read (6) `list_drafts`, `get_draft`, `get_thread`, `get_message`, `search_threads`, `list_labels` · write (9) `create_draft`, `label_thread`, `untrash_thread`, `unmark_thread_spam`, `label_message`, `update_message_labels`, `untrash_message`, `unmark_message_spam`, `create_label` · destructive (8) `unlabel_thread`, `apply_sensitive_thread_label`, `trash_thread`, `mark_thread_spam`, `unlabel_message`, `apply_sensitive_message_label`, `trash_message`, `mark_message_spam`. **There is no send tool**, which matches the catalogue's "cannot send".
- **Google Drive (8):** read (6) `download_file_content`, `get_file_metadata`, `get_file_permissions`, `list_recent_files`, `read_file_content`, `search_files` · write (2) `copy_file`, `create_file` (both `openWorldHint: true`) · destructive (0).
- **Slack:** not listed without an account. **Not recorded.**

If hints were trusted: 17 read, 14 write, 9 destructive. **A caution before anyone turns that on:** `create_event`, `update_event` and `respond_to_event` can notify other people (invitations, RSVPs) yet are annotated non-destructive and not open-world, so a `write` preset would allow an agent to email third parties. They should be pinned `destructive` by name first. (Observed from the annotations only; none of these tools was called.) Nothing was pinned in Phase 4: that is a catalogue change and needs your decision.

#### D. Security results

Held (stand-in AND real endpoint unless marked): deny by default; no grant, no contact with the provider; the read grant is exactly one tool; filtered lists with real data; other tools, write tools, look-alike names, repeated keys and batched lists refused before the provider; capability per agent, per channel, dead on teardown; the provider's 401 never leaks its text or `WWW-Authenticate`; switching off and Disconnect felt on the next call (stand-in); a failed refresh handled for a running agent (stand-in); no secret in any output or evidence (stand-in).

#### E. FAILED checks and UNRESOLVED risks (reported, not worked around)

**F1. FAILED (stand-in; open): two engines sharing one store can destroy a rotated sign-in.** If a provider rotates single-use refresh tokens and two processes refresh at the same moment, one gets `invalid_grant`, writes a "dead" marker over the other's freshly rotated tokens, and a restart then needs a new sign-in. A provider that keeps its refresh token (Google's behaviour) is unaffected: both refresh, nothing is lost. Reproduce: `node --test test/phase4-known-limits.test.cjs` (a `todo` test: it runs, shows the failure, and does not fail the suite). **How likely in practice:** the app takes `requestSingleInstanceLock`, which I checked with real Electron 32.3.3: a second instance on the same profile exits before its `ready` handler runs, so two apps cannot share a store. Anything else that opens the store can; the gate refuses to run beside the app for exactly this reason. Whether Slack rotates is unknown. **Proposed fix (needs your approval, not made):** after a permanent refresh failure, re-read the store and adopt a newer record instead of marking the grant dead, and/or a cross-process refresh lock.

**R1. A capability is a bearer handle.** An agent that reads another agent's capability string can use it, within that agent's grants. File isolation between agents is verified against the real CLI (section 12.4) but a process-tree binding (design D4) is not built.
**R2. Google issuer string (untested, fails closed).** The pinned issuer is `https://accounts.google.com`, which is what Google's authorization-server metadata publishes and what RFC 9207 requires `iss` to equal; the MCP servers' resource metadata writes it with a trailing slash. If Google's real authorization response carries the slash form, sign-in fails with `invalid-callback` and the log says `iss-mismatch`. Only a real sign-in settles it.
**R3. Slack loopback redirect (untested; read the warning).** Slack's documentation (docs.slack.dev, "Using PKCE") says a redirect to plain `http://localhost` is treated as a desktop redirect **only if the Slack app has opted in to PKCE, and that opt-in is one-way** (it marks the app a public client and cannot be undone without contacting Slack). Standard Slack OAuth requires `https` redirect URLs. The documentation names `localhost`; this app registers `http://127.0.0.1:33104/oauth/callback`, and nothing I found says whether Slack accepts the IP literal. **Do not enable PKCE on a Slack app you care about until you have read that page.** The Slack MCP documentation shows harness clients using a `callbackPort`, which suggests loopback callbacks are expected, but it does not state the redirect URI.
**R4. The consent screens ask for more than the broker will ever allow.** Calendar's three scopes are all read-only. Gmail asks for `gmail.compose` and Drive for `drive.file`, both write-capable: consenting gives the *app* that ability at Google even though the broker denies the tools. For a first run with read-only consent everywhere, use Calendar.
**R5. Annotation-implied "write" can reach other people** (section C).
**R6. Unknown until a real sign-in:** whether the authenticated tool list differs from the public one; how `tools/call` answers are framed (JSON or a stream); whether Google issues a refresh token under `access_type=offline` here; refresh-token expiry (7 days for a Google app in Testing); how quickly Google refuses an access token after revocation.
**R7. A server that answers a request on a separate GET stream** would deliver a tool list unfiltered. Google answers GET with 405; Slack's GET behaviour is unknown without an account.
**R8. Sessions.** Google is stateless, so session binding and session close have never run against a real server. Slack may issue sessions; unknown.

#### F. Checks that need Windows hardware (ALL UNVERIFIED; none was run)

`npm run test:store` on Windows (atomic replace on NTFS, an antivirus holding a file, a profile on OneDrive or a network drive, process-id reuse); real `safeStorage` on Windows (DPAPI) and the secret file's ACL (Windows ignores mode `0600`); `requestSingleInstanceLock` on Windows; the sandbox's deny-read patterns (there is no sandbox on Windows, so the permission rules are the only layer); `shell.openExternal` and the loopback listener on Windows; Claude Code on Windows reading the `--mcp-config` file and its `Authorization` header; the gate's hidden prompt in `cmd` and PowerShell; deleting the throwaway profile while Electron holds files.

#### G. REAL ACCOUNT checklist (every box is UNTICKED; a box is ticked only by a real run)

For each of Google Calendar, Gmail, Google Drive, Slack, one at a time: `[ ]` authorization and callback validation (state, PKCE, issuer) · `[ ]` token persisted encrypted and survives a restart · `[ ]` refresh · `[ ]` expiry · `[ ]` the real tool list (Slack's only) · `[ ]` one read-only tool granted to one agent and executed · `[ ]` another agent cannot use that capability · `[ ]` ungranted and write tools refused before the provider (already shown against the real Google endpoints without an account; repeat signed in) · `[ ]` running agent during disconnect, switching off, expiry, refresh failure · `[ ]` disconnect revokes immediately, and the provider refuses the old tokens · `[ ]` no secret in any output, log or evidence.

**Runbook (Calendar first).** Close the app. In a terminal on this machine:

    cd <your clone of this repository>
    # Node 22, not Node 26 (Homebrew's Node 26 breaks the native modules); on the machine this was written on that meant:
    export PATH="/usr/local/bin:$PATH"
    npx electron tools/verify-broker-live.cjs google-calendar --account --prompt-client --tool list_calendars --evidence ~/Desktop/phase4-calendar.json

Have ready: a Google Cloud OAuth client (type Web application, "Use this client for an AI-powered agent" ticked), `http://127.0.0.1:33102/oauth/callback` registered as a redirect URI, your test account added as a test user, and Workspace Developer Preview access for `calendarmcp.googleapis.com`. macOS may ask for Keychain access: that is the real `safeStorage` being used for the first time. The tool prints each step as PASS, FAIL or SKIP, then writes the evidence file (no secret in it) and revokes what it created.



### 12.6 Stage B: the security foundation (BUILT AND TESTED; the local servers are live-checked; no real provider account was used)

**Your instruction, in short.** Stage B first: fix F1 to F5 before any new provider; keep the `mcp-remote` bridge as the fallback; no key, token or provider secret may reach an agent, a renderer, terminal output or a log; every integration, local servers included, is opt-in; pin third-party packages and verify them; no commit, push or publication. At the review you added: verify B5 and B6 further (the eight points below), resolve the baseline test failures, and never call an integration verified on stand-in tests alone. Stage A has not been started.

**The model.** An agent reaches an MCP server only through the broker. Three gates, all required, all closed by default:

1. **Consent**: `mcpDefaults[id].enabled === true`. Nothing ships on; the six old defaults were reset once (`mcpOptInV1`), and a first-run, reset or brand-new config is born migrated.
2. **Ready**: the credential is stored (keyed servers) and the package is installed from its lock (local servers).
3. **Access**: a grant for *that agent* that is not `none`, per tool, optionally with an end time. An unclassified tool counts as destructive and is never part of `read` or `write`.

What an agent is given is `{type:'http', url:'http://127.0.0.1:<port>/m/<id>', headers:{Authorization:'Bearer <capability>'}}` and nothing else: no command, argument, environment variable or key. The only exception is the bridge fallback for Gmail, Calendar, Drive and Slack, which you told me to keep intact: while its engine is `bridge` (the default for those four) the agent's own CLI launches `mcp-remote`, as before.

| Step | What was built | Where | Held by |
|---|---|---|---|
| B1 (D7, F1) | No catalogue entry ships on; one-time migration; a hire manifest can *request* servers but none is enabled | `mcpCatalog.ts`, `config.ts` | `mcp-opt-in.test.cjs` |
| B2 (F5) | Durable audit trail: hash-chained JSONL (HMAC when the key is in the encrypted store), rotation 2 MB × 6, a scrub backstop for credential shapes, and a sealed anchor (`head.json` plus a copy in the encrypted store) that catches truncation, deleted files and rollback | `broker/audit-store.ts` | `audit-store.test.cjs`, `audit-wiring.test.cjs` |
| B3 (F2) | Six config secrets (Slack signing secret and bot token, Groq key, org-trigger key, webhook secrets, the legacy webhook secret) moved out of `config.json` into the encrypted store, write-then-verify; the renderer learns only whether one is set | `configSecrets.ts`, `config.ts` | `config-secrets*.test.cjs` |
| B4 (F3) | REST grants: same model as MCP, judged request by request (`METHOD /path` under the base URL); GET, HEAD, OPTIONS read; POST, PUT, PATCH write; DELETE and unknown methods destructive; a GraphQL POST is read only if its document is a query; method-override headers stripped; default none | `broker/rest-permissions.ts`, `rest-route.ts` | `rest-*.test.cjs` |
| B5 | Every package pinned to an exact version with a per-package lock (npm `package-lock.json` with sha512, or PyPI `requirements.txt` with sha256); installed with `npm ci --ignore-scripts --omit=dev` or `uv pip install --require-hashes --no-deps --no-build`; a marker is written last, and a lock that changed since is refused; tool classes pinned from each server's real tool list | `mcpPackages.ts`, `resources/mcp-locks/` | `mcp-packages.test.cjs`, `mcp-pins.test.cjs` |
| B6 | The app runs every local server: one child per (agent, integration), request ids rewritten, the agent's capabilities replaced, process-group kill, timeouts and limits; the credential goes over a private pipe and is set in-process, never in arguments or the initial environment | `broker/stdio-host.ts`, `mcpLaunch.ts`, `mcpCredentials.ts` | `stdio-host.test.cjs`, `mcp-launch.test.cjs`, `stage-b-e2e.test.cjs` |
| B7 | Skill installs cannot grant tools, run hooks or install anything (see the guard below) | `skillGuard.ts`, `skills.ts` | `skill-guard.test.cjs` |
| B8 | Settings: package state and an Access panel for every server; the documents | `McpDefaultsSettings.tsx` | typecheck, i18n parity tests |

**Why the credential travels on a pipe.** Measured on macOS, a variable set when a process starts is visible to any process of the same user through `ps eww`; one set afterwards, inside the process, is not. So the app starts the server through a small launcher that reads the credential from file descriptor 3, sets it in-process, and only then imports the server. A server that cannot be given its credential that way (a non-Node runtime) is not started: there is no fallback to the environment.

**The skill guard.** For every markdown file in a skill: `allowed-tools`, `hooks`, `mcpServers` and `permissionMode` are removed from the front matter, whatever the spelling or YAML shape, and inline `!`cmd`` and fenced `!` commands are defused. `.mcp.json`, `settings.json`, `hooks.json`, `plugin.json`, `.claude/`, `.git*` and similar files are not written. Files are mode 0644. Nothing is executed and no dependency is installed (neither module can reach `child_process`, and neither imports the grants). A record of the source and the hash of both the downloaded and the installed version of each file is kept outside the skill folder. Scripts and dependency files are written as plain data and listed for you.

#### The eight added points: where each is proved

| # | Point | Automated | Live | Not covered |
|---|---|---|---|---|
| 1 | Every pinned package installs, starts, lists tools and takes a real call; `npm ci --ignore-scripts` not assumed | locks, markers, refusal on mismatch, pins and tool-class snapshots | `tools/verify-packages-live.cjs`: 10 of 10 packages, on Node 26.3 and on Node 22.12 | Notion and Brave answered a fake key with a refusal (proves the path only); Browser needs a Chromium the app does not install (present here); Windows, Linux |
| 2 | No credential in config, arguments, environment, terminal or logs | `stage-b-e2e` (2), `stdio-host` (pipe, `ps eww`), `mcp-launch` | `tools/verify-stage-b-live.cjs` with a canary, a real `claude` CLI | A same-user debugger reading a server's memory |
| 3 | Every stdio server is launched and controlled by the app | `stage-b-e2e` (3): its parent is the app, the agent has no way to start one, a stdio server listens on nothing | every server process is a child of the app and none a descendant of the CLI | The bridge fallback, by design |
| 4 | Direct-server bypass and cross-agent reuse | `stage-b-e2e` (4): another agent's or integration's server, a capability on the wrong channel, hostile ids, hosts, origins and methods, a switched-off integration | after revocation the same config connects to nothing | PID binding (D4) is not built: a capability is a bearer handle |
| 5 | Rotation keeps the chain; deletion, truncation and modification are detectable | `audit-store` (26): edit, delete, swap, invent, rotation, truncation, deleted newest and oldest files, anchor edited, history rebuilt, rollback, `head.json` deleted | not applicable | Records inside the anchor window (at most 10 records or 1 s); someone who can write the folder *and* holds the key |
| 6 | MCP and REST revocation, split into stopped before the provider and already executing upstream | `stage-b-e2e` (6): after revocation a request never reaches the server; one running is cut off and the server killed; what it had already done stays done; against a real upstream, a REST request in flight is cut from the agent while the upstream had already received it | the revoked config connects to nothing | Anything a real provider does with a request it had already accepted |
| 7 | A third-party skill cannot run hooks, install dependencies or grant tools | `skill-guard` (14) | not applicable | An agent that is later told to run a shipped script still can |
| 8 | Baseline failures | the full suite, run twice, compared with the recorded pre-Stage-B run | | see the report |

#### Results at the end of Stage B

| What | Result |
|---|---|
| Typecheck (node and web) and `electron-vite build` | clean; the packaged app has not been built |
| Recorded baseline before Stage B (end of Phase 4) | 1594 tests: 1590 pass, **0 fail**, 3 skipped, 1 todo (the open Phase 4 finding F1). That tree was never committed, and my snapshot of it was lost when the scratch folder was cleared, so it cannot be re-run; the figure is the one printed at the time |
| Full suite, first run on the final tree | 1784 tests: 1776 pass, **4 fail**, 3 skipped, 1 todo (below) |
| Full suite, second and third runs after the fixes | **1785 tests: 1781 pass, 0 fail**, 3 skipped, 1 todo (F1), both times (the third after every document was final). One test more than the first run: the regression test for the idle race |
| Skipped | 2 real-CLI tests (they need `MD_REAL_CLAUDE=1`; `verify-stage-b-live.cjs` does the same thing and was run), 1 Windows-only path test |
| `tools/verify-packages-live.cjs` | 10 of 10 as expected on Node 26.3 and on Node 22.12: seven PASS with real answers, Notion and Brave LIMITED (a fake key, refused by the provider), `mcp-remote` PASS against a stand-in server |
| `tools/verify-stage-b-live.cjs`, real `claude` 2.1.325, model haiku | 26 of 26 checks, one N/A (the environment of the CLI process cannot be read on macOS), 6 turns, about $0.0044 |

**The four failures of the first run, and what each was.** None was a failure in the recorded baseline, so none is "pre-existing" in the sense of failing before Stage B.

1. `ipc-sender`, `mcp-engine-switch` (2 tests): **regressions of my own edits to `index.ts`, caught late.** Each pinned an exact piece of source: the config-update handler as `withoutProtectedKeys(patch)` alone, and the engine switch as using `capableMcpEntry`. Stage B wrapped the first in `withoutSecretKeys(...)` and, because `capableMcpEntry` now means any integration the broker serves, gave the switch its own narrower lookup `oauthEngineEntry`. The tests now pin the new text, and `mcp-engine-switch` additionally asserts that the wider lookup is *not* used there.
2. `stdio-host` "an idle child is stopped and comes back on demand": **a real race in my host.** The idle timer was armed when a request *started* and stopped the child without asking whether a request was still waiting, so a slow start or a slow tool could be cut off. It cannot happen at the shipped 10-minute idle time and 2-minute request limit, but it is wrong. Fixed (an idle timer re-arms while anything is pending), with a new test that fails on the old code with the same error as the flake and passes on the new.
3. `verify-broker-live-electron` "--prompt-client without a terminal": **intermittent, not caused by Stage B, not fully explained.** The gate tool and both of its test files are unchanged since before Stage B. The test failed once, under the load of the whole suite, because an empty `mosbius-gate-*` throwaway profile appeared and stayed in the OS temp folder; it passed alone (5 of 5, twice), and in the second and third full runs a watcher saw all three gate profiles created and deleted within about a second each. I think the cause is Electron recreating the profile folder just after the tool removed it; I did not prove it. A leftover of the same family, holding a stale `Singleton*` lock from a killed process, was already in the temp folder before that run, probably from a test run of mine that was interrupted.

**Existing tests I changed in Stage B** (all because a deliberate behaviour changed, none to make a failure go away; the old assertion is named where it no longer applies):

| Test file | Change |
|---|---|
| `mcp-config-wiring` | Four tests that assumed six servers on by default and an agent config carrying commands were replaced by nine that assert the broker-only shape (`type`, `url` and one `Authorization` header and **no** `command`, `args`, `env`), that nothing is written when nothing is on, that no catalogue entry ships on, that a stored key is in no file or spawn argument, and that a malformed entry is never written. The old "filesystem and git are pinned to the agent workspace" check moved to `mcp-launch.test.cjs`, where the launch is now built |
| `mcp-phase3-integration`, `oauth-security`, `mcp-broker-wiring` | "Nothing written" is now also true of the file itself: with nothing switched on there is no `mcp-config.json`, which is stricter. Assertions that no server of any kind is written were added |
| `mcp-wiring` | **Deliberately reversed:** "the in-app engine can serve exactly the four OAuth integrations, and nothing else" became "the broker serves every catalogue integration; a bridged one only once its engine is `broker`", with new checks that consent is the only switch and that an engine flag is not consent. `PROTECTED_CONFIG_KEYS` gained `restGrants`; a hosted-server test was added |
| `mcp-route` | A structural check of how `index.ts` wires the route was rewritten for the composite credential provider and the host. A check that `mcpSecret` appears nowhere in `index.ts` is as strict as before (it had to be narrowed once because `mcpSecretRefs` appeared, and was restored to the bare word) |
| `mcp-bridge-security` | The fixture now hands the hive a capability instead of a token, and asserts that the config holds the capability and **not** the token |
| `ipc-sender`, `mcp-engine-switch` | Above |
| `release-notes` file guard | not edited; the notes file was shortened to fit it |

**Unresolved, and said plainly.** (a) A capability is a bearer handle readable by anything running as you that can read the agent's config; D4 (binding it to the agent's process) is not built. (b) Revoking stops the next request and aborts those in flight, but cannot undo effects already produced or recall a request a provider has already received. (c) The bridge fallback still launches `mcp-remote@0.16.6` through `npx -y` from the agent's CLI with its tokens in readable files while in use; the verified-install path exists and is tested but is deliberately not wired to it. (d) The agent engines' own installers still use `@latest`; that is a separate surface. (e) Only Claude Code agents are connected to the broker; Codex and Gemini CLI are not, and nothing claims they work. (f) GitHub's hosted tool classes are not pinned (that needs a token), so `read` and `write` allow nothing there until tools are ticked by name; the four OAuth services are unpinned too. (g) Notion and Brave were exercised with a fake key only; GitHub, Gmail, Calendar, Drive and Slack with nothing real; **none of those is verified**. (h) Windows and Linux are untested. (i) The REST capability reaches only the workers the lead agent hires, through their environment. (j) Phase 4 finding F1 (rotating refresh tokens against a shared store) is still open.

---

### 12.7 The connection layer and the three agent CLIs (BUILT AND TESTED; Claude Code, Codex and Gemini CLI run for real against a stand-in model and provider; no real provider account used)

**Connections.** A hosted server can be connected with an account and no pasted key. `src/main/connect/` holds it: `discovery` (RFC 9728 and 8414, limited to hosts the catalogue pins, https, no credentials; a server with no resource metadata names its authorization server in the catalogue), `loopback` (a random-port `127.0.0.1` listener that accepts only a top-level navigation, checks `state` and `iss` (RFC 9207), and refuses a second callback), `flows` (`dcr`: a public client registered per sign-in, PKCE S256, the RFC 8707 `resource`, revocation (RFC 7009) and client removal (RFC 7592); `device`: RFC 8628), `grant-store` and `manager`. Tokens go through the existing `OAuthTokenProvider` (single flight, write-ahead rotation, expiry margin, dead grants) and the existing `TokenStore`; nothing a provider returned is ever given to the page, which sees a `ConnectionSummary` of statuses and fixed error codes only. `src/shared/providers.ts` is the manifest the Discover tab draws; `verified` and `limited` need an evidence file in the repository, enforced by `test/providers.test.cjs`.

**Which agents get a pass, and how.** `src/main/index.ts` mints a pass (`integrationBroker.grantMcp`) for an agent of one of three CLIs only, and only for integrations the user switched on and granted that agent. `src/main/hive.ts` then hands it over in the way that CLI reads:

| CLI | Mechanism | Where the pass is | Verified |
| --- | --- | --- | --- |
| Claude Code | `--mcp-config <agent folder>/mcp-config.json`, `type: http` | the file (`0600`), on the agent's deny-read list | real CLI, `tools/verify-stage-b-live.cjs` |
| Codex CLI | `-c mcp_servers.<name>.url=…` and `-c mcp_servers.<name>.bearer_token_env_var=…`; the value in one variable (`MOSBIUS_MCP_SECRET_TOKEN_<ID>`) | the Codex process's environment, out of its shell's environment, and out of reach of a command in the shell **while Codex's OS sandbox is on** (with it off, `ps` reads it from the Codex process: measured) | real CLI 0.142.2 with a stand-in model, `tools/verify-codex-live.cjs` |
| Gemini CLI | `mcpServers.<name>.httpUrl` and `headers.Authorization: "Bearer $VAR"` in the user settings of a Gemini home of the agent's own (`GEMINI_CLI_HOME`), the person's settings merged in and their login, skills and extensions linked in; the value in `VAR`; trust from the person's own `trustedFolders.json` | the Gemini process's environment, **and so its shell's** (measured) | real CLI 0.68.0 with a stand-in model, `tools/verify-gemini-live.cjs` |

**What the Codex run found.** (1) The stand-in provider the tests used answered `404` to the transport's `GET` and `DELETE` and listed tools with no `inputSchema`. Claude Code tolerates both; Codex's typed client rejects the list as "unexpected response type" and treats a `404` on a live session as "session expired". The route passes a conforming server's answers straight through (a regression test pins `405` for `GET`, `204` for `DELETE`, the tool schema kept, an ended session refused). (2) Codex's default `shell_environment_policy` does **not** drop `*TOKEN*`, `*KEY*` or `*SECRET*` variables from the shell it runs for the model, and its shell snapshot (a stable feature, on by default) re-exports the whole environment into every command, defeating any exclusion. For a Codex agent that has an integration the app sets `features.shell_snapshot=false` and `shell_environment_policy.exclude=[<the user's own patterns>, "MOSBIUS_MCP_*"]`. The run carries a control (the same run without those two settings shows the variable to the shell). (3) Codex reads skills from `~/.agents/skills`, `<project>/.agents/skills` and `.codex/skills`, not `.claude/skills`, so skills install per target (`src/shared/agentCompat.ts`).

**What the Gemini run found.** (1) The first design (a system settings file) could not work: Gemini 0.68.0 skips a system settings file unless the folder holding it is owned by root ("Security Warning: Skipping system settings file"), so the user layer of an isolated `GEMINI_CLI_HOME` is the one layer an app can own. (2) The route's browser guard refused every request from the real CLI: Node's built-in `fetch` adds `Sec-Fetch-Mode: cors`, and the guard refused any `Sec-Fetch-*` header. It now treats `cors` alone as a program and still refuses `Origin`, `Sec-Fetch-Site`, `-Dest`, `-User` and every other mode (`looksLikeBrowser`). (3) Gemini expands `$VAR` in `headers` from its own environment, names a tool `mcp_<server>_<tool>`, and refuses a tool it was not offered before the broker is reached. (4) It loads an MCP server only in a folder the person has trusted in Gemini; the app uses the person's own trust file and never `--skip-trust`. (5) Its shell inherits the whole environment, so the pass is readable there, and **no Gemini setting can stop that** (F9, closure attempted and left open): the pass must be in Gemini's own environment because Gemini expands `$VAR` in its settings from `process.env` at start-up, and a command in its shell can read the processes above it (`ps eww`); the CLI has no per-variable lever (`sanitizeEnvironment` returns the whole environment unless the global redaction is on); and the global redaction, even with every name allowed, still hides `SSH_AUTH_SOCK`, other secret-named variables (the shell command is sanitized a second time with a filter that drops such names from the allow list) and credential-shaped values (checked before the allow list). A `BASH_ENV` start-up file hides the pass from `env` only and is not shipped; Gemini's own macOS sandbox did not start on the isolated-home layout. The pass is bounded by the grant (the run builds a request by hand with the pass and is refused for every tool outside the grant). The same `ps` route applies to Codex once its sandbox is off; its sandbox (`-s workspace-write`) refuses it, so Codex's label carries that condition.

**What is not known.** A real OpenAI or Gemini model's use of the offered tools was not tested; both runs used a scripted stand-in model, with no Codex or Gemini sign-in. Whether a real Gemini login reaches an agent through the links the app makes was checked for structure only. Other Gemini CLI versions were not run.

## 13. Unknowns, risks and size

**Cannot be known without real accounts** (and so cannot be called verified):

- Whether Google's and Slack's authorization servers accept this exact flow (endpoints, `access_type=offline`, `resource`, scopes) and issue refresh tokens.
- The real tool names, annotations and classes for the four servers; until pinned, the `read` preset allows nothing.
- Whether Slack accepts an `http://127.0.0.1` redirect URL.
- Whether `revoke` works for tokens minted through these MCP servers.
- Whether Claude Code is happy with a local broker's `Mcp-Session-Id`, SSE and 401 behaviour. The real-client check in section 11 covers this against a stand-in, not against Google.

**Risks**

| Risk | Size | Mitigation |
|---|---|---|
| Refactoring the REST broker changes behaviour | Medium | Characterization tests first; facade keeps the API |
| SSE/JSON-RPC filtering has edge cases | Medium | Strict parser, fuzzing, fail closed |
| Google Testing-status weekly expiry annoys users | Certain for personal use | Say so in the UI; publishing the OAuth app removes it |
| Same-user process reads a capability (T5) | Real | D4 hardening phase; documented |
| Larger codebase to own than a bridge | Medium | Zero new dependencies; electron-free modules with injected deps |

**Size (rough)**: about 2,700 lines of new code, about 3,000 lines of tests, one new Settings section, about 30 new strings per language. Phases 0 and 1 are valuable on their own (a tested, atomic store; a tested broker) even if you stop there.

**What I recommend you approve**: Phase 0 and Phase 1 first, because they are behaviour-neutral and make everything after them provable; then decide on D2 (default access), D4 (process binding) and D5 (fallback) before Phase 2 starts.
