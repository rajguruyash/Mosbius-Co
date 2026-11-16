/**
 * Every provider the app can connect an agent to, in one list: what it is, which catalogue entries and REST
 * templates serve it, how a user gets in, and how far it has actually been checked. This is what the
 * Discover tab draws; it holds no secret and no endpoint (those live with the entries it points at).
 *
 * `verification` is deliberately stingy. A provider is `verified` only when a real sign-in or key was used
 * for a real call, and the file that proves it is in this repository: test/providers.test.cjs fails the
 * build if a `verified` or `limited` provider names no evidence file, or one that does not exist. Stand-in
 * results never count. Everything else says `untested`, in as many words, to the user.
 */

export type ProviderCategory = 'knowledge' | 'dev' | 'work' | 'comms' | 'payments' | 'search' | 'crm' | 'local' | 'custom' | 'ai';

/** How a user gets in, in the order the Connect button tries them:
 *    account  sign in with the account itself (the app registers itself; no key, no app of yours)
 *    device   a short code typed at the provider's page (needs an app the provider has registered)
 *    own-app  an OAuth app YOU register at the provider, then one sign-in
 *    key      a token or API key you create at the provider, kept encrypted and never shown to an agent
 *    local    nothing to connect: the app runs it on this computer
 *    engine   the key an agent's own engine uses (Settings > AI engines)
 */
export type Way = 'account' | 'device' | 'own-app' | 'key' | 'local' | 'engine';

export type VerificationStatus = 'verified' | 'limited' | 'untested' | 'planned' | 'na';

export interface Verification {
  status: VerificationStatus;
  /** The day the evidence was gathered. */
  on?: string;
  /** A file in this repository that holds the evidence. Required for `verified` and `limited`. */
  evidence?: string;
  /** What the evidence does and does not show, in plain words. Shown to the user. */
  note: string;
}

export interface ProviderManifest {
  id: string;
  label: string;
  category: ProviderCategory;
  /** MCP catalogue entries that serve it, the preferred one first. */
  mcp: readonly string[];
  /** REST templates (by label) that serve it. */
  rest: readonly string[];
  ways: readonly Way[];
  verification: Verification;
}

const LOCAL_EVIDENCE = 'evidence/stage-b/packages-node26.json';
const LOCAL: Verification = {
  status: 'verified', on: '2026-11-15', evidence: LOCAL_EVIDENCE,
  note: 'Installed from its hash-pinned lock, started by the app, and answered a real tool call. Tested on macOS only.'
};
const NO_ACCOUNT = (what: string): Verification => ({
  status: 'untested',
  note: `${what} Nobody has signed in to this provider through the app yet, so it is not marked verified.`
});

export const PROVIDERS: readonly ProviderManifest[] = [
  // ─── run on this computer, no account ───────────────────────────────────────
  { id: 'sequential-thinking', label: 'Sequential Thinking', category: 'local', mcp: ['sequential-thinking'], rest: [], ways: ['local'], verification: LOCAL },
  { id: 'time', label: 'Time', category: 'local', mcp: ['time'], rest: [], ways: ['local'], verification: LOCAL },
  { id: 'fetch', label: 'Fetch', category: 'local', mcp: ['fetch'], rest: [], ways: ['local'], verification: LOCAL },
  { id: 'filesystem', label: 'Filesystem', category: 'local', mcp: ['filesystem'], rest: [], ways: ['local'], verification: LOCAL },
  { id: 'git', label: 'Git', category: 'local', mcp: ['git'], rest: [], ways: ['local'], verification: LOCAL },
  { id: 'context7', label: 'Context7 docs', category: 'local', mcp: ['context7'], rest: [], ways: ['local'], verification: LOCAL },
  { id: 'playwright', label: 'Browser', category: 'local', mcp: ['playwright'], rest: [], ways: ['local'], verification: LOCAL },

  // ─── sign in with the account ───────────────────────────────────────────────
  {
    id: 'notion', label: 'Notion', category: 'knowledge', mcp: ['notion-hosted', 'notion'], rest: ['Notion'], ways: ['account', 'key'],
    verification: NO_ACCOUNT('The sign-in service publishes what the app needs (read on 2026-11-15). The local token-based server answered a fake token with Notion\'s refusal.')
  },
  { id: 'linear', label: 'Linear', category: 'work', mcp: ['linear'], rest: ['Linear'], ways: ['account', 'key'], verification: NO_ACCOUNT('The sign-in service publishes what the app needs (read on 2026-11-15).') },
  { id: 'jira', label: 'Jira', category: 'work', mcp: ['atlassian'], rest: ['Jira'], ways: ['account', 'key'], verification: NO_ACCOUNT('Shares one sign-in with Confluence. The sign-in service publishes what the app needs (read on 2026-11-15).') },
  { id: 'confluence', label: 'Confluence', category: 'knowledge', mcp: ['atlassian'], rest: ['Confluence'], ways: ['account', 'key'], verification: NO_ACCOUNT('Shares one sign-in with Jira. The sign-in service publishes what the app needs (read on 2026-11-15).') },
  { id: 'sentry', label: 'Sentry', category: 'dev', mcp: ['sentry'], rest: ['Sentry'], ways: ['account', 'key'], verification: NO_ACCOUNT('The sign-in service publishes what the app needs (read on 2026-11-15).') },
  { id: 'stripe', label: 'Stripe', category: 'payments', mcp: ['stripe'], rest: ['Stripe'], ways: ['account', 'key'], verification: NO_ACCOUNT('The sign-in service publishes what the app needs (read on 2026-11-15). Payments and refunds are never reached by a preset.') },

  // ─── need an app or a key of yours ──────────────────────────────────────────
  {
    id: 'github', label: 'GitHub', category: 'dev', mcp: ['github'], rest: ['GitHub'], ways: ['device', 'key'],
    verification: NO_ACCOUNT('The device sign-in needs a GitHub app whose client id you provide, and whether GitHub\'s hosted server accepts the token such an app mints is not yet known. A personal access token works as before.')
  },
  { id: 'google-calendar', label: 'Google Calendar', category: 'work', mcp: ['google-calendar'], rest: [], ways: ['own-app'], verification: NO_ACCOUNT('Needs a Google OAuth client you register, and Google\'s Workspace Developer Preview. Checked against a stand-in and against Google\'s public endpoints only.') },
  { id: 'google-drive', label: 'Google Drive', category: 'work', mcp: ['google-drive'], rest: [], ways: ['own-app'], verification: NO_ACCOUNT('Needs a Google OAuth client you register, and Google\'s Workspace Developer Preview. Checked against a stand-in and against Google\'s public endpoints only.') },
  { id: 'gmail', label: 'Gmail', category: 'comms', mcp: ['gmail'], rest: [], ways: ['own-app'], verification: NO_ACCOUNT('Needs a Google OAuth client you register, and Google\'s Workspace Developer Preview. Gmail\'s scopes are restricted: held back on purpose.') },
  { id: 'slack', label: 'Slack', category: 'comms', mcp: ['slack'], rest: [], ways: ['own-app'], verification: NO_ACCOUNT('Slack only lets published or internal apps use its server; you need an app a workspace admin has approved.') },
  {
    id: 'brave-search', label: 'Brave Search', category: 'search', mcp: ['brave-search'], rest: [], ways: ['key'],
    verification: {
      status: 'limited', on: '2026-11-15', evidence: LOCAL_EVIDENCE,
      note: 'The server installs from its lock, starts and lists its tools. A call with a made-up key reached Brave and was refused; no real key has been used.'
    }
  },
  { id: 'hubspot', label: 'HubSpot', category: 'crm', mcp: [], rest: ['HubSpot'], ways: ['key'], verification: NO_ACCOUNT('Uses a private-app token you create. HubSpot\'s own sign-in needs a secret that cannot ship in a desktop app.') },
  { id: 'salesforce', label: 'Salesforce', category: 'crm', mcp: [], rest: [], ways: [], verification: { status: 'planned', note: 'Salesforce publishes a hosted server, but its developer pages could not be checked, so it is not offered yet.' } },
  { id: 'custom-rest', label: 'Your own REST API', category: 'custom', mcp: [], rest: ['Custom REST API'], ways: ['key'], verification: NO_ACCOUNT('Any base address with no key, a bearer token or a header you choose. Every request is checked by method and path against the grants.') },

  // ─── the keys the agents' own engines use ───────────────────────────────────
  ...(['anthropic', 'openai', 'google-ai', 'openrouter', 'groq'] as const).map((id): ProviderManifest => ({
    id, label: { anthropic: 'Anthropic', openai: 'OpenAI', 'google-ai': 'Google AI', openrouter: 'OpenRouter', groq: 'Groq' }[id], category: 'ai',
    mcp: [], rest: [], ways: ['engine'],
    verification: { status: 'na', note: 'An engine key: the agent\'s own program reads it. It is managed in Settings > AI engines, not here.' }
  }))
];

export const providerById = (id: string): ProviderManifest | undefined => PROVIDERS.find((p) => p.id === id);

/** The provider a catalogue entry belongs to (the first listed, for the one entry two providers share). */
export const providerOfMcp = (entryId: string): ProviderManifest | undefined => PROVIDERS.find((p) => p.mcp.includes(entryId));
