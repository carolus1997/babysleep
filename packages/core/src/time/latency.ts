import type { SettlingAttemptT, SleepSessionT, TimeQualityT } from '@babysleep/contract';
import { iqr, mean, median, quantile, sampleSd } from '../stats/descriptive';
import { MS_PER_HOUR, parseInstant } from './zone';

export const DEFAULT_LATENCY_REVIEW_THRESHOLD_MS = 3 * MS_PER_HOUR;

export type LatencyResult =
  | { status: 'ok'; ms: number; quality: TimeQualityT }
  /** Supera el umbral de revisión: se conserva el valor, pero no entra en resúmenes. */
  | { status: 'needs_review'; ms: number; quality: TimeQualityT }
  /** Sin inicio de intento registrado: la latencia es DESCONOCIDA, nunca cero. */
  | { status: 'unknown'; reason: 'no_attempt' | 'no_attempt_start' }
  /** El intento figura después del sueño observado: dato incoherente. */
  | { status: 'anomaly'; reason: 'attempt_after_sleep' };

export interface LatencyOptions {
  reviewThresholdMs?: number;
}

/**
 * Latencia de conciliación = inicio del sueño observado − inicio del intento.
 *
 * La hora de colocación en la cuna NO interviene. Si algún extremo es aproximado,
 * el resultado hereda la calidad `approx`. Una calidad ausente en un extremo
 * presente se trata como `approx` (no se afirma exactitud sin constancia).
 */
export function settlingLatency(
  attempt: Pick<SettlingAttemptT, 'started_utc' | 'started_quality'> | null | undefined,
  session: Pick<SleepSessionT, 'sleep_start_utc' | 'start_quality'>,
  opts: LatencyOptions = {},
): LatencyResult {
  if (attempt === null || attempt === undefined) return { status: 'unknown', reason: 'no_attempt' };
  if (attempt.started_utc === null) return { status: 'unknown', reason: 'no_attempt_start' };

  const ms = parseInstant(session.sleep_start_utc) - parseInstant(attempt.started_utc);
  if (ms < 0) return { status: 'anomaly', reason: 'attempt_after_sleep' };

  const quality: TimeQualityT =
    session.start_quality === 'exact' && attempt.started_quality === 'exact' ? 'exact' : 'approx';
  const threshold = opts.reviewThresholdMs ?? DEFAULT_LATENCY_REVIEW_THRESHOLD_MS;
  return ms > threshold ? { status: 'needs_review', ms, quality } : { status: 'ok', ms, quality };
}

export interface LatencySummary {
  /** Latencias válidas que entran en el resumen. */
  n: number;
  excluded: { unknown: number; needs_review: number; anomaly: number };
  meanMs: number | null;
  medianMs: number | null;
  q1Ms: number | null;
  q3Ms: number | null;
  iqrMs: number | null;
  /** Desviación estándar muestral; requiere n ≥ 2. */
  sdMs: number | null;
  /** Cuántas de las latencias válidas tienen calidad aproximada. */
  approxCount: number;
}

/** Resume solo las latencias `ok`. Los casos dudosos se cuentan, no se mezclan. */
export function summarizeLatency(results: readonly LatencyResult[]): LatencySummary {
  const ok = results.filter((r): r is Extract<LatencyResult, { status: 'ok' }> => r.status === 'ok');
  const values = ok.map((r) => r.ms);
  return {
    n: values.length,
    excluded: {
      unknown: results.filter((r) => r.status === 'unknown').length,
      needs_review: results.filter((r) => r.status === 'needs_review').length,
      anomaly: results.filter((r) => r.status === 'anomaly').length,
    },
    meanMs: mean(values),
    medianMs: median(values),
    q1Ms: quantile(values, 0.25),
    q3Ms: quantile(values, 0.75),
    iqrMs: iqr(values),
    sdMs: sampleSd(values),
    approxCount: ok.filter((r) => r.quality === 'approx').length,
  };
}
