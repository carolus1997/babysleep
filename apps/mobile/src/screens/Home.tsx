import type { AwakeningT, SettlingAttemptT, SleepSessionT, TagT } from '@babysleep/contract';
import { buildSpans, localDate, parseInstant, sleepDayTotals, summarizeAwakenings, suggestSleepType } from '@babysleep/core';
import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { finishAwakening, getOpenAwakening, listAwakenings, startAwakening, thresholdMs } from '../domain/awakening';
import { awakeStatus } from '../domain/awake';
import { backupReminderDue } from '../domain/export';
import { listTags, type ObservationTarget } from '../domain/notes';
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
  startSleep,
  startSleepWith,
  undoCancelSleep,
} from '../domain/sleep';
import { clearIntent, loadIntent } from '../domain/sleepIntent';
import { t } from '../i18n/es';
import { fmtClock, fmtDur, fmtElapsed } from '../ui/format';
import type { SyncStatus } from '../sync/useAutoSync';
import { useLive, useNow } from '../ui/hooks';
import { Icon } from '../ui/Icon';
import { Banner, Btn, Card, Chip, EmptyState, Inset, Ring, Round, Tile } from '../ui/primitives';
import { AwakeningsSheet } from './AwakeningsSheet';
import { FeedingCard } from './FeedingCard';
import { NotesSheet } from './NotesSheet';
import { SleepModeSheet } from './SleepModeSheet';

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
  const [modeSheet, setModeSheet] = useState(false);
  const tags = useLive(() => listTags(ctx), [ctx], [] as TagT[]);

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
  const awake = awakeStatus({ sessions, zone: ctx.zone, nowMs: now });

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

  // «Ya duerme» desde la preparación: el sueño empieza con el modo y la forma elegidos al prepararlo.
  const intent = attempt ? loadIntent(attempt.id) : null;
  const intentLabel = intent
    ? [
        t(intent.type === 'nap' ? 'home.type.nap' : 'home.type.night'),
        ...intent.onsetSlugs.map((s) => tags.find((x) => x.tag_slug === s)?.label_i18n['es']).filter((x): x is string => x !== undefined),
      ].join(' · ')
    : null;
  const startFromAttempt = () =>
    run(async () => {
      const type = intent?.type ?? suggestSleepType(ctx.now(), ctx.zone);
      const onsetTagIds = (intent?.onsetSlugs ?? []).map((s) => tags.find((x) => x.tag_slug === s && x.category === 'onset')?.id).filter((x): x is string => x !== undefined);
      const s = await startSleepWith(ctx, baby.id, { type, onsetTagIds });
      clearIntent();
      return s;
    });

  const cancelOpenAttempt = async () => {
    if (!attempt) return;
    const id = attempt.id;
    if (await run(() => cancelSettling(ctx, id))) {
      clearIntent();
      toast(t('home.cancelSettleDone'), { label: t('home.undo'), run: () => void run(() => reopenSettling(ctx, id)) });
    }
  };

  const nightN = open ? awakenings.filter((a) => a.session_id === open.id).length : 0;
  const hasHistory = sessions.length > 0;

  return (
    <div className="space-y-4">
      {expired && (
        <Banner tone="danger" onClick={goSettings}>
          {t('home.sessionExpired')}
        </Banner>
      )}
      {reminder && <Banner onClick={goSettings}>{t('home.backupDue')}</Banner>}

      {open ? (
        <>
          <Card className="flex flex-col items-center pb-14 text-center">
            <Ring tour="ring" progress={0}>
              <p className="text-[12px] font-bold text-muted">{t('home.sleeping', { time: fmtClock(parseInstant(open.sleep_start_utc), ctx.zone) })}</p>
              <p className="my-1 text-[34px] font-extrabold leading-none tabular-nums" aria-live="off">
                {fmtElapsed(now - parseInstant(open.sleep_start_utc))}
              </p>
              <Icon name="moon" size={18} className="text-seg-nap" />
            </Ring>
            <div className="mt-3 flex justify-center gap-2" role="group" aria-label={t('home.sleeping', { time: fmtClock(parseInstant(open.sleep_start_utc), ctx.zone) })}>
              {(['nap', 'night'] as const).map((ty) => (
                <Chip key={ty} active={open.sleep_type === ty} onClick={() => run(() => editSession(ctx, open.id, { type: ty }))}>
                  {t(ty === 'nap' ? 'home.type.nap' : 'home.type.night')}
                </Chip>
              ))}
            </div>
          </Card>
          <div className="-mt-[58px] flex justify-center">
            <Round data-tour="round" icon="sun" label={t('home.roundWake')} aria-label={t('home.roundWakeName')} onClick={finish} />
          </div>

          <Inset className="flex flex-wrap items-center justify-center gap-2">
            <span className="text-[13px] font-bold text-muted">{t('home.fixStart')}</span>
            {[5, 10, 15].map((m) => (
              <Chip key={m} onClick={() => run(() => nudgeTime(ctx, open.id, 'start', -m))}>
                −{m} min
              </Chip>
            ))}
          </Inset>

          {open.sleep_type === 'night' && (
            <Card>
              {openAwake && (
                <p className="mb-2 text-sm font-bold">
                  {t('awake.awakeSince', { time: fmtClock(parseInstant(openAwake.start_utc), openAwake.start_tz), dur: fmtElapsed(now - parseInstant(openAwake.start_utc)) })}
                </p>
              )}
              <Btn variant={openAwake ? 'primary' : 'secondary'} className="w-full" onClick={wakeUp}>
                {openAwake ? t('awake.backToSleep') : t('awake.wokeUp')}
              </Btn>
              <Btn variant="ghost" className="mt-1 w-full" onClick={() => setAwakeSheet(open.id)}>
                {t('awake.openN', { n: nightN })}
              </Btn>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Tile icon="pencil" onClick={() => setNotes({ sessionId: open.id })}>
              {t('home.notes')}
            </Tile>
            <Tile icon="undo" onClick={cancelOpenSleep}>
              {t('home.cancelSleep')}
            </Tile>
          </div>
        </>
      ) : (
        <>
          <Card className="flex flex-col items-center pb-14 text-center" aria-label={t('wakeTime.title')}>
            {awake.state === 'awake' ? (
              <>
                <Ring tour="ring" progress={awake.usual !== null ? awake.elapsedMs / awake.usual.toMs : 0}>
                  <p className="text-[12px] font-bold text-muted">{t('wakeTime.title')}</p>
                  <p className="my-1 text-[34px] font-extrabold leading-none tabular-nums">{fmtDur(awake.elapsedMs)}</p>
                  <p className="text-[12px] font-semibold text-muted">
                    {t('wakeTime.since', { time: fmtClock(awake.sinceMs, ctx.zone), what: t(awake.after === 'night' ? 'wakeTime.afterNight' : 'wakeTime.afterNap') })}
                  </p>
                </Ring>
                {awake.usual !== null && (
                  <p className="mt-3 text-[13px] text-muted">
                    {t('wakeTime.usual', { from: fmtDur(awake.usual.fromMs), to: fmtDur(awake.usual.toMs) })}
                    {awake.elapsedMs > awake.usual.toMs && ` ${t('wakeTime.over')}`}
                  </p>
                )}
                {awake.stale && <p className="mt-2 text-[13px] text-muted">{t('wakeTime.stale')}</p>}
              </>
            ) : (
              !hasHistory && <EmptyState icon="moon" title={t('home.emptyTitle')} hint={t('home.emptyHint')} />
            )}
          </Card>
          <div className="-mt-[58px] flex flex-col items-center gap-1">
            <Round
              data-tour="round"
              icon="moon"
              label={attempt ? t('home.roundSleepNow') : t('home.roundSleep')}
              aria-label={attempt ? t('home.roundSleepNowName') : t('home.roundSleepName')}
              onClick={() => (attempt ? startFromAttempt() : setModeSheet(true))}
            />
            <p className="max-w-[16rem] text-center text-[12px] text-muted">{attempt ? t('home.startSleepHintPrep') : t('home.startSleepHint')}</p>
          </div>

          {attempt && (
            <Inset>
              <p className="font-bold">{t('home.settling', { dur: fmtDur(attempt.started_utc ? now - parseInstant(attempt.started_utc) : 0) })}</p>
              {intentLabel && <p className="text-[13px] font-semibold text-muted">{intentLabel}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {attempt.put_down_utc ? (
                  <span className="self-center text-sm text-muted">{t('home.putDownDone', { time: fmtClock(parseInstant(attempt.put_down_utc), ctx.zone) })}</span>
                ) : (
                  <Chip onClick={() => run(() => markPutDown(ctx, attempt.id))}>{t('home.putDown')}</Chip>
                )}
                <Chip onClick={() => setNotes({ attemptId: attempt.id })}>{t('home.settleNotes')}</Chip>
                <Chip onClick={cancelOpenAttempt}>{t('home.cancelSettle')}</Chip>
              </div>
            </Inset>
          )}
        </>
      )}

      <FeedingCard />

      <Card data-tour="today" title={t('home.today')}>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-xl font-extrabold tabular-nums">{fmtDur(today.napMs)}</p>
            <p className="text-[13px] font-semibold text-muted">{t('home.todayNaps')}</p>
            <p className="text-[12px] text-muted">{t('home.todayNapsSub', { n: today.napCount })}</p>
          </div>
          <div>
            <p className="text-xl font-extrabold tabular-nums">{fmtDur(today.nightMs)}</p>
            <p className="text-[13px] font-semibold text-muted">{t('home.todayNight')}</p>
          </div>
          <div>
            <p className="text-xl font-extrabold tabular-nums">{fmtDur(today.totalMs)}</p>
            <p className="text-[13px] font-semibold text-muted">{t('home.todaySleep')}</p>
          </div>
        </div>
        {today.totalMs > 0 && (
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface2" aria-hidden>
            <i className="bg-nap" style={{ width: `${(today.napMs / today.totalMs) * 100}%` }} />
            <i className="bg-night" style={{ width: `${(today.nightMs / today.totalMs) * 100}%` }} />
          </div>
        )}
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
        <p className="mt-2 text-center text-[12px] text-muted">{t('home.todayHint')}</p>
      </Card>

      {!open && (lastClosedNight || lastClosed) && (
        <div className="grid grid-cols-2 gap-2">
          {lastClosedNight && (
            <Tile icon="moon" onClick={() => setAwakeSheet(lastClosedNight.id)}>
              {t('awake.openN', { n: awakenings.filter((a) => a.session_id === lastClosedNight.id).length })} · {fmtClock(parseInstant(lastClosedNight.sleep_start_utc), lastClosedNight.start_tz)}
            </Tile>
          )}
          {lastClosed && (
            <Tile icon="pencil" onClick={() => setNotes({ sessionId: lastClosed.id })}>
              {t('home.notes')} · {fmtClock(parseInstant(lastClosed.sleep_start_utc), ctx.zone)}
            </Tile>
          )}
        </div>
      )}

      {notes && <NotesSheet target={notes} onClose={() => setNotes(null)} />}
      {modeSheet && <SleepModeSheet babyId={baby.id} onClose={() => setModeSheet(false)} />}
      {awakeSheet && sessions.find((x) => x.id === awakeSheet) && (
        <AwakeningsSheet session={sessions.find((x) => x.id === awakeSheet) as SleepSessionT} onClose={() => setAwakeSheet(null)} />
      )}
    </div>
  );
}
