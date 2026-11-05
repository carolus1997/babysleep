import type { AwakeningT, SettlingAttemptT, SleepSessionT } from '@babysleep/contract';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { listAwakenings, thresholdMs } from '../domain/awakening';
import { buildOverview } from '../domain/overview';
import { listSessions } from '../domain/sleep';
import { t } from '../i18n/es';
import { fmtDayShort, fmtDur } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Card, Chip } from '../ui/primitives';
import { FeedStats } from './FeedStats';
import { Rhythm } from './Rhythm';
import { Timeline } from './Timeline';

const RANGES = [7, 14, 28] as const;
const MIN_DAYS_FOR_CONFIDENCE = 3;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xl font-bold">{value}</p>
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}

/** Estadísticas con dos vistas: el resumen de siempre y el análisis de ritmo. */
export function Stats() {
  const [view, setView] = useState<'summary' | 'rhythm' | 'timeline' | 'feeds'>('summary');
  return (
    <div className="space-y-4">
      <div className="flex gap-1" role="group" aria-label={t('stats.title')}>
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
      </div>
      {view === 'summary' ? <Summary /> : view === 'rhythm' ? <Rhythm /> : view === 'timeline' ? <Timeline /> : <FeedStats />}
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
        <h1 className="text-2xl font-bold">{t('stats.title')}</h1>
        <div className="flex gap-1" role="group" aria-label={t('stats.title')}>
          {RANGES.map((r) => (
            <Chip key={r} active={days === r} onClick={() => setDays(r)}>
              {r}d
            </Chip>
          ))}
        </div>
      </div>

      <p className="text-sm text-muted">
        {t('stats.range', { n: days })} · {t('stats.coverage', { d: o.daysWithData, n: days })}
      </p>
      {o.daysWithData < MIN_DAYS_FOR_CONFIDENCE && <p className="rounded-2xl bg-surface2 p-3 text-sm">{t('stats.notEnough')}</p>}

      <Card>
        <div className="grid grid-cols-2 gap-4">
          <Stat label={t('stats.meanDaily')} value={o.meanDailyTotalMs === null ? '—' : fmtDur(o.meanDailyTotalMs)} />
          <Stat label={t('stats.meanNaps', { n: o.napDays })} value={o.meanNapTotalMs === null ? '—' : fmtDur(o.meanNapTotalMs)} />
          <Stat label={t('stats.meanNight', { n: o.nightDays })} value={o.meanNightTotalMs === null ? '—' : fmtDur(o.meanNightTotalMs)} />
          <Stat label={t('stats.napsPerDay')} value={o.meanNapsPerDay === null ? '—' : o.meanNapsPerDay.toFixed(1)} />
          <Stat label={t('stats.napMedian')} value={o.medianNapMs === null ? '—' : fmtDur(o.medianNapMs)} />
          <Stat label={t('stats.nightMedian')} value={o.medianNightMs === null ? '—' : fmtDur(o.medianNightMs)} />
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
        <div className="flex h-36 items-end gap-1" role="img" aria-label={t('stats.chart')}>
          {o.series.map((d) => (
            <div key={d.date} className="flex h-full flex-1 flex-col justify-end" title={`${d.date}: ${fmtDur(d.totalMs)}`}>
              <div className="w-full overflow-hidden rounded-t-md bg-surface2" style={{ height: `${(d.totalMs / max) * 100}%` }}>
                <div className="bg-nap" style={{ height: `${d.totalMs === 0 ? 0 : (d.napMs / d.totalMs) * 100}%` }} />
                <div className="bg-night" style={{ height: `${d.totalMs === 0 ? 0 : (d.nightMs / d.totalMs) * 100}%` }} />
              </div>
              {days <= 14 && <span className="mt-1 text-center text-[10px] text-muted">{fmtDayShort(d.date)}</span>}
            </div>
          ))}
        </div>
        <p className="mt-2 flex gap-3 text-xs text-muted">
          <span>
            <span className="mr-1 inline-block size-2 rounded-sm bg-nap" />
            {t('home.type.nap')}
          </span>
          <span>
            <span className="mr-1 inline-block size-2 rounded-sm bg-night" />
            {t('home.type.night')}
          </span>
        </p>
        <p className="mt-1 text-xs text-muted">{t('stats.chartHint')}</p>
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
          <li className={q.overlapsPending > 0 ? 'text-danger' : ''}>{t('stats.q.overlap', { n: q.overlapsPending })}</li>
          <li>{t('stats.q.approx', { n: q.approxTimes, t: q.sessionsInRange })}</li>
          <li>{t('stats.q.awakenings', { n: q.awakeningsUnknown, t: q.sessionsInRange })}</li>
        </ul>
      </Card>

      <p className="text-xs text-muted">{t('stats.disclaimer')}</p>
    </div>
  );
}
