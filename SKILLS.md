# Skills

Mosbius & Co. is a fan-made project inspired by How I Met Your Mother. It is not affiliated with, endorsed by or connected to the show, its makers or its owners.

A skill is a folder with a `SKILL.md`: instructions an agent can load. This page is the reference for **Settings → Integrations & Skills → Skills**.

## The rule

**Installing a skill grants nothing and connects nothing.** A skill cannot give itself a tool, run a hook, start a server, or arm anything. The app copies it in with those things taken out, tells you what it took out, and never connects a service because a skill mentions one.

## What the installer does

For every file it writes:

- `allowed-tools`, `hooks`, `mcpServers` and `permissionMode` are removed from the markdown, in every spelling and YAML shape.
- Run-on-load syntax (a `!` followed by a backtick command) is defused.
- Configuration that would arm a hook, a server or a plugin (`.mcp.json`, `settings.json`, `hooks.json`, `plugin.json`, anything under `.claude/`) is **not written at all**.
- Scripts and dependency files (`*.sh`, `package.json`, `requirements.txt`, …) are written as plain, non-executable data and **listed to you**. Nothing is installed and nothing is run. An agent that is later told to run one still can; the app does not take away an agent's own shell.
- The installer imports no code that can start a process, touch a grant or read a credential (a test checks the source).

The result tells you the exact commit it read, how many grants or commands it took out, which scripts the skill ships, and which integrations it *needs* (named in its `allowed-tools`, which were then removed) and which it only *mentions* (text, shown as a suggestion). A needed integration appears as a chip with a **Connect** button; pressing it opens that service on the Discover tab. It is never connected for you.

## Where a skill goes

The three agent CLIs do not read the same folder, so you choose what you install **for**:

| Install for | Folder | Read by |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/<name>` | Claude Code. A project skill folder was shown to be listed by the real CLI (`evidence/claude/claude-skills-live.json`). |
| Codex CLI and Gemini CLI | `~/.agents/skills/<name>` | Codex CLI: **shown** by the real CLI to list a skill here, in `<project>/.agents/skills` and in `.codex/skills`, and **not** in `.claude/skills` (`evidence/codex/codex-live.json`). Gemini CLI 0.68.0: **shown** by the real CLI to list a skill installed here, both when you run `gemini` yourself and inside the Gemini home the app builds for an agent (a link to this folder), and to read `~/.gemini/skills`, `<project>/.agents/skills` and `<project>/.gemini/skills`, but **not** `.claude/skills` (`evidence/gemini/gemini-live.json`). |

Each folder has its own install record, so the same skill can be installed for both, updated for one, and removed from one, and the other stays exactly as it was.

## What the app remembers, and where

Every install writes a record **outside the skill folder**, where an agent cannot edit it (`<app data>/skill-installs/`, one folder per target): the source, the exact commit it was read at, the hash of every file as downloaded and as written, what the guard removed, the scripts it noted, and the integrations it names. Records from older versions are still read.

## Keeping a skill honest

- **Check** recomputes every hash and reports a skill that has changed on disk since it was installed, file by file (changed, missing, added). An agent, an editor or anything else can have changed it.
- **Look for update** fetches the newer commit into a staging folder, passes it through the same guard, and shows you **every changed line**, any tool the new version asks to pre-approve (removed on install, but shown), any new script or dependency file, any new integration it would use, and any file *you or an agent changed* that the update would replace. Nothing changes until you press **Install update**.
- **Install update** keeps the old folder and record, so **Roll back** can restore the previous version. Up to five versions are kept. An update that fails half way leaves the skill as it was.
- **Remove** asks twice, deletes the folder, and removes the record and its backups.

The app never updates a skill by itself.

## What is checked, and what is not

- Tested against a fake GitHub (`test/skill-manager.test.cjs`, `test/skill-targets.test.cjs`, `test/skill-guard.test.cjs`): pinning, hashes, integrity, the update preview, apply, rollback, failure half way, refusals for names that are not folder names, per-target separation, and that nothing a skill ships is run.
- Driven in the real desktop app, development and packaged builds (`evidence/ui`, `evidence/ui-packaged`): installed skills listed with their provenance, an edit detected by **Check**, two-step **Remove** deleting only that target's folder and record, an older record still read after an upgrade, everything surviving a restart.
- **Not done:** installing a skill from the live catalogue (that downloads files, and was left to you), and a real update from a real repository. The catalogue is a community list (abubakarsiddik31/claude-skills-collection) and is shown as it is; the app does not vouch for its entries.
- Windows and Linux were not run.
