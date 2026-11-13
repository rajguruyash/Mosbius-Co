// Scene lab entry — see vite.lab.config.ts. Not part of the app build.
import { createRoot } from 'react-dom/client';
import './design/global.css';
import './i18n';
import { useStore } from './store/store';
import { OFFICE_CAST } from './scene/office/cast';

// A bridge that answers everything with "nothing": subscriptions hand back an
// unsubscribe, every other call resolves to null.
(window as any).cth = new Proxy({}, {
  get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null),
});

const params = new URLSearchParams(location.search);
const count = Number(params.get('n') ?? 14);
const ACCENTS = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];
const STATUSES = ['working', 'thinking', 'idle', 'working', 'waiting', 'working', 'idle', 'success'];
const ACTIONS = ['edit App.tsx', 'npm test', 'read SPEC.md', 'grep "useStore"', 'review PR 42', 'write tests'];
const agents = OFFICE_CAST.slice(0, count).map((c, i) => ({
  id: `a${i}`, name: c.displayName, character: c.name, isGod: i === 0,
  status: i === 0 ? 'working' : STATUSES[i % STATUSES.length],
  accent: ACCENTS[i % ACCENTS.length], action: ACTIONS[i % ACTIONS.length],
  carrying: undefined, lastPrompt: '', model: 'lab', engine: 'claude',
}));
useStore.setState({ agents: agents as any, floorLocation: params.get('loc') ?? 'apartment' } as any);
if (params.get('live') !== '0') {
  setInterval(() => {
    const st = useStore.getState();
    const i = 1 + Math.floor(Math.random() * (st.agents.length - 1));
    const next = STATUSES[Math.floor(Math.random() * STATUSES.length)];
    useStore.setState({ agents: st.agents.map((a, k) => (k === i ? { ...a, status: next, action: ACTIONS[Math.floor(Math.random() * ACTIONS.length)] } : a)) as any });
  }, 4000);
}
(window as any).lab = useStore;

if (params.get('screen') === 'wizard') {
  // Replays a status captured from the real Agent Manager (?status=<json>) so the
  // setup step can be looked at without touching a real workspace.
  const real = JSON.parse(decodeURIComponent(params.get('status') ?? '[]'));
  (window as any).cth = new Proxy({}, {
    get: (_t, prop: string) => prop === 'agentsStatus' ? async () => real
      : prop.startsWith('on') ? () => () => {} : async () => null,
  });
  const { OnboardingWizard } = await import('./components/OnboardingWizard');
  createRoot(document.getElementById('root')!).render(<OnboardingWizard onComplete={() => {}} />);
} else {
  const { OfficeFloor } = await import('./scene/office/OfficeFloor');
  createRoot(document.getElementById('root')!).render(<OfficeFloor />);
}
