/**
 * Estadística descriptiva básica.
 *
 * Los cuantiles usan el método lineal de tipo 7 (el predeterminado de numpy),
 * fijado para que los resultados coincidan con los fixtures dorados generados
 * con numpy en `tools/oracle-py`.
 */

export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : sum(xs) / xs.length;
}

/** Cuantil de tipo 7, `q` en [0, 1]. Devuelve `null` si no hay datos. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (q < 0 || q > 1) throw new RangeError('q debe estar en [0, 1]');
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = s[lo] as number;
  const b = s[hi] as number;
  return a + (h - lo) * (b - a);
}

export const median = (xs: readonly number[]): number | null => quantile(xs, 0.5);

/** Varianza muestral (ddof = 1). Requiere al menos 2 datos. */
export function sampleVariance(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
}

export function sampleSd(xs: readonly number[]): number | null {
  const v = sampleVariance(xs);
  return v === null ? null : Math.sqrt(v);
}

export function iqr(xs: readonly number[]): number | null {
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  return q1 === null || q3 === null ? null : q3 - q1;
}

/** Formatea segundos como `H h MM min SS s` (sin redondear, para comparar con los esperados). */
export function formatHms(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? '-' : '';
  const t = Math.round(Math.abs(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${sign}${h} h ${String(m).padStart(2, '0')} min ${String(s).padStart(2, '0')} s`;
}
