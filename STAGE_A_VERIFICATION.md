# Stage A: what was checked against the real providers, and what is still open

Tool: `tools/stage-a-spike.cjs` (not product code; tested against a stand-in by `test/stage-a-spike.test.cjs`, 31 tests).
Stand-in results prove the tool behaves. They prove nothing about a provider. Everything below that says "live" came from
the real service on the date given; everything that says "docs" came from the provider's own pages, read by a helper, and is
marked as such until a live run confirms it.

## 1. Public metadata, read live on 2026-11-15 (no account, nothing registered)

`node tools/stage-a-spike.cjs metadata` asks each server for an unauthenticated `initialize`, follows its
`WWW-Authenticate` to the resource metadata, then to the authorization server metadata, and refuses any endpoint that is
not on a host the provider is pinned to.

| Provider | Self-registration (RFC 7591) | Public client (`none`) | PKCE | Revocation | `iss` on redirect | Client-ID metadata document | Notes |
|---|---|---|---|---|---|---|---|
| Notion | yes | yes | S256 | at the token endpoint | yes | yes | scope `default` |
| Linear | yes | yes | S256 | at the token endpoint | yes | yes | scopes `read`, `write` |
| Sentry | yes | yes | S256 | at the token endpoint | yes | yes | scopes `org:read`, `project:write`, `team:write`, `event:write`, `alerts:write` |
| Stripe | yes | yes, and only that | S256 | own endpoint | no | no | the authorization server is `access.stripe.com/mcp`, named by `mcp.stripe.com`'s own metadata; scope `mcp` |
| Atlassian | yes (`mcp.atlassian.com/v1/register`) | yes | plain and S256 | at the token endpoint | no | no | publishes **no** resource metadata; `mcp.atlassian.com` is its own authorization server |
| Slack | **no** | **no** (`client_secret_post` only) | S256 | none advertised | no | no | confidential OAuth with the app's own client id and secret |
| GitHub | **no** | not advertised | S256 | none advertised | yes | no | hosts must bring their own GitHub App or OAuth App |
| Google Calendar | **no** | **no** (`client_secret_post`, `client_secret_basic` only) | plain and S256 | yes | yes | no | `initialize` and `tools/list` answer without a token; `tools/call` needs one |

What this decides: Notion, Linear, Sentry, Stripe and Atlassian can be connected with no client secret and no Mosbius-owned
registration, by registering a public client for each sign-in. Slack, GitHub and Google cannot be reached that way: each
needs an app that someone registers.

## 2. From the providers' own documentation (not yet confirmed by a live run)

**Google.** Workspace MCP guide, "Manage OAuth clients" and the desktop-app page.
- A user-delegated client that calls the Workspace MCP servers must have **"Use this client for an AI-powered agent"**
  ticked (Google Auth Platform > Clients). It is a self-declaration and grants no extra scope. Some Workspace endpoints
  accept only such clients. The guide's examples all use the **Web application** type; whether a **Desktop app** client
  may be flagged and used is **not stated**.
- For a desktop client Google says the secret is **optional** at the token endpoint and at refresh, and that desktop apps
  are public clients; whether a Desktop client's secret may be shipped inside an app is not stated.
- Access is a **Developer Preview** and needs membership of the Google Workspace Developer Preview Program (an
  application form, a Google Group and registration of the Cloud project; "a couple of days"; per Workspace account and per
  project; service accounts cannot be registered).
- Calendar MCP scopes: `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.readonly`.
- External app in **Testing**: at most 100 test users, authorization lasts **7 days** (basic scopes exempt). In production
  and unverified: 100 new users for the life of the project, hidden app name, unverified-app warning.

**GitHub.** Device flow and refresh pages, REST pages for OAuth applications, the MCP server README.
- Device flow needs **no client secret** for an OAuth App or a GitHub App, but "Enable Device Flow" must be ticked, and a
  callback URL is not needed.
- A GitHub App user token lasts 8 hours; its refresh token lasts 6 months and is **single use**. The refresh needs the
  client secret **unless the token came from the device flow**, so a device-flow token can refresh without a secret.
- An OAuth App token does not expire unless the app opts in.
- **Revoking** a token or an authorization (`DELETE /applications/{client_id}/token` and `/grant`) needs the client id
  **and** secret as Basic auth. A public client cannot revoke at GitHub; the user ends it in GitHub's settings.
- The remote server accepts OAuth and a PAT; it does not say which kinds of OAuth token. The OAuth App `repo` scope is read
  **and write** to all private repositories, and there is no read-only repository scope. The server offers a read-only
  mode by URL suffix (`/readonly`) or the `X-MCP-Readonly` header, which the broker could add for read-only grants.

**Slack.** PKCE, token rotation and MCP server pages.
- With PKCE the code exchange and the refresh of a desktop-redirect token need no client secret. Opting an app in to PKCE
  is **one-way** (Slack support must undo it). `http://localhost` redirects count as desktop redirects only for an app that
  opted in; `127.0.0.1` is not mentioned. With PKCE, refresh tokens expire after 30 days and rotate.
- The MCP server says it uses **confidential** OAuth with the app's client id and secret, supports no dynamic
  registration, and allows only apps published in the Slack Marketplace and internal apps. User tokens only.

## 3. Live runs

A live run registers or uses something at a real provider and needs the owner's sign-in, so each is a request, never
something the tool starts by itself. Result column is filled only from an evidence file.

| Run | Command (run it in your own terminal) | Needs | Result |
|---|---|---|---|
| Notion (self-registering) | `node tools/stage-a-spike.cjs dcr notion --tool notion-search --args '{"query":"notes"}' --wait 15 --evidence ~/Desktop/stage-a-notion.json` | your Notion sign-in | **PENDING** |
| GitHub (device flow) | `node tools/stage-a-spike.cjs device github --client-id <ID> --tool get_me --wait 15 --evidence ~/Desktop/stage-a-github.json` | an app you registered (below) | **BLOCKED** until the app exists |
| Google Calendar (desktop client, no secret) | `node tools/stage-a-spike.cjs pkce google-calendar --client-id <ID> --secret none --tool list_calendars --wait 15 --evidence ~/Desktop/stage-a-google.json` | Developer Preview membership, a Cloud project, a client | **BLOCKED** |
| Google Calendar (with the secret, if the first fails) | the same with `--secret prompt` (the secret is typed at a hidden prompt) | as above | **BLOCKED** |
| Linear, Sentry, Stripe, Atlassian | the Notion command with the provider name | your sign-in at each | verified through the product's own sign-in once it exists; the tool can be used first if you want |

## 4. Exact setup for the identities only you can create

**GitHub App (for the device flow).**
1. GitHub > Settings > Developer settings > GitHub Apps > New GitHub App.
2. Name: anything unique, for example `Mosbius and Co (test)`. Homepage URL: your repository's address. Callback URL: leave empty.
3. Tick **Enable Device Flow**. Leave **Expire user authorization tokens** ticked. Untick **Webhook > Active**.
4. Permissions, repository: Contents, Issues and Pull requests, each **Read-only** (Metadata is added for you). Nothing else.
5. Where can it be installed: **Only on this account**. Create the app.
6. Copy the **Client ID** (a public value; you may paste it into this chat). Do **not** generate a client secret.
7. Install the app on your account, choosing a few repositories.
8. If the remote server rejects a GitHub App token, repeat with Developer settings > **OAuth Apps** > New OAuth App, tick
   **Enable Device Flow**, and tell me; the scope then requested is `repo read:org` (coarse: read and write to all your private repositories).

**Google (Calendar first).**
1. Join the **Google Workspace Developer Preview Program**: https://developers.google.com/workspace/preview, the application
   form. It asks for a Google Workspace account and a Cloud project; approval takes days. Start this first.
2. Cloud Console: create or pick a project. Enable **Google Calendar API** (`calendar-json.googleapis.com`) and the Calendar MCP
   service (`calendarmcp.googleapis.com`).
3. Google Auth Platform > Audience: **External** (or Internal on a Workspace organisation); add yourself as a **test user**.
   Data access: add `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.readonly`.
4. Clients > Create client. Choose **Desktop app** first, and look for **Use this client for an AI-powered agent**: tick it
   if it is there, and tell me whether it was. Copy the **Client ID** (public). Do not paste a secret anywhere.
5. If a Desktop client cannot be flagged or the MCP server refuses it, create a **Web application** client instead, tick the same
   box and register one exact redirect URI such as `http://127.0.0.1:34102/oauth/callback`; I run it with `--redirect-port 34102`.

**Slack** (later, and only if you want it): an internal or Marketplace app; opting in to PKCE cannot be undone without Slack
support; a workspace admin must approve. I will not ask you to do this until everything else is done.

## 5. Decisions the evidence already supports

1. **No Mosbius backend is needed for Notion, Linear, Sentry, Stripe or Atlassian.** Each registers a public client per sign-in.
2. **GitHub** is likely backend-free too through the device flow, but cannot revoke at the provider without a secret, and the
   token kind the remote server accepts is unconfirmed.
3. **Google is the one real unknown.** Its metadata advertises no public-client method. If a Desktop client's exchange works
   without the secret, no backend is needed; if it needs the secret, the choice is the owner's: ship Google's own "not
   confidential" desktop secret, or run a small token-exchange gateway. Neither is chosen until the live run answers.
4. **Slack stays a customer-owned app**, as built.
