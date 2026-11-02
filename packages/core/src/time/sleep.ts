import type { SleepSessionT } from '@babysleep/contract';
import { clip, intersect, intervalLength, mergeIntervals, unionLength, type Interval } from './interval';
import {
  localDate,
  naturalDayWindow,
  parseInstant,
  rolling24hWindow,
  MS_PER_24H,
  MS_PER_MIN,
  type EpochMs,
} from './zone';

/**
 * Subconjunto de `SleepSession` que necesita el núcleo. Los campos opcionales
 * permiten construir entradas mínimas en pruebas y en el cliente.
 */
export type SessionInput = Pick<SleepSessionT, 'id' | 'sleep_start_utc' | 'sleep_end_utc' | 'sleep_type'> & {
  baby_id?: string;
  deleted_at?: string | null;
  merged_into?: string | null;
};

export type SleepKind = 'nap' | 'night';

export interface SessionSpan {
  id: string;
  type: SleepKind;
  interval: Interval;
  /** `true` si la sesión seguía abierta y se cerró virtualmente en `nowMs`. */
  open: boolean;
}

export type AnomalyKind = 'non_positive_duration' | 'exceeds_24h';
export interface SessionAnomaly {
  id: string;
  kind: AnomalyKind;
}

export interface OverlapPair {
  a: string;
  b: string;
  overlapMs: number;
  /** Inicios dentro de la tolerancia: probable registro duplicado de dos cuidadores. */
  probableDuplicate: boolean;
  /** Los solapes nunca se resuelven solos: quedan pendientes de revisión. */
  status: 'pending_review';
}

export interface SpanOptions {
  /** Si se indica, las sesiones abiertas se cierran virtualmente en este instante. */
  nowMs?: EpochMs;
  /** Tolerancia de inicio para marcar un solape como probable duplicado (por defecto 5 min). */
  duplicateStartToleranceMs?: number;
}

export const DEFAULT_DUPLICATE_START_TOLERANCE_MS = 5 * MS_PER_MIN;

/**
 * Sesiones que cuentan para los totales: se excluyen las eliminadas (borrado
 * lógico) y las fusionadas en otra. Ambas siguen existiendo en la base, de modo
 * que la trazabilidad se conserva.
 */
export function activeSessions<T extends SessionInput>(sessions: readonly T[]): T[] {
  return sessions.filter((s) => (s.deleted_at ?? null) === null && (s.merged_into ?? null) === null);
}

function assertSingleBaby(sessions: readonly SessionInput[]): void {
  const ids = new Set(sessions.map((s) => s.baby_id).filter((x): x is string => x !== undefined));
  if (ids.size > 1) throw new Error('Los totales de sueño no pueden mezclar sesiones de varios bebés');
}

export interface SpanBuild {
  spans: SessionSpan[];
  anomalies: SessionAnomaly[];
  /** Sesiones abiertas que no entran porque no se indicó `nowMs`. */
  openExcluded: string[];
}

export function buildSpans(sessions: readonly SessionInput[], opts: SpanOptions = {}): SpanBuild {
  assertSingleBaby(sessions);
  const spans: SessionSpan[] = [];
  const anomalies: SessionAnomaly[] = [];
  const openExcluded: string[] = [];
  for (const s of activeSessions(sessions)) {
    const start = parseInstant(s.sleep_start_utc);
    let end: EpochMs;
    let open = false;
    if (s.sleep_end_utc === null) {
      if (opts.nowMs === undefined) {
        openExcluded.push(s.id);
        continue;
      }
      end = opts.nowMs;
      open = true;
    } else {
      end = parseInstant(s.sleep_end_utc);
    }
    if (end <= start) {
      anomalies.push({ id: s.id, kind: 'non_positive_duration' });
      continue;
    }
    if (end - start > MS_PER_24H) anomalies.push({ id: s.id, kind: 'exceeds_24h' });
    spans.push({ id: s.id, type: s.sleep_type, interval: { start, end }, open });
  }
  return { spans, anomalies, openExcluded };
}

/** Duración registrada de una sesión cerrada (`fin − inicio`), sin tocar nada más. */
export function recordedDurationMs(s: Pick<SessionInput, 'sleep_start_utc' | 'sleep_end_utc'>): number | null {
  if (s.sleep_end_utc === null) return null;
  return parseInstant(s.sleep_end_utc) - parseInstant(s.sleep_start_utc);
}

/**
 * Pares de sesiones solapadas. Tocarse (fin = inicio) no es solapar.
 * Se detectan con un barrido sobre los inicios ordenados.
 */
export function findOverlaps(spans: readonly SessionSpan[], toleranceMs = DEFAULT_DUPLICATE_START_TOLERANCE_MS): OverlapPair[] {
  const sorted = [...spans].sort((x, y) => x.interval.start - y.interval.start || x.interval.end - y.interval.end);
  const out: OverlapPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i] as SessionSpan;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j] as SessionSpan;
      if (b.interval.start >= a.interval.end) break;
      const inter = intersect(a.interval, b.interval);
      if (inter === null) continue;
      out.push({
        a: a.id,
        b: b.id,
        overlapMs: intervalLength(inter),
        probableDuplicate: Math.abs(a.interval.start - b.interval.start) <= toleranceMs,
        status: 'pending_review',
      });
    }
  }
  return out;
}

export interface SleepTotals {
  /** Unión de todos los intervalos: cada instante dormido cuenta una sola vez. */
  totalMs: number;
  napMs: number;
  nightMs: number;
  includesOpen: boolean;
  openExcluded: string[];
  anomalies: SessionAnomaly[];
  overlaps: OverlapPair[];
}

/**
 * Sueño dentro de una ventana: suma de intersecciones, con la UNIÓN de
 * intervalos para que dos cuidadores que registren lo mismo no dupliquen el total.
 * Las sesiones solapadas se devuelven como `overlaps` pendientes de revisión.
 */
export function sleepInWindow(sessions: readonly SessionInput[], window: Interval, opts: SpanOptions = {}): SleepTotals {
  const { spans, anomalies, openExcluded } = buildSpans(sessions, opts);
  const clipped = spans
    .map((s) => ({ span: s, interval: clip(s.interval, window) }))
    .filter((x): x is { span: SessionSpan; interval: Interval } => x.interval !== null);
  const inWindow = clipped.map((c) => c.span);
  return {
    totalMs: unionLength(clipped.map((c) => c.interval)),
    napMs: unionLength(clipped.filter((c) => c.span.type === 'nap').map((c) => c.interval)),
    nightMs: unionLength(clipped.filter((c) => c.span.type === 'night').map((c) => c.interval)),
    includesOpen: clipped.some((c) => c.span.open),
    openExcluded,
    anomalies,
    overlaps: findOverlaps(inWindow, opts.duplicateStartToleranceMs),
  };
}

// ---------------------------------------------------------- tres vistas distintas

/** (1) Día natural local: puede medir 23, 24 o 25 horas. */
export function naturalDayTotals(sessions: readonly SessionInput[], date: string, zone: string, opts: SpanOptions = {}) {
  const w = naturalDayWindow(date, zone);
  return {
    kind: 'natural_day' as const,
    date,
    zone,
    lengthHours: w.lengthHours,
    ...sleepInWindow(sessions, { start: w.startMs, end: w.endMs }, opts),
  };
}

/** (2) Ventana móvil de 24 horas reales que termina en `endMs`. */
export function rolling24hTotals(sessions: readonly SessionInput[], endMs: EpochMs, opts: SpanOptions = {}) {
  const w = rolling24hWindow(endMs);
  return { kind: 'rolling_24h' as const, lengthHours: 24, ...sleepInWindow(sessions, { start: w.startMs, end: w.endMs }, opts) };
}

export interface AttributedDay {
  kind: 'attributed_by_wake_date';
  date: string;
  /** Duraciones COMPLETAS de las sesiones atribuidas (no se parten por medianoche). */
  totalMs: number;
  napMs: number;
  nightMs: number;
  sessionIds: string[];
}

/**
 * (3) Atribución: la noche pertenece a la fecha local de su despertar; la siesta, a
 * la fecha local de su inicio. Es una etiqueta de agrupación: no recorta ni altera
 * ninguna duración. Las noches abiertas no tienen despertar y no se atribuyen.
 */
export function attributedTotals(
  sessions: readonly SessionInput[],
  zone: string,
  opts: SpanOptions = {},
): { days: AttributedDay[]; unattributed: string[]; anomalies: SessionAnomaly[] } {
  const { spans, anomalies, openExcluded } = buildSpans(sessions, opts);
  const groups = new Map<string, SessionSpan[]>();
  const unattributed = [...openExcluded];
  for (const s of spans) {
    if (s.type === 'night' && s.open) {
      unattributed.push(s.id);
      continue;
    }
    const date = localDate(s.type === 'night' ? s.interval.end : s.interval.start, zone);
    const g = groups.get(date);
    if (g === undefined) groups.set(date, [s]);
    else g.push(s);
  }
  const days = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, g]) => ({
      kind: 'attributed_by_wake_date' as const,
      date,
      totalMs: unionLength(g.map((s) => s.interval)),
      napMs: unionLength(g.filter((s) => s.type === 'nap').map((s) => s.interval)),
      nightMs: unionLength(g.filter((s) => s.type === 'night').map((s) => s.interval)),
      sessionIds: g.map((s) => s.id),
    }));
  return { days, unattributed, anomalies };
}

/** Intervalos disjuntos de sueño (unión) de un conjunto de sesiones; útil para ventanas de vigilia. */
export function sleepUnion(sessions: readonly SessionInput[], opts: SpanOptions = {}): Interval[] {
  return mergeIntervals(buildSpans(sessions, opts).spans.map((s) => s.interval));
}

/** Etiquetas visibles por defecto (español). Las claves son estables para i18n. */
export const METRIC_KIND_LABELS_ES = {
  natural_day: 'Día natural',
  rolling_24h: 'Ventana móvil de 24 h',
  attributed_by_wake_date: 'Noche atribuida a la fecha de despertar',
} as const;
