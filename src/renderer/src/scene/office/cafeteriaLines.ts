// Break small-talk — MacLaren's edition.
//
// An agent's break is a walk downstairs to the pub: a spot at the bar, the
// jukebox, or a seat in a booth. Two kinds of line:
//   • solo  — one quip shown above a single agent at a break spot
//   • pair  — a short exchange between two agents facing each other in a booth
//
// Lines are kept short so they fit the ThoughtBubble. Character keys match
// OfficeCharacterName; anyone without bespoke lines falls back to the pools.

import type { OfficeCharacterName } from './cast';

/** Where an agent is lingering — picks a contextual line pool.
 *  'coffee' = standing at the bar, 'vending' = at the jukebox, 'table' = a booth. */
export type BreakSpot = 'coffee' | 'vending' | 'snack' | 'table';

const pick = <T,>(arr: readonly T[], seed: number): T =>
  arr[((seed % arr.length) + arr.length) % arr.length];

const BAR: readonly string[] = [
  'one more round, Carl',
  'put it on my tab',
  'is Carl ignoring me?',
  'a scotch. neat. like my code.',
  'nothing good happens after 2 a.m.',
  'just the one. for the build.',
];

const JUKEBOX: readonly string[] = [
  'who picked this song?',
  'one quarter. one perfect track.',
  'it ate my dollar. again.',
  'this is my jam',
  'please not the same song twice',
  '500 miles. obviously.',
];

const SNACK: readonly string[] = [
  'who ordered the wings?',
  'best burger in New York. I checked.',
  'just a little treat',
  'are these everyone’s fries?',
];

const BOOTH: readonly string[] = [
  'our booth. nobody sits here.',
  'kids, this is where it happened',
  'five more minutes',
  'true story',
  'I needed this, honestly',
  'did you read the stand-up notes?',
];

const SPOT_POOL: Record<BreakSpot, readonly string[]> = {
  coffee: BAR, vending: JUKEBOX, snack: SNACK, table: BOOTH,
};

const BY_CHARACTER: Partial<Record<OfficeCharacterName, readonly string[]>> = {
  ted:      ['kids, it was a simple pull request…', 'it’s pronounced encyclo-PAE-dia', 'I’m an architect. professionally.', 'have you met my refactor?'],
  marshall: ['lawyered.', 'slap bet. you owe me one.', 'I believe in the build. and Sasquatch.', 'best burger in New York'],
  lily:     ['you son of a beach', 'where’s the poop, Robin?', 'I can keep a secret. mostly.', 'aldrin justice.'],
  robin:    ['in Canada we call that a hotfix', 'but, um…', 'I’m not sentimental. it’s the scotch.', 'let’s go to the mall. kidding.'],
  barney:   ['suit up!', 'legen— wait for it —dary', 'challenge accepted', 'true story', 'haaave you met my commit?'],
  tracy:    ['I left my umbrella somewhere', 'the bass player says hi', 'driving gloves on'],
  penny:    ['dad, is this going somewhere?', 'you’ve told this one already'],
  luke:     ['is this story almost over?', 'can we go now?'],
  ranjit:   ['hello!', 'party in the cab!', 'best driver in New York'],
  carl:     ['what’ll it be?', 'last call. I mean it.', 'you five again'],
  wendy:    ['booth’s yours, as always', 'another round?'],
  arthur:   ['who wants to be fired first?', 'I’m in a mood.'],
  bilson:   ['who filed these numbers?', 'my office. now.'],
  blauman:  ['that’s it. I quit.', 'I am DONE with this place'],
  randy:    ['I brewed this one myself', 'please fire me. please.'],
  patrice:  ['you’re my best friend!', 'I made everyone cookies'],
  james:    ['suit up, little brother', 'legendary runs in the family'],
  victoria: ['I baked something for the team', 'try the cupcake'],
  stella:   ['that is definitely a rash', 'I have a kid, I’m busy'],
  zoey:     ['save the Arcadian!', 'you can’t tear this down'],
  quinn:    ['nobody touch my coffee table', 'I said what I said'],
  nora:     ['that’s rather sweet, actually'],
  captain:  ['ever been on a boat?', 'I do love boats.'],
  sandy:    ['Sandy Rivers, Metro News 1', 'good morning, New York'],
  stuart:   ['Claudia said I could stay out', 'don’t tell Claudia'],
  marvin:   ['skol Vikings', 'that’s my boy'],
};

/** A solo break line. Character flavour ~60% of the time, else the line fits
 *  the spot. `seed` keeps it deterministic per call site. */
export function pickSoloLine(character: OfficeCharacterName, spot: BreakSpot, seed: number): string {
  const flavour = BY_CHARACTER[character];
  if (flavour && seed % 5 < 3) return pick(flavour, Math.floor(seed / 5));
  return pick(SPOT_POOL[spot], seed);
}

// ─── paired exchanges (two agents across a booth table) ──────────────────────
// Beats ALTERNATE: [0] the one who sat down, [1] their table-mate, [2] the
// first again, and so on.

type Exchange = readonly string[];

const EXCHANGES: readonly Exchange[] = [
  ['challenge accepted.', 'nobody challenged you.', 'challenge accepted.'],
  ['it’s going to be legen—', 'don’t.', '—wait for it—', 'I’m leaving.', 'dary.'],
  ['lawyered.', 'that’s not what that means.', 'lawyered.'],
  ['nothing good happens after 2 a.m.', 'it’s 2:15.', 'ship it anyway.'],
  ['have you met my pull request?', 'I have reviewed it. twice.', 'and?', 'we need to talk.'],
  ['true story.', 'none of that happened.', 'true story.'],
  ['I think I’m in love with this API.', 'you met it an hour ago.', 'when you know, you know.'],
  ['best burger in New York?', 'this one.', 'you said that about the last one.'],
  ['who’s the yellow umbrella’s?', 'not yours.', 'not yet.'],
  ['is that a major bug?', '*salutes* Major Bug.', 'general chaos.', '*salutes*'],
  ['I’ll fix it in the morning.', 'future you will hate you.', 'future me handles it.'],
  ['how long was I telling that story?', 'nine seasons.', 'worth it.'],
  ['the tests pass on my machine.', 'your machine is a liar.', 'harsh. fair.'],
  ['slap bet?', 'on what?', 'whether CI goes green.', 'you’re on.'],
  ['we should buy this bar.', 'we should finish the sprint.', 'then buy the bar.'],
  ['what’s the rule?', 'never deploy on a Friday.', 'it’s a platinum rule.'],
  ['I had a plan.', 'was it a good plan?', 'it was a plan.'],
  ['just be cool.', 'I am cool.', 'you’re sweating.', 'coolly.'],
  ['remember the pineapple?', 'nobody knows where it came from.', 'true story.'],
  ['one more round?', 'we have stand-up at nine.', 'so two more rounds.'],
];

const PAIR_POOL: readonly Exchange[] = EXCHANGES;

const KEYED_EXCHANGES: Partial<Record<OfficeCharacterName, Exchange>> = {
  ted:      ['kids, back in the day—', 'oh no.', '—we wrote our own parser.'],
  barney:   ['suit up.', 'it’s a code review.', 'exactly. suit up.'],
  marshall: ['lawyered.', '...fine. lawyered.'],
  lily:     ['I knew before either of you.', 'knew what?', 'everything. always.'],
  robin:    ['in Canada, this just works.', 'it’s the same compiler.', 'but politer.'],
  carl:     ['last call.', 'it’s four in the afternoon.', 'for you, last call.'],
  patrice:  ['I think it’s wonderful!', 'nobody asked you, Patrice!'],
  blauman:  ['that’s it, I quit!', 'again?', '...I’ll be at my desk.'],
  ranjit:   ['hello!', 'Ranjit!', 'where to?'],
};

/** A multi-beat exchange for two agents sharing a booth. Beats alternate:
 *  index 0 = `speaker`, 1 = the table-mate, 2 = speaker, … */
export function pickExchange(speaker: OfficeCharacterName, seed: number): Exchange {
  const keyed = KEYED_EXCHANGES[speaker];
  if (keyed && seed % 4 === 0) return keyed;
  return pick(PAIR_POOL, seed);
}
