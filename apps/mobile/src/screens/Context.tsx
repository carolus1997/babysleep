import type { AwakeningT, EventCategoryT, FeedingT, LifeEventT, SettlingAttemptT, SleepSessionT } from '@babysleep/contract';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { listAwakenings, thresholdMs } from '../domain/awakening';
import { buildBeforeAfter, METRIC_KIND, MIN_DAYS_TO_COMPARE, type MetricComparison, type MetricKey } from '../domain/beforeAfter';
import { listFeedings } from '../domain/feeding';
import { listLifeEvents } from '../domain/notes';
import { listSessions } from '../domain/sleep';
import { t, type I18nKey } from '../i18n/es';
import { fmtDur, fmtMinuteOfDay } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Card, Chip } from '../ui/primitives';

const RANGES = [7, 14] as const;

const fmtValue = (key: MetricKey, v: number | null): string => {
  if (v === null) return '—';
  const k = METRIC_KIND[key];
  return k === 'duration' ? fmtDur(v) : k === 'clock' ? fmtMinuteOfDay(v) : v.toFixed(1);
};

/** Diferencia con signo: «+1 h 5 min», «−20 min», «+0.5». */
const fmtDelta = (key: MetricKey, d: number | null): string => {
  if (d === null) return '—';
  const k = METRIC_KIND[key];
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  const abs = Math.abs(d);
  if (k === 'duration') return `${sign}${fmtDur(abs)}`;
  if (k === 'clock') return `${sign}${Math.round(abs)} min`;
  return `${sign}${abs.toFixed(1)}`;
};

function Row({ c }: { c: MetricComparison }) {
  return (
    <li className="py-2">
      <p className="font-medium">{t(`context.m.${c.key}` as I18nKey)}</p>
      <div className="mt-1 grid grid-cols-3 gap-2 text-sm">
        <div>
          <p className="text-xs text-muted">{t('context.before')}</p>
          <p className="font-semibold">{fmtValue(c.key, c.before)}</p>
          <p className="text-[10px] text-muted">n={c.nBefore}</p>
        </div>
        <div>
          <p className="text-xs text-muted">{t('context.after')}</p>
          <p className="font-semibold">{fmtValue(c.key, c.after)}</p>
          <p className="text-[10px] text-muted">n={c.nAfter}</p>
        </div>
        <div>
          <p className="text-xs text-muted">{t('context.change')}</p>
          <p className="font-semibold">{fmtDelta(c.key, c.delta)}</p>
          <p className="text-[10px] text-muted">
            {c.baselineDelta === null ? t('context.noBase') : t('context.base', { d: fmtDelta(c.key, c.baselineDelta) })}
          </p>
        </div>
      </div>
    </li>
  );
}

/** Módulo de análisis 7: qué cambió alrededor de un hito del diario. Coincidencia temporal, nunca causa. */
export function Context() {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const now = useNow(300_000);
  const events = useLive(() => listLifeEvents(ctx, babyId), [ctx, babyId], [] as LifeEventT[]);
  const cats = useLive(() => ctx.db.event_category.toArray(), [ctx], [] as EventCategoryT[]);
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const feedings = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const awakenings = useLive(() => listAwakenings(ctx, babyId), [ctx, babyId], [] as AwakeningT[]);
  const attempts = useLive(() => ctx.db.settling_attempt.where('baby_id').equals(babyId).toArray(), [ctx, babyId], [] as SettlingAttemptT[]);
  const thr = thresholdMs(baby ?? undefined);
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [picked, setPicked] = useState<string | null>(null);
  const ev = events.find((e) => e.id === picked) ?? events[0] ?? null;
  const catName = (id: string) => cats.find((c) => c.id === id)?.label_i18n['es'] ?? '';

  const ba = useMemo(
    () =>
      ev === null
        ? null
        : buildBeforeAfter({ sessions, feedings, awakenings, attempts, awakeningThresholdMs: thr, zone: ctx.zone, nowMs: now, eventDate: ev.start_date, days }),
    [ev, sessions, feedings, awakenings, attempts, thr, ctx.zone, now, days],
  );
  if (baby === null) return null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('context.intro')}</p>

      {events.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">{t('context.noEvents')}</p>
        </Card>
      ) : (
        <>
          <Card title={t('context.pick')}>
            <ul className="space-y-1">
              {events.slice(0, 12).map((e) => (
                <li key={e.id}>
                  <button
                    className={`flex min-h-12 w-full items-center justify-between gap-2 rounded-2xl border px-3 text-left ${
                      ev?.id === e.id ? 'border-accent bg-surface2' : 'border-line bg-surface'
                    }`}
                    onClick={() => setPicked(e.id)}
                    aria-pressed={ev?.id === e.id}
                  >
                    <span>
                      <span className="font-semibold">{catName(e.category_id)}</span>
                      {e.description && <span className="ml-2 text-sm text-muted">{e.description}</span>}
                    </span>
                    <span className="shrink-0 text-sm text-muted">{e.start_date}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <div className="flex gap-1" role="group" aria-label={t('context.range')}>
            {RANGES.map((x) => (
              <Chip key={x} active={days === x} onClick={() => setDays(x)}>
                {x} {t('context.daysEachSide')}
              </Chip>
            ))}
          </div>

          {ba !== null && ev !== null && (
            <Card title={`${catName(ev.category_id)} · ${ev.start_date}`}>
              <p className="mb-2 text-xs text-muted">
                {t('context.periods', { b: `${ba.before.from} → ${ba.before.to}`, db: ba.before.daysWithData, days })}
                {ba.after !== null && ` · ${t('context.periodsAfter', { a: `${ba.after.from} → ${ba.after.to}`, da: ba.after.daysWithData, days })}`}
              </p>
              {ba.after === null ? (
                <p className="rounded-2xl bg-surface2 p-3 text-sm">{t('context.wait', { n: ba.daysMissing })}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {ba.comparisons.map((c) => (
                    <Row key={c.key} c={c} />
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-muted">{t('context.hint', { min: MIN_DAYS_TO_COMPARE })}</p>
            </Card>
          )}
        </>
      )}
      <p className="text-xs text-muted">{t('context.noCause')}</p>
      <p className="text-xs text-muted">{t('stats.disclaimer')}</p>
    </div>
  );
}
