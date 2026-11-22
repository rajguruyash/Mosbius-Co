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

## Agent Huddle and notifications

Two features that share one source of truth. The **notification service** turns what agents really do (finish, ask a question, wait for a permission, hit an error, lose access to an integration) into records the person can act on. The **Huddle** is a second, small window that stays on top of everything else and shows the same agents, so the main window can be out of the way while work goes on. Neither one starts, owns or duplicates an agent: opening and closing the Huddle changes which window is visible and nothing else.

| Path | What |
|---|---|
| `src/shared/agentActivity.ts` | the state machine: lifecycle events in, one state per agent out (`idle`, `working`, `researching`, `waiting`, `completed`, `needs-input`, `needs-approval`, `error`, `paused`, `stopped`) and the signals that mean something happened. Pure; every rule is unit-tested |
| `src/shared/notifications.ts` | the notification model: six categories (`completed`, `intervention`, `input`, `approval`, `access`, `info`), priorities, preferences, and which signal becomes which record. Text travels as i18n keys and arguments, never as finished sentences |
| `src/shared/huddle.ts` | the one `HuddleState` the window renders, the commands it may send, and the window geometry (sizes, docking, snapping, clamping to a monitor) as pure functions |
| `src/shared/promptKeys.ts` | the keys that answer a permission prompt, and the gap between key presses |
| `src/main/activityTracker.ts` | one activity per agent, advanced by hook events, the terminal starting and dying, pause and halt, the circuit breaker, a keystroke typed at an open prompt, and the passage of quiet |
| `src/shared/soundPolicy.ts` | how the sounds share the speakers: which cue outranks which, how long each holds them, when a second one is dropped or takes over, and the volume curve. Pure |
| `src/main/soundPort.ts` | playing a sound without holding anything up: it looks for the file, starts the system player, and returns; files are made in the background. Electron-free |
| `src/main/notifyService.ts`, `notifyDelivery.ts`, `soundSynth.ts` | records, de-duplication, preferences, the history file, the desktop banner and the sounds (composed and mastered in `soundSynth.ts`, played by the system's own player from `notifyDelivery.ts`). The service talks to ports, so it runs under plain Node in tests |
| `src/main/lifecycleWiring.ts`, `hooks.ts`, `pty.ts`, `index.ts` | where the real events are tapped: the hook server, the terminal manager (a read-only "tap" with a 96 KB replay buffer), the control registry, the breaker, the broker's access audits |
| `src/main/huddleHub.ts` | merges the roster the main window publishes, the tracker, the live terminals and the notifications into one state, broadcast to every window (coalesced, 80 ms, never sent twice); validates and routes every command by agent id |
| `src/main/notifyActions.ts`, `conversation.ts` | what approve, reject, choose, answer and restart really do; the conversation view (the tail of the agent's own transcript, or its hive thread) |
| `src/main/huddleWindow.ts`, `huddleSetup.ts` | the window (flags, docking, monitors) and the composition root that owns every IPC channel |
| `src/preload/huddle.ts` | the narrow bridge the Huddle window gets; a test pins its exact list of keys |
| `src/renderer/src/huddle/` | the Huddle UI (compact list, expanded panel, one agent's conversation and terminal, preferences), the characters and the attention schedule |
| `src/renderer/src/components/NotificationBell.tsx`, `NotificationSettings.tsx` | the bell and inbox in the main window, and Settings → General → Notifications; they share `PrefsPanel` with the Huddle so the two cannot disagree |
| `src/renderer/src/scene/office/activityStates.ts` | the floor's animation system, extended compatibly: three glyphs (question, error, paused) and the mapping from the nine states to a pose |
| `test/fixtures/stand-in-agent.cjs`, `tools/huddle-validate.cjs` | a program that behaves like a hook-reporting CLI, and the harness that drives the real app with it |

### How an event travels

```
hook payload ─┐
terminal up/down ┤
pause / halt ────┼─▶ ActivityTracker ─▶ reduceActivity() ─▶ signals ─▶ NotificationService ─▶ banner, sound, history
circuit breaker ─┤        (main)         (pure state machine)      │
a keystroke ─────┘                                                 └▶ HuddleHub ─▶ huddle:state ─▶ every window
renderer roster (names, characters, queues, tasks) ───────────────────▶ HuddleHub
```

- **One state machine, in the main process.** The main window's store still drives the floor, but the Huddle and the notifications have to keep working while that window is minimised, so they read the tracker, which reacts only to events the main process really sees. The renderer contributes a roster (name, character, location, queue length, hive tasks) over `huddle:publishRoster`. Nothing is guessed: progress is shown only when an agent writes a todo list or has hive tasks, and a state is only ever the consequence of an event.
- **Commands go to the owner of the thing.** Sending a message hands it to the main window's own message queue (`hive:enqueueToAgent`), the same path as typing in the command centre, so a message sent while an agent is busy waits its turn and a message to one agent can never reach another. Pause, resume, stop and restart call the same functions as the existing controls. Nothing writes to a terminal except an answer to a prompt that is open in that terminal.
- **Permission prompts are answered where they live.** A prompt Claude Code shows in its own terminal cannot be answered through a hook, so approve is Enter, reject is Esc, choosing option *n* is *n* presses of the down arrow and then Enter (each key a separate write, 70 ms apart, because a menu loses a key that arrives in the same chunk), and "reject, and do this instead" is Esc followed by the instruction through the agent's normal queue. A notification is resolved once its keys were really written to a live terminal. Nothing is written if the notification is already resolved, the action was never offered for it, or the terminal is gone, so a stray Enter cannot reach a prompt that has already closed. A prompt answered some other way (in the terminal itself, or the agent simply moves on) resolves the notification too, recorded as done by the agent. A prompt stays open while other tool calls run beside it (sub-agents, parallel reads): it is closed by its own call finishing (matched by the CLI's call id, else by tool name), by a keystroke that answers it, or by the turn ending. Whether Claude Code sends a call id in every hook it fires, and in what order parallel calls report, was not observed against the real CLI (its hooks are switched off in the `--bare` mode the key check needs); without ids the tool name decides.
- **De-duplication is by event identity, not by time.** The same unresolved request (same agent, same kind, same subject) is one notification whose repeat count rises; a new notification appears when the request is resolved and a different one arrives.
- **Attention is a schedule, not a loop.** A request that is waiting keeps a steady dot and ring (which cost nothing); the character bounces, shakes or glows in short bursts: at once, after 20 s, one minute, three minutes, then every five minutes. The schedule restarts only for a new request and ends only when the request is resolved or dismissed. Opening the Huddle does not clear it.
- **The window never takes focus unless a person is typing in it.** It is frameless, transparent, always on top (level `screen-saver`, so it also sits over full-screen apps), shown with `showInactive()`, and `focusable: false` until a text field is clicked (`huddle:keyboard` turns focus on and off again). Electron's `type: 'panel'` was tried and is refused on macOS ("NSWindow does not support nonactivating panel styleMask"), so it is not used. Position, monitor, dock edge (left, right or free) and level (compact or expanded; the single-agent view is never restored, because that agent may be gone) are saved; the size follows from the level and the number of agents. The saved position is clamped to the monitor under it when monitors or scale change.
- **Text.** Banners and the Huddle read the same locale files (`huddle.*` and `notify.*` in `en`, `zh-CN`, `ar`); the main process learns the language from the renderers (`app:reportLanguage`).

Saved state: the Huddle's preferences are the kv entry `huddle.prefs` in the app's SQLite store; the notification history and preferences are `notifications.json` in the user-data folder. A request that was still open when the app quit is closed on the next start (resolution by `system`, note `app-restarted`), so an old question never offers buttons that answer nothing.

### The sounds

Each kind of event has its own sound. All of them are composed in code: `src/main/soundSynth.ts` makes them from a few oscillators and noise, deterministically, and all but the task-complete piano hook are cut from one tune. No recorded audio ships with the app, and `test/bundled-sound.test.cjs` keeps it so. The operating system's own player plays the files (`afplay`, `paplay`, or PowerShell's `SoundPlayer`), so they sound in every window state, with the main window minimised and while another application is in front.

| Sound | When | What it is |
|---|---|---|
| `completed` | an agent finished the whole of its task | **Mosbius Signature Piano — Task Complete**: the app's own synthesized piano hook, about 3.3 s |
| `intervention` | an agent is stuck at a prompt, or its circuit breaker tripped | knock, knock, then a short question on the piano |
| `input` | an agent asked a question | a piano note and a bell a fourth above (B E) |
| `approval` | a permission prompt | three rising fourths that end open (E A D) |
| `access` | the broker refused an integration call | two muted low plucks and a suspended chord left hanging |
| `critical` | an agent crashed | a gentle descent (B G E B) ending on a soft hand-drum thud |
| `started` | an agent started (not a notification: nothing is recorded) | a tiny pluck and a quiet bell |
| `signature` | never an event: previews and the test notification | the tune itself, about three seconds: the rise, the ask and the fall, ending on a G chord |

The palette is acoustic (pluck, soft piano, small bell, a knuckle on wood, a hand drum), the key is G major, the pulse is 150 beats a minute, and each cue except the piano hook is one of the signature's cells (`CELLS`), which `test/sound-synth.test.cjs` checks. Every cue gets a small room, a high-pass at 60 Hz and a low-pass at 4.8 kHz, is normalised to its own loudness in LUFS (urgent cues a little louder, `started` about 6 LU softer than the rest) and limited, so nothing clips, nothing is shrill and no cue is much louder than another; the tests measure each of those. Nobody has listened to a unit test: the measurements say a sound is clean, in tune and level, not that it is pleasant. The preview buttons are how a person decides that, and the notes, instruments and levels are data (`SCORES`, `CELLS`, `SOUND_TARGET_LUFS`), so changing one is an edit to a table. Bump `SOUND_VERSION` when the music or the mastering changes, so the files already on disk are replaced.

**The task-complete piano hook (`completed`).** It is the sound an agent finishing the whole of its task rings, and what the unit tests render. An original arrangement of a chord progression in A major at about 132 beats a minute over the bass A G# F# E D E A (`HOOK_PROGRESSION` in `src/main/soundSynth.ts`: nine steps, the frequencies and lengths it was specified with, held against that table by the tests). Every step is a chord struck by all its voices together (rolled a few milliseconds from the bass up), the top voice a little firmer, and the upper notes bounce between the hits: the two upper-only steps re-strike while the bass before them still rings. The last chord (A major, six voices) is held for 750 ms and then eased off like a pedal lifting. It is played by one instrument, `grandPiano`: additive synthesis with unison strings a hair apart that fade at different rates (the quick drop and long tail of a real note), stiffness that sharpens the high partials, a felt hammer that is darker when soft and brighter up the keyboard, lifted second to fifth partials in the bass (so the lowest notes carry on small speakers), a short hammer thud and a soundboard that answers low. No oscillator beeps, no sample, no recording. It is mono on purpose: the cues share one loudness measure and laptop speakers are nearly mono. It was not made with the Web Audio API, which would have needed a page and an audio context alive in some window: the app already renders sounds in the main process and hands them to the operating system's player, which is what makes them sound with every window minimised and which no page's lifecycle can interrupt.

The event that rings it is the agent's own `Stop` hook ending a substantial turn (`turn-completed` with `substantial` in `src/shared/agentActivity.ts`, a notification of category `completed` from `intentFromSignal`): at least 15 seconds or three tool calls, and for the orchestrator only a turn a person asked for. A helper finishing (`SubagentStop`), a checklist item, a tool result, a command exiting, a pause, a question, a permission prompt, an error (a crash, `StopFailure`), a stop and an interrupt are other events and ring something else or nothing; repeated Stops are one completion. Nothing is inferred from terminal output. `test/completion-sound.test.cjs` drives the real chain with Claude Code's hook payloads for every one of those. Agents finishing together, or within six seconds of each other, ring it once and every completion is still recorded; a more urgent cue takes over from it at once.

Playing never holds up an agent. The notification service calls `playSound` from the middle of handling the event, so `src/main/soundPort.ts` does only cheap things on that call: look for the cue's file and start the system player as a separate process. Every file is made in the background (`renderCueAsync`: the render is a generator taken in slices of about 8 ms with the event loop handed back between them) from five seconds after the app starts, and a file that is somehow not there yet is made the same way and played when ready, or dropped if it would be late. `test/sound-port.test.cjs` measures that.

Sounds share the speakers through `SoundGate` (`src/shared/soundPolicy.ts`). One sound at a time. The same cue again inside its cooldown is one cue (five agents finishing together ring once). A lower-ranked cue is dropped while a higher one sounds, and a higher one takes over at once (the lower one's player process is stopped), so an urgent sound is never made to wait behind a chime. A stand-in longer than the cue's own sound (a person's file) holds the speakers for its real length, read from its header, and widens the cooldown by how much longer it is, so a seven-second file is not followed straight away by itself: for such a `completed` file the same-news window is about ten seconds, not six. `started` is routine: it gives way to everything and is heard at most every six seconds. A dropped sound is never a lost notification: the record, the banner and the Huddle still say it, and the record's delivery report says `muted`.

Preferences (in `notifications.json`): `sound` is the master switch, `volume` is the slider (0 to 1, squared to a gain), `cues` is one switch for each sound (the start sound is one of them: a start is not a notification, so it has no category; a preferences file from before there was one switch per sound keeps its old start-sound setting as that sound's switch), and the per-category switches silence the sound along with the banner. A sound that is switched off is silent and its record is untouched: its notification is still recorded and its banner still shown, and its delivery report says the sound was `off`. macOS and Linux players take the gain as an option; Windows' has none, so there the file is written at that gain (in twentieths). Settings → General → Notifications and the Huddle's own preferences panel have the slider, a switch beside each sound (the signature tune, which no event rings, has none) and a play button for each. A play button goes through its own channel (`notify:previewSound`) and only plays the sound: no record, no banner, no change to any agent. It works even when the notification sounds are off or that sound is switched off, so a person can hear what they are about to switch, and pressing another button takes over from the first.

**A person's own sound.** A WAV file named for a cue in `<data folder>/sounds/custom/` (`completed.wav`, `approval.wav` and so on, the names in the table above) is played instead of the sound that comes with the app for that cue, as it is, at the volume slider and under that sound's switch; previews play it too. The app never writes to that folder or removes anything from it (on Windows, whose player has no volume option, a copy at the volume is kept in `custom/.scaled/`), and nothing in it is part of the app or of any installer. The gate holds the speakers for the file's real length, read from its header, so a long file is not talked over. Remove the file and the sound that comes with the app is back.

**No recorded audio ships.** `src/main/huddleSetup.ts` still hands `<resources>/sounds` (a development run: the repo's `resources/sounds`) to the sound port as `bundledDir`, and for each cue the port looks, in this order, for `sounds/custom/<cue>.wav`, then `<bundledDir>/<cue>.wav`, then the synthesized sound; a missing file falls through to the next. Nothing creates the bundled folder: `electron-builder.yml` has no `extraResources` entry for it, the repository holds no audio file, and `test/bundled-sound.test.cjs` fails if either changes, so a recording cannot reach an installer by accident. The port's history, and so the tours, call a person's file `custom/<cue>.wav` and the app's own sounds `<cue>-vN.wav`. `LICENSE-ASSETS` says that every sound is composed in code.

Under `MOSBIUS_UI_TEST=1` (the real-app tours) the player is still started on the real file, but at zero volume, so a long run does not fill the room with chimes; `node tools/huddle-validate.cjs --audible` (which sets `MOSBIUS_SOUND_AUDIBLE=1`) lets a person listen while it drives the app. The sound port keeps a short history of what it was asked for (`sounds` in the tour's debug view), which `tools/huddle-validate.cjs` reads to check that each real event rang its own cue.

### Running it

```bash
node --test test/agent-activity.test.cjs test/notification-service.test.cjs test/huddle-hub.test.cjs \
  test/huddle-geometry.test.cjs test/conversation.test.cjs test/pty-mirror.test.cjs test/sound-synth.test.cjs test/sound-policy.test.cjs test/sound-port.test.cjs test/completion-sound.test.cjs test/bundled-sound.test.cjs \
  test/hooks-observer.test.cjs test/activity-glyph.test.cjs test/huddle-wiring.test.cjs test/huddle-ui.test.cjs
npm run build && node tools/huddle-validate.cjs                 # the real app; writes evidence/huddle/
node tools/huddle-validate.cjs --only approvals,attention       # some scenarios; --keep leaves the throwaway profile
node tools/verify-claude-prompt-keys.cjs                        # the app's keys against the REAL claude terminal interface (no account)
```

`tools/huddle-validate.cjs` starts the built app on a throwaway profile, adds real agents through the app's own form (they are the stand-in program, installed as a command named `claude` so the app wires hooks for it exactly as it does for the real CLI), and drives both windows. The scenarios are `opening`, `working`, `approvals`, `questions`, `failures`, `several`, `attachments`, `controls`, `returning`, `placing`, `preferences`, `attention`, `languages`, `bell`, `restarting`, `population`, `keyboard` (the window can take the keyboard only while a text field has been clicked, and gives it back when the field is left), `independence` (a long task keeps running, as the same process with one completion, while the Huddle is opened, closed and the main window minimised), `sounds` (the start cue, the volume slider, three agents asking in one breath ringing once, the master switch, Settings' play buttons creating nothing, a switch for each sound, and that the task-complete preview plays the app's own piano hook, never a file from the bundled folder), `custom` (a WAV in the data folder's `sounds/custom/` replaces a sound, and taking it away brings back the one that comes with the app) and `dedupe` (a waiting prompt announced again is still one open notification; a new request after an answer is a second one). It records the window flags read back from the main process, the tracker's states, the terminal text and screenshots of the Huddle in `evidence/huddle/`.

### The Huddle's pictures and videos

The README and the website show the Huddle with pictures and videos of the real app, recorded into `screenshots/huddle/` by two scenarios of `tools/huddle-validate.cjs`. Neither runs unless asked for, and both need ffmpeg on the PATH.

**`--only media`** (`node tools/huddle-validate.cjs --only media --packaged "<the app's executable>" --out <a scratch folder>`) records the Huddle's own windows over the DevTools protocol, never the screen:

- Three pictures at twice the pixel density: the compact list, the expanded panel with a request and a working agent, and one agent's view (`huddle-compact`, `-expanded` and `-agent`, `.png`). The window is photographed on its own cream (its background is that cream at 95%, so a picture with transparency would show whatever it was put on through it), and the always-on scrollbars this machine draws are hidden (a trackpad shows none until you scroll).
- `huddle-story.mp4` with its still: about seventeen seconds of the expanded Huddle in a fresh office. An agent asks to run a command and it is approved from the Huddle; another works through a task; a third asks which database to use and is answered; the first finishes. The frames are pictures taken one after another at twice the pixel density (a DevTools screencast gives one pixel per point, which is soft), about twenty a second, then put on a steady 30 frames a second with ffmpeg.
- Two GIFs for the README (`huddle-approve.gif`, `huddle-answer.gif`), cut from the same recording.

**`--only desktop`** (the same flags; `--dry` does everything except record and takes a picture of the screen at each step; `--keep-raw` keeps the raw recording and its timings in the `--out` folder) makes `huddle-desktop.mp4`, its still and `huddle-desktop.gif`: a real recording of the real screen, macOS only. The script, in order: the whole app is open at Barney's apartment with agents at work; the pointer goes to Huddle and clicks; the app minimises (the real macOS animation) and the Huddle comes up in the top right corner of the empty desktop; the camera moves in on it; the agents' animations and the requests that arrive are seen in the compact list; the Huddle opens out for a request to approve and a question to answer, then its notifications and its settings, then one agent's conversation and its terminal, then a message typed to another agent and the reply; and the camera moves back out to the whole desktop. It is a little over a minute long.

- Two steps. The recorder takes the whole built-in display at twice its pixel density, and `tools/camera-render.cjs` is a virtual camera over that recording: it holds on a view, glides (eased) to the next, and makes the video in one ffmpeg pass (the `zoompan` filter), cutting each frame out of the recording at its real size, so a view that is half the screen wide still has a pixel of recording for every pixel of video. The camera's views come from the script's own timings (the recorder prints the moment its first frame is taken) and from the Huddle's real window bounds at each of its three levels, so the camera is on the window and does not guess where it is. It eases the edges of the view (left, top, width), not the centre and the zoom: the Huddle is docked against the display's right edge, and easing the centre and the zoom separately swept that edge out of frame half way through a move. `--from-raw <the --out folder of a --keep-raw run>` runs the camera pass again on a kept recording, which is how a view is tuned without recording again. The video is 1920×1200, the display's own shape.
- The recorder (`tools/record-desktop.swift`, ScreenCaptureKit, macOS 15 or later) needs the Screen Recording permission of whatever starts it. The recording leaves out the files on the desktop (the Finder), every other application's windows and menu-bar icons, and notification banners, and the recorder's own indicator, so nothing has to be hidden or switched off: no setting is changed and nothing on the screen is closed or moved. What is left is the wallpaper, the menu bar (the clock and the system's own icons) and the app's own windows.
- Run it with the Mac in front of you. The first thing it does is a two-second throwaway recording, which makes macOS ask its Screen Recording question if it has not been answered; the script then waits (up to four minutes) while that question is on screen, so nothing real is recorded until a person has answered it. Only a person can: the answer is a button in a system dialog.
- It records the built-in display, because the app is placed there and because a display with a full-screen application on it shows a black backdrop instead of the wallpaper. The app opens where it was last, and nothing from outside can move it (the DevTools protocol cannot, and moving another application's window needs the Accessibility permission), so the app is started once to make its store, the window's place is written into that store (`window.bounds` in `harness.db`), and the app is started again. The Huddle's place (the top right corner, where it docks to the right edge) is set with the tour's `huddleDebugMove`, which the app remembers. Choosing an agent in the main window takes the view to the room its character is in at that moment (a new character walks in through MacLaren's), so the script chooses Barney's apartment last and checks that it is the room on show when the recording starts.
- The pointer is the real one, glided by the tool with `CGWarpMouseCursorPosition` (no permission needed), so keep your hands off the mouse and the keyboard while it runs. Each click is a real click inside the page: the harness cannot press the mouse button through the window server, which would need the Accessibility permission. The words typed to an agent are typed into the page one letter at a time. The title bar's version number is hidden while recording (a build made from the repo carries the repo's own number there).

The agents in all of it are the stand-in program of the tour (they are not models, so the words in a terminal or a conversation are theirs). For the desktop video it runs in its demo mode (`MOSBIUS_STANDIN_DEMO=<a folder>`, which the scenario sets and nothing else does): it keeps a transcript of its turns in the shape Claude Code keeps one, so the Huddle's conversation view has a conversation to show, and it leaves the `#tags` and its two lines that say what it is out of what it prints and writes. Everything it says is one of its scenarios' own lines, and the model names on the agent cards are the ones the app has configured for them, not anything the stand-in runs. The pointer in the story video is drawn by the script; the clicks under it are real events in the Huddle. Pictures are not edited after they are taken.

`npm run website:build` copies the seven files the page uses (`HUDDLE_MEDIA` in `tools/build-website.cjs`) byte for byte into `website/assets/huddle/`, and `npm run website:check` fails if a copy is stale, a file is missing or unused, a picture lacks alt text or its size, or a `<video>` is not muted, inline, named and without `autoplay`. `website/js/huddle.js` starts a video while it is on screen, stops it when it scrolls away, and for a visitor who asked for reduced motion leaves the still picture and a play button.

### What is and is not verified

- **Verified in the real app, with the stand-in agent:** the whole path from a message typed in the Huddle to the agent's terminal, its states, progress, completion and notification; approve, reject, alternative, option and answer reaching only the right agent; several agents needing input at once; a crash, a restart and Restart & Continue; attachments queued while an agent is busy; pause, resume and stop; repeated open and close with identical terminal process ids and no listener left behind; docking, dragging and the saved position; the attention schedule; the three languages including right-to-left.
- **Verified against the real `claude` CLI** (2.1.325, in a real terminal; the model behind it is a loopback stand-in, so there is no account and no network; `tools/verify-claude-prompt-keys.cjs`, 27 of 27 checks): Enter approves a Bash command and a file edit; Escape rejects both (nothing runs, and the CLI tells the model the tool use was interrupted); Down presses move the highlight to the entry asked for (read from the screen before Enter is sent) and Enter takes it, for entries 2, 3 and 4 of its four-entry Bash menu; Escape followed by a typed line reaches the model as the next message. This shows how the real prompt reacts to the app's keys. It does not show what a real model will ask for. The menus belong to that CLI version (Bash has four entries, a file edit three): the app sends keys, not entry numbers, so a reordered menu changes which entry a number means but not what approve and reject do. Only agents that report through Claude Code's hooks raise these requests; prompts from Codex or Gemini CLI were not tested.
- **Not verified:** how the sounds sound on real speakers (they are measured, not heard; see the sounds above), and the Windows and Linux players (the commands, and the files written at a gain for Windows, are unit-tested; nothing was played there); the cues for `intervention` and `access` in the real app (the unit tests cover which event rings which cue; the real-app tours trigger the other five); the operating system's own file dialog (the harness names files instead); a real mouse click on the Huddle through the window server, and so whether the operating system lets the window become the key window after a person's real click (the harness clicks through the DevTools protocol, which exercises the app's own keyboard hand-off and shows the window's flags change, but is not an operating-system click; appearing without stealing focus is judged from the window's flags and from which application is in front before and after); full-screen apps; Windows and Linux (the code paths exist, nothing was run there; on Linux under Wayland an always-on-top window may be ignored by the compositor).
- **Limits of the platform, handled as follows.** macOS and Linux give no signal when notification permission is switched off (only Windows reports a failure), so the app cannot tell "shown" from "swallowed by the system": the status says the notification was handed to the system, the Test button and a link to the system settings are offered, and the in-app bell, sound and the Huddle itself always show the request. Voice input is wired to the main window's dictation and is not offered in the Huddle.

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
