import type { FeedingT, SleepSessionT } from '@babysleep/contract';
import type { Backtest, Forecast as ForecastT } from '@babysleep/core';
import { useMemo } from 'react';
import { useApp } from '../app/AppContext';
import { buildForecast } from '../domain/forecast';
import { listFeedings } from '../domain/feeding';
import { listSessions } from '../domain/sleep';
import { t } from '../i18n/es';
import { fmtClock, fmtDur } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Card } from '../ui/primitives';

const MIN_PREDICTED_FOR_BACKTEST = 3;

function Abstain({ f }: { f: Extract<ForecastT, { kind: 'abstain' }> }) {
  return (
    <p className="rounded-2xl bg-surface2 p-3 text-sm">
      {f.reason === 'few_data' ? t('forecast.fewData', { n: f.n, needed: f.needed }) : t('forecast.irregular')}
    </p>
  );
}

function Range({ range, zone }: { range: { fromMs: number; midMs: number; toMs: number }; zone: string }) {
  return (
    <div>
      <p className="text-2xl font-bold">
        {fmtClock(range.fromMs, zone)} – {fmtClock(range.toMs, zone)}
      </p>
      <p className="text-sm text-muted">{t('forecast.median', { time: fmtClock(range.midMs, zone) })}</p>
    </div>
  );
}

function BacktestLine({ b }: { b: Backtest }) {
  if (b.predicted < MIN_PREDICTED_FOR_BACKTEST) return <p className="mt-3 text-xs text-muted">{t('forecast.btNone')}</p>;
  return (
    <p className="mt-3 text-xs text-muted">
      {t('forecast.bt', {
        hits: b.hits,
        n: b.predicted,
        err: fmtDur(b.medianAbsErrMs ?? 0),
        naive: fmtDur(b.naiveMedianAbsErrMs ?? 0),
        abst: b.abstained,
      })}
    </p>
  );
}

/** Módulo de análisis 6: previsión orientativa con abstención y prueba hacia atrás. */
export function Forecast() {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const feedings = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const now = useNow(60_000);
  const v = useMemo(() => buildForecast({ sessions, feedings, zone: ctx.zone, nowMs: now }), [sessions, feedings, ctx.zone, now]);
  if (baby === null) return null;
  const { sleep: s, feed: f } = v;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('forecast.intro')}</p>

      <Card title={t('forecast.sleep')}>
        {s.state === 'sleeping' && <p className="text-sm text-muted">{t('forecast.sleeping')}</p>}
        {s.state === 'unknown' && <p className="text-sm text-muted">{t(s.reason === 'stale' ? 'forecast.stale' : 'forecast.noSessions')}</p>}
        {s.state === 'awake' && (
          <>
            <p className="mb-2 text-sm">
              {t('forecast.awakeSince', { time: fmtClock(s.awakeSinceMs, ctx.zone), dur: fmtDur(now - s.awakeSinceMs) })} ·{' '}
              {t(s.position === 'bedtime' ? 'forecast.nextBedtime' : 'forecast.nextNap')}
            </p>
            {s.forecast.kind === 'range' && s.range !== null ? <Range range={s.range} zone={ctx.zone} /> : s.forecast.kind === 'abstain' && <Abstain f={s.forecast} />}
            {s.range !== null && now > s.range.toMs && <p className="mt-2 text-xs text-muted">{t('forecast.passed')}</p>}
            {s.forecast.kind === 'range' && <p className="mt-2 text-xs text-muted">{t('forecast.basisN', { n: s.forecast.n })}</p>}
            <BacktestLine b={s.backtest} />
          </>
        )}
      </Card>

      <Card title={t('forecast.feed')}>
        {f.state === 'feeding' && <p className="text-sm text-muted">{t('forecast.feeding')}</p>}
        {f.state === 'unknown' && <p className="text-sm text-muted">{t(f.reason === 'stale' ? 'forecast.feedStale' : 'forecast.noFeeds')}</p>}
        {f.state === 'waiting' && (
          <>
            <p className="mb-2 text-sm">{t('forecast.lastFeed', { time: fmtClock(f.lastStartMs, ctx.zone) })}</p>
            {f.forecast.kind === 'range' && f.range !== null ? <Range range={f.range} zone={ctx.zone} /> : f.forecast.kind === 'abstain' && <Abstain f={f.forecast} />}
            {f.range !== null && now > f.range.toMs && <p className="mt-2 text-xs text-muted">{t('forecast.passedFeed')}</p>}
            {f.forecast.kind === 'range' && (
              <p className="mt-2 text-xs text-muted">{t(f.basis === 'same_band' ? 'forecast.basisBand' : 'forecast.basisAll', { n: f.forecast.n })}</p>
            )}
            <BacktestLine b={f.backtest} />
          </>
        )}
      </Card>

      <p className="text-xs text-muted">{t('forecast.hint')}</p>
      <p className="text-xs text-muted">{t('stats.disclaimer')}</p>
    </div>
  );
}
