import type { SleepSessionT } from '@babysleep/contract';
import type { CircularStats, WindowStats } from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { buildRhythm, MIN_N_TO_COMPARE } from '../domain/rhythm';
import { listSessions } from '../domain/sleep';
import { t } from '../i18n/es';
import { fmtDur, fmtMinuteOfDay } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Card, Chip } from '../ui/primitives';

const RANGES = [7, 14, 28] as const;

/** «+12 min» / «−8 min» frente al periodo anterior; nada si alguno de los dos tiene pocos datos. */
export function delta(cur: WindowStats, prev: WindowStats): string | null {
  if (cur.n < MIN_N_TO_COMPARE || prev.n < MIN_N_TO_COMPARE || cur.meanMs === null || prev.meanMs === null) return null;
  const min = Math.round((cur.meanMs - prev.meanMs) / 60_000);
  if (min === 0) return t('rhythm.same');
  return `${min > 0 ? '+' : '−'}${Math.abs(min)} min`;
}

function WindowRow({ label, cur, prev, scaleMs }: { label: string; cur: WindowStats; prev: WindowStats; scaleMs: number }) {
  const d = delta(cur, prev);
  return (
    <li className="py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className="text-right">
          <span className="text-lg font-bold">{cur.meanMs === null ? '—' : fmtDur(cur.meanMs)}</span>
          {d !== null && <span className="ml-2 text-xs text-muted">{d}</span>}
        </span>
      </div>
      {cur.meanMs !== null && (
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface2" aria-hidden>
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (cur.meanMs / scaleMs) * 100)}%` }} />
        </div>
      )}
      <p className="mt-1 text-xs text-muted">
        {cur.n === 0
          ? t('rhythm.noData')
          : t('rhythm.winDetail', { n: cur.n, med: fmtDur(cur.medianMs ?? 0), min: fmtDur(cur.minMs ?? 0), max: fmtDur(cur.maxMs ?? 0) })}
        {cur.n > 0 && cur.n < MIN_N_TO_COMPARE && ` · ${t('rhythm.fewData')}`}
      </p>
    </li>
  );
}

function ClockRow({ label, s }: { label: string; s: CircularStats }) {
  return (
    <div>
      <p className="text-xl font-bold">
        {s.meanMinute === null ? '—' : fmtMinuteOfDay(s.meanMinute)}
        {s.sdMinutes !== null && <span className="ml-1 text-sm font-normal text-muted">± {Math.round(s.sdMinutes)} min</span>}
      </p>
      <p className="text-sm text-muted">
        {label} · n={s.n}
      </p>
    </div>
  );
}

/** Módulo de análisis 1: ventanas de vigilia y ritmo diario. Descriptivo; sin normas ni diagnósticos. */
export function Rhythm() {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const [days, setDays] = useState<(typeof RANGES)[number]>(14);
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const now = useNow(60_000);
  const v = useMemo(() => buildRhythm({ sessions, zone: ctx.zone, nowMs: now, days }), [sessions, ctx.zone, now, days]);
  if (baby === null) return null;

  const { windows: w, rhythm: r } = v.current;
  const pw = v.previous.windows;
  const scale = Math.max(1, ...[w.first, w.between, w.bedtime].map((s) => s.meanMs ?? 0)) * 1.15;
  const hasWindows = w.first.n + w.between.n + w.bedtime.n > 0;

  return (
    <div className="space-y-4">
      <div className="flex gap-1" role="group" aria-label={t('rhythm.title')}>
        {RANGES.map((x) => (
          <Chip key={x} active={days === x} onClick={() => setDays(x)}>
            {x}d
          </Chip>
        ))}
      </div>

      <Card title={t('rhythm.windows')}>
        {!hasWindows ? (
          <p className="text-sm text-muted">{t('rhythm.windowsEmpty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            <WindowRow label={t('rhythm.win.first')} cur={w.first} prev={pw.first} scaleMs={scale} />
            <WindowRow label={t('rhythm.win.between')} cur={w.between} prev={pw.between} scaleMs={scale} />
            <WindowRow label={t('rhythm.win.bedtime')} cur={w.bedtime} prev={pw.bedtime} scaleMs={scale} />
          </ul>
        )}
        {w.byIndex.length > 1 && (
          <div className="mt-3 border-t border-line pt-3">
            <p className="mb-1 text-sm font-medium">{t('rhythm.byIndex')}</p>
            <ul className="space-y-1 text-sm">
              {w.byIndex.map(({ index, stats }) => (
                <li key={index} className="flex justify-between">
                  <span className="text-muted">{t('rhythm.nth', { n: index })}</span>
                  <span>
                    {stats.meanMs === null ? '—' : fmtDur(stats.meanMs)} <span className="text-xs text-muted">(n={stats.n})</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">{t('rhythm.windowsHint')}</p>
        {(w.tooLong > 0 || w.overlapping > 0) && (
          <p className="mt-1 text-xs text-muted">{t('rhythm.excluded', { long: w.tooLong, over: w.overlapping })}</p>
        )}
      </Card>

      <Card title={t('rhythm.daily')}>
        <div className="grid grid-cols-2 gap-4">
          <ClockRow label={t('rhythm.bedtime')} s={r.bedtime} />
          <ClockRow label={t('rhythm.wakeUp')} s={r.wakeUp} />
          <ClockRow label={t('rhythm.firstNap')} s={r.firstNap} />
          <div>
            <p className="text-xl font-bold">
              {r.napsPerDay.mean === null ? '—' : r.napsPerDay.mean.toFixed(1)}
              {r.napsPerDay.sd !== null && <span className="ml-1 text-sm font-normal text-muted">± {r.napsPerDay.sd.toFixed(1)}</span>}
            </p>
            <p className="text-sm text-muted">
              {t('rhythm.napsPerDay')} · n={r.napsPerDay.n}
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted">{t('rhythm.dailyHint')}</p>
      </Card>

      {v.openSessions > 0 && <p className="text-xs text-muted">{t('rhythm.open', { n: v.openSessions })}</p>}
      <p className="text-xs text-muted">{t('stats.disclaimer')}</p>
    </div>
  );
}
