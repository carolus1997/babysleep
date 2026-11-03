import type { FeedingT, FeedTypeT } from '@babysleep/contract';
import { localDate, parseInstant } from '@babysleep/core';
import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { cancelFeeding, finishFeeding, getOpenFeeding, lastFeeding, listFeedings, nudgeFeedingStart, restoreFeeding, startFeeding, summarizeFeedings, FEED_TYPES } from '../domain/feeding';
import type { ObservationTarget } from '../domain/notes';
import { t, type I18nKey } from '../i18n/es';
import { fmtClock, fmtDur, fmtElapsed } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Btn, Card, Chip } from '../ui/primitives';
import { FeedLabel, FinishFeedingSheet } from './FeedingSheets';
import { NotesSheet } from './NotesSheet';

/** «3 tomas · 420 ml» (los ml solo si hay biberones con cantidad). */
export function dayLine(f: ReturnType<typeof summarizeFeedings>): string {
  const parts = [`${f.count} ${f.count === 1 ? 'toma' : 'tomas'}`];
  if (f.bottlesWithAmount > 0) parts.push(f.bottlesWithAmount < f.bottles ? `${f.ml} ml (de ${f.bottlesWithAmount} de ${f.bottles} biberones)` : `${f.ml} ml`);
  if (f.breastMs > 0) parts.push(`${fmtDur(f.breastMs)} al pecho`);
  return parts.join(' · ');
}

/** Tomas en Inicio: cronómetro (pecho, biberón, sólidos), la última toma y el resumen de hoy. */
export function FeedingCard() {
  const { ctx, baby, run, toast } = useApp();
  const babyId = baby?.id ?? '';
  const open = useLive(() => getOpenFeeding(ctx, babyId), [ctx, babyId], undefined as FeedingT | undefined);
  const all = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const now = useNow(open ? 1000 : 30_000);
  const [finishing, setFinishing] = useState<FeedingT | null>(null);
  const [notes, setNotes] = useState<ObservationTarget | null>(null);
  if (baby === null) return null;

  const today = summarizeFeedings(all, localDate(now, ctx.zone), ctx.zone);
  const last = lastFeeding(all, now);

  const done = (f: FeedingT) => {
    setFinishing(null);
    const dur = f.end_utc ? parseInstant(f.end_utc) - parseInstant(f.start_utc) : 0;
    toast(t('feed.saved', { dur: fmtDur(dur) }), { label: t('home.notes'), run: () => setNotes({ feedingId: f.id }) });
  };

  const finish = async (f: FeedingT) => {
    if (f.feed_type === 'solids') {
      const r = await run(() => finishFeeding(ctx, f.id));
      if (r) done(r);
    } else setFinishing(f); // pecho y biberón piden, de forma opcional, el pecho o los ml
  };

  return (
    <>
      <Card title={t('feed.title')}>
        {open ? (
          <div className="text-center">
            <p className="text-sm text-muted">
              <FeedLabel type={open.feed_type} /> · {t('feed.running', { time: fmtClock(parseInstant(open.start_utc), ctx.zone) })}
            </p>
            <p className="my-2 font-mono text-4xl font-bold tabular-nums" aria-live="off">
              {fmtElapsed(now - parseInstant(open.start_utc))}
            </p>
            <Btn variant="primary" className="h-16 w-full text-xl" onClick={() => finish(open)}>
              {t('feed.finish')}
            </Btn>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <span className="text-sm text-muted">{t('feed.fixStart')}</span>
              {[5, 10, 15].map((m) => (
                <Chip key={m} onClick={() => run(() => nudgeFeedingStart(ctx, open.id, -m))}>
                  −{m} min
                </Chip>
              ))}
            </div>
            <Btn
              variant="ghost"
              className="mt-1 w-full text-muted"
              onClick={async () => {
                if (await run(async () => (await cancelFeeding(ctx, open.id), true))) {
                  toast(t('feed.cancelDone'), { label: t('home.undo'), run: () => void run(() => restoreFeeding(ctx, open.id)) });
                }
              }}
            >
              {t('feed.cancel')}
            </Btn>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              {FEED_TYPES.map((ty: FeedTypeT) => (
                <Btn key={ty} className="flex min-h-16 flex-col items-center justify-center gap-0.5 px-1 text-sm leading-tight" onClick={() => run(() => startFeeding(ctx, baby.id, ty))}>
                  <FeedLabel type={ty} />
                </Btn>
              ))}
            </div>
            <p className="mt-2 text-center text-xs text-muted">{t('feed.startHint')}</p>
          </>
        )}
        <div className="mt-3 space-y-0.5 text-center text-sm text-muted">
          {last && !open && (
            <p>
              {t('feed.last', { type: t(`feed.type.${last.feeding.feed_type}` as I18nKey).toLowerCase(), dur: fmtDur(last.sinceMs) })}
            </p>
          )}
          {today.count > 0 && <p>{t('feed.today', { line: dayLine(today) })}</p>}
        </div>
      </Card>

      {finishing && <FinishFeedingSheet feeding={finishing} onClose={() => setFinishing(null)} onDone={done} />}
      {notes && <NotesSheet target={notes} onClose={() => setNotes(null)} />}
    </>
  );
}
