import { mean, median } from '../stats/descriptive';
import { activeSessions, buildSpans, type SessionInput, type SessionSpan, type SpanOptions } from './sleep';
import { MS_PER_HOUR, offsetMinutes, type EpochMs } from './zone';

/**
 * Posición de una ventana de vigilia respecto al sueño que la rodea:
 *  - `first`:   noche → primera siesta del día.
 *  - `between`: siesta → siesta.
 *  - `bedtime`: siesta → noche (la última ventana antes de acostarse).
 *  - `other`:   cualquier otra combinación (p. ej. noche → noche); se guarda pero no se promedia por posición.
 */
export type WakeWindowPosition = 'first' | 'between' | 'bedtime' | 'other';

export interface WakeWindow {
  /** Sueño que la abre (su fin) y el que la cierra (su inicio). */
  fromId: string;
  toId: string;
  startMs: EpochMs;
  endMs: EpochMs;
  durationMs: number;
  position: WakeWindowPosition;
  /** Orden (1, 2, …) dentro del día de sueño para `first` y `between`; `null` en el resto. */
  index: number | null;
}

/** Una ventana más larga que esto casi seguro esconde un sueño sin registrar: se excluye, no se promedia. */
export const DEFAULT_MAX_WAKE_WINDOW_MS = 8 * MS_PER_HOUR;

export interface WakeWindowBuild {
  windows: WakeWindow[];
  /** Huecos entre dos sueños demasiado largos para ser una ventana de vigilia (probable dato que falta). */
  tooLong: number;
  /** Pares de sueños que se solapan: no hay ventana que medir (se resuelven en la bandeja de solapes). */
  overlapping: number;
  /** Cada hueco descartado con el instante en que habría terminado, para atribuirlo a un periodo igual que las ventanas. */
  skipped: Array<{ endMs: EpochMs; kind: 'too_long' | 'overlap' }>;
}

export interface WakeWindowOptions extends SpanOptions {
  maxWindowMs?: number;
}

function position(a: SessionSpan, b: SessionSpan): WakeWindowPosition {
  if (a.type === 'night' && b.type === 'nap') return 'first';
  if (a.type === 'nap' && b.type === 'nap') return 'between';
  if (a.type === 'nap' && b.type === 'night') return 'bedtime';
  return 'other';
}

/**
 * Ventanas de vigilia: tiempo entre el fin de un sueño y el inicio del siguiente observado.
 * Solo se miden ventanas cuyos dos extremos se conocen: un sueño abierto no tiene fin, así que no
 * abre ventana; sí puede cerrarla (su inicio es conocido). Nada se rellena ni se interpola.
 */
export function wakeWindows(sessions: readonly SessionInput[], opts: WakeWindowOptions = {}): WakeWindowBuild {
  const maxMs = opts.maxWindowMs ?? DEFAULT_MAX_WAKE_WINDOW_MS;
  // Sin `nowMs` los sueños abiertos no entran; con él, se cierran virtualmente y NO abren ventana (ver abajo).
  const spans = buildSpans(sessions, opts).spans.sort((x, y) => x.interval.start - y.interval.start);
  const windows: WakeWindow[] = [];
  const skipped: WakeWindowBuild['skipped'] = [];
  let napIdx = 0;
  for (let i = 0; i < spans.length - 1; i++) {
    const a = spans[i] as SessionSpan;
    const b = spans[i + 1] as SessionSpan;
    if (a.type === 'night') napIdx = 0;
    if (a.open) continue;
    const gap = b.interval.start - a.interval.end;
    if (gap <= 0) {
      if (gap < 0) skipped.push({ endMs: b.interval.start, kind: 'overlap' });
      continue;
    }
    if (gap > maxMs) {
      skipped.push({ endMs: b.interval.start, kind: 'too_long' });
      continue;
    }
    const pos = position(a, b);
    let index: number | null = null;
    if (pos === 'first') index = napIdx = 1;
    else if (pos === 'between') index = ++napIdx;
    windows.push({ fromId: a.id, toId: b.id, startMs: a.interval.end, endMs: b.interval.start, durationMs: gap, position: pos, index });
  }
  return {
    windows,
    tooLong: skipped.filter((x) => x.kind === 'too_long').length,
    overlapping: skipped.filter((x) => x.kind === 'overlap').length,
    skipped,
  };
}

export interface WindowStats {
  n: number;
  meanMs: number | null;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export function windowStats(durations: readonly number[]): WindowStats {
  return {
    n: durations.length,
    meanMs: mean(durations),
    medianMs: median(durations),
    minMs: durations.length === 0 ? null : Math.min(...durations),
    maxMs: durations.length === 0 ? null : Math.max(...durations),
  };
}

export interface WakeWindowSummary {
  first: WindowStats;
  between: WindowStats;
  bedtime: WindowStats;
  /** Por orden dentro del día: 1.ª, 2.ª, … ventana entre siestas (la 1.ª es la de después de la noche). */
  byIndex: Array<{ index: number; stats: WindowStats }>;
  tooLong: number;
  overlapping: number;
}

export function summarizeWakeWindows(build: WakeWindowBuild): WakeWindowSummary {
  const of = (p: WakeWindowPosition) => windowStats(build.windows.filter((w) => w.position === p).map((w) => w.durationMs));
  const indices = [...new Set(build.windows.filter((w) => w.index !== null).map((w) => w.index as number))].sort((a, b) => a - b);
  return {
    first: of('first'),
    between: of('between'),
    bedtime: of('bedtime'),
    byIndex: indices.map((index) => ({ index, stats: windowStats(build.windows.filter((w) => w.index === index).map((w) => w.durationMs)) })),
    tooLong: build.tooLong,
    overlapping: build.overlapping,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Horas del día: estadística circular (23:50 y 00:10 están a 20 min, no a 23 h 40 min).
 * ---------------------------------------------------------------------------------------------- */

const MIN_PER_DAY = 1440;

/** Minutos desde la medianoche LOCAL (0–1439) de un instante en una zona. */
export function localMinuteOfDay(ms: EpochMs, zone: string): number {
  const total = Math.floor(ms / 60_000) + offsetMinutes(ms, zone);
  return ((total % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
}

export interface CircularStats {
  n: number;
  /** Hora media en minutos desde la medianoche (0–1439), o `null` si no hay datos o las horas se reparten sin dirección. */
  meanMinute: number | null;
  /** Desviación circular en minutos (cuanto menor, más regular), o `null` con menos de 2 datos. */
  sdMinutes: number | null;
}

export function circularStats(minutes: readonly number[]): CircularStats {
  const n = minutes.length;
  if (n === 0) return { n, meanMinute: null, sdMinutes: null };
  let s = 0;
  let c = 0;
  for (const m of minutes) {
    const ang = (2 * Math.PI * m) / MIN_PER_DAY;
    s += Math.sin(ang);
    c += Math.cos(ang);
  }
  s /= n;
  c /= n;
  const r = Math.hypot(s, c);
  // Con R casi 0 no hay hora «media» con sentido (horas repartidas por todo el reloj).
  if (r < 1e-9) return { n, meanMinute: null, sdMinutes: null };
  const meanAng = Math.atan2(s, c);
  const meanMinute = (((meanAng * MIN_PER_DAY) / (2 * Math.PI)) % MIN_PER_DAY + MIN_PER_DAY) % MIN_PER_DAY;
  const sd = n < 2 ? null : (Math.sqrt(-2 * Math.log(Math.min(1, r))) * MIN_PER_DAY) / (2 * Math.PI);
  return { n, meanMinute, sdMinutes: sd };
}

export interface DailyRhythm {
  /** Hora de acostarse: inicio de las noches. */
  bedtime: CircularStats;
  /** Hora de despertar de la mañana: fin de las noches cerradas. */
  wakeUp: CircularStats;
  /** Inicio de la primera siesta de cada día de sueño. */
  firstNap: CircularStats;
  /** Siestas por día de sueño: solo tramos completos, entre dos noches registradas (un día sin siestas cuenta 0). */
  napsPerDay: { n: number; mean: number | null; sd: number | null };
}

/**
 * Ritmo diario: hora de acostarse, de despertar y de la primera siesta, con su regularidad.
 * Solo usa sueños cerrados, para no tomar como «despertar» un fin que aún no existe.
 */
export function dailyRhythm(sessions: readonly SessionInput[], zone: string): DailyRhythm {
  const closed = activeSessions(sessions)
    .filter((s) => s.sleep_end_utc !== null)
    .sort((a, b) => Date.parse(a.sleep_start_utc) - Date.parse(b.sleep_start_utc));
  const nights = closed.filter((s) => s.sleep_type === 'night');
  const bed = nights.map((s) => localMinuteOfDay(Date.parse(s.sleep_start_utc), zone));
  const wake = nights.map((s) => localMinuteOfDay(Date.parse(s.sleep_end_utc as string), zone));

  // Un «día de sueño» de siestas es el tramo entre dos noches consecutivas; solo cuentan los tramos
  // cerrados por una noche posterior (no el día en curso, que aún puede ganar siestas).
  const firstNaps: number[] = [];
  const napCounts: number[] = [];
  let napsSince: SessionInput[] = [];
  let seenNight = false;
  for (const s of closed) {
    if (s.sleep_type === 'nap') {
      napsSince.push(s);
    } else {
      // El tramo anterior a la primera noche registrada puede estar recortado por el inicio de los datos.
      if (seenNight) {
        const first = napsSince[0];
        if (first !== undefined) firstNaps.push(localMinuteOfDay(Date.parse(first.sleep_start_utc), zone));
        napCounts.push(napsSince.length);
      }
      seenNight = true;
      napsSince = [];
    }
  }
  const m = mean(napCounts);
  let sd: number | null = null;
  if (m !== null && napCounts.length >= 2) {
    sd = Math.sqrt(napCounts.reduce((acc, x) => acc + (x - m) ** 2, 0) / (napCounts.length - 1));
  }
  return {
    bedtime: circularStats(bed),
    wakeUp: circularStats(wake),
    firstNap: circularStats(firstNaps),
    napsPerDay: { n: napCounts.length, mean: m, sd },
  };
}
