import { useEffect, useState } from 'react';
import { t } from '../i18n/es';
import { isSeen, markSeen, type TutorialKey } from '../tutorial/seen';
import { TOUR_STEPS } from '../tutorial/content';
import { Icon } from './Icon';
import { Btn } from './primitives';

/**
 * Tour de bienvenida: pantalla completa con el mismo lenguaje que el Acceso. Se puede saltar en cualquier paso
 * (botón o Escape) y se vuelve a ver desde Ajustes → Ayuda.
 */
export function Tour({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const step = TOUR_STEPS[i]!;
  const last = i === TOUR_STEPS.length - 1;
  const finish = () => {
    markSeen('tour');
    onDone();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish();
    document.addEventListener('keydown', onKey);
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div role="dialog" aria-modal="true" aria-label={t('tour.label')} className="fixed inset-0 z-50 overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-6 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <div className="flex min-h-11 items-center justify-between">
          {i > 0 ? (
            <button
              onClick={() => setI(i - 1)}
              aria-label={t('tour.back')}
              className="grid size-11 place-items-center rounded-full bg-surface2 text-fg transition-transform hover:bg-surface3 active:scale-[0.95]"
            >
              <Icon name="next" className="rotate-180" />
            </button>
          ) : (
            <span />
          )}
          {!last && (
            <Btn variant="ghost" onClick={finish}>
              {t('tour.skip')}
            </Btn>
          )}
        </div>

        <div className="flex flex-1 flex-col items-center justify-center text-center" aria-live="polite">
          <span className="mb-6 grid size-28 place-items-center rounded-full bg-accent-soft text-accent">
            <Icon name={step.icon} size={52} />
          </span>
          <h1 className="text-[26px] font-extrabold leading-tight">{t(step.title)}</h1>
          <p className="mt-3 max-w-xs text-[15px] font-medium text-muted">{t(step.body)}</p>
        </div>

        <p className="sr-only">{t('tour.progress', { n: i + 1, total: TOUR_STEPS.length })}</p>
        <div aria-hidden className="mb-5 flex justify-center gap-2">
          {TOUR_STEPS.map((_, k) => (
            <span key={k} className={`h-2 rounded-full transition-all ${k === i ? 'w-6 bg-accent' : 'w-2 bg-line'}`} />
          ))}
        </div>
        <Btn key={i} autoFocus variant="primary" className="h-14 w-full text-base" onClick={() => (last ? finish() : setI(i + 1))}>
          {last ? t('tour.start') : t('tour.next')}
        </Btn>
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

