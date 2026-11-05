import type { AwakeningT, BabyT, FeedingT, SleepSessionT } from '@babysleep/contract';
import { ageDays, analyzeFeeding, correctedAgeDays, MS_PER_24H, quantile } from '@babysleep/core';
import { buildOverview } from './overview';
import { buildRhythm } from './rhythm';

/** Una semana con menos días con datos que esto no se dibuja: un promedio así engañaría. */
export const MIN_DAYS_PER_WEEK = 3;
export const DEFAULT_WEEKS = 8;

export interface WeekRow {
  /** Fin de la semana (instante); cada semana son 7 días consecutivos hacia atrás desde aquí. */
  endMs: number;
  /** Edad en semanas cumplidas al final de la semana (cronológica) y, en prematuros, la corregida. */
  ageWeeks: number;
  correctedWeeks: number | null;
  /** Días completos con datos de sueño (de 7). */
  daysWithData: number;
  /** `false` si hay menos de `MIN_DAYS_PER_WEEK` días con datos: las medias de la semana van a `null`. */
  enough: boolean;
  meanTotalMs: number | null;
  /** Primer y tercer cuartil (tipo 7) de los totales diarios de la semana. */
  q1TotalMs: number | null;
  q3TotalMs: number | null;
  meanNapMs: number | null;
  meanNightMs: number | null;
  napsPerDay: number | null;
  /** Ventana de vigilia media entre siestas y número de ventanas medidas. */
  meanBetweenWindowMs: number | null;
  betweenWindowN: number;
  feedsPerDay: number | null;
}

export interface TrendsInput {
  baby: Pick<BabyT, 'birth_date' | 'gestational_weeks'>;
  sessions: readonly SleepSessionT[];
  feedings: readonly FeedingT[];
  awakenings?: readonly AwakeningT[];
  awakeningThresholdMs?: number;
  zone: string;
  nowMs: number;
  weeks?: number;
}

/**
 * Evolución semana a semana del propio bebé, de la más antigua a la más reciente. NO compara con otros bebés ni con
 * tablas de referencia: describe cómo cambia el suyo con la edad. Cada semana usa solo días completos con datos.
 */
export function buildTrends(input: TrendsInput): WeekRow[] {
  const weeks = input.weeks ?? DEFAULT_WEEKS;
  const rows: WeekRow[] = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const endMs = input.nowMs - k * 7 * MS_PER_24H;
    const o = buildOverview({
      sessions: input.sessions,
      attempts: [],
      awakenings: input.awakenings ?? [],
      ...(input.awakeningThresholdMs === undefined ? {} : { awakeningThresholdMs: input.awakeningThresholdMs }),
      zone: input.zone,
      nowMs: endMs,
      days: 7,
    });
    const enough = o.daysWithData >= MIN_DAYS_PER_WEEK;
    const totals = o.series.filter((d) => d.hasData && d.complete).map((d) => d.totalMs);
    const r = buildRhythm({ sessions: input.sessions, zone: input.zone, nowMs: endMs, days: 7 }).current.windows.between;
    const f = analyzeFeeding({ feedings: input.feedings, sessions: input.sessions, zone: input.zone, fromMs: endMs - 7 * MS_PER_24H, toMs: endMs + 1, nowMs: endMs });
    const corrected = correctedAgeDays(input.baby.birth_date, input.baby.gestational_weeks, endMs);
    rows.push({
      endMs,
      ageWeeks: Math.floor(ageDays(input.baby.birth_date, endMs) / 7),
      correctedWeeks: corrected === null ? null : Math.floor(corrected / 7),
      daysWithData: o.daysWithData,
      enough,
      meanTotalMs: enough ? o.meanDailyTotalMs : null,
      q1TotalMs: enough ? quantile(totals, 0.25) : null,
      q3TotalMs: enough ? quantile(totals, 0.75) : null,
      meanNapMs: enough ? o.meanNapTotalMs : null,
      meanNightMs: enough ? o.meanNightTotalMs : null,
      napsPerDay: enough ? o.meanNapsPerDay : null,
      meanBetweenWindowMs: r.n >= MIN_DAYS_PER_WEEK ? r.meanMs : null,
      betweenWindowN: r.n,
      feedsPerDay: f.daysObserved >= MIN_DAYS_PER_WEEK ? f.meanPerDay : null,
    });
  }
  return rows;
}
