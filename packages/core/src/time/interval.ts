import type { EpochMs } from './zone';

/** Intervalo semiabierto `[start, end)` en instantes. */
export interface Interval {
  start: EpochMs;
  end: EpochMs;
}

export const intervalLength = (i: Interval): number => i.end - i.start;

/** Intersección de dos intervalos, o `null` si no se solapan. Tocarse no es solapar. */
export function intersect(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

export function overlapLength(a: Interval, b: Interval): number {
  const i = intersect(a, b);
  return i === null ? 0 : intervalLength(i);
}

/** Recorta `i` a la ventana `w`. */
export const clip = (i: Interval, w: Interval): Interval | null => intersect(i, w);

/** Unión de intervalos: lista ordenada de intervalos disjuntos (se fusionan los que se tocan). */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list
    .filter((i) => i.end > i.start)
    .map((i) => ({ ...i }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** Duración total de la unión: cada instante cuenta una sola vez. */
export function unionLength(list: readonly Interval[]): number {
  return mergeIntervals(list).reduce((acc, i) => acc + intervalLength(i), 0);
}
