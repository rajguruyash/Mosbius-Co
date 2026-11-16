/**
 * What each agent CLI can do with the app's integrations and skills, and what has actually been shown.
 * Pure data, shared by the main process, the Settings page and the tests.
 *
 * The three CLIs are different programs. Nothing here assumes that what works for one works for another:
 * each gets its own way of being handed an integration, its own skills folder, and its own label.
 *
 * Labels (the same rule as the provider manifest):
 *   verified     a real run of the real CLI, recorded in an evidence file that is in this repository
 *                (the test suite refuses a `verified` label that has no evidence file);
 *   wired        the app writes what the CLI's own documentation says it reads; not run against the CLI;
 *   unsupported  the CLI has no way to do it, or the app does not offer it.
 * A stand-in model or provider does NOT stop a run being real for the CLI: what is being verified is the CLI's
 * own behaviour (startup, tool offers, calls, the shell it runs). It never counts as a real provider account.
 */

export type AgentKey = 'claude' | 'codex' | 'gemini';

/** The two places the app installs a skill: Claude Code's own folder, and the shared `.agents` folder that Codex reads
 *  (and Gemini CLI too: its own user folder is the same one, measured on 0.68.0). */
export type SkillTarget = 'claude' | 'agents';

export type Support = 'verified' | 'wired' | 'unsupported';

export interface AgentCompat {
  agent: AgentKey;
  label: string;
  /** Reaching an integration through the in-app broker. */
  integrations: Support;
  /** How the agent is handed the broker's address and its capability. */
  delivery: 'config-file' | 'command-line-and-env' | 'settings-file-and-env';
  /** Whether the shell the CLI runs for the model can read the agent's own capability. */
  capabilityHiddenFromShell: 'yes' | 'no' | 'unknown';
  /** True when the CLI was MEASURED to load an integration only in a folder the person has trusted in that CLI itself
   *  (Gemini CLI 0.68.0). False means it was not seen to need that in the recorded run, not that it never does. */
  folderTrustRequired: boolean;
  /** True when "hidden from the shell" was MEASURED to hold only while the CLI's own OS sandbox is on: the pass is out of
   *  the shell's environment, but the CLI process that holds it can be read from the shell once the sandbox is off
   *  (Codex CLI 0.142.2, with a control run in the evidence). False means it was not measured that way. */
  shellProtectionNeedsSandbox: boolean;
  /** Repository files that back every `verified` above. */
  integrationsEvidence: string[];
  /** Skills. */
  skills: Support;
  skillTarget: SkillTarget;
  /** Where the CLI looks for skills (for the user to read; `~` is the home folder). */
  skillFolders: string[];
  skillsEvidence: string[];
}

export const AGENT_COMPAT: readonly AgentCompat[] = [
  {
    agent: 'claude', label: 'Claude Code',
    integrations: 'verified', delivery: 'config-file',
    // the config file holding the capability is on the deny-read list of the agent's own settings
    capabilityHiddenFromShell: 'yes', folderTrustRequired: false, shellProtectionNeedsSandbox: false,
    integrationsEvidence: ['evidence/stage-b/stage-b-live.json'],
    // the project folder was run (the CLI lists the skill before any model call); the user-level folder uses the same loader
    skills: 'verified', skillTarget: 'claude', skillFolders: ['~/.claude/skills', '<project>/.claude/skills'], skillsEvidence: ['evidence/claude/claude-skills-live.json']
  },
  {
    agent: 'codex', label: 'Codex CLI',
    integrations: 'verified', delivery: 'command-line-and-env',
    // Two protections, both measured with controls. (1) Out of the shell's environment, by two overrides the app adds (a shell
    // exclusion and the shell snapshot switched off). (2) The CLI process that holds the pass cannot be inspected from the shell
    // while Codex's OS sandbox is on (the app's auto mode, -s workspace-write: ps is refused); with the sandbox off the shell
    // reads the pass from the Codex process, so the label holds only while the sandbox is on.
    capabilityHiddenFromShell: 'yes', folderTrustRequired: false, shellProtectionNeedsSandbox: true,
    integrationsEvidence: ['evidence/codex/codex-live.json'],
    skills: 'verified', skillTarget: 'agents', skillFolders: ['~/.agents/skills', '<project>/.agents/skills', '<project>/.codex/skills'], skillsEvidence: ['evidence/codex/codex-live.json']
  },
  {
    agent: 'gemini', label: 'Gemini CLI',
    integrations: 'verified', delivery: 'settings-file-and-env',
    // NOT hidden (measured, with a control): Gemini's shell inherits the whole environment, and cannot be made unable to read the
    // pass (finding F9, left OPEN on purpose; the evidence's `f9` section says exactly why): the pass must be in Gemini's own
    // environment, which the shell can read; the CLI has no per-variable lever; and its global redaction hides variables that are
    // not the pass, SSH_AUTH_SOCK among them, whatever the allow list says. What limits a pass that can be read is what it can
    // do: this machine only, this agent only, its grant only, gone on exit.
    capabilityHiddenFromShell: 'no', shellProtectionNeedsSandbox: false,
    // an untrusted folder: the server is shown as disabled and never contacted (measured, `trust` group of the evidence)
    folderTrustRequired: true,
    // 0.68.0, in a folder the person has trusted in Gemini; a stand-in model and provider; no Gemini login was used
    integrationsEvidence: ['evidence/gemini/gemini-live.json'],
    skills: 'verified', skillTarget: 'agents', skillFolders: ['~/.agents/skills', '~/.gemini/skills', '<project>/.agents/skills', '<project>/.gemini/skills'], skillsEvidence: ['evidence/gemini/gemini-live.json']
  }
];

export function compatOf(agent: string): AgentCompat | undefined {
  return AGENT_COMPAT.find((a) => a.agent === agent);
}

/** Which agent a hive provider id belongs to, when it is one of the three; the other CLIs are not covered here. */
export function agentKeyOf(provider: string | undefined): AgentKey | undefined {
  if (provider === 'claude' || provider === 'claude-code') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'gemini') return 'gemini';
  return undefined;
}

/** The skills target for an agent kind; Claude Code's own folder unless the CLI reads the shared one. */
export function skillTargetFor(agent: AgentKey): SkillTarget {
  return compatOf(agent)?.skillTarget ?? 'claude';
}

/** The agents a skills target serves. */
export function agentsForTarget(target: SkillTarget): AgentKey[] {
  return AGENT_COMPAT.filter((a) => a.skillTarget === target).map((a) => a.agent);
}
