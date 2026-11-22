# Mosbius & Co. platform roadmap (internal execution tracker)

This file is a tracker, not an approval gate. It records what is done, what is in progress and what is
blocked on something only the owner can do. Status words are used strictly:

- **PASS**: done, and checked by a real run or a test whose result is recorded here or in the linked document.
- **FAIL**: tried, and it does not work. The reason is stated.
- **IN PROGRESS** / **TODO**: not finished.
- **BLOCKED**: cannot be finished without an external action. The exact action is listed in "External dependencies".
- **UNVERIFIED**: built, and tested only against stand-ins or not tested against the real thing.
- **NOT RUN**: written, but the real program was not run (an agent CLI that is not installed here).
- **N/A**: does not apply.

Stand-in results and real-provider results are never mixed. A provider is "verified" only after a real sign-in plus a
real read-only tool call. No real provider account has been used anywhere in this work.

Standing rules (from the owner): nothing is published, deployed or released without the owner's separate authorization.
On 2026-11-16 the owner authorized one commit and push of the reviewed documentation, website, CI and platform changes to
this repository's `main` branch, and nothing more: no release, no tag, no installer upload, no deployment of the website,
no paid infrastructure, no change of visibility; no mandatory Mosbius account; no confidential client secret in a
distributed binary; every integration is opt-in; the `mcp-remote` bridge stays as the fallback until the owner approves
its removal; credentials are typed by the owner at hidden prompts, never in chat; the fan-made disclaimer stays wherever
the product is described.

Last updated: 2026-11-16. Reports: [SECURITY_REPORT.md](SECURITY_REPORT.md), [INTEGRATIONS.md](INTEGRATIONS.md), [SKILLS.md](SKILLS.md).

## 1. Security foundation

| Item | Status | Evidence |
|---|---|---|
| Every integration opt-in; one-time migration of the old defaults | PASS | `test/mcp-opt-in.test.cjs`; checked in the real app (older profile), `evidence/ui-packaged` |
| Durable hash-chained audit log with sealed anchor; rotation; tamper detection | PASS | `test/audit-store.test.cjs` (26), `audit-wiring` (9); verified again after a restart of the real app |
| Config secrets out of `config.json`; renderer sees booleans only | PASS | `test/config-secrets*.test.cjs` (25) |
| REST per-request grants, default none | PASS | `test/rest-*.test.cjs` (38) |
| MCP package pins, hash-locked verified installs, install scripts off | PASS | `tools/verify-packages-live.cjs`: 10 of 10 on Node 26.3 and 22.12 |
| App-run local MCP servers behind the broker; credential on a private pipe | PASS | `test/stage-b-e2e.test.cjs` (13); real `claude`, `evidence/stage-b/stage-b-live.json` |
| Skill installs cannot grant tools, run hooks or install dependencies | PASS | `test/skill-guard.test.cjs` |
| Refresh-token concurrency (finding F1) | PASS | `test/phase4-known-limits.test.cjs` |
| Capability is a bearer handle: investigated | PASS (investigated, residual stated) | `SECURITY_REPORT.md`; `test/capability-exposure.test.cjs`. Binding a pass to a process was considered and not built, with the reason |
| REST capability reaches workers through their environment: investigated | PASS (investigated, residual stated) | by design the worker uses it; given only with a REST grant, default none |
| Codex's shell leaks a pass by default (finding F2) | PASS (fixed, with a control on the real CLI) | `evidence/codex/codex-live.json` |
| Idle timer never stops a child with a request in flight | PASS | `test/stdio-host.test.cjs` |
| Gemini's first design could not load on 0.68.0 (a system settings file is refused unless root owns it) (F7) | PASS (fixed: an isolated Gemini home per agent, with a control on the real CLI) | `evidence/gemini/gemini-live.json`; `test/gemini-broker-wiring.test.cjs` |
| The broker refused clients built on Node's own `fetch` as "browsers" (F8) | PASS (fixed; pages still refused) | `test/mcp-route.test.cjs` |
| Gemini's shell can read its agent's pass (F9) | OPEN, on purpose: closure was attempted and is not possible with this CLI (the pass must be in Gemini's own environment and the shell can read it with `ps`; no per-variable lever; the global redaction hides `SSH_AUTH_SOCK` and other variables whatever the allow list says). Nothing was shipped for it | `evidence/gemini/gemini-live.json` (section `f9`); `SECURITY_REPORT.md` |
| Codex's "hidden from the shell" needs its OS sandbox (F2) | PASS, with its condition measured: sandbox on, `ps` refused; sandbox off, the real pass is readable from the Codex process | `evidence/codex/codex-live.json` |

## 2. Universal integration architecture

| Item | Status |
|---|---|
| Stage A spike tool for the unknowns (`tools/stage-a-spike.cjs`) | PASS (31 tests; public metadata read live 2026-11-15; live sign-in runs wait for the owner) |
| Provider manifest, one description of every provider, evidence-enforced | PASS (`src/shared/providers.ts`, `test/providers.test.cjs`) |
| Connection model (runtime summary: provider, method, status, scope, times; no secrets) | PASS (`src/shared/connect.ts`, `src/main/connect/`, 19 + 5 tests) |
| Vault: tokens and connection facts sealed in the existing encrypted store, `mcp:<id>:oauth` and `mcp:<id>:conn` | PASS |
| Auth strategies: `dcr` (RFC 7591 + PKCE + 8707 + 9207 + 7009 + 7592), `device` (RFC 8628) | PASS against a stand-in |
| Auth strategy `public` (a registered Desktop client, PKCE, no secret) | TODO: reserved in the model, not implemented; waits for the Google test |
| Gateway for providers that insist on a client secret | NOT BUILT, by decision: prototype only, decided after the Google test, no deployment, no recurring cost |
| Tool discovery with pinned classes; an unclassified tool is blocked | PASS |
| "New tools since your review" diff | TODO |
| Connection lifecycle: connect, reconnect, disconnect with provider revocation where the provider offers it | PASS against a stand-in |

## 3. Providers

"Verified" means a real sign-in and a real read-only call; nothing is verified except the local servers.
The generated table in [INTEGRATIONS.md](INTEGRATIONS.md) is the authority; this one adds what remains.

| Provider | Built | Real-provider status | What remains |
|---|---|---|---|
| Sequential Thinking, Time, Fetch, Filesystem, Git, Context7, Browser | yes | PASS (real tool calls, macOS only) | Windows and Linux |
| Notion | yes (account sign-in; token) | UNVERIFIED | the owner runs `tools/stage-a-spike.cjs dcr notion ...` and approves in the browser |
| Linear, Sentry, Stripe, Atlassian (Jira, Confluence) | yes (account sign-in; keys) | UNVERIFIED | the same, one command each |
| GitHub | yes (sign-in code; token) | UNVERIFIED | the owner registers a GitHub App with device flow and supplies its client ID |
| Google Calendar, Drive, Gmail | yes (own app, in-app engine or bridge) | UNVERIFIED | Developer Preview, a Cloud project, a Desktop client; whether it works without its secret |
| Slack | yes (own app) | UNVERIFIED | an internal or Marketplace app approved by an admin |
| Brave Search | yes (key) | LIMITED (a fake key only) | a real key |
| HubSpot | REST template (key) | UNVERIFIED | a private-app token; its hosted MCP server is not wired |
| Salesforce | no | NOT IMPLEMENTED | developer documentation could not be checked, so no entry is added from memory; needs an org and a registered app |
| Custom REST | yes | PASS for the broker path against stand-ins | |
| Model-provider keys (Anthropic, OpenAI, Google AI, OpenRouter, Groq) | yes (engine settings) | N/A (the CLIs use them) | |

## 4. Skills platform

PASS. Catalogue, search, categories, install and uninstall for two targets (Claude Code, and Codex and Gemini CLI),
commit-pinned provenance outside the skill folder, per-file hashes, integrity check, update preview with every changed
line, apply with backup, rollback, dependency detection with Connect buttons, per-CLI labels, and the rule that a skill
grants nothing and connects nothing. 32 tests; driven in the real app (`evidence/ui`, `evidence/ui-packaged`).
**Not done:** installing from the live catalogue and a real update from a real repository (they download files).

## 5. Settings and experience

PASS in the real desktop app, development and packaged macOS builds, 57 of 57 checks each: Discover, Connected, Skills,
Agent access (including what each CLI can do, with Gemini's caveats, in English and Arabic) and Activity; honest card labels; a failure flow; opt-in; one-time migration from an older profile; restart
persistence; audit verification after restart; keyboard navigation with real key events; accessibility (names, tablist,
roving focus, contrast 5.47:1 or better dark and 6.02:1 light); English, Simplified Chinese and Arabic right to left; narrow
windows (760 and 560 px); light and dark. Screenshots in `evidence/ui` and `evidence/ui-packaged`.
**Not done:** a connection flow to a real provider; Windows and Linux; an Arabic or Chinese reader's review of the text.

## 6. Coding agents

| Agent | Installed here | Integrations | Skills |
|---|---|---|---|
| Claude Code 2.1.325 | yes | PASS (real CLI, real pinned servers) | PASS (project folder listed by the real CLI) |
| Codex CLI 0.142.2 | yes (not signed in) | PASS with a stand-in model and provider: 39 of 39, with controls (`tools/verify-codex-live.cjs`) | PASS (`~/.agents/skills` listed by the real CLI) |
| Gemini CLI 0.68.0 | yes, a pinned throwaway install (deleted afterwards; no Gemini login) | PASS with a stand-in model and provider: 50 of 50, with controls (`tools/verify-gemini-live.cjs`). The pass **is visible to its shell, and no setting can change that** (F9, OPEN on purpose); an integration loads only in a folder trusted in Gemini | PASS (`~/.agents/skills`, `~/.gemini/skills`, `<project>/.agents/skills`, `<project>/.gemini/skills` listed by the real CLI; not `.claude/skills`) |

## 7. Validation, builds, documents

| Item | Status |
|---|---|
| Full suite | PASS: 1957 tests, 1954 pass, 0 fail, 3 skipped (two opt-in real-client tests, run separately with the real Claude CLI after the broker-guard change and passing 2 of 2; one Windows-only). Run twice on the final tree on 2026-11-16 with identical results, 33 tests more than the run before the documents, website and CI work (catalogue 11, website 11, CI workflows 6, lockfile 5). Also run from a fresh clone of the commit on Node 20.20.2 with npm 10.8.2, which is what CI's `setup-node` gives: `npm ci`, typecheck, release links, document and website checks and the production build pass there, and so does the suite, after one Node 20 gap in the test loader was closed (see CHANGELOG) |
| CI install (`npm ci`) | PASS: the failure CI reported ("Missing: ws@8.23.0 from lock file", both jobs, at the install step) was reproduced, traced to an optional peer dependency the lock did not satisfy, and fixed by regenerating the lock with `npm install --package-lock-only`; `npm ci` from a clean dependency state, typecheck and the production build pass. Guarded offline by `test/lockfile-sync.test.cjs`, which fails on the old lock |
| GitHub Actions on the pushed commit | NOT RECORDED HERE: `ci.yml` runs on every push to `main`; its result belongs to the commit that triggers it and is reported with that commit |
| Landing page (`website/`) | PASS: `npm run website:check` and `test/website.test.cjs` (generated data current, links and assets whole, no typed counts, no sentence that calls an account-based provider verified, the page's scripts run against the data and read back), and viewed at desktop and phone widths in a browser. NOT DEPLOYED: it is in the repository (it was not under version control before), and nothing publishes it |
| Typecheck (node and web) | PASS |
| Lint | N/A: the project defines no linter |
| Production build (`electron-vite build`) | PASS |
| Package integrity | PASS for the macOS arm64 app, rebuilt from the final source: the broker fix and the Access-tab note are inside the asar, ten hash-pinned MCP locks present, no repository tests, evidence, tools or sources inside |
| Migration tests | PASS: opt-in migration and older skill records, in tests and in the real app |
| macOS Apple Silicon build | PASS: unsigned, not notarised (no signing identity); also the universal build the config asks for |
| Windows x64 build | BUILT, NOT RUN: cross-built from this Mac with the project's own script (`npm run dist:win-on-mac`), unsigned installer `Mosbius-Co-0.4.6-win-x64-setup.exe` (130 MB), rebuilt from the final source; contents checked (the broker fix inside the asar, Windows native modules, node-pty win32-x64 prebuilds, hash-pinned locks, nothing of the repository's tests or evidence); never started on Windows, so UNVERIFIED |
| Linux build | BLOCKED here: the native modules need a Linux toolchain; `.github/workflows/platforms.yml` builds it, UNVERIFIED until it runs |
| CI workflows for Windows and Linux | written (`platforms.yml`), parse, UNVERIFIED: it now runs only when started by hand from the Actions tab (it builds unsigned installers and keeps them for a week), and has never run |
| Documents synchronised | PASS: README, CHANGELOG, release notes, `INTEGRATIONS.md`, `SKILLS.md`, `SECURITY_REPORT.md`, `MCP_BROKER_DESIGN.md` 12.7 and the landing page. The tables and counts in the README, `INTEGRATIONS.md` and the website are generated from one catalogue (`tools/lib/catalogue.cjs`, derived from the files the app uses and the `evidence/` runs), and `npm run docs:check` and `npm run website:check` fail on drift. Not checked by a machine: the prose of `SKILLS.md`, `SECURITY_REPORT.md` and `MCP_BROKER_DESIGN.md`, which is written by hand |

## 8. Agent Huddle and notifications

Design, file map and limits: [DEVELOPMENT.md](DEVELOPMENT.md#agent-huddle-and-notifications). Everything below ran against a stand-in agent (a program that reports through hooks like a CLI; it is not a model). No real provider account was used.

| Item | Status |
|---|---|
| Notification service (categories, priorities, de-duplication, history, preferences, desktop banner, sounds) | PASS in unit tests (`test/notification-service.test.cjs`, `test/sound-synth.test.cjs`) and in the real app through `tools/huddle-validate.cjs` |
| Agent state machine and the floor's new glyphs | PASS in unit tests (`test/agent-activity.test.cjs`, `test/activity-glyph.test.cjs`, `test/hooks-observer.test.cjs`) |
| Huddle window (compact, expanded, one agent), docking, saved position, no focus taken | PASS in the real app with the stand-in agent: window flags read back from the main process, and the application that was in front kept the keyboard when the Huddle appeared; the window can take the keyboard only after a text field is clicked and gives it back when the field is left. UNVERIFIED: a real operating-system mouse click or drag on the window (the harness clicks through the DevTools protocol and moves the window with `setPosition`, which fire the same events the app listens to), full-screen applications |
| Approve, reject, choose, answer, restart, from a notification or from the Huddle | PASS against the stand-in agent, each reaching only the right agent. PASS against the real `claude` CLI 2.1.325 for the keys, on a Bash prompt and a file-edit prompt (Enter approves, Escape rejects, Down presses then Enter take the entry the highlight is on, Escape then a typed line reaches the model): `tools/verify-claude-prompt-keys.cjs`, 27 of 27, with a loopback stand-in for the model and no account. UNVERIFIED: what a real model asks for, and prompts from Codex and Gemini CLI |
| Notification permission switched off in the system | UNVERIFIED: macOS and Linux give no signal. The app says "handed to the system", offers a test banner and the system settings, and the bell, the sound and the Huddle keep working |
| Voice input in the Huddle | TODO: the app's dictation is bound to the main window |
| Windows, Linux | NOT RUN |
| Full suite after these changes | PASS on the v1.1.0 tree as it was staged for release: 2203 tests, 2200 pass, 0 fail, 3 skipped (the same three as before: two opt-in real-client tests and one Windows-only); typecheck, `docs:check`, `website:check` and `check:links` pass. On the built macOS Apple silicon installer: `tools/huddle-validate.cjs` passes 144 of 144 checks and `tools/ui-validate.cjs` 58 of 58. `tools/verify-claude-prompt-keys.cjs` passed 27 of 27 against the real `claude` CLI in an earlier run and was not repeated for this build |

## External dependencies (what only the owner can do)

Each is a non-blocking request. Work on everything else continues.

1. **Real OAuth consent** for each self-registering provider (Notion, Linear, Sentry, Stripe, Atlassian): run the command the tool prints; approve in the browser.
2. **GitHub**: register a GitHub App with device flow enabled and give the client ID (a public value).
3. **Google**: enroll in the Workspace Developer Preview Program (takes days), create a Cloud project, enable the Calendar API and `calendarmcp.googleapis.com`, configure the consent screen and add yourself as a test user, create an OAuth client and tick "Use this client for an AI-powered agent". Steps in `STAGE_A_VERIFICATION.md`.
4. **Slack**: an internal or Marketplace app; PKCE opt-in is one-way; a workspace admin must approve.
5. **HubSpot, Salesforce, Jira, Confluence, Stripe, Sentry, Brave, model providers**: your own keys or apps, entered at hidden prompts.
6. **Gemini CLI sign-in**, only if you want a run with a real Gemini model and to confirm that a real Gemini login carries into an agent's home; everything recorded does not need it. (The pinned install into a throwaway folder was done with your permission and deleted afterwards.)
7. **Codex sign-in**, only if you want a run with a real OpenAI model; everything recorded does not need it.
8. **Windows and Linux**: machines, or a run of `platforms.yml` started by hand from the Actions tab (it is not automatic).
9. **Domain and privacy policy** (needed for Google brand verification and a client-id metadata document).
10. **Apple signing and notarization credentials** for a distributable macOS build.
