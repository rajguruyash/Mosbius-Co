/**
 * The Huddle window cannot take the keyboard (so it can never interrupt typing in another app) until the person
 * clicks into one of its own text fields. This asks the main process to allow it then, and to stop allowing it
 * once no text field is in use.
 */
const isText = (el: Element | null): boolean =>
  !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text', 'search', ''].includes((el as HTMLInputElement).type)));

let release: ReturnType<typeof setTimeout> | null = null;

export function wantKeyboard(): void {
  if (release) { clearTimeout(release); release = null; }
  try { void window.huddle.keyboard(true); } catch { /* the bridge is gone */ }
}

/** Wire the whole page: clicking into any text field asks for the keyboard; leaving them all gives it back. */
export function watchTextFields(): () => void {
  const down = (e: PointerEvent): void => { if (isText(e.target as Element)) wantKeyboard(); };
  const out = (): void => {
    if (release) clearTimeout(release);
    release = setTimeout(() => {
      release = null;
      if (!isText(document.activeElement)) { try { void window.huddle.keyboard(false); } catch { /* gone */ } }
    }, 250);
  };
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('focusout', out, true);
  return () => {
    document.removeEventListener('pointerdown', down, true);
    document.removeEventListener('focusout', out, true);
    if (release) { clearTimeout(release); release = null; }
  };
}
