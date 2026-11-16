/* The agents, skills, security, screenshots and status sections.
 *
 * Like the integrations section, everything that states a fact is read from window.MOSBIUS_CATALOGUE (js/catalogue.js),
 * which tools/build-website.cjs writes from the app's own data and its evidence files: which coding agents are covered,
 * the version of each that was run, how many checks that run made, where each looks for skills, whether its shell can
 * read its pass, and the counts in the status table. The sentences around those facts are here; the facts are not.
 */
(function () {
  'use strict';

  const C = window.MOSBIUS_CATALOGUE;
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* "a, b and c" */
  function list(items) {
    if (items.length < 2) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /* the app's own three words for "how far was this shown", said in full */
  function supportWord(s) {
    if (s === 'verified') return 'Verified';
    if (s === 'wired') return 'Wired, not run';
    return 'Not supported';
  }

  function runPhrase(run) {
    if (!run) return 'no run is recorded';
    return run.passed + ' of ' + run.checks + ' checks passed' + (run.date ? ' on ' + run.date : '');
  }

  function shellAnswer(a) {
    if (a.shell.passHidden === 'no') {
      return 'Yes. A command in its shell can read the pass, and no setting of its own can stop that. A known finding (F9), left open on purpose.';
    }
    if (a.shell.passHidden === 'yes' && a.shell.onlyWhileSandboxed) {
      return 'No, but only while its own OS sandbox is on. With the sandbox off, a command can read the pass from its process.';
    }
    if (a.shell.passHidden === 'yes') return 'No.';
    return 'Not measured.';
  }

  function fact(dl, term, node) {
    dl.appendChild(el('dt', null, term));
    const dd = el('dd');
    if (typeof node === 'string') dd.textContent = node; else dd.appendChild(node);
    dl.appendChild(dd);
  }

  // ── the coding agents ────────────────────────────────────────────────────────────────────────────────────────────
  function agentCard(a) {
    const card = el('article', 'agent-card');

    const head = el('div', 'agent-card-head');
    head.appendChild(el('h3', null, a.label));
    head.appendChild(el('span', 'agent-ver', 'version run: ' + a.version));
    card.appendChild(head);

    const tags = el('div', 'agent-tags');
    tags.appendChild(el('span', 'tag ' + (a.integrations === 'verified' ? 'tag-on' : 'tag-optin'),
      (a.integrations === 'verified' ? 'Run with the real CLI' : supportWord(a.integrations)).toUpperCase()));
    if (a.shell.onlyWhileSandboxed) tags.appendChild(el('span', 'tag tag-consent', 'NEEDS ITS SANDBOX ON'));
    if (a.shell.passHidden === 'no') tags.appendChild(el('span', 'tag tag-consent', 'SHELL CAN READ THE PASS'));
    if (a.folderTrustRequired) tags.appendChild(el('span', 'tag tag-optin', 'TRUSTED FOLDERS ONLY'));
    card.appendChild(tags);

    card.appendChild(el('p', 'agent-summary', a.summary +
      (a.folderTrustRequired ? ' It loads integrations only in folders you have trusted in ' + a.label + ' itself.' : '')));

    const dl = el('dl', 'facts');
    fact(dl, 'Integrations', supportWord(a.integrations) + ': ' + runPhrase(a.run) + ', with ' + a.runHow.text + '.');
    fact(dl, 'Skills', supportWord(a.skills) + ': the real CLI lists skills installed for it. ' +
      (a.skillTarget === 'claude' ? 'It has a folder of its own.' : 'It reads the shared agents folder.'));
    fact(dl, 'Can its shell read the pass?', shellAnswer(a));
    if (a.installCommand) fact(dl, 'Install', el('code', null, a.installCommand));
    card.appendChild(dl);
    return card;
  }

  function renderAgents() {
    const host = $('agent-cards');
    if (host) host.replaceChildren(...C.agents.map(agentCard));
    const note = $('engines-note');
    if (note && C.otherEngines.length) {
      note.textContent = 'The app can also start ' + C.otherEngines.join(', ') +
        ', or any command of your own. The integrations and skills platform does not cover those: only ' +
        list(C.agents.map((a) => a.label)) + ' are handed integrations or have their skills managed by the app.';
    }
  }

  // ── where each CLI finds its skills ──────────────────────────────────────────────────────────────────────────────
  function renderSkills() {
    const body = $('skills-compat');
    if (!body) return;
    const rows = [];
    for (const a of C.agents) {
      const tr = el('tr');
      const th = el('th', null, a.label);
      th.setAttribute('scope', 'row');
      tr.appendChild(th);
      const folders = el('td');
      a.skillFolders.forEach((f, i) => {
        if (i) folders.appendChild(el('span', null, ', '));
        folders.appendChild(el('code', null, f));
      });
      tr.appendChild(folders);
      tr.appendChild(el('td', null, supportWord(a.skills) + ': ' + runPhrase(a.skillsRun) + '.'));
      rows.push(tr);
    }
    body.replaceChildren(...rows);
  }

  // ── the known limits ─────────────────────────────────────────────────────────────────────────────────────────────
  function limits() {
    const out = [];
    out.push(['A pass is a bearer value',
      'Anything running as you that can read an agent\'s environment or its configuration can use that agent\'s pass until it is cancelled. The app bounds the damage (this computer only, that agent only, its grant checked on every request, never the credential itself); it cannot remove the risk.']);
    for (const a of C.agents) {
      if (a.shell.onlyWhileSandboxed) {
        out.push([a.label + ': the protection needs its sandbox',
          'The pass is kept out of the shell\'s environment, and with the CLI\'s own OS sandbox on, the shell cannot inspect the process that holds it. With the sandbox off, a command can read the pass from that process.']);
      }
      if (a.shell.passHidden === 'no') {
        out.push([a.label + ': its shell can read the pass',
          'The pass has to be in the CLI\'s own environment, which a command in its shell can read, and the CLI has no setting that prevents it. Finding F9, left open on purpose: nothing was built that only looks like a fix. What limits it is what a pass can do.']);
      }
      if (a.folderTrustRequired) {
        out.push([a.label + ': trusted folders only',
          'It loads an integration only in a folder you have trusted in ' + a.label + ' itself. Elsewhere the integration is disabled and the broker is never contacted.']);
      }
    }
    const ownApp = C.groups.flatMap((g) => g.providers).filter((p) => p.ways.indexOf('own-app') >= 0);
    if (ownApp.length) {
      out.push(['The legacy bridge leaves tokens in readable files',
        'On the default engine, ' + list(ownApp.map((p) => p.label)) + ' are reached through the mcp-remote bridge, which keeps their tokens in readable files while an agent that uses them runs. The in-app engine does not do this.']);
    }
    if (C.counts.realAccountVerified === 0) {
      out.push(['No real provider account has been used',
        'Every account-based provider is stand-in tested only. A real sign-in can still fail at its first real call.']);
    }
    out.push(['A first grant needs a new session',
      'Narrowing access, or widening an integration an agent already has, applies on its next request. An agent that started with no access to an integration does not get it mid-session: start a new session for that agent.']);
    out.push(['Unsigned builds; macOS only so far',
      'The builds are unsigned and not notarised. Everything here was tested on macOS; Windows and Linux were not run.']);
    return out;
  }

  function renderLimits() {
    const host = $('limits');
    if (!host) return;
    host.replaceChildren(...limits().map(([title, text]) => {
      const box = el('div', 'limit');
      box.appendChild(el('b', null, title));
      box.appendChild(el('p', null, text));
      return box;
    }));
  }

  // ── the screenshots ──────────────────────────────────────────────────────────────────────────────────────────────
  function renderShots() {
    const host = $('shots');
    if (!host) return;
    host.replaceChildren(...C.screenshots.map((s) => {
      const fig = el('figure', 'shot');
      const img = el('img');
      img.setAttribute('src', s.file);
      img.setAttribute('alt', s.alt);
      img.setAttribute('width', String(s.width));
      img.setAttribute('height', String(s.height));
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      // the capture is small on the page: the picture itself opens at full size
      const link = el('a', 'shot-link');
      link.setAttribute('href', s.file);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
      link.setAttribute('aria-label', s.title + ': open the full-size capture');
      link.appendChild(img);
      fig.appendChild(link);
      const cap = el('figcaption');
      cap.appendChild(el('b', null, s.title));
      cap.appendChild(el('span', null, s.caption));
      fig.appendChild(cap);
      return fig;
    }));
  }

  // ── the status table: the rows whose numbers come from the data ──────────────────────────────────────────────────
  function renderStatus() {
    const host = $('status-generated');
    if (!host) return;
    const n = C.counts;
    const rows = [];
    for (const a of C.agents) {
      rows.push([a.label + ' ' + a.version,
        supportWord(a.integrations) + ' with the real CLI: ' + runPhrase(a.run) + ', with ' + a.runHow.text + '.']);
    }
    rows.push(['Integrations', C.countsSentence]);
    rows.push(['Local MCP servers', n.localServers + ' locally tested on macOS: each answered a real tool call' +
      (C.runs.localServers ? ' (' + runPhrase(C.runs.localServers) + ')' : '') + '.']);
    rows.push(['Account-based providers', n.realAccountVerified === 0
      ? 'Stand-in tested only. None has been verified with a real account.'
      : n.realAccountVerified + ' verified with a real account; the rest are stand-in tested only.']);
    rows.push(['Skills platform', 'Tested against a stand-in GitHub and driven in the real desktop app. Not run against the live catalogue.']);
    rows.push(['The desktop app, driven for real',
      'Development build: ' + runPhrase(C.runs.desktopAppDevelopment) + '. Packaged build: ' + runPhrase(C.runs.desktopAppPackaged) + '.']);
    rows.push(['Settings', C.hubTabs.join(', ') + '. In English, Simplified Chinese and Arabic; not reviewed by native readers.']);
    rows.push(['Locations', C.locations.map((l) => l.label).join(', ') + '.']);
    host.replaceChildren(...rows.map(([area, state]) => {
      const tr = el('tr');
      const th = el('th', null, area);
      th.setAttribute('scope', 'row');
      tr.appendChild(th);
      tr.appendChild(el('td', null, state));
      return tr;
    }));
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!C) return;
    renderAgents();
    renderSkills();
    renderLimits();
    renderShots();
    renderStatus();
  });
})();
