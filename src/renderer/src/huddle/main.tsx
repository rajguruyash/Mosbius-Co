import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../design/global.css';
import './huddle.css';
import i18n from '../i18n';
import { setAppTheme } from '../design/theme';
import { HuddleApp } from './HuddleApp';

// The language and theme are the person's choices, kept in this page's storage by the main window. Both windows
// share it, so a change made there reaches here, and a banner from the main process reads in the same language.
window.addEventListener('storage', (e) => {
  if (e.key === 'cth.language' && e.newValue && e.newValue !== i18n.language) void i18n.changeLanguage(e.newValue);
  if (e.key === 'cth.theme' && (e.newValue === 'dark' || e.newValue === 'light')) setAppTheme(e.newValue);
});
const report = (lng: string): void => { try { window.huddle.reportLanguage(lng); } catch { /* the bridge is gone: the window is closing */ } };
i18n.on('languageChanged', report);
report(i18n.language);

const root = document.getElementById('root');
if (!root) throw new Error('No root element');
createRoot(root).render(
  <StrictMode>
    <HuddleApp />
  </StrictMode>
);
