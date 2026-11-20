# Development, verification and project status

Mosbius & Co. is a fan-made project inspired by How I Met Your Mother. It is not affiliated with, endorsed by or connected to the show, its makers or its owners.

This is the engineering companion to [README.md](README.md): installing from source, the development commands, continuous integration, how the project is laid out, and how far each capability has been checked. The tables marked *generated* are written by `npm run docs:gen` from the data the app itself uses, and `npm run docs:check` fails if they drift.

## Installing from source and first run

### Requirements

| | Needed |
|---|---|
| **To use the published app** | macOS on Apple Silicon, or Windows 10/11 x64 (untested on Windows hardware). At least one coding agent CLI, installed and signed in (see [Coding agents](#agent-clis-what-was-run)). |
| **To run from source** | **Node 22** (not Node 26: Homebrew's Node 26 breaks the native modules), npm, git. Native modules (`node-pty`, `better-sqlite3`) are rebuilt for Electron on install; where no prebuilt binary applies you also need a C++ toolchain and Python 3 (Xcode Command Line Tools on macOS). |
| **Platform status** | macOS on Apple Silicon: developed and tested here. Windows x64: built, never run. Linux: not built; the encrypted credential store needs a system keyring. |

### Run from source

```bash
git clone https://github.com/rajguruyash/Mosbius-Co.git
cd Mosbius-Co
npm ci
npm run dev
```

`npm ci` installs exactly what `package-lock.json` pins (use `npm install` if you are changing dependencies). Each agent needs its own command-line tool installed and signed in (`claude`, `codex`, `gemini`); the app can install the ones that are missing.

### First run

1. Choose a workspace: a folder where the app keeps one crew's agents, memory, tasks and settings. Opening or creating a workspace never changes another one.
2. Pick the coding agent the boss should use.
3. Add agents with **+ add agent**. They join the location you are looking at.
4. Switch locations with the tabs above the floor, or keys 1 to 7.

### Connect an integration and give an agent access

1. **Settings → Integrations & Skills → Discover.** Find the service, press **Connect** (or **Turn on**, for a local one) and follow the card: approve on the service's own page, or paste a key you created. Nothing is on until you do this.
2. **Connected.** Check it is on and connected; choose which of its tools may be used at all.
3. **Agent access.** Give the agent access: none, read, write or a list of tools, with an optional end time. The default is none.
4. **Start a new session for that agent** if it was running before you gave it access to this integration. Then ask it to use the integration; the **Activity** tab shows each request and whether it was allowed.

### Install a skill

**Settings → Integrations & Skills → Skills.** Choose *Install for* **Claude Code** or **Codex CLI and Gemini CLI**, search the catalogue, press **Install**. Read what the app took out of the copy and which integrations it needs; press **Connect** on those yourself if you want them. **Check**, **Look for update** and **Roll back** keep it honest.

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| macOS says the app cannot be opened | The app is unsigned and not notarised | Right-click it in Applications, choose **Open**. |
| Windows SmartScreen warns | The installer is unsigned | **More info → Run anyway.** |
| A Keychain permission dialog appears the first time you connect something, and the app seems stuck | The first use of the encrypted store makes macOS ask, and an unsigned app waits | Answer the dialog; choosing *Always Allow* stops it asking again. |
| `npm ci` prints `EBADENGINE` | A dependency asks for a newer Node patch release than yours | Only a warning. Use the current Node 22. |
| `npm ci` fails with "Missing: … from lock file" | `package.json` and `package-lock.json` are out of sync | Run `npm install` and commit the lock file (the cause, and how it was fixed, is in [CHANGELOG.md](CHANGELOG.md)). |
| Native-module errors on start | You are on Node 26, or the rebuild did not run | Use Node 22, then `npm ci` again. |
| An agent cannot see an integration | It is not switched on, not connected, not granted to that agent, or the agent started before you granted it | Follow [Connect an integration](#connect-an-integration-and-give-an-agent-access), then start a new session for the agent. |
| Gemini does not offer an integration | The agent's folder is not trusted in Gemini | Trust the folder in Gemini. The app never changes your trust file and never passes `--skip-trust`. |
| Codex's shell can see the pass | Codex was started with its sandbox off | Start it in the app's auto mode (`-s workspace-write`), or accept the risk in [the limits](SECURITY_REPORT.md). |
| Linux says it cannot store credentials | There is no system keyring and the app will not store them unencrypted | Install and unlock a keyring (a Secret Service provider), then reconnect. |
| Gmail, Calendar, Drive or Slack will not sign in | These need an OAuth app you register, and Google's servers are in Developer Preview | Register the app, add the redirect URI Settings shows (callback ports 33101 to 33104), then sign in once. |

## Project status

An honest table. "Checked" means a run is recorded in this repository; each row names where.

| Area | State | Where it is shown |
|---|---|---|
| macOS, Apple Silicon | Developed and tested: the automated suite, the real desktop app driven (development and packaged), the three agent CLIs | `evidence/ui-packaged/`, `evidence/ui/` |
| macOS, Intel | A universal build is configured and was built; **never run on an Intel Mac** | `electron-builder.yml` |
| Windows, x64 | Installer published (v1.0.0.0, before the platform in this page); cross-built on a Mac; **never run on Windows**; a manual CI workflow exists and has never run | `.github/workflows/platforms.yml` |
| Linux | An AppImage target is configured; **not built, not run** | `electron-builder.yml` |
| Claude Code, Codex CLI, Gemini CLI | Verified with the real CLIs; Codex and Gemini with a stand-in model and provider; no real Gemini login | the table under [Agent CLIs](#agent-clis-what-was-run)(#agent-clis-what-was-run) |
| Local MCP servers | Locally tested on macOS (real tool calls) | `evidence/stage-b/` |
| Account-based providers | Stand-in tested; **none verified with a real account** | [the catalogue](#the-integration-catalogue) |
| Skills platform | Tested against a stand-in GitHub and in the real app; not run from the live catalogue | [SKILLS.md](SKILLS.md) |
| Security findings | Found, fixed and tested; one left open on purpose (F9) | [SECURITY_REPORT.md](SECURITY_REPORT.md) |
| Interface languages | English, Simplified Chinese, Arabic (right to left); not reviewed by native readers | `evidence/ui-packaged/` |
| Website | A static page in `website/`, **not deployed** | [The landing page](#the-landing-page) |
| Signing and notarisation | Not done; builds are unsigned | — |

The release builds on the Releases page (v1.0.0 and v1.0.0.0) **predate** the Integrations & Skills platform.

## Agent CLIs: what was run

The **Integrations & Skills** platform below is built for three agent CLIs. Each is handed its access in its own way, because the three programs do not read the same configuration. The table says what was actually run, with what, and what is known to be weaker.

<!-- gen:agents:start (generated by tools/gen-docs.cjs from src/shared/agentCompat.ts and the evidence files; do not edit by hand) -->

| Coding agent | Version run | How it is handed an integration | Can its shell read the pass? | Integrations | Skills |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | 2.1.325 | Gets its integrations from a config file in its own folder that its own settings forbid it to read. Skills live in its own folder. | No | Verified: the real CLI, 26 of 26 checks passed (2026-11-15), with a real model (haiku) and the real pinned local servers; no third-party account | Verified: the real CLI lists skills from `~/.claude/skills`, `<project>/.claude/skills` |
| **Codex CLI** | 0.142.2 | Gets the broker address on its command line and the pass in one variable that is kept out of its shell's environment. Skills live in the shared agents folder. | No, **only while Codex's OS sandbox is on**; with it off, a command can read it from the Codex process | Verified: the real CLI, 39 of 39 checks passed (2026-11-16), with a stand-in model and a stand-in provider; no model account and no third-party account | Verified: the real CLI lists skills from `~/.agents/skills`, `<project>/.agents/skills`, `<project>/.codex/skills` |
| **Gemini CLI** | 0.68.0 | Gets a Gemini home of its own whose settings name one variable that holds the pass. Skills live in the shared agents folder. Loads integrations only in folders you have trusted in Gemini. | **Yes** (finding F9, left open: no Gemini setting can stop it) | Verified: the real CLI, 50 of 50 checks passed (2026-11-16), with a stand-in model and a stand-in provider; no model account and no third-party account | Verified: the real CLI lists skills from `~/.agents/skills`, `~/.gemini/skills`, `<project>/.agents/skills`, `<project>/.gemini/skills` |

<!-- gen:agents:end -->

Only the versions in the table were run, and these programs change quickly: on 2026-11-16 the npm registry already had a newer Codex CLI (0.169.0) than the one that was run (0.142.2), and nothing here says a newer release behaves the same way.

"Verified" here means *the real command-line program was run against the real broker and the real app, and the run is recorded in the repository*. It does **not** mean a real third-party account was used. Claude Code was run with a real model and the real pinned local servers; Codex and Gemini were run with a stand-in model and a stand-in provider, so whether a real OpenAI or Gemini model uses the offered tools well was not tested, and no Gemini login was used (whether a real Gemini login carries into an agent's home is untested). Details and the exact limits are in [INTEGRATIONS.md](INTEGRATIONS.md) and [SECURITY_REPORT.md](SECURITY_REPORT.md).


### Install and sign in

| Agent | Install | Sign in | Docs |
|---|---|---|---|
| **Claude Code** | `npm install -g @anthropic-ai/claude-code` | `claude auth login` | [docs.claude.com](https://docs.claude.com/en/docs/claude-code) |
| **Codex CLI** | `npm install -g @openai/codex` | `codex login` | [github.com/openai/codex](https://github.com/openai/codex) |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | run `gemini` and sign in with Google (or set `GEMINI_API_KEY`) | [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) |

The app can run these install commands for you from **Settings → Coding agents**, after you approve the exact command. Plans, free allowances and limits are set by each provider; the app points to them rather than promising any.


### Other agents the app can start

Besides the three above, the app can start Cursor, Copilot, Grok, Qwen, Kimi Code, OpenCode, Crush, Pi and Antigravity, or any custom command. **The Integrations & Skills platform does not cover them**: only Claude Code, Codex and Gemini CLI are handed integrations or have skills managed by the app.

## The integration catalogue

This part is **generated from the app's own data** (`src/shared/providers.ts` and the files beside it), so it cannot say something the app does not. The full table, with what each check showed, is in [INTEGRATIONS.md](INTEGRATIONS.md).

<!-- gen:catalogue:start (generated by tools/gen-docs.cjs from the app's own provider data; do not edit by hand) -->

22 providers in 8 groups: 21 implemented, 1 not implemented. 7 are locally tested (real tool calls), 1 partly, 14 have had their connection path run against a stand-in, and **0 have been verified with a real account**. Behind them are 19 MCP server entries and 9 REST templates.

**What the words mean**

- **Implemented.** The app has a way to connect an agent to it: code, a catalogue entry or REST template, and a card in Settings. It says nothing about whether it has been run against the real service.
- **Locally tested.** The real server ran on the development Mac and answered a real tool call. It needs no account. macOS only.
- **Stand-in tested.** The way the app connects to it (sign-in, sign-in code, your own app, a key, or the REST route) was run end to end against a stand-in service that behaves like a provider. It proves the app's side of the connection, not the provider's.
- **Real-account verified.** A real sign-in or key was used for a real call, and the evidence file is in the repository. Nothing is in this state yet.
- **Not yet verified.** Implemented, but never run against the real service with a real account.
- **Not implemented.** Not available in the app.
- **✓, partly, —, n/a.** In the tables: yes, only in part, no, and "does not apply" (a local server needs no account, so nothing about an account applies to it).

#### Local MCP tools

Run on your computer, need no account. The app installs each from a version-pinned, hash-checked lock and runs it itself.

| Provider | What an agent can do | Connects by | Implemented | Locally tested | Stand-in tested | Real-account verified | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Sequential Thinking** | Helps an agent work through a problem in steps. | runs on this computer | ✓ | ✓ | n/a | n/a | Locally tested |
| **Time** | Tells an agent the date, the time and time zones. | runs on this computer | ✓ | ✓ | n/a | n/a | Locally tested |
| **Fetch** | Lets an agent read a web page you point it at. | runs on this computer | ✓ | ✓ | n/a | n/a | Locally tested |
| **Filesystem** | Lets an agent read the folders you choose. | runs on this computer | ✓ | ✓ | n/a | n/a | Locally tested |
| **Git** | Lets an agent read a git repository's history. | runs on this computer | ✓ | ✓ | n/a | n/a | Locally tested |
| **Context7 docs** | Looks up current documentation for libraries. | runs on this computer | ✓ | ✓ | n/a | n/a | Locally tested |
| **Browser** | A browser an agent can drive. | runs on this computer | ✓ | ✓ | n/a | n/a | Locally tested |

#### Developer tools

Code hosting and error tracking.

| Provider | What an agent can do | Connects by | Implemented | Locally tested | Stand-in tested | Real-account verified | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **GitHub** | Read repositories, issues and pull requests. | sign-in code, a key you create | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |
| **Sentry** | Read errors and issues from Sentry. | sign in with your account, a key you create | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |

#### Productivity and knowledge

Issues, pages and documents.

| Provider | What an agent can do | Connects by | Implemented | Locally tested | Stand-in tested | Real-account verified | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Notion** | Search and read your Notion pages and databases. | sign in with your account, a key you create | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |
| **Linear** | Read Linear issues and projects. | sign in with your account, a key you create | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |
| **Jira** | Search and read Jira issues. | sign in with your account, a key you create | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |
| **Confluence** | Search and read Confluence pages. | sign in with your account, a key you create | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |

#### Communication

Messages.

| Provider | What an agent can do | Connects by | Implemented | Locally tested | Stand-in tested | Real-account verified | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Slack** | Search and read Slack channels. | an OAuth app you register | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |

#### Google Workspace

Reached with an OAuth app you register yourself; Google's servers are in Developer Preview.

| Provider | What an agent can do | Connects by | Implemented | Locally tested | Stand-in tested | Real-account verified | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Gmail** | Search and read your mail. | an OAuth app you register | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |
| **Google Calendar** | See your calendar and free times. | an OAuth app you register | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |
| **Google Drive** | Find and read files in Drive. | an OAuth app you register | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |

#### Search and research

Search the web.

| Provider | What an agent can do | Connects by | Implemented | Locally tested | Stand-in tested | Real-account verified | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Brave Search** | Search the web through Brave. | a key you create | ✓ | partly | ✓ | — | Partly tested locally · Not yet verified |

#### Business and payments

Payments and customer records.

| Provider | What an agent can do | Connects by | Implemented | Locally tested | Stand-in tested | Real-account verified | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Stripe** | Look up Stripe customers, payments and products. | sign in with your account, a key you create | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |
| **HubSpot** | Read HubSpot contacts, companies and deals. | a key you create | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |
| **Salesforce** | Planned. Not available yet. | not available yet | — | — | — | — | Not implemented |

#### Custom APIs

Any REST API of your own.

| Provider | What an agent can do | Connects by | Implemented | Locally tested | Stand-in tested | Real-account verified | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Your own REST API** | Connect any REST API with its own key. | a key you create | ✓ | — | ✓ | — | Stand-in tested · Not yet verified |

Not integrations, and not counted above: the keys the agents' own engines use (Anthropic, OpenAI, Google AI, OpenRouter, Groq). The Discover tab lists them too, which is why it shows 27 entries, but they are set under **Settings → AI engines**.

<!-- gen:catalogue:end -->

**What "locally tested" covers.** Sequential Thinking, Time, Fetch, Filesystem, Git, Context7 and Browser (Playwright) each installed from their pinned lock, started, listed their tools and answered a real call, on macOS and on Node 22 and 26. Filesystem and Git are scoped to the agent's workspace, never your whole disk. Brave Search installed, started and listed its tools; a call with a made-up key reached Brave and was refused, which shows the path and not an account.

**What "stand-in tested" does not cover.** Sign-in, refresh, a tool call, forged callbacks and "no secret in a process listing or a log" were exercised against a stand-in service. Nothing was signed in to a real Notion, Linear, Atlassian, Sentry, Stripe, GitHub, Google or Slack account. Whether GitHub's hosted server accepts the token a device-code app mints, and whether a Google Desktop client works without its secret, are not known. A provider can fail at its first real call.

**The `mcp-remote` bridge.** Gmail, Calendar, Drive and Slack publish an official server that a Claude Code agent cannot use directly, because it obtains its OAuth client by registering itself, and these services do not allow that. So the app can run [`mcp-remote`](https://github.com/punkpeye/mcp-remote) (pinned to 0.16.6) in between, holding an OAuth app *you* registered. Each service has its own fixed callback port on `127.0.0.1` (33101 to 33104); Settings shows the exact redirect URI to register, and you sign in once. Google's servers are in Developer Preview, and Slack needs an app a workspace admin has approved. **This path leaves tokens in readable files while an agent that uses them runs** (see [the limits](SECURITY_REPORT.md)); it is kept on purpose, and removed only on the owner's word.

## Continuous integration

Three workflows live in `.github/workflows/`:

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every push to `main` or `release/**`, and every pull request to them | **Typecheck** (both processes) and **release links** block. **Documents and website match the app** blocks: `npm run docs:check` and `npm run website:check`, on Ubuntu, without a native rebuild. **Build** and **Tests** run on macOS and do not block yet: the suite was written and run on a Mac, and they stay non-blocking until they have been seen green on a GitHub runner. |
| `platforms.yml` | only when someone starts it by hand | the suite, an unsigned installer build and the interface test on macOS, Windows and Linux. The Windows and Linux legs are marked experimental. It publishes, signs and releases nothing. |
| `pr-evidence.yml` | pull requests | asks for a before and an after image in the description. It never checks out or runs the pull request's code, because it runs with write permission. |

Every job installs with `npm ci`, so a `package-lock.json` that is out of step with `package.json` fails there, first. That is exactly what stopped CI once ("Missing: ws@8.23.0 from lock file"; the cause and the fix are in [CHANGELOG.md](CHANGELOG.md)), and `test/lockfile-sync.test.cjs` now runs the same check offline. The actions are on versions that run on Node 24, because GitHub deprecated actions that run on Node 20; that is the runtime of the actions only. The Node version of the project's own tooling is the `node-version` in each job, which was not changed. `test/ci-workflows.test.cjs` keeps these properties in place.

## How it is built

- **Electron** main process: spawns each agent in a pseudo-terminal (`node-pty`), routes messages between agents through a local folder of plain files, keeps tasks and memory, and runs the in-process **broker** that every integration goes through.
- **React** renderer: the command centre, agent cards, settings, and the Integrations & Skills hub.
- **Pixi.js** floor: one painted world image with depth-sorted pieces, tile collision, door links between locations, characters drawn from per-character recipes.
- **The art is generated by code.** `tools/himym/` paints every room and exports the images and map data the app loads: `python3 tools/himym/build.py`.

Where things are:

| Path | What |
|---|---|
| `src/main/` | agent processes, message routing, tasks, config, the broker (`broker/`), sign-ins (`connect/`, `oauth/`), skills |
| `src/renderer/src/scene/office/` | the floor: world, camera, characters, cast |
| `src/renderer/src/components/` | command centre, cards, setup screens; `hub/` is Integrations & Skills |
| `src/shared/` | data both sides read: the provider manifest, the MCP catalogue, the agent compatibility table |
| `resources/mcp-locks/` | the hash-pinned dependency locks of the local MCP servers |
| `evidence/` | the recorded runs that back every "verified" |
| `tools/himym/` | the room painters and exporter |
| `website/` | the landing page |

## Development

```bash
npm run dev            # run the app from source
npm run typecheck      # node + web type checks
npm run test:focused   # the automated suite
npm run build          # production build into out/
npm run dist:mac       # build a Mac app and DMG into dist/
npm run dist:win-on-mac  # cross-build the unsigned Windows installer on a Mac
npm run docs:gen       # regenerate the generated parts of DEVELOPMENT.md and INTEGRATIONS.md
npm run docs:check     # fail if those parts are out of date
npm run website:build  # regenerate the website's data and check its links and claims
npm run website:check  # the same checks, writing nothing: fails if a generated file is stale
```

`npx vite --config vite.lab.config.ts` serves only the floor, with stand-in agents, at `http://localhost:5199/lab.html`.

Checks you can run against the real programs (each prints PASS or FAIL for every check and writes its evidence):

```bash
node tools/verify-codex-live.cjs --evidence evidence/codex/codex-live
node tools/verify-gemini-live.cjs --gemini /path/to/gemini --evidence evidence/gemini/gemini-live
node tools/verify-stage-b-live.cjs      # a real Claude Code uses the pinned servers through the broker
node tools/verify-packages-live.cjs     # every pinned package installs, starts, lists tools and takes a call
node tools/ui-validate.cjs --out evidence/ui   # the real desktop app, driven, with screenshots
```

### The landing page

`website/` is a separate deliverable: plain HTML, CSS and scripts, no bundler and no dependencies. Its characters and rooms are exported from the app itself, so the page cannot drift from the product, and everything it says about integrations, agents, locations and status is **generated from the same data the app uses**. It is not deployed anywhere; open `website/index.html` through any static file server to look at it.

It shows the crew and the locations, the three coding agents with what was run for each, every integration grouped by what it is for (Local MCP tools, Developer tools, Productivity and knowledge, Communication, Google Workspace, Search and research, Business and payments, Custom APIs) with how far it has been checked, the skills platform, who can reach what and the known limits, five real captures of the settings interface, and the honest status table.

```bash
node tools/export-sprites.cjs   # every character and pose, the portraits, and one atlas
python3 tools/export-rooms.py   # the rooms, the street, the skyline and the cab
npm run website:build           # write the catalogue data, copy the screenshots, then check the page
npm run website:check           # the same checks, writing nothing (CI runs this)
```

The first two write into `website/assets/` and regenerate the manifests the page reads. `test/sprite-export.test.cjs` fails if an exported pose goes missing, stops differing from idle, or starts redrawing the body instead of the arms.

What `website:build` writes and checks:

- `website/js/catalogue.js` is written from the app's own data (`tools/lib/catalogue.cjs`), and the settings captures in `website/assets/ui/` are copied byte for byte from `evidence/ui-packaged/`. Counts in the page's prose are generated words, never typed.
- It fails on a broken link, anchor, image or script, an image without alt text, a room that is not one of the app's locations, a count typed by hand, or a sentence that calls an account-based provider verified without saying it is not.
- It then runs the page's own scripts against that data and reads what a visitor would get: every provider drawn once, each filter showing only its own group, no "undefined" on screen.

`test/website.test.cjs` runs all of it, and also proves the checks catch what they are for. Screenshots are never made up: the five captures are the ones the interface test took of the packaged app on a throwaway profile, and one of them shows a skill called "demo" that the test installed from a stand-in repository.

### Documentation

| Document | What |
|---|---|
| [INTEGRATIONS.md](INTEGRATIONS.md) | Every provider, how it connects, who can use what, how far each has been checked |
| [SKILLS.md](SKILLS.md) | The skills platform in detail |
| [SECURITY_REPORT.md](SECURITY_REPORT.md) | Security findings F1 to F9, what was tested, what remains |
| [MCP_BROKER_DESIGN.md](MCP_BROKER_DESIGN.md) | How the broker works and its limits |
| [MOSBIUS_PLATFORM_ROADMAP.md](MOSBIUS_PLATFORM_ROADMAP.md) | What is done, in progress and blocked on something only the owner can do |
| [STAGE_A_VERIFICATION.md](STAGE_A_VERIFICATION.md) | The identities only the owner can create, and the exact steps |
| [CHANGELOG.md](CHANGELOG.md) | What changed |

## Known gaps

Things the product does not do yet, kept here so the README and the website can stay about what it does:

- **Moving an agent between locations.** An agent belongs to the location that was open when you added it. Changing location changes which crew you are looking at and never touches a session. There is no control yet to move an existing agent from one location to another (`setAgentLocation` exists in the store and nothing calls it).
- **Linux.** An AppImage target is configured in `electron-builder.yml`; it has not been built or run.
- **Integrations and skills for other agent CLIs.** Only Claude Code, Codex and Gemini CLI are handed integrations or have skills managed by the app; the other agents the app can start (Cursor, Copilot, Grok, Qwen, Kimi Code, OpenCode, Crush, Pi, Antigravity, or a custom command) run without them.
- **Salesforce** is listed in the provider data as planned and is not offered.
