/* Mosbius & Co — what the characters say.
 *
 * Short catchphrases and original lines written for this page. Nothing here is
 * transcribed dialogue: the recognisable phrases are the two- and three-word
 * ones a parody tribute is built on, and everything else is written for the
 * product — code review, builds, tests, deploys.
 *
 * Lines are grouped by situation so a scene can ask for the right kind of line
 * rather than any line: `M.line('barney', 'deploy')`.
 */
window.M = window.M || {};

(function (M) {
  'use strict';

  /** Who the five are on the page. Roles are how the app presents a crew —
   *  one agent per room, not one model per person. */
  M.CAST = [
    {
      name: 'ted', label: 'Ted', role: 'The Architect',
      blurb: 'Starts with the shape of the thing. Ted is the agent you give the ' +
             'vague brief to — the one that reads the repository first and comes ' +
             'back with a plan before a single file changes.',
    },
    {
      name: 'barney', label: 'Barney', role: 'The Strategist',
      blurb: 'Takes the job nobody wants and makes it sound like an opportunity. ' +
             'The agent you point at the migration, the flaky suite, the rewrite.',
    },
    {
      name: 'marshall', label: 'Marshall', role: 'The Builder',
      blurb: 'Writes it, runs it, writes the test, runs it again. The long ' +
             'implementation session in the room next door.',
    },
    {
      name: 'lily', label: 'Lily', role: 'The Coordinator',
      blurb: 'Keeps the rooms honest about who is doing what. Watches the ' +
             'other sessions and tells you which one is actually stuck.',
    },
    {
      name: 'robin', label: 'Robin', role: 'The Independent One',
      blurb: 'Goes and finds out. Reads the docs, the changelog and the issue ' +
             'thread, and reports back without being asked twice.',
    },
  ];

  M.ROLE_OF = Object.fromEntries(M.CAST.map((c) => [c.name, c]));

  const LINES = {
    ted: {
      catch: ['Wait for it...', 'Trust me on this.'],
      idle: ['Give me one second.', 'I like where this is going.', 'Let me read it first.'],
      code: ['I have got a plan.', 'Read the repo, then the ticket.', 'This wants a refactor, not a patch.'],
      pub: ['First round is on me.', 'Downstairs. Booth. Now.'],
      home: ['I am going up to the apartment.', 'Up to 4C, back in five.'],
      spawn: ['We have got company.', 'Everyone, gather round.'],
      deploy: ['Right. Shipping it.'],
      pass: ['That is the shape of it.'],
      fail: ['Back to the drawing board.'],
      room: { apartment: 'This is where it all starts.', columbia: 'Class is in session.' },
    },
    barney: {
      catch: ['Suit up!', 'Legendary!', 'Challenge accepted!'],
      idle: ['True story.', 'Have you met my pull request?'],
      code: ['This refactor? Legendary.', 'New rule: no untested merges.', 'I call it... the strategy.'],
      pub: ['Daddy needs a scotch.', 'To the bar!'],
      home: ['Upstairs. Do not wait up.'],
      spawn: ['Challenge accepted!'],
      deploy: ['This deploy is going to be LEGENDARY!'],
      pass: ['Told you. Legendary.'],
      fail: ['We do not talk about that build.'],
      room: { barney: 'Welcome to the Fortress.', lasertag: 'Laser tag is a lifestyle.', gnb: 'Suit up, it is a Monday.' },
    },
    marshall: {
      catch: ['Lawyered!'],
      idle: ['One more test.', 'Almost green.'],
      code: ['Writing the test first.', 'That is a race condition, I can feel it.', 'Green. All green.'],
      pub: ['I will get these.', 'One pint, then the build.'],
      home: ['Going up for my charger.'],
      spawn: ['I am on the implementation.'],
      deploy: ['Build is running.'],
      pass: ['Lawyered!'],
      fail: ['Objection. That is a flaky test.'],
      room: { apartment: 'Couch. Laptop. Done.', gnb: 'Billable hours, technically.' },
    },
    lily: {
      catch: ['Seriously, you two.'],
      idle: ['Can everyone please focus?', 'I am keeping notes.'],
      code: ['Who is touching that file?', 'Two of you are editing the same thing.', 'One task each. Please.'],
      pub: ['Booth. Everyone. Now.'],
      home: ['Up to the apartment, back in a minute.'],
      spawn: ['I will coordinate everything.'],
      deploy: ['Everybody ready? Good.'],
      pass: ['See? Teamwork.'],
      fail: ['Nobody panic. Reverting.'],
      room: { apartment: 'Shoes off, please.', maclarens: 'One round. One.' },
    },
    robin: {
      catch: ['Seriously?'],
      idle: ['I read the changelog so you do not have to.', 'Hmm. Interesting.'],
      code: ['The docs say otherwise.', 'That API changed in version four.', 'I checked. Twice.'],
      pub: ['Scotch, neat.'],
      home: ['Heading up. I left the laptop on.'],
      spawn: ['I have got the research.'],
      deploy: ['Breaking news: deploying.'],
      pass: ['Breaking news: the build passed!'],
      fail: ['Well. That is breaking news.'],
      room: { rooftop: 'Better view from up here.', columbia: 'Doing the reading.' },
    },
    carl: { catch: ['What will it be?'], idle: ['Tab is open.'], room: { maclarens: 'Usual?' } },
    arthur: { catch: ['My office. Now.'], idle: ['Where are we on this?'], room: { gnb: 'Is it done?' } },
    ranjit: { catch: ['Get in!'], idle: ['I know a shortcut.'] },
  };

  const used = new Map();

  /**
   * One line for a character in a situation. Avoids repeating the previous
   * line, and falls back to a neighbouring bucket rather than going silent.
   */
  M.line = function line(name, kind, room) {
    const set = LINES[name] || LINES.ted;
    let pool = [];
    if (kind === 'room' && room && set.room && set.room[room]) pool = [set.room[room]];
    else if (set[kind]) pool = set[kind];
    if (!pool.length) pool = (set.idle || []).concat(set.catch || []);
    if (!pool.length) return '';
    const key = name + ':' + kind;
    const last = used.get(key);
    const pick = pool.length > 1 ? pool.filter((l) => l !== last) : pool;
    const chosen = pick[Math.floor(Math.random() * pick.length)];
    used.set(key, chosen);
    return chosen;
  };

  M.hasRoomLine = (name, room) => Boolean(LINES[name] && LINES[name].room && LINES[name].room[room]);
})(window.M);
