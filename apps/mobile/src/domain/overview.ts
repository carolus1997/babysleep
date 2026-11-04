import type { SettlingAttemptT, SleepSessionT } from '@babysleep/contract';
import {
  activeSessions,
  buildSpans,
  DEFAULT_LATENCY_REVIEW_THRESHOLD_MS,
  findOverlaps,
  localDate,
  median,
  mean,
  naturalDayWindow,
  parseInstant,
  recordedDurationMs,
  settlingLatency,
  sleepDayTotals,
  summarizeLatency,
  type LatencySummary,
  type LatencyResult,
} from '@babysleep/core';

export interface DayRow {
  date: string;
  lengthHours: number;
  totalMs: number;
  napMs: number;
  nightMs: number;
  napCount: number;
  nightCount: number;
  hasData: boolean;
  /** `false` si queda una sesión abierta del día: aún puede crecer y no entra en los promedios. */
  complete: boolean;
}

export interface Overview {
  days: number;
  /** Días completos analizados (de hace `days` días hasta ayer), del más antiguo al más reciente. */
  series: DayRow[];
  today: DayRow;
  daysWithData: number;
  meanDailyTotalMs: number | null;
  /** Promedio de horas de siesta por día (solo días completos con alguna siesta registrada). */
  meanNapTotalMs: number | null;
  /** Promedio de horas de noche (solo días completos con noche registrada). */
  meanNightTotalMs: number | null;
  napDays: number;
  nightDays: number;
  meanNapsPerDay: number | null;
  medianNapMs: number | null;
  medianNightMs: number | null;
  latency: LatencySummary;
  quality: {
    openSessions: number;
    overlapsPending: number;
    anomalies: number;
    approxTimes: number;
    sessionsInRange: number;
    /** Siempre desconocido mientras no se registren despertares como completos. */
    awakeningsUnknown: number;
  };
}

export interface OverviewInput {
  sessions: readonly SleepSessionT[];
  attempts: readonly SettlingAttemptT[];
  zone: string;
  nowMs: number;
  days: number;
  latencyReviewThresholdMs?: number;
}

function dayRow(sessions: readonly SleepSessionT[], date: string, zone: string, nowMs: number | undefined): DayRow {
  const t = sleepDayTotals(sessions, date, zone, nowMs === undefined ? {} : { nowMs });
  return {
    date,
    lengthHours: 24,
    totalMs: t.totalMs,
    napMs: t.napMs,
    nightMs: t.nightMs,
    napCount: t.napCount,
    nightCount: t.nightCount,
    hasData: t.totalMs > 0,
    complete: t.complete,
  };
}

/**
 * Resumen para la pestaña Estadísticas. Los promedios usan SOLO días completos con
 * datos (no se rellenan los vacíos con ceros) y declaran cuántos días hay. Los
 * totales son por «día de sueño»: de la primera siesta al despertar de la noche siguiente.
 */
export function buildOverview(input: OverviewInput): Overview {
  const { sessions, attempts, zone, nowMs, days } = input;
  const todayDate = localDate(nowMs, zone);

  const dates: string[] = [];
  let cursor = todayDate;
  for (let i = 0; i < days; i++) {
    cursor = localDate(naturalDayWindow(cursor, zone).startMs - 1, zone);
    dates.unshift(cursor);
  }
  const series = dates.map((d) => dayRow(sessions, d, zone, undefined));
  const withData = series.filter((d) => d.hasData && d.complete);
  const napDays = withData.filter((d) => d.napCount > 0);
  const nightDays = withData.filter((d) => d.nightCount > 0);
  const today = dayRow(sessions, todayDate, zone, nowMs);

  const rangeStart = naturalDayWindow(dates[0] ?? todayDate, zone).startMs;
  const active = activeSessions(sessions);
  const inRange = active.filter((s) => parseInstant(s.sleep_start_utc) >= rangeStart);
  const closed = inRange.filter((s) => s.sleep_end_utc !== null);
  const dur = (s: SleepSessionT) => recordedDurationMs(s) as number;

  const attemptById = new Map(attempts.map((a) => [a.id, a]));
  const latencyOpts =
    input.latencyReviewThresholdMs === undefined ? {} : { reviewThresholdMs: input.latencyReviewThresholdMs };
  const latencies: LatencyResult[] = closed.map((s) =>
    settlingLatency(s.settling_attempt_id === null ? null : (attemptById.get(s.settling_attempt_id) ?? null), s, {
      reviewThresholdMs: DEFAULT_LATENCY_REVIEW_THRESHOLD_MS,
      ...latencyOpts,
    }),
  );

  const { spans, anomalies } = buildSpans(inRange, { nowMs });
  return {
    days,
    series,
    today,
    daysWithData: withData.length,
    meanDailyTotalMs: mean(withData.map((d) => d.totalMs)),
    meanNapTotalMs: mean(napDays.map((d) => d.napMs)),
    meanNightTotalMs: mean(nightDays.map((d) => d.nightMs)),
    napDays: napDays.length,
    nightDays: nightDays.length,
    meanNapsPerDay: mean(withData.map((d) => d.napCount)),
    medianNapMs: median(closed.filter((s) => s.sleep_type === 'nap').map(dur)),
    medianNightMs: median(closed.filter((s) => s.sleep_type === 'night').map(dur)),
    latency: summarizeLatency(latencies),
    quality: {
      openSessions: inRange.filter((s) => s.sleep_end_utc === null).length,
      overlapsPending: findOverlaps(spans).length,
      anomalies: anomalies.length,
      approxTimes: closed.filter((s) => s.start_quality === 'approx' || s.end_quality === 'approx').length,
      sessionsInRange: closed.length,
      awakeningsUnknown: closed.filter((s) => s.awakenings_completeness === 'unknown').length,
    },
  };
}
