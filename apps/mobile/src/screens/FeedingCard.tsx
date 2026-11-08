import type { FeedingT } from '@babysleep/contract';
import { localDate, parseInstant } from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { buildForecast } from '../domain/forecast';
import { cancelFeeding, getOpenFeeding, lastFeeding, listFeedings, nudgeFeedingStart, restoreFeeding, startFeeding, summarizeFeedings } from '../domain/feeding';
import type { ObservationTarget } from '../domain/notes';
import { t, type I18nKey } from '../i18n/es';
import { fmtClock, fmtDur, fmtElapsed } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Icon } from '../ui/Icon';
import { Btn, Card, Chip, Ring, Round, Sheet } from '../ui/primitives';
import { FinishFeedingSheet } from './FeedingSheets';
import { NotesSheet } from './NotesSheet';

/** «3 tomas · 420 ml» (los ml solo si hay biberones con cantidad). */
export function dayLine(f: ReturnType<typeof summarizeFeedings>): string {
  const parts = [`${f.count} ${f.count === 1 ? 'toma' : 'tomas'}`];
  if (f.bottlesWithAmount > 0) parts.push(f.bottlesWithAmount < f.bottles ? `${f.ml} ml (de ${f.bottlesWithAmount} de ${f.bottles} biberones)` : `${f.ml} ml`);
  if (f.breastMs > 0) parts.push(`${fmtDur(f.breastMs)} al pecho`);
  return parts.join(' · ');
}

/**
 * Toma en Hoy: un anillo pequeño (neutro, para que solo el de sueño lleve el acento) y un botón circular «Toma» que
 * arranca el cronómetro sin preguntar nada. Al terminar se dice qué ha tomado (pecho, biberón, sólidos…).
 * Diseño: docs/design/prototypes (vistas «Tomas y sueño» y «Revisión UX»).
 */
export function FeedingCard() {
  const { ctx, baby, run, toast } = useApp();
  const babyId = baby?.id ?? '';
  const open = useLive(() => getOpenFeeding(ctx, babyId), [ctx, babyId], undefined as FeedingT | undefined);
  const all = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const now = useNow(open ? 1000 : 30_000);
  const [finishing, setFinishing] = useState<FeedingT | null>(null);
  const [options, setOptions] = useState(false);
  const [notes, setNotes] = useState<ObservationTarget | null>(null);
  const feedForecast = useMemo(() => buildForecast({ sessions: [], feedings: all, zone: ctx.zone, nowMs: now }).feed, [all, ctx.zone, now]);
  if (baby === null) return null;

  const today = summarizeFeedings(all, localDate(now, ctx.zone), ctx.zone);
  const last = lastFeeding(all, now);
  const range = feedForecast.state === 'waiting' && feedForecast.forecast.kind === 'range' ? feedForecast.forecast : null;

  const done = (f: FeedingT) => {
    setFinishing(null);
    const dur = f.end_utc ? parseInstant(f.end_utc) - parseInstant(f.start_utc) : 0;
    toast(t('feed.saved', { dur: fmtDur(dur) }), { label: t('home.notes'), run: () => setNotes({ feedingId: f.id }) });
  };

  const cancelTake = async (f: FeedingT) => {
    setOptions(false);
    if (await run(async () => (await cancelFeeding(ctx, f.id), true))) {
      toast(t('feed.cancelDone'), { label: t('home.undo'), run: () => void run(() => restoreFeeding(ctx, f.id)) });
    }
  };

  return (
    <>
      <Card aria-label={t('feed.title')}>
        {open ? (
          <>
            <div className="-mt-1 flex min-h-11 items-center justify-between gap-2">
              <p className="text-[13px] font-bold text-muted">{t('feed.runningHead', { time: fmtClock(parseInstant(open.start_utc), ctx.zone) })}</p>
              <button
                onClick={() => setOptions(true)}
                aria-label={t('feed.options')}
                className="-mr-2 grid size-11 shrink-0 place-items-center rounded-full bg-surface2 text-fg transition-transform hover:bg-surface3 active:scale-[0.95]"
              >
                <Icon name="more" />
              </button>
            </div>
            <div className="flex items-center gap-3">
              <Ring size={76} stroke={8} neutral progress={0}>
                <span className="text-[17px] font-extrabold tabular-nums" aria-live="off">
                  {fmtElapsed(now - parseInstant(open.start_utc))}
                </span>
              </Ring>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-extrabold">{t('feed.runningNow')}</p>
                <p className="text-[12px] font-semibold text-muted">{t('feed.runningHint')}</p>
              </div>
              <Round small icon="check" label={t('feed.roundFinish')} aria-label={t('feed.roundFinishName')} onClick={() => setFinishing(open)} />
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3">
            <Ring size={76} stroke={8} neutral progress={last && range ? last.sinceMs / range.highMs : 0}>
              <span className="text-[17px] font-extrabold tabular-nums">{last ? fmtDur(last.sinceMs) : '—'}</span>
            </Ring>
            <div className="min-w-0 flex-1">
              {last ? (
                <>
                  <p className="text-[12px] font-bold text-muted">{t('feed.card.last', { time: fmtClock(parseInstant(last.feeding.start_utc), ctx.zone) })}</p>
                  <p className="text-sm font-extrabold">{t(`feed.type.${last.feeding.feed_type}` as I18nKey)}</p>
                  <p className="text-[12px] font-semibold text-muted">
                    {range ? t('feed.card.every', { from: fmtDur(range.lowMs), to: fmtDur(range.highMs) }) : t('feed.card.learning')}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-extrabold">{t('feed.card.none')}</p>
                  <p className="text-[12px] font-semibold text-muted">{t('feed.card.noneHint')}</p>
                </>
              )}
            </div>
            <Round small icon="milk" label={t('feed.roundStart')} aria-label={t('feed.roundStartName')} onClick={() => run(() => startFeeding(ctx, baby.id, 'breast'))} />
          </div>
        )}
        {today.count > 0 && <p className="mt-3 text-center text-[12px] text-muted">{t('feed.today', { line: dayLine(today) })}</p>}
      </Card>

      {options && open && (
        <Sheet title={t('feed.options')} onClose={() => setOptions(false)}>
          <p className="-mt-2 mb-3 text-[13px] font-semibold text-muted">
            {t('feed.optionsFrom', { time: fmtClock(parseInstant(open.start_utc), ctx.zone), dur: fmtDur(now - parseInstant(open.start_utc)) })}
          </p>
          <span className="mb-1.5 block text-[13px] font-bold text-muted">{t('feed.fixStart')}</span>
          <div className="flex gap-2">
            {[5, 10, 15].map((m) => (
              <Chip
                key={m}
                onClick={async () => {
                  if (await run(() => nudgeFeedingStart(ctx, open.id, -m))) setOptions(false);
                }}
              >
                −{m} min
              </Chip>
            ))}
          </div>
          <Btn variant="danger" className="mt-4 w-full" onClick={() => cancelTake(open)}>
            {t('feed.cancelTake')}
          </Btn>
        </Sheet>
      )}
      {finishing && <FinishFeedingSheet feeding={finishing} onClose={() => setFinishing(null)} onDone={done} />}
      {notes && <NotesSheet target={notes} onClose={() => setNotes(null)} />}
    </>
  );
}
