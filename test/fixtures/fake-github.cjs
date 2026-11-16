'use strict';

/**
 * A fake GitHub for the skills tests: the commit lookup, the directory listing at a commit and the raw files at a
 * commit, for one repository `o/r`. Nothing here reaches the network.
 */
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const URL1 = 'https://github.com/o/r/tree/main/skills/demo';

const V1 = {
  'skills/demo/SKILL.md': '---\nname: demo\ndescription: Does a demo.\nallowed-tools: Read\n---\n# Demo\nSay hello.\nKeep it short.\n',
  'skills/demo/notes.md': 'Some notes.\n'
};
const V2 = {
  'skills/demo/SKILL.md': '---\nname: demo\ndescription: Does a demo.\nallowed-tools: Read, mcp__mosbius-github__create_issue\n---\n# Demo\nSay hello.\nRun !`ls` first.\nKeep it short and open an issue when asked.\n',
  'skills/demo/run.sh': '#!/bin/sh\necho hi\n',
  'skills/demo/package.json': '{"name":"x","scripts":{"postinstall":"echo owned"}}\n'
};

function fakeGitHub() {
  const st = { head: SHA1, versions: new Map([[SHA1, V1]]), commitsFail: false, calls: [] };
  const raw = (sha, p) => `https://raw.githubusercontent.com/o/r/${sha}/${p}`;
  const getText = async (url) => {
    st.calls.push(url);
    if (/^https:\/\/api\.github\.com\/repos\/o\/r\/commits\//.test(url)) {
      if (st.commitsFail) throw new Error('rate limited (403)');
      return JSON.stringify({ sha: st.head });
    }
    let m = /^https:\/\/api\.github\.com\/repos\/o\/r\/contents\/([^?]*)\?ref=([^&]+)$/.exec(url);
    if (m) {
      const ref = decodeURIComponent(m[2]);
      const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : st.head;
      const files = st.versions.get(sha);
      if (!files) throw new Error('Not Found (404)');
      const prefix = decodeURI(m[1]).replace(/\/$/, '');
      const entries = new Map();
      for (const p of Object.keys(files)) {
        if (prefix && !p.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? p.slice(prefix.length + 1) : p;
        const first = rest.split('/')[0];
        if (rest.includes('/')) entries.set(first, { name: first, path: prefix ? `${prefix}/${first}` : first, type: 'dir' });
        else entries.set(first, { name: first, path: p, type: 'file', size: files[p].length, download_url: raw(sha, p) });
      }
      if (entries.size === 0) throw new Error('Not Found (404)');
      return JSON.stringify([...entries.values()]);
    }
    m = /^https:\/\/raw\.githubusercontent\.com\/o\/r\/([0-9a-f]{40})\/(.+)$/.exec(url);
    if (m && st.versions.get(m[1])?.[m[2]] !== undefined) return st.versions.get(m[1])[m[2]];
    throw new Error('Not Found (404)');
  };
  return { st, getText, publish(sha, files) { st.versions.set(sha, files); st.head = sha; } };
}

module.exports = { fakeGitHub, SHA1, SHA2, URL1, V1, V2 };
