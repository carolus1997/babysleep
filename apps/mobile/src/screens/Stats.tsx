import type { AwakeningT, SettlingAttemptT, SleepSessionT } from '@babysleep/contract';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app/AppContext';
import { listAwakenings, thresholdMs } from '../domain/awakening';
import { buildOverview } from '../domain/overview';
import { listSessions } from '../domain/sleep';
import { t } from '../i18n/es';
import { fmtDayShort, fmtDur } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Card, Chip, EmptyState, Inset, Tabs } from '../ui/primitives';
import { Context } from './Context';
import { FeedStats } from './FeedStats';
import { Report } from './Report';
import { Rhythm } from './Rhythm';
import { Timeline } from './Timeline';
import { Trends } from './Trends';

const RANGES = [7, 14, 28] as const;
const MIN_DAYS_FOR_CONFIDENCE = 3;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xl font-extrabold tabular-nums">{value}</p>
      <p className="text-[13px] font-semibold text-muted">{label}</p>
    </div>
  );
}

/** Estadísticas con dos vistas: el resumen de siempre y el análisis de ritmo. */
export function Stats({ resetKey = 0 }: { /** Sube cada vez que se pulsa «Estadísticas» en la barra: vuelve al Resumen. */ resetKey?: number }) {
  const [view, setView] = useState<'summary' | 'rhythm' | 'timeline' | 'feeds' | 'trends' | 'report' | 'context'>('summary');
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setView('summary');
  }, [resetKey]);
  return (
    <div className="space-y-4">
      <Tabs label={t('stats.title')} tour="stats-tabs">
        <Chip active={view === 'summary'} onClick={() => setView('summary')}>
          {t('stats.view.summary')}
        </Chip>
        <Chip active={view === 'rhythm'} onClick={() => setView('rhythm')}>
          {t('stats.view.rhythm')}
        </Chip>
        <Chip active={view === 'timeline'} onClick={() => setView('timeline')}>
          {t('stats.view.timeline')}
        </Chip>
        <Chip active={view === 'feeds'} onClick={() => setView('feeds')}>
          {t('stats.view.feeds')}
        </Chip>
        <Chip active={view === 'trends'} onClick={() => setView('trends')}>
          {t('stats.view.trends')}
        </Chip>
        <Chip active={view === 'report'} onClick={() => setView('report')}>
          {t('stats.view.report')}
        </Chip>
        <Chip active={view === 'context'} onClick={() => setView('context')}>
          {t('stats.view.context')}
        </Chip>
      </Tabs>
      {view === 'summary' ? (
        <Summary />
      ) : view === 'rhythm' ? (
        <Rhythm />
      ) : view === 'timeline' ? (
        <Timeline />
      ) : view === 'feeds' ? (
        <FeedStats />
      ) : view === 'trends' ? (
        <Trends />
      ) : view === 'report' ? (
        <Report />
      ) : (
        <Context />
      )}
    </div>
  );
}

function Summary() {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const attempts = useLive(() => ctx.db.settling_attempt.where('baby_id').equals(babyId).toArray(), [ctx, babyId], [] as SettlingAttemptT[]);
  const awakenings = useLive(() => listAwakenings(ctx, babyId), [ctx, babyId], [] as AwakeningT[]);
  const now = useNow(60_000);
  const thr = thresholdMs(baby ?? undefined);
  const o = useMemo(
    () => buildOverview({ sessions, awakenings, awakeningThresholdMs: thr, attempts, zone: ctx.zone, nowMs: now, days }),
    [sessions, awakenings, thr, attempts, ctx.zone, now, days],
  );
  if (baby === null) return null;

  const max = Math.max(1, ...o.series.map((d) => d.lengthHours * 3_600_000 * 0.75), ...o.series.map((d) => d.totalMs));
  const { latency: lat, quality: q } = o;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-extrabold">{t('stats.title')}</h1>
        <div className="flex gap-1.5" role="group" aria-label={t('stats.title')}>
          {RANGES.map((r) => (
            <Chip key={r} active={days === r} onClick={() => setDays(r)}>
              {r}d
            </Chip>
          ))}
        </div>
      </div>

      <p className="text-[13px] text-muted">
        {t('stats.range', { n: days })} · {t('stats.coverage', { d: o.daysWithData, n: days })}
      </p>
      {o.daysWithData < MIN_DAYS_FOR_CONFIDENCE && <Inset className="text-sm">{t('stats.notEnough')}</Inset>}

      <Card>
        <p className="text-[13px] font-bold text-muted">{t('stats.meanDaily')}</p>
        <p className="mt-1 text-[40px] font-extrabold leading-none tabular-nums">{o.meanDailyTotalMs === null ? '—' : fmtDur(o.meanDailyTotalMs)}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Inset>
            <Stat label={t('stats.meanNaps', { n: o.napDays })} value={o.meanNapTotalMs === null ? '—' : fmtDur(o.meanNapTotalMs)} />
          </Inset>
          <Inset>
            <Stat label={t('stats.meanNight', { n: o.nightDays })} value={o.meanNightTotalMs === null ? '—' : fmtDur(o.meanNightTotalMs)} />
          </Inset>
          <Inset>
            <Stat label={t('stats.napsPerDay')} value={o.meanNapsPerDay === null ? '—' : o.meanNapsPerDay.toFixed(1)} />
          </Inset>
          <Inset>
            <Stat label={t('stats.napMedian')} value={o.medianNapMs === null ? '—' : fmtDur(o.medianNapMs)} />
          </Inset>
          <Inset className="col-span-2">
            <Stat label={t('stats.nightMedian')} value={o.medianNightMs === null ? '—' : fmtDur(o.medianNightMs)} />
          </Inset>
        </div>
      </Card>

      <Card title={t('stats.awake.title')}>
        {o.awakeningNights === 0 ? (
          <p className="text-sm text-muted">{t('stats.awake.empty')}</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Stat label={t('stats.awake.perNight')} value={(o.meanAwakeningsPerNight ?? 0).toFixed(1)} />
            <Stat label={t('stats.awake.longPerNight')} value={(o.meanLongAwakeningsPerNight ?? 0).toFixed(1)} />
            <Stat label={t('stats.awake.meanAwake')} value={fmtDur(o.meanAwakeMs ?? 0)} />
          </div>
        )}
        <p className="mt-2 text-xs text-muted">{t('stats.awake.basis', { n: o.awakeningNights })}</p>
      </Card>

      <Card title={t('stats.chart')}>
        {o.daysWithData === 0 ? (
          <EmptyState icon="chart" title={t('stats.chartEmpty')} hint={t('stats.chartEmptyHint')} />
        ) : (
          <>
            <div className="relative">
              {o.meanDailyTotalMs !== null && (
                <div
                  aria-hidden
                  className="absolute inset-x-0 border-t-2 border-dashed border-muted/60"
                  style={{ bottom: `calc(${days <= 14 ? '1.25rem + ' : ''}${(o.meanDailyTotalMs / max) * 100}% * ${days <= 14 ? 0.8 : 1})` }}
                />
              )}
              <div className={`flex h-44 items-end ${days <= 14 ? 'gap-1.5' : 'gap-0.5'}`} role="img" aria-label={t('stats.chart')}>
                {o.series.map((d) => (
                  <div key={d.date} className="flex h-full flex-1 flex-col justify-end" title={`${d.date}: ${fmtDur(d.totalMs)}`}>
                    {days <= 14 && d.totalMs > 0 && <span className="mb-0.5 text-center text-[11px] font-bold tabular-nums">{(d.totalMs / 3_600_000).toFixed(1).replace('.', ',')}</span>}
                    <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-lg" style={{ height: `${days <= 14 ? (d.totalMs / max) * 80 : (d.totalMs / max) * 100}%` }}>
                      <div className="bg-nap" style={{ height: `${d.totalMs === 0 ? 0 : (d.napMs / d.totalMs) * 100}%` }} />
                      <div className="bg-night" style={{ height: `${d.totalMs === 0 ? 0 : (d.nightMs / d.totalMs) * 100}%` }} />
                    </div>
                    {days <= 14 && <span className="mt-1 h-4 text-center text-[11px] font-semibold text-muted">{fmtDayShort(d.date)}</span>}
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-2 flex gap-4 text-[12px] font-semibold text-muted">
              <span>
                <span className="mr-1.5 inline-block size-2.5 rounded-sm bg-nap" />
                {t('home.type.nap')}
              </span>
              <span>
                <span className="mr-1.5 inline-block size-2.5 rounded-sm bg-night" />
                {t('home.type.night')}
              </span>
              <span>- - {t('stats.meanLine')}</span>
            </p>
            <p className="mt-1 text-[12px] text-muted">{t('stats.chartHint')}</p>
          </>
        )}
      </Card>

      <Card title={t('stats.latency')}>
        {lat.n === 0 ? (
          <p className="text-sm text-muted">{t('stats.latencyEmpty')}</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Stat label="mediana" value={fmtDur(lat.medianMs ?? 0)} />
            <Stat label="media" value={fmtDur(lat.meanMs ?? 0)} />
            <Stat label="n" value={String(lat.n)} />
          </div>
        )}
        {lat.excluded.unknown > 0 && <p className="mt-2 text-xs text-muted">{t('stats.latencyUnknown', { n: lat.excluded.unknown })}</p>}
        {lat.excluded.needs_review > 0 && <p className="mt-1 text-xs text-danger">{t('stats.latencyReview', { n: lat.excluded.needs_review })}</p>}
      </Card>

      <Card title={t('stats.quality')}>
        <ul className="space-y-1 text-sm">
          <li>{t('stats.q.open', { n: q.openSessions })}</li>
          <li className={q.overlapsPending > 0 ? 'font-bold text-danger' : ''}>{t('stats.q.overlap', { n: q.overlapsPending })}</li>
          <li>{t('stats.q.approx', { n: q.approxTimes, t: q.sessionsInRange })}</li>
          <li>{t('stats.q.awakenings', { n: q.awakeningsUnknown, t: q.sessionsInRange })}</li>
        </ul>
      </Card>

      <p className="text-xs text-muted">{t('stats.disclaimer')}</p>
    </div>
  );
}
