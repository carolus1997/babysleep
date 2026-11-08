import type { AwakeningT, FeedingT, SleepSessionT } from '@babysleep/contract';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { listAwakenings, thresholdMs } from '../domain/awakening';
import { listFeedings } from '../domain/feeding';
import { listSessions } from '../domain/sleep';
import { buildTrends, MIN_DAYS_PER_WEEK, type WeekRow } from '../domain/trends';
import { t } from '../i18n/es';
import { fmtDur } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Card, Chip } from '../ui/primitives';

const RANGES = [8, 12] as const;

/** Una métrica semanal como barras: una por semana, la última a la derecha. Sin dato = hueco, nunca barra a cero. */
function WeekBars({ title, rows, pick, fmt, hint }: { title: string; rows: WeekRow[]; pick: (r: WeekRow) => number | null; fmt: (v: number) => string; hint?: string }) {
  const vals = rows.map(pick);
  const max = Math.max(1e-9, ...vals.map((v) => v ?? 0));
  const last = [...vals].reverse().find((v) => v !== null) ?? null;
  return (
    <Card title={title}>
      <p className="mb-2 text-2xl font-bold">{last === null ? '—' : fmt(last)}</p>
      <div className="flex h-24 items-end gap-1" role="img" aria-label={`${title}: ${vals.map((v) => (v === null ? 'sin datos' : fmt(v))).join(', ')}`}>
        {rows.map((r, i) => {
          const v = vals[i] ?? null;
          return (
            <div key={r.endMs} className="flex h-full flex-1 flex-col justify-end" title={v === null ? t('trends.noData') : fmt(v)}>
              {v === null ? (
                <div className="h-1 w-full rounded-full border border-dashed border-line" />
              ) : (
                <div className="w-full rounded-t-md bg-accent" style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1 text-[11px] text-muted" aria-hidden>
        {rows.map((r) => (
          <span key={r.endMs} className="flex-1 text-center leading-tight">
            {r.ageWeeks}
            {r.correctedWeeks !== null && <span className="block">c.{r.correctedWeeks}</span>}
          </span>
        ))}
      </div>
      <p className="mt-1 text-xs text-muted">{t('trends.axis')}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

/** Módulo de análisis 4: cómo cambia el propio bebé semana a semana. No compara con otros bebés ni con tablas. */
export function Trends() {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const [weeks, setWeeks] = useState<(typeof RANGES)[number]>(8);
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const feedings = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const awakenings = useLive(() => listAwakenings(ctx, babyId), [ctx, babyId], [] as AwakeningT[]);
  const now = useNow(300_000);
  const thr = thresholdMs(baby ?? undefined);
  const rows = useMemo(
    () => (baby === null ? [] : buildTrends({ baby, sessions, feedings, awakenings, awakeningThresholdMs: thr, zone: ctx.zone, nowMs: now, weeks })),
    [baby, sessions, feedings, awakenings, thr, ctx.zone, now, weeks],
  );
  if (baby === null) return null;
  const enough = rows.filter((r) => r.enough).length;

  return (
    <div className="space-y-4">
      <div className="flex gap-1" role="group" aria-label={t('trends.title')}>
        {RANGES.map((x) => (
          <Chip key={x} active={weeks === x} onClick={() => setWeeks(x)}>
            {x} {t('trends.weeksShort')}
          </Chip>
        ))}
      </div>
      <p className="text-sm text-muted">{t('trends.intro', { min: MIN_DAYS_PER_WEEK })}</p>
      {enough < 2 && <p className="rounded-2xl bg-surface2 p-3 text-sm">{t('trends.notEnough')}</p>}

      <WeekBars title={t('trends.total')} rows={rows} pick={(r) => r.meanTotalMs} fmt={fmtDur} hint={t('trends.totalHint')} />
      <WeekBars title={t('trends.night')} rows={rows} pick={(r) => r.meanNightMs} fmt={fmtDur} />
      <WeekBars title={t('trends.nap')} rows={rows} pick={(r) => r.meanNapMs} fmt={fmtDur} />
      <WeekBars title={t('trends.napsPerDay')} rows={rows} pick={(r) => r.napsPerDay} fmt={(v) => v.toFixed(1)} />
      <WeekBars title={t('trends.window')} rows={rows} pick={(r) => r.meanBetweenWindowMs} fmt={fmtDur} hint={t('trends.windowHint', { min: MIN_DAYS_PER_WEEK })} />
      <WeekBars title={t('trends.feeds')} rows={rows} pick={(r) => r.feedsPerDay} fmt={(v) => v.toFixed(1)} />
      <p className="text-xs text-muted">{t('stats.disclaimer')}</p>
    </div>
  );
}
