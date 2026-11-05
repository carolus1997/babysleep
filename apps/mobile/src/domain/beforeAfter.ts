import type { AwakeningT, FeedingT, SettlingAttemptT, SleepSessionT } from '@babysleep/contract';
import { analyzeFeeding, localDate, MS_PER_24H, MS_PER_HOUR, naturalDayWindow } from '@babysleep/core';
import { buildOverview } from './overview';
import { buildRhythm } from './rhythm';

/** Un periodo con menos días con datos que esto no se compara: una diferencia así sería ruido. */
export const MIN_DAYS_TO_COMPARE = 3;

export type MetricKind = 'duration' | 'count' | 'clock';
export const METRIC_KEYS = ['total', 'night', 'nap', 'naps', 'awake', 'window', 'bedtime', 'feeds', 'latency'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface PeriodMetrics {
  /** Primer y último día (fecha local) del periodo. */
  from: string;
  to: string;
  daysWithData: number;
  values: Record<MetricKey, number | null>;
  /** Cuántos datos hay detrás de cada valor (días, ventanas, noches, intentos…). */
  n: Record<MetricKey, number>;
}

export const METRIC_KIND: Record<MetricKey, MetricKind> = {
  total: 'duration',
  night: 'duration',
  nap: 'duration',
  naps: 'count',
  awake: 'count',
  window: 'duration',
  bedtime: 'clock',
  feeds: 'count',
  latency: 'duration',
};

export interface BeforeAfterInput {
  sessions: readonly SleepSessionT[];
  feedings: readonly FeedingT[];
  awakenings: readonly AwakeningT[];
  attempts: readonly SettlingAttemptT[];
  awakeningThresholdMs: number;
  zone: string;
  nowMs: number;
  /** Fecha local (`YYYY-MM-DD`) en que empieza el hito. */
  eventDate: string;
  /** Días a cada lado, sin contar el día del hito. */
  days: number;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * MS_PER_24H).toISOString().slice(0, 10);
}

/** Diferencia con signo entre dos horas del día (minutos), por el camino corto del reloj: 23:50 → 00:10 = +20. */
export function clockDelta(fromMin: number, toMin: number): number {
  return ((((toMin - fromMin) % 1440) + 1440 + 720) % 1440) - 720;
}

/**
 * Métricas de los `days` días completos que preceden al día `endDate` (excluido). El día del hito no entra en ningún
 * periodo: está a medias y mezcla el «antes» con el «después».
 */
export function periodMetrics(input: Omit<BeforeAfterInput, 'eventDate'>, endDate: string): PeriodMetrics {
  const { zone, days } = input;
  const endMs = naturalDayWindow(endDate, zone).startMs;
  const o = buildOverview({
    sessions: input.sessions,
    attempts: input.attempts,
    awakenings: input.awakenings,
    awakeningThresholdMs: input.awakeningThresholdMs,
    zone,
    nowMs: endMs + 12 * MS_PER_HOUR,
    days,
  });
  const rh = buildRhythm({ sessions: input.sessions, zone, nowMs: endMs, days }).current;
  const f = analyzeFeeding({ feedings: input.feedings, sessions: input.sessions, zone, fromMs: endMs - days * MS_PER_24H, toMs: endMs, nowMs: endMs + 12 * MS_PER_HOUR });
  return {
    from: o.series[0]?.date ?? addDays(endDate, -days),
    to: o.series[o.series.length - 1]?.date ?? addDays(endDate, -1),
    daysWithData: o.daysWithData,
    values: {
      total: o.meanDailyTotalMs,
      night: o.meanNightTotalMs,
      nap: o.meanNapTotalMs,
      naps: o.meanNapsPerDay,
      awake: o.meanAwakeningsPerNight,
      window: rh.windows.between.meanMs,
      bedtime: rh.rhythm.bedtime.meanMinute,
      feeds: f.meanPerDay,
      latency: o.latency.medianMs,
    },
    n: {
      total: o.daysWithData,
      night: o.nightDays,
      nap: o.napDays,
      naps: o.daysWithData,
      awake: o.awakeningNights,
      window: rh.windows.between.n,
      bedtime: rh.rhythm.bedtime.n,
      feeds: f.daysObserved,
      latency: o.latency.n,
    },
  };
}

export interface MetricComparison {
  key: MetricKey;
  before: number | null;
  after: number | null;
  nBefore: number;
  nAfter: number;
  /** `después − antes` (para horas del día, por el camino corto); `null` si algún lado tiene pocos datos. */
  delta: number | null;
  /** Cuánto cambió ya entre las dos semanas ANTERIORES al hito: la variación normal del propio bebé, como referencia. */
  baselineDelta: number | null;
}

export interface BeforeAfter {
  eventDate: string;
  days: number;
  before: PeriodMetrics;
  priorBefore: PeriodMetrics;
  /** `null` mientras no hayan pasado `days` días completos desde el hito. */
  after: PeriodMetrics | null;
  /** Días que faltan para poder comparar (0 si ya se puede). */
  daysMissing: number;
  comparisons: MetricComparison[];
}

const MIN_N = 3;

function diff(kind: MetricKind, a: number | null, nA: number, b: number | null, nB: number): number | null {
  if (a === null || b === null || nA < MIN_N || nB < MIN_N) return null;
  return kind === 'clock' ? clockDelta(a, b) : b - a;
}

/**
 * Compara los `days` días antes de un hito con los `days` días después. Es descriptivo: dice qué cambió junto al hito,
 * nunca que el hito lo causara. Incluye la variación entre las dos semanas previas como referencia de lo «normal».
 */
export function buildBeforeAfter(input: BeforeAfterInput): BeforeAfter {
  const { eventDate, days, zone, nowMs } = input;
  const today = localDate(nowMs, zone);
  const afterEndDate = addDays(eventDate, days + 1);
  const complete = afterEndDate <= today;
  const before = periodMetrics(input, eventDate);
  const priorBefore = periodMetrics(input, addDays(eventDate, -days));
  const after = complete ? periodMetrics(input, afterEndDate) : null;
  const comparisons: MetricComparison[] = METRIC_KEYS.map((key) => {
    const kind = METRIC_KIND[key];
    return {
      key,
      before: before.values[key],
      after: after?.values[key] ?? null,
      nBefore: before.n[key],
      nAfter: after?.n[key] ?? 0,
      delta: after === null ? null : diff(kind, before.values[key], before.n[key], after.values[key], after.n[key]),
      baselineDelta: diff(kind, priorBefore.values[key], priorBefore.n[key], before.values[key], before.n[key]),
    };
  });
  const daysMissing = complete ? 0 : Math.max(1, Math.round((Date.parse(`${afterEndDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_24H));
  return { eventDate, days, before, priorBefore, after, daysMissing, comparisons };
}
