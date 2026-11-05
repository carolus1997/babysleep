import type { FeedingT, SleepSessionT } from '@babysleep/contract';
import { analyzeFeeding, MS_PER_24H, type DayBand } from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { listFeedings } from '../domain/feeding';
import { listSessions } from '../domain/sleep';
import { t, type I18nKey } from '../i18n/es';
import { fmtDur } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Card, Chip } from '../ui/primitives';
import { delta } from './Rhythm';

const RANGES = [7, 14, 28] as const;
const BAND_KEY: Record<DayBand, I18nKey> = {
  small_hours: 'fstats.band.small_hours',
  morning: 'fstats.band.morning',
  afternoon: 'fstats.band.afternoon',
  evening: 'fstats.band.evening',
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xl font-bold">{value}</p>
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}

/** Módulo de análisis 3: tomas. Descriptivo; no dice cuánto «debería» comer. */
export function FeedStats() {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const [days, setDays] = useState<(typeof RANGES)[number]>(14);
  const feedings = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const now = useNow(60_000);
  const { cur, prev } = useMemo(() => {
    const from = now - days * MS_PER_24H;
    const base = { feedings, sessions, zone: ctx.zone, nowMs: now };
    return {
      cur: analyzeFeeding({ ...base, fromMs: from, toMs: now + 1 }),
      prev: analyzeFeeding({ ...base, fromMs: from - days * MS_PER_24H, toMs: from }),
    };
  }, [feedings, sessions, ctx.zone, now, days]);
  if (baby === null) return null;

  const maxBand = Math.max(1, ...cur.byBand.map((b) => b.perDay ?? 0));
  const d = delta(cur.intervals, prev.intervals);

  return (
    <div className="space-y-4">
      <div className="flex gap-1" role="group" aria-label={t('fstats.title')}>
        {RANGES.map((x) => (
          <Chip key={x} active={days === x} onClick={() => setDays(x)}>
            {x}d
          </Chip>
        ))}
      </div>

      {cur.count === 0 ? (
        <Card title={t('fstats.title')}>
          <p className="text-sm text-muted">{t('fstats.empty')}</p>
        </Card>
      ) : (
        <>
          <Card title={t('fstats.title')}>
            <div className="grid grid-cols-2 gap-4">
              <Stat label={t('fstats.perDay', { n: cur.daysObserved })} value={cur.meanPerDay === null ? '—' : cur.meanPerDay.toFixed(1)} />
              <div>
                <p className="text-xl font-bold">
                  {cur.intervals.medianMs === null ? '—' : fmtDur(cur.intervals.medianMs)}
                  {d !== null && <span className="ml-2 text-xs font-normal text-muted">{d}</span>}
                </p>
                <p className="text-sm text-muted">{t('fstats.intervalMedian', { n: cur.intervals.n })}</p>
              </div>
              <Stat label={t('fstats.intervalRange')} value={cur.intervals.minMs === null ? '—' : `${fmtDur(cur.intervals.minMs)} – ${fmtDur(cur.intervals.maxMs ?? 0)}`} />
              <Stat
                label={t('fstats.durationMedian', { n: cur.duration.n })}
                value={cur.duration.medianMs === null ? '—' : fmtDur(cur.duration.medianMs)}
              />
            </div>
            <p className="mt-3 text-xs text-muted">{t('fstats.intervalHint')}</p>
            {cur.durationUnknown > 0 && <p className="mt-1 text-xs text-muted">{t('fstats.durationUnknown', { n: cur.durationUnknown })}</p>}
            {cur.intervalsTooLong > 0 && <p className="mt-1 text-xs text-muted">{t('fstats.tooLong', { n: cur.intervalsTooLong })}</p>}
          </Card>

          <Card title={t('fstats.bands')}>
            <ul className="space-y-2">
              {cur.byBand.map((b) => (
                <li key={b.band}>
                  <div className="flex justify-between text-sm">
                    <span>{t(BAND_KEY[b.band])}</span>
                    <span className="font-semibold">{b.perDay === null ? '—' : b.perDay.toFixed(1)}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface2" aria-hidden>
                    <div className="h-full rounded-full bg-accent" style={{ width: `${((b.perDay ?? 0) / maxBand) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">{t('fstats.bandsHint')}</p>
          </Card>

          <Card title={t('fstats.types')}>
            <div className="grid grid-cols-3 gap-3">
              <Stat label={t('feed.type.breast')} value={String(cur.byType.breast)} />
              <Stat label={t('feed.type.bottle')} value={String(cur.byType.bottle)} />
              <Stat label={t('feed.type.solids')} value={String(cur.byType.solids)} />
            </div>
            {cur.bottle.n > 0 && (
              <p className="mt-3 text-sm">
                {cur.bottle.meanMl === null
                  ? t('fstats.bottleNoMl', { n: cur.bottle.n })
                  : t('fstats.bottleMl', { ml: Math.round(cur.bottle.meanMl), k: cur.bottle.withMl, n: cur.bottle.n })}
              </p>
            )}
          </Card>

          <Card title={t('fstats.nights')}>
            {cur.nights.n === 0 ? (
              <p className="text-sm text-muted">{t('fstats.nightsEmpty')}</p>
            ) : (
              <Stat label={t('fstats.nightsMean', { n: cur.nights.n })} value={(cur.nights.meanPerNight ?? 0).toFixed(1)} />
            )}
            <p className="mt-3 text-xs text-muted">{t('fstats.nightsHint')}</p>
          </Card>
        </>
      )}
      <p className="text-xs text-muted">{t('stats.disclaimer')}</p>
    </div>
  );
}
