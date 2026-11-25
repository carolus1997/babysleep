import type { BabyT } from '@babysleep/contract';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from './app/AppContext';
import { applyFeedIntent, parseFeedIntent, type FeedIntent } from './domain/feedIntent';
import { parseMedIntent, type MedIntent } from './domain/medIntent';
import { cancelFeeding, restoreFeeding } from './domain/feeding';
import { t, type I18nKey } from './i18n/es';
import { Health } from './screens/Health';
import { HomeShell, type HomeSection } from './screens/HomeShell';
import { Onboarding } from './screens/Onboarding';
import { BabySheet, Settings } from './screens/Settings';
import { Stats } from './screens/Stats';
import { fmtAges } from './ui/format';
import { Icon, type IconName } from './ui/Icon';
import { Avatar } from './ui/photo';
import { Sheet } from './ui/primitives';
import { Splash } from './ui/Splash';
import { Hint, Tour } from './ui/Tutorial';
import { isSeen } from './tutorial/seen';

type Tab = 'home' | 'health' | 'stats' | 'settings';
const TABS: ReadonlyArray<{ id: Tab; label: I18nKey; icon: IconName }> = [
  { id: 'home', label: 'tab.home', icon: 'moon' },
  { id: 'health', label: 'tab.health', icon: 'health' },
  { id: 'stats', label: 'tab.stats', icon: 'chart' },
  { id: 'settings', label: 'tab.settings', icon: 'settings' },
];

/** Edad real y, en prematuros menores de 24 meses, la corregida. */
function AgeLabel({ baby }: { baby: BabyT }) {
  const { age, corrected } = fmtAges(baby.birth_date, baby.gestational_weeks, Date.now());
  return (
    <span className="text-[13px] font-semibold text-muted">
      {age}
      {corrected !== null && <span title="Edad corregida: descuenta lo que faltó hasta las 40 semanas"> · corregida: {corrected}</span>}
    </span>
  );
}

export function App() {
  const { baby, babies, selectBaby, welcome } = useApp();
  // Datos del bebé activo (y su foto), a un toque desde el avatar de la cabecera.
  const [profile, setProfile] = useState(false);
  const [tab, setTab] = useState<Tab>('home');
  // Altura real de la cabecera (varía con el área segura y el tamaño de texto): las pestañas interiores se quedan fijas justo debajo.
  const headerRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--hdr-h', `${el.getBoundingClientRect().height}px`);
    set();
    new ResizeObserver(set).observe(el);
  }, []);
  const [homeSection, setHomeSection] = useState<HomeSection>('today');
  // Sube cada vez que se pulsa «Salud» o «Estadísticas»: sus pestañas interiores vuelven a la primera.
  const [resetKey, setResetKey] = useState(0);
  const [navNote, setNavNote] = useState<{ text: string; n: number }>({ text: '', n: 0 });
  const [switching, setSwitching] = useState(false);
  const [touring, setTouring] = useState(() => !isSeen('tour'));
  // Aviso de medicación: abre Salud → Medicación en ese tratamiento (y, con «Ya la di», la hoja de registro).
  const [medIntent, setMedIntent] = useState<MedIntent | null>(null);
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

  // Pulsar una sección de la barra lleva siempre a su primera pestaña y arriba del todo: Inicio → Hoy, Salud → Resumen,
  // Estadísticas → Resumen, Ajustes → arriba. Si ya estabas en ella, además se anuncia (lectores de pantalla).
  const goTab = (id: Tab) => {
    if (id === 'home') setHomeSection('today');
    if (id === 'health' || id === 'stats') setResetKey((k) => k + 1);
    const same = id === tab;
    setTab(id);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    window.scrollTo({ top: 0, behavior: same && !reduced ? 'smooth' : 'auto' });
    if (same) {
      const name = id === 'home' ? 'home.sec.today' : id === 'health' ? 'health.sec.overview' : id === 'stats' ? 'stats.view.summary' : 'settings.title';
      setNavNote((p) => ({ text: t('nav.backTo', { name: t(name) }), n: p.n + 1 }));
    }
  };

  // Al cambiar de pestaña se empieza arriba (antes Salud se abría a mitad de la lista de la pantalla anterior).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  // La bienvenida solo sale al iniciar sesión. Va siempre la primera de un fragmento, en la misma posición en ambas
  // ramas, para que no se reinicie cuando el bebé activo termina de cargar. Con un solo bebé no se pregunta cuál.
  const splash = welcome > 0 && <Splash key={welcome} babies={babies} activeId={baby?.id ?? null} onPick={selectBaby} />;
  if (babies.length === 0 || baby === null)
    return (
      <>
        {splash}
        <Onboarding />
      </>
    );

  return (
    <>
      {splash}
      <div className="relative mx-auto flex min-h-dvh max-w-md flex-col land:max-w-none">
      <header ref={headerRef} className="sticky top-0 z-30 bg-bg px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] land:fixed land:left-0 land:z-40 land:w-[calc(78px+env(safe-area-inset-left))] land:border-r land:border-line land:bg-surface land:px-0 land:pb-1 land:pl-[env(safe-area-inset-left)] land:pt-2">
        <div className="flex min-h-12 items-center gap-2 land:flex-col land:justify-center">
          <button className="grid size-12 shrink-0 place-items-center rounded-full" onClick={() => setProfile(true)} aria-label={t('app.babyProfile', { alias: baby.alias })}>
            <Avatar baby={baby} size={40} />
          </button>
          {/* Con un solo bebé no hay nada que cambiar: el nombre también lleva a sus datos. */}
          <button
            className="flex min-h-12 min-w-0 flex-1 items-center justify-between gap-2 rounded-2xl text-left land:hidden"
            onClick={() => (babies.length > 1 ? setSwitching(true) : setProfile(true))}
            aria-label={babies.length > 1 ? `${baby.alias}. Cambiar de bebé` : t('app.babyData', { alias: baby.alias })}
          >
            <span className="flex flex-col leading-tight">
              <span className="text-xl font-extrabold">{baby.alias}</span>
              <AgeLabel baby={baby} />
            </span>
            {babies.length > 1 && (
              <span className="flex min-h-9 shrink-0 items-center gap-1 rounded-full bg-surface2 px-3 text-xs font-bold">
                <Icon name="swap" size={15} />
                {t('app.switchBaby')}
              </span>
            )}
          </button>
          {/* En apaisado no cabe el nombre: el botón de cambiar de bebé va aparte, bajo el avatar. */}
          {babies.length > 1 && (
            <button className="hidden size-9 place-items-center rounded-full bg-surface2 land:grid" onClick={() => setSwitching(true)} aria-label={`${baby.alias}. Cambiar de bebé`}>
              <Icon name="swap" size={15} />
            </button>
          )}
        </div>
      </header>

      {/* `relative` sin `z-*`: sube el contenido por encima del fondo de foto SIN crear un contexto de
          apilamiento; con `z-10` las hojas (z-40) quedaban atrapadas debajo de la cabecera y la barra. */}
      <main className="relative flex-1 px-4 pb-28 pt-2 land:pb-4 land:pl-[calc(78px+env(safe-area-inset-left)+1rem)] land:pr-[calc(1rem+env(safe-area-inset-right))] land:pt-1">
        {tab === 'home' && <HomeShell section={homeSection} onSection={setHomeSection} goSettings={() => setTab('settings')} />}
        {tab === 'health' && <Hint id="hint-health">{t('hint.health')}</Hint>}
        {tab === 'stats' && <Hint id="hint-stats">{t('hint.stats')}</Hint>}
        {tab === 'health' && <Health medIntent={medIntent} onMedIntentUsed={() => setMedIntent(null)} resetKey={resetKey} />}
        {tab === 'stats' && <Stats resetKey={resetKey} />}
        {tab === 'settings' && <Settings onReplayTour={() => setTouring(true)} />}
      </main>

      <p role="status" aria-live="polite" className="sr-only">
        {navNote.text}
        {navNote.n % 2 === 0 ? '' : '\u200b'}
      </p>

      <nav
        aria-label="Principal"
        className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-md grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] land:inset-y-0 land:right-auto land:mx-0 land:w-[calc(78px+env(safe-area-inset-left))] land:max-w-none land:grid-cols-1 land:grid-rows-4 land:border-r land:border-t-0 land:pb-2 land:pl-[env(safe-area-inset-left)] land:pt-[4.25rem]"
      >
        {TABS.map((x) => (
          <button
            key={x.id}
            data-tour={`tab-${x.id}`}
            aria-current={tab === x.id ? 'page' : undefined}
            onClick={() => goTab(x.id)}
            className={`flex min-h-16 min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 nav-label font-bold land:min-h-12 ${
              tab === x.id ? 'text-accent' : 'text-muted'
            }`}
          >
            <span className={`grid h-7 w-12 place-items-center rounded-full ${tab === x.id ? 'bg-accent-soft' : ''}`}>
              <Icon name={x.icon} size={22} />
            </span>
            <span className="max-w-full truncate">{t(x.label)}</span>
          </button>
        ))}
      </nav>

      {touring && <Tour
          onDone={() => setTouring(false)}
          onGo={(g) => {
            setTab(g.tab);
            if (g.section) setHomeSection(g.section);
          }}
        />}

      {profile && <BabySheet key={baby.id} baby={baby} onClose={() => setProfile(false)} />}

      {switching && (
        <Sheet title={t('settings.babies')} onClose={() => setSwitching(false)}>
          <ul className="space-y-2">
            {babies.map((b) => (
              <li key={b.id}>
                <button
                  className={`flex min-h-14 w-full items-center gap-3 rounded-2xl border-2 px-4 text-left ${
                    b.id === baby.id ? 'border-accent bg-surface2' : 'border-transparent bg-surface'
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
