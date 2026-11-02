import { useState } from 'react';
import { useApp } from './app/AppContext';
import { t, type I18nKey } from './i18n/es';
import { History } from './screens/History';
import { Home } from './screens/Home';
import { Onboarding } from './screens/Onboarding';
import { Settings } from './screens/Settings';
import { Stats } from './screens/Stats';
import { fmtAge } from './ui/format';
import { Sheet } from './ui/primitives';

type Tab = 'home' | 'history' | 'stats' | 'settings';
const TABS: ReadonlyArray<{ id: Tab; label: I18nKey; icon: string }> = [
  { id: 'home', label: 'tab.home', icon: '☾' },
  { id: 'history', label: 'tab.history', icon: '☰' },
  { id: 'stats', label: 'tab.stats', icon: '▥' },
  { id: 'settings', label: 'tab.settings', icon: '⚙' },
];

export function App() {
  const { baby, babies, selectBaby } = useApp();
  const [tab, setTab] = useState<Tab>('home');
  const [switching, setSwitching] = useState(false);

  if (babies.length === 0 || baby === null) return <Onboarding />;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header
        className="sticky top-0 z-30 border-b-4 bg-bg px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]"
        style={{ borderBottomColor: baby.color ?? 'var(--accent)' }}
      >
        <button
          className="flex min-h-12 w-full items-center justify-between rounded-2xl px-1 text-left"
          onClick={() => setSwitching(true)}
          aria-label={`${baby.alias}. Cambiar de bebé`}
        >
          <span className="flex items-center gap-2">
            <span className="inline-block size-4 rounded-full" style={{ background: baby.color ?? 'var(--accent)' }} />
            <span className="text-xl font-bold">{baby.alias}</span>
            <span className="text-sm text-muted">{fmtAge(baby.birth_date, Date.now())}</span>
          </span>
          {babies.length > 1 && <span className="text-muted">⇅</span>}
        </button>
      </header>

      <main className="flex-1 px-4 pb-28 pt-4">
        {tab === 'home' && <Home goSettings={() => setTab('settings')} />}
        {tab === 'history' && <History />}
        {tab === 'stats' && <Stats />}
        {tab === 'settings' && <Settings />}
      </main>

      <nav
        aria-label="Principal"
        className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-md grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        {TABS.map((x) => (
          <button
            key={x.id}
            aria-current={tab === x.id ? 'page' : undefined}
            onClick={() => setTab(x.id)}
            className={`flex min-h-16 flex-col items-center justify-center gap-0.5 text-xs font-medium ${
              tab === x.id ? 'text-accent' : 'text-muted'
            }`}
          >
            <span aria-hidden className="text-xl leading-none">
              {x.icon}
            </span>
            {t(x.label)}
          </button>
        ))}
      </nav>

      {switching && (
        <Sheet title={t('settings.babies')} onClose={() => setSwitching(false)}>
          <ul className="space-y-2">
            {babies.map((b) => (
              <li key={b.id}>
                <button
                  className={`flex min-h-14 w-full items-center gap-3 rounded-2xl border px-4 text-left ${
                    b.id === baby.id ? 'border-accent bg-surface2' : 'border-line bg-surface'
                  }`}
                  onClick={() => {
                    selectBaby(b.id);
                    setSwitching(false);
                  }}
                >
                  <span className="inline-block size-4 rounded-full" style={{ background: b.color ?? 'var(--accent)' }} />
                  <span className="font-semibold">{b.alias}</span>
                  <span className="text-sm text-muted">{fmtAge(b.birth_date, Date.now())}</span>
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </div>
  );
}
