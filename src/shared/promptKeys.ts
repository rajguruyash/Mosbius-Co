/**
 * The keys that answer a prompt in an agent's terminal, in one place.
 *
 * An approval is answered the way a person would answer it: in the agent's own terminal, because that is where
 * the prompt is. (The hook that announces it cannot carry the answer back: it is released within seconds, and a
 * person takes longer.) These are the keystrokes for Claude Code's menus; they are named here so a change in the
 * program's prompt is a one-line change, and so the tests can assert exactly what is sent.
 */

/** Enter: takes the highlighted choice, which in a permission prompt is "Yes". */
export const KEY_APPROVE = '\r';
/** A lone Escape: cancels the prompt, which Claude Code treats as "No". */
export const KEY_REJECT = '\u001b';
/** Down arrow: moves the highlight in a list of choices. */
export const KEY_DOWN = '\u001b[B';

/** The keys that pick option `index` (0-based) in a list menu: move down that many, then Enter. */
export function keysForOption(index: number): string {
  const n = Math.max(0, Math.min(20, Math.floor(index)));
  return KEY_DOWN.repeat(n) + '\r';
}

/** The same choice as separate key presses, in order. A real terminal program sees each key arrive on its own, a
 *  moment apart; sending them as one burst can outrun a menu that redraws between keys. */
export function optionKeySteps(index: number): string[] {
  const n = Math.max(0, Math.min(20, Math.floor(index)));
  return [...Array.from({ length: n }, () => KEY_DOWN), '\r'];
}

/** The pause between presses of a multi-key answer. */
export const KEY_GAP_MS = 70;
