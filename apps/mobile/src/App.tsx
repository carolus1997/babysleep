import type { BabyT } from '@babysleep/contract';
import { useEffect, useState } from 'react';
import { useApp } from './app/AppContext';
import { applyFeedIntent, parseFeedIntent, type FeedIntent } from './domain/feedIntent';
import { parseMedIntent, type MedIntent } from './domain/medIntent';
import { cancelFeeding, restoreFeeding } from './domain/feeding';
import { t, type I18nKey } from './i18n/es';
import { Health } from './screens/Health';
import { HomeShell, type HomeSection } from './screens/HomeShell';
import { Onboarding } from './screens/Onboarding';
import { Settings } from './screens/Settings';
import { Stats } from './screens/Stats';
import { fmtAges } from './ui/format';
import { Avatar, useBabyPhotoUrl } from './ui/photo';
import { Sheet } from './ui/primitives';
import { Splash } from './ui/Splash';

type Tab = 'home' | 'health' | 'stats' | 'settings';
const TABS: ReadonlyArray<{ id: Tab; label: I18nKey; icon: string }> = [
  { id: 'home', label: 'tab.home', icon: '☾' },
  { id: 'health', label: 'tab.health', icon: '✚' },
  { id: 'stats', label: 'tab.stats', icon: '▥' },
  { id: 'settings', label: 'tab.settings', icon: '⚙' },
];

/** Edad real y, en prematuros menores de 24 meses, la corregida. */
function AgeLabel({ baby }: { baby: BabyT }) {
  const { age, corrected } = fmtAges(baby.birth_date, baby.gestational_weeks, Date.now());
  return (
    <span className="text-sm text-muted">
      {age}
      {corrected !== null && <span title="Edad corregida: descuenta lo que faltó hasta las 40 semanas"> · corregida: {corrected}</span>}
    </span>
  );
}

export function App() {
  const { baby, babies, selectBaby } = useApp();
  const [tab, setTab] = useState<Tab>('home');
  const [homeSection, setHomeSection] = useState<HomeSection>('today');
  const [switching, setSwitching] = useState(false);
  // Aviso de medicación: abre Salud → Medicación en ese tratamiento (y, con «Ya la di», la hoja de registro).
  const [medIntent, setMedIntent] = useState<MedIntent | null>(null);
  const photo = useBabyPhotoUrl(baby?.id ?? '');
  const { ctx, run, toast } = useApp();
  const babyId = baby?.id ?? null;

  // «Toca toma»: al tocar el aviso (o sus botones) la app se abre con `?feed=breast|bottle|ask`, o, si ya estaba
  // abierta, el service worker avisa con un mensaje. La dirección se limpia para que recargar no repita nada.
  useEffect(() => {
    if (babyId === null) return;
    const handle = async (intent: FeedIntent) => {
      setTab('home');
      setHomeSection('today');
      const r = await run(() => applyFeedIntent(ctx, babyId, intent));
      if (r === undefined || r.kind === 'ask') return;
      if (r.kind === 'already_running') return toast(t('feed.intentRunning'));
      const id = r.feeding.id;
      toast(t('feed.intentStarted'), {
        label: t('home.undo'),
        run: async () => {
          await run(() => cancelFeeding(ctx, id));
          toast(t('feed.cancelDone'), { label: t('home.undo'), run: () => void run(() => restoreFeeding(ctx, id)) });
        },
      });
    };
    // Los avisos de cita abren la app con `?go=health` (o, si ya estaba abierta, un mensaje del service worker).
    const params = new URLSearchParams(window.location.search);
    if (params.get('go') === 'health') {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      setTab('health');
    }
    const medFromUrl = parseMedIntent(window.location.search);
    if (medFromUrl !== null) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      setTab('health');
      setMedIntent(medFromUrl);
    }
    const fromUrl = parseFeedIntent(window.location.search);
    if (fromUrl !== null) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      void handle(fromUrl);
    }
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; feed?: string; go?: string; med?: string; given?: boolean } | null;
      if (d?.type === 'med-intent') {
        const intent = parseMedIntent(`?med=${d.med ?? ''}${d.given === true ? '&given=1' : ''}`);
        if (intent === null) return;
        setTab('health');
        setMedIntent(intent);
        return;
      }
      if (d?.type === 'go' && d.go === 'health') return setTab('health');
      if (d?.type !== 'feed-intent') return;
      const intent = parseFeedIntent(`?feed=${d.feed ?? ''}`);
      if (intent !== null) void handle(intent);
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, [ctx, babyId, run, toast]);

  // La hoja de estilos sabe si hay foto para volver translúcidas las tarjetas (solo tema claro).
  useEffect(() => {
    document.documentElement.toggleAttribute('data-photo', photo !== null);
    return () => document.documentElement.removeAttribute('data-photo');
  }, [photo]);

  // La bienvenida va siempre la primera de un fragmento, en la misma posición en ambas ramas, para que no se
  // reinicie cuando el bebé activo termina de cargar. Se monta una vez por carga de la página.
  if (babies.length === 0 || baby === null)
    return (
      <>
        <Splash baby={baby} />
        <Onboarding />
      </>
    );

  return (
    <>
      <Splash baby={baby} />
      <div className="relative mx-auto flex min-h-dvh max-w-md flex-col">
      {photo && <div aria-hidden className="photo-bg" style={{ backgroundImage: `url(${photo})` }} />}
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
            <Avatar baby={baby} size={32} />
            <span className="text-xl font-bold">{baby.alias}</span>
            <AgeLabel baby={baby} />
          </span>
          {babies.length > 1 && <span className="text-muted">⇅</span>}
        </button>
      </header>

      {/* `relative` sin `z-*`: sube el contenido por encima del fondo de foto SIN crear un contexto de
          apilamiento; con `z-10` las hojas (z-40) quedaban atrapadas debajo de la cabecera y la barra. */}
      <main className="relative flex-1 px-4 pb-28 pt-4">
        {tab === 'home' && <HomeShell section={homeSection} onSection={setHomeSection} goSettings={() => setTab('settings')} />}
        {tab === 'health' && <Health medIntent={medIntent} onMedIntentUsed={() => setMedIntent(null)} />}
        {tab === 'stats' && <Stats />}
        {tab === 'settings' && <Settings />}
      </main>

      <nav
        aria-label="Principal"
        className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-md grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] backdrop-blur-md"
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
                  <Avatar baby={b} size={32} />
                  <span className="font-semibold">{b.alias}</span>
                  <AgeLabel baby={b} />
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      </div>
    </>
  );
}
