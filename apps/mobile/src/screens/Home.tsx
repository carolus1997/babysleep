import type { AwakeningT, SettlingAttemptT, SleepSessionT } from '@babysleep/contract';
import { buildSpans, localDate, parseInstant, sleepDayTotals, summarizeAwakenings } from '@babysleep/core';
import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { finishAwakening, getOpenAwakening, listAwakenings, startAwakening, thresholdMs } from '../domain/awakening';
import { backupReminderDue } from '../domain/export';
import type { ObservationTarget } from '../domain/notes';
import {
  cancelSettling,
  cancelSleep,
  editSession,
  finishSleep,
  getOpenAttempt,
  getOpenSession,
  listSessions,
  markPutDown,
  nudgeTime,
  reopenSettling,
  startSettling,
  startSleep,
  undoCancelSleep,
} from '../domain/sleep';
import { t } from '../i18n/es';
import { fmtClock, fmtDur, fmtElapsed } from '../ui/format';
import type { SyncStatus } from '../sync/useAutoSync';
import { useLive, useNow } from '../ui/hooks';
import { Btn, Card, Chip } from '../ui/primitives';
import { AwakeningsSheet } from './AwakeningsSheet';
import { FeedingCard } from './FeedingCard';
import { NotesSheet } from './NotesSheet';

export function Home({ goSettings }: { goSettings: () => void }) {
  const { ctx, baby, run, toast } = useApp();
  const babyId = baby?.id ?? '';
  const open = useLive(() => getOpenSession(ctx, babyId), [ctx, babyId], undefined as SleepSessionT | undefined);
  const attempt = useLive(() => getOpenAttempt(ctx, babyId), [ctx, babyId], undefined as SettlingAttemptT | undefined);
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const reminder = useLive(() => backupReminderDue(ctx), [ctx, sessions.length], false);
  const expired = useLive(async () => ((await ctx.db.meta.get('sync_status'))?.value as SyncStatus | undefined)?.sessionExpired === true, [ctx], false);
  const awakenings = useLive(() => listAwakenings(ctx, babyId), [ctx, babyId], [] as AwakeningT[]);
  const openAwake = useLive(() => (open ? getOpenAwakening(ctx, open.id) : Promise.resolve(undefined)), [ctx, open?.id, awakenings.length], undefined as AwakeningT | undefined);
  const now = useNow(open || attempt ? 1000 : 30_000);
  const [awakeSheet, setAwakeSheet] = useState<string | null>(null);
  const [notes, setNotes] = useState<ObservationTarget | null>(null);

  if (baby === null) return null;

  const todayDate = localDate(now, ctx.zone);
  const thr = thresholdMs(baby);
  const today = sleepDayTotals(sessions, todayDate, ctx.zone, { nowMs: now, awakenings, awakeningThresholdMs: thr });
  // Por la mañana, antes de la primera siesta, el día aún está vacío: se enseña la noche que acaba de terminar.
  const lastNight = today.totalMs === 0 ? [...sessions].reverse().find((s) => s.sleep_type === 'night' && s.sleep_end_utc !== null) : undefined;
  const lastNightSum = lastNight ? summarizeAwakenings(buildSpans([lastNight]).spans, awakenings, thr) : undefined;
  const lastClosedNight = [...sessions].reverse().find((s) => s.sleep_type === 'night' && s.sleep_end_utc !== null);
  const wakeUp = async () => {
    if (!open) return;
    const id = open.id;
    if (openAwake) await run(() => finishAwakening(ctx, openAwake.id));
    else await run(() => startAwakening(ctx, id));
  };
  const lastClosed = [...sessions].reverse().find((s) => s.sleep_end_utc !== null);
  const awakeMs = !open && lastClosed?.sleep_end_utc ? now - parseInstant(lastClosed.sleep_end_utc) : null;

  const finish = async () => {
    if (!open) return;
    const done = await run(() => finishSleep(ctx, open.id));
    if (done?.sleep_end_utc) {
      const dur = parseInstant(done.sleep_end_utc) - parseInstant(done.sleep_start_utc);
      toast(t('home.saved', { dur: fmtDur(dur) }), {
        label: t('home.undo'),
        run: () => void run(() => editSession(ctx, done.id, { endMs: null })),
      });
    }
  };

  const cancelOpenSleep = async () => {
    if (!open) return;
    const id = open.id;
    if (await run(() => cancelSleep(ctx, id))) {
      toast(t('home.cancelSleepDone'), { label: t('home.undo'), run: () => void run(() => undoCancelSleep(ctx, id)) });
    }
  };

  const cancelOpenAttempt = async () => {
    if (!attempt) return;
    const id = attempt.id;
    if (await run(() => cancelSettling(ctx, id))) {
      toast(t('home.cancelSettleDone'), { label: t('home.undo'), run: () => void run(() => reopenSettling(ctx, id)) });
    }
  };

  return (
    <div className="space-y-4">
      {expired && (
        <button className="w-full rounded-2xl border border-danger bg-surface2 p-3 text-left text-sm" onClick={goSettings} role="alert">
          {t('home.sessionExpired')}
        </button>
      )}
      {reminder && (
        <button className="w-full rounded-2xl border border-line bg-surface2 p-3 text-left text-sm" onClick={goSettings}>
          {t('home.backupDue')}
        </button>
      )}

      {open ? (
        <Card className="text-center">
          <p className="text-sm text-muted">{t('home.sleeping', { time: fmtClock(parseInstant(open.sleep_start_utc), ctx.zone) })}</p>
          <p className="my-2 font-mono text-5xl font-bold tabular-nums" aria-live="off">
            {fmtElapsed(now - parseInstant(open.sleep_start_utc))}
          </p>
          <div className="mb-4 flex justify-center gap-2">
            {(['nap', 'night'] as const).map((ty) => (
              <Chip key={ty} active={open.sleep_type === ty} onClick={() => run(() => editSession(ctx, open.id, { type: ty }))}>
                {t(ty === 'nap' ? 'home.type.nap' : 'home.type.night')}
              </Chip>
            ))}
          </div>
          <Btn variant="primary" className="h-28 w-full text-2xl" onClick={finish}>
            {t('home.finishSleep')}
          </Btn>
          {open.sleep_type === 'night' && (
            <div className="mt-3 rounded-2xl bg-surface2 p-3">
              {openAwake && (
                <p className="mb-2 text-sm font-semibold">
                  {t('awake.awakeSince', { time: fmtClock(parseInstant(openAwake.start_utc), openAwake.start_tz), dur: fmtElapsed(now - parseInstant(openAwake.start_utc)) })}
                </p>
              )}
              <Btn variant={openAwake ? 'primary' : 'secondary'} className="w-full" onClick={wakeUp}>
                {openAwake ? t('awake.backToSleep') : t('awake.wokeUp')}
              </Btn>
              <Btn variant="ghost" className="mt-1 w-full text-muted" onClick={() => setAwakeSheet(open.id)}>
                {t('awake.openN', { n: awakenings.filter((a) => a.session_id === open.id).length })}
              </Btn>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <span className="text-sm text-muted">{t('home.fixStart')}</span>
            {[5, 10, 15].map((m) => (
              <Chip key={m} onClick={() => run(() => nudgeTime(ctx, open.id, 'start', -m))}>
                −{m} min
              </Chip>
            ))}
          </div>
          <Btn className="mt-3 w-full" onClick={() => setNotes({ sessionId: open.id })}>
            {t('home.notes')}
          </Btn>
          <Btn variant="ghost" className="mt-1 w-full text-muted" onClick={cancelOpenSleep}>
            {t('home.cancelSleep')}
          </Btn>
        </Card>
      ) : (
        <Card className="text-center">
          {attempt && (
            <div className="mb-4 rounded-2xl bg-surface2 p-3">
              <p className="font-semibold">
                {t('home.settling', { dur: fmtDur(attempt.started_utc ? now - parseInstant(attempt.started_utc) : 0) })}
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {attempt.put_down_utc ? (
                  <span className="self-center text-sm text-muted">
                    {t('home.putDownDone', { time: fmtClock(parseInstant(attempt.put_down_utc), ctx.zone) })}
                  </span>
                ) : (
                  <Chip onClick={() => run(() => markPutDown(ctx, attempt.id))}>{t('home.putDown')}</Chip>
                )}
                <Chip onClick={() => setNotes({ attemptId: attempt.id })}>{t('home.settleNotes')}</Chip>
                <Chip onClick={cancelOpenAttempt}>{t('home.cancelSettle')}</Chip>
              </div>
            </div>
          )}
          <Btn variant="primary" className="h-28 w-full text-2xl" onClick={() => run(() => startSleep(ctx, baby.id))}>
            {t('home.startSleep')}
          </Btn>
          <p className="mt-2 text-sm text-muted">{t('home.startSleepHint')}</p>
          {!attempt && (
            <Btn className="mt-3 w-full" onClick={() => run(() => startSettling(ctx, baby.id))}>
              {t('home.settle')}
            </Btn>
          )}
        </Card>
      )}

      <FeedingCard />

      <Card title={t('home.today')}>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-2xl font-bold">{fmtDur(today.napMs)}</p>
            <p className="text-sm text-muted">{t('home.todayNaps')}</p>
            <p className="text-xs text-muted">{t('home.todayNapsSub', { n: today.napCount })}</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{fmtDur(today.nightMs)}</p>
            <p className="text-sm text-muted">{t('home.todayNight')}</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{fmtDur(today.totalMs)}</p>
            <p className="text-sm text-muted">{t('home.todaySleep')}</p>
          </div>
        </div>
        {today.nightCount > 0 && today.awakeningCount > 0 && (
          <p className="mt-3 text-center text-sm text-muted">
            {t('home.nightLine', { bed: fmtDur(today.nightBedMs), sleep: fmtDur(today.nightMs), n: today.awakeningCount, long: today.longAwakeningCount })}
          </p>
        )}
        {lastNight?.sleep_end_utc && lastNightSum && (
          <p className="mt-3 text-center text-sm text-muted">
            {t('home.lastNightReal', {
              dur: fmtDur(parseInstant(lastNight.sleep_end_utc) - parseInstant(lastNight.sleep_start_utc) - lastNightSum.awakeMs),
              n: lastNightSum.count,
            })}
          </p>
        )}
        <p className="mt-2 text-center text-xs text-muted">{t('home.todayHint')}</p>
        {awakeMs !== null && <p className="mt-3 text-center text-sm text-muted">{t('home.awakeFor', { dur: fmtDur(awakeMs) })}</p>}
      </Card>

      {lastClosedNight && !open && (
        <Btn className="w-full" onClick={() => setAwakeSheet(lastClosedNight.id)}>
          {t('awake.openN', { n: awakenings.filter((a) => a.session_id === lastClosedNight.id).length })} · {fmtClock(parseInstant(lastClosedNight.sleep_start_utc), lastClosedNight.start_tz)}
        </Btn>
      )}

      {lastClosed && !open && (
        <Btn className="w-full" onClick={() => setNotes({ sessionId: lastClosed.id })}>
          {t('home.notes')} · {fmtClock(parseInstant(lastClosed.sleep_start_utc), ctx.zone)}
        </Btn>
      )}

      {notes && <NotesSheet target={notes} onClose={() => setNotes(null)} />}
      {awakeSheet && sessions.find((x) => x.id === awakeSheet) && (
        <AwakeningsSheet session={sessions.find((x) => x.id === awakeSheet) as SleepSessionT} onClose={() => setAwakeSheet(null)} />
      )}
    </div>
  );
}
