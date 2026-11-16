/**
 * How an app-run local server is started for one agent (Stage B, F1): the installed package's
 * own executable, the catalogue's arguments with `<cwd>` replaced by THAT agent's workspace, the
 * environment the server is allowed (see mcpCredentials.ts), the roots it is told about, and, if
 * it has one, its credential on a private pipe.
 *
 * Pure, so the rule that decides which directory a filesystem or git server may touch is tested
 * directly: it is always the working directory of the agent that asked, never the whole disk, never
 * another agent's, and never something the agent supplied in the request.
 *
 * THE CREDENTIAL IS NOT IN THE ENVIRONMENT. A variable in a process's initial environment is listed
 * by `ps eww` (and by /proc/<pid>/environ) to every other process the same user runs, which includes
 * an agent that can run a shell. So a Node server is started through a tiny launcher: it reads the
 * credential from file descriptor 3, sets it in `process.env` once it is running, and then loads the
 * server. A variable set that way is not in the initial environment block the OS reports. The launcher
 * is plain text with no secret in it, so it may appear in the argument list.
 */
import { isAbsolute } from 'node:path';
import type { McpCatalogEntry } from '../shared/mcpCatalog';
import type { StdioLaunch } from './broker/stdio-host';

/** Run as `node -e <this> <server.js> [server args]`. Reads `{NAME: value}` from fd 3, sets it in-process, runs the server. */
export const NODE_SECRET_LAUNCHER = [
  "const fs=require('node:fs');const {pathToFileURL}=require('node:url');",
  "let s={};try{s=JSON.parse(fs.readFileSync(3,'utf8')||'{}')}catch{}",
  "for(const k of Object.keys(s)){if(typeof s[k]==='string')process.env[k]=s[k]}",
  "const a=process.argv.slice(1);const bin=a[0];process.argv=[process.argv[0],bin,...a.slice(1)];",
  "import(pathToFileURL(bin).href).catch((e)=>{process.stderr.write(String(e&&e.message||e)+'\\n');process.exit(1)});"
].join('');

export function resolveLaunch(
  entry: McpCatalogEntry,
  installed: { command: string; args: string[]; runtime?: 'node' | 'native' },
  cwd: string,
  env: Record<string, string>,
  secrets?: Record<string, string>
): StdioLaunch | undefined {
  if (entry.spec.transport === 'http' || entry.spec.transport === 'bridge') return undefined;
  if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd)) return undefined;
  const serverArgs = entry.spec.args.map((a) => (a === '<cwd>' ? cwd : a));
  const hasSecrets = !!secrets && Object.keys(secrets).length > 0;
  if (!hasSecrets) {
    return { command: installed.command, args: [...installed.args, ...serverArgs], env, cwd, roots: [cwd] };
  }
  // A credential only ever travels on the private pipe, which only the Node launcher can read. A
  // server that cannot be started that way does not get its credential at all, and does not start.
  if (installed.runtime !== 'node' || installed.args.length < 1) return undefined;
  return {
    command: installed.command,
    args: ['-e', NODE_SECRET_LAUNCHER, ...installed.args, ...serverArgs],
    env, secrets, cwd, roots: [cwd]
  };
}
