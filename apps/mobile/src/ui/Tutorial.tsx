import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { t } from '../i18n/es';
import { HOME_TODAY, TOUR_STEPS, type TourGo } from '../tutorial/content';
import { isSeen, markSeen, type TutorialKey } from '../tutorial/seen';
import { Icon } from './Icon';
import { Btn } from './primitives';

type Box = { top: number; left: number; width: number; height: number };
const PAD = 6;

/** Sigue en pantalla el elemento real señalado (por `data-tour`), también mientras la página se mueve. */
function useTargetBox(target: string | null, stepKey: number): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    setBox(null);
    if (target === null) return;
    let raf = 0;
    let scrolled = false;
    const tick = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
      if (el) {
        if (!scrolled) {
          scrolled = true;
          el.scrollIntoView({ block: 'center' });
        }
        const r = el.getBoundingClientRect();
        setBox((b) =>
          b && Math.abs(b.top - r.top) < 0.5 && Math.abs(b.left - r.left) < 0.5 && Math.abs(b.width - r.width) < 0.5 && Math.abs(b.height - r.height) < 0.5
            ? b
            : { top: r.top, left: r.left, width: r.width, height: r.height },
        );
      } else setBox(null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, stepKey]);
  return box;
}

/**
 * Tour interactivo: tarjetas a pantalla completa y focos sobre la app real. En los pasos con `tap` basta tocar el
 * elemento resaltado para seguir; en las tarjetas se desliza hacia los lados. Escape o «Saltar» lo cierran.
 */
export function Tour({ onDone, onGo }: { onDone: () => void; onGo: (g: TourGo) => void }) {
  const [i, setI] = useState(0);
  const dir = useRef(1);
  const step = TOUR_STEPS[i]!;
  const last = i === TOUR_STEPS.length - 1;
  const spot = step.kind === 'spot' ? step : null;
  const box = useTargetBox(spot?.target ?? null, i);

  const finish = () => {
    markSeen('tour');
    onGo(HOME_TODAY);
    onDone();
  };
  const goTo = (n: number) => {
    dir.current = n > i ? 1 : -1;
    setI(Math.max(0, Math.min(TOUR_STEPS.length - 1, n)));
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // Cada paso lleva la app a la pantalla donde está lo que enseña.
  useEffect(() => {
    if (step.go) onGo(step.go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finishRef.current();
    document.addEventListener('keydown', onKey);
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.style.overflow = prev;
    };
  }, []);

  // «Pruébalo»: al tocar el elemento resaltado la app hace lo suyo (cambiar de sección o pestaña) y el tour sigue.
  useEffect(() => {
    if (!spot?.tap) return;
    let timer = 0;
    const onClick = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest(`[data-tour="${spot.target}"]`)) timer = window.setTimeout(() => goTo(i + 1), 350);
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  const touchX = useRef<number | null>(null);
  const swipe = {
    onTouchStart: (e: React.TouchEvent) => {
      touchX.current = e.touches[0]?.clientX ?? null;
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const x0 = touchX.current;
      const x1 = e.changedTouches[0]?.clientX;
      touchX.current = null;
      if (x0 === null || x1 === undefined) return;
      if (x1 - x0 < -50 && !last) goTo(i + 1);
      if (x1 - x0 > 50 && i > 0) goTo(i - 1);
    },
  };

  const controls = (
    <>
      <div aria-hidden className="mb-4 flex justify-center gap-2">
        {TOUR_STEPS.map((_, k) => (
          <span key={k} className={`h-2 rounded-full transition-all duration-200 ${k === i ? 'w-6 bg-accent' : 'w-2 bg-line'}`} />
        ))}
      </div>
      <div className="flex items-center gap-2">
        {i > 0 && (
          <button
            onClick={() => goTo(i - 1)}
            aria-label={t('tour.back')}
            className="grid size-12 shrink-0 place-items-center rounded-full bg-surface2 text-fg transition-transform hover:bg-surface3 active:scale-[0.95]"
          >
            <Icon name="next" className="rotate-180" />
          </button>
        )}
        <Btn key={i} autoFocus variant="primary" className="h-12 flex-1 text-base" onClick={() => (last ? finish() : goTo(i + 1))}>
          {last ? t('tour.start') : t('tour.next')}
        </Btn>
      </div>
    </>
  );

  const motion = { '--dx': `${dir.current * 28}px` } as CSSProperties;

  if (step.kind === 'card')
    return (
      <div role="dialog" aria-modal="true" aria-label={t('tour.label')} className="fixed inset-0 z-50 overflow-y-auto bg-bg" {...swipe}>
        <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-6 pt-[max(1.25rem,env(safe-area-inset-top))]">
          <div className="flex min-h-11 items-center justify-end">
            {!last && (
              <Btn variant="ghost" onClick={finish}>
                {t('tour.skip')}
              </Btn>
            )}
          </div>
          <div key={i} style={motion} className="flex flex-1 animate-[tour-in_0.28s_ease-out] flex-col items-center justify-center text-center" aria-live="polite">
            <span className="relative mb-6 grid size-28 place-items-center">
              <span aria-hidden className="absolute inset-0 animate-[tour-halo_2.4s_ease-out_infinite] rounded-full bg-accent-soft" />
              <span className="relative grid size-28 animate-[tour-pop_0.5s_ease-out] place-items-center rounded-full bg-accent-soft text-accent">
                <Icon name={step.icon} size={52} />
              </span>
            </span>
            <h1 className="text-[26px] font-extrabold leading-tight">{t(step.title)}</h1>
            <p className="mt-3 max-w-xs text-[15px] font-medium text-muted">{t(step.body)}</p>
          </div>
          <p className="sr-only">{t('tour.step', { n: i + 1, total: TOUR_STEPS.length })}</p>
          {controls}
        </div>
      </div>
    );

  // Foco sobre un elemento real: cuatro velos alrededor dejan el hueco libre (o tapado si no hay que tocarlo).
  const h = box ? { top: box.top - PAD, left: box.left - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 } : null;
  const vh = window.innerHeight;
  const below = h !== null && h.top + h.height / 2 < vh / 2;
  const veil = 'fixed';
  const tipPos: CSSProperties =
    h === null ? { top: '50%', transform: 'translateY(-50%)' } : below ? { top: h.top + h.height + 12 } : { bottom: vh - h.top + 12 };

  return (
    <div role="dialog" aria-modal="false" aria-label={t('tour.label')} className="fixed inset-0 z-50 pointer-events-none">
      {h === null ? (
        <div className="pointer-events-auto fixed inset-0 bg-black/60" />
      ) : (
        <>
          <div className={`${veil} pointer-events-auto left-0 right-0 top-0`} style={{ height: Math.max(0, h.top) }} />
          <div className={`${veil} pointer-events-auto left-0 right-0 bottom-0`} style={{ top: h.top + h.height }} />
          <div className={`${veil} pointer-events-auto left-0`} style={{ top: h.top, height: h.height, width: Math.max(0, h.left) }} />
          <div className={`${veil} pointer-events-auto right-0`} style={{ top: h.top, height: h.height, left: h.left + h.width }} />
          <div
            aria-hidden
            className="pointer-events-none fixed rounded-[22px] shadow-[0_0_0_9999px_rgba(0,0,0,0.6)] transition-all duration-200"
            style={h}
          />
          {!spot?.tap && <div className="pointer-events-auto fixed" style={h} />}
          <div
            aria-hidden
            className="pointer-events-none fixed animate-[tour-pulse_1.6s_ease-in-out_infinite] rounded-[22px] border-2 border-accent transition-all duration-200"
            style={h}
          />
        </>
      )}
      <div
        key={i}
        style={{ ...tipPos, '--dy': below ? '12px' : '-12px' } as CSSProperties}
        className="pointer-events-auto fixed inset-x-4 mx-auto max-w-md animate-[tour-in_0.25s_ease-out] rounded-3xl border border-(--card-border) bg-bg p-4 shadow-xl"
      >
        <div className="mb-1 flex items-center justify-between">
          <p className="text-[12px] font-bold text-muted">{t('tour.step', { n: i + 1, total: TOUR_STEPS.length })}</p>
          <Btn variant="ghost" className="min-h-11 px-3" onClick={finish}>
            {t('tour.skip')}
          </Btn>
        </div>
        <h2 className="text-lg font-extrabold">{t(step.title)}</h2>
        <p className="mb-4 mt-1 text-sm font-medium text-muted" aria-live="polite">
          {t(step.body)}
        </p>
        {controls}
      </div>
    </div>
  );
}

/** Pista de primera vez: una línea que dice qué es la sección. Se descarta y no vuelve. */
export function Hint({ id, children }: { id: TutorialKey; children: string }) {
  const [open, setOpen] = useState(() => !isSeen(id));
  if (!open) return null;
  return (
    <div role="note" className="flex items-start gap-3 rounded-2xl bg-surface2 p-3 text-sm font-medium text-fg">
      <Icon name="info" className="mt-0.5 text-accent" />
      <span className="flex-1">{children}</span>
      <button
        onClick={() => {
          markSeen(id);
          setOpen(false);
        }}
        className="min-h-11 shrink-0 rounded-full px-3 font-bold text-accent hover:bg-accent-soft"
      >
        {t('hint.ok')}
      </button>
    </div>
  );
}
