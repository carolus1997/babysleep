import type { SettlingAttemptT, SleepSessionT } from '@babysleep/contract';
import { localDate, naturalDayTotals, parseInstant } from '@babysleep/core';
import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { backupReminderDue } from '../domain/export';
import type { ObservationTarget } from '../domain/notes';
import {
  cancelSettling,
  editSession,
  finishSleep,
  getOpenAttempt,
  getOpenSession,
  listSessions,
  markPutDown,
  nudgeTime,
  startSettling,
  startSleep,
} from '../domain/sleep';
import { t } from '../i18n/es';
import { fmtClock, fmtDur, fmtElapsed } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Btn, Card, Chip } from '../ui/primitives';
import { NotesSheet } from './NotesSheet';

export function Home({ goSettings }: { goSettings: () => void }) {
  const { ctx, baby, run, toast } = useApp();
  const babyId = baby?.id ?? '';
  const open = useLive(() => getOpenSession(ctx, babyId), [ctx, babyId], undefined as SleepSessionT | undefined);
  const attempt = useLive(() => getOpenAttempt(ctx, babyId), [ctx, babyId], undefined as SettlingAttemptT | undefined);
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const reminder = useLive(() => backupReminderDue(ctx), [ctx, sessions.length], false);
  const now = useNow(open || attempt ? 1000 : 30_000);
  const [notes, setNotes] = useState<ObservationTarget | null>(null);

  if (baby === null) return null;

  const todayDate = localDate(now, ctx.zone);
  const today = naturalDayTotals(sessions, todayDate, ctx.zone, { nowMs: now });
  const napsToday = sessions.filter((s) => s.sleep_type === 'nap' && localDate(parseInstant(s.sleep_start_utc), ctx.zone) === todayDate).length;
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

  return (
    <div className="space-y-4">
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
                <Chip onClick={() => run(() => cancelSettling(ctx, attempt.id))}>{t('home.cancelSettle')}</Chip>
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

      <Card title={t('home.today')}>
        <div className="grid grid-cols-2 gap-3 text-center">
          <div>
            <p className="text-2xl font-bold">{fmtDur(today.totalMs)}</p>
            <p className="text-sm text-muted">{t('home.todaySleep')}</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{napsToday}</p>
            <p className="text-sm text-muted">{t('home.naps')}</p>
          </div>
        </div>
        {awakeMs !== null && <p className="mt-3 text-center text-sm text-muted">{t('home.awakeFor', { dur: fmtDur(awakeMs) })}</p>}
      </Card>

      {lastClosed && !open && (
        <Btn className="w-full" onClick={() => setNotes({ sessionId: lastClosed.id })}>
          {t('home.notes')} · {fmtClock(parseInstant(lastClosed.sleep_start_utc), ctx.zone)}
        </Btn>
      )}

      {notes && <NotesSheet target={notes} onClose={() => setNotes(null)} />}
    </div>
  );
}
