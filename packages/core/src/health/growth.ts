import { correctedAgeDays } from '../time/age';
import { HCFA_GIRLS, LFA_GIRLS, WFA_GIRLS, type LmsTable } from './whoGirlsData';

/**
 * Crecimiento: peso, longitud/talla y perímetro cefálico frente a los estándares de la OMS (niñas, 0 a 5 años).
 *
 * Solo HECHOS: dónde cae una medida respecto a la referencia (puntuación z y percentil) y cómo ha cambiado entre
 * medidas. Nada de «normal»/«anormal»: la interpretación es del pediatra. Los estándares de la OMS describen cómo
 * crecen niños alimentados según las recomendaciones, no son un diagnóstico.
 */

export type GrowthKind = 'weight' | 'length' | 'head';
export const GROWTH_KINDS: readonly GrowthKind[] = ['weight', 'length', 'head'];

export const WHO_SOURCE = {
  name: 'OMS · Estándares de crecimiento infantil (2006), niñas de 0 a 5 años',
  url: 'https://www.who.int/tools/child-growth-standards/standards',
} as const;

const DAYS_PER_MONTH = 30.4375;

/** Tabla de la OMS de cada medida (la de talla puede no estar cargada todavía). */
export const tableFor = (kind: GrowthKind): LmsTable | null => (kind === 'weight' ? WFA_GIRLS : kind === 'head' ? HCFA_GIRLS : LFA_GIRLS);

const lastAgeDays = (t: LmsTable): number => (t.unit === 'day' ? t.first + t.M.length - 1 : Math.floor((t.first + t.M.length - 1) * DAYS_PER_MONTH));

/** Edad máxima (en días) para la que hay referencia, o `null` si la tabla no está cargada. */
export function maxReferenceDays(kind: GrowthKind): number | null {
  const t = tableFor(kind);
  return t === null ? null : lastAgeDays(t);
}

export interface Lms {
  L: number;
  M: number;
  S: number;
}

/** L, M y S a una edad en días (interpolación lineal entre renglones de la tabla mensual). `null` fuera de rango. */
export function lmsAt(kind: GrowthKind, ageDays: number): Lms | null {
  const t = tableFor(kind);
  if (t === null || !Number.isFinite(ageDays) || ageDays < 0 || ageDays > lastAgeDays(t)) return null;
  const pos = t.unit === 'day' ? ageDays - t.first : ageDays / DAYS_PER_MONTH - t.first;
  const i0 = Math.min(Math.floor(pos), t.M.length - 1);
  const i1 = Math.min(i0 + 1, t.M.length - 1);
  const f = pos - i0;
  const mix = (a: readonly number[]): number => (a[i0] as number) * (1 - f) + (a[i1] as number) * f;
  return { L: mix(t.L), M: mix(t.M), S: mix(t.S) };
}

/** Puntuación z con el método LMS de la OMS. */
export function zScore(value: number, { L, M, S }: Lms): number {
  return Math.abs(L) < 1e-9 ? Math.log(value / M) / S : ((value / M) ** L - 1) / (L * S);
}

/** Valor de la medida que corresponde a una puntuación z (para dibujar las curvas). */
export function valueAtZ(z: number, { L, M, S }: Lms): number {
  return Math.abs(L) < 1e-9 ? M * Math.exp(S * z) : M * (1 + L * S * z) ** (1 / L);
}

/** Función de distribución normal estándar (Abramowitz-Stegun 7.1.26, error < 1,5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Percentil (0-100) de una puntuación z. */
export const percentileOfZ = (z: number): number => normalCdf(z) * 100;

/** Percentiles que se dibujan como curvas. */
export const CURVE_PERCENTILES = [3, 15, 50, 85, 97] as const;
const Z_OF_PERCENTILE: Record<(typeof CURVE_PERCENTILES)[number], number> = { 3: -1.880793608, 15: -1.036433389, 50: 0, 85: 1.036433389, 97: 1.880793608 };

/** Unidad en que se guarda y en que se muestra cada medida. */
export const GROWTH_UNIT: Record<GrowthKind, { stored: 'g' | 'mm'; shown: 'kg' | 'cm' }> = {
  weight: { stored: 'g', shown: 'kg' },
  length: { stored: 'mm', shown: 'cm' },
  head: { stored: 'mm', shown: 'cm' },
};

/** Valor guardado (g o mm) → valor de referencia de la OMS (kg o cm). */
export const toReference = (kind: GrowthKind, stored: number): number => (kind === 'weight' ? stored / 1000 : stored / 10);

export interface GrowthMeasureInput {
  measuredOn: string;
  weightG: number | null;
  lengthMm: number | null;
  headMm: number | null;
}

export interface GrowthPoint {
  kind: GrowthKind;
  /** Fecha civil de la medida. */
  on: string;
  /** Valor de referencia (kg o cm). */
  value: number;
  /** Edad usada para situar la medida, en días. */
  ageDays: number;
  /** `true` si la edad es la CORREGIDA (prematuro). */
  corrected: boolean;
  /** Puntuación z y percentil, o `null` si no hay referencia (talla sin cargar, o más de 5 años). */
  z: number | null;
  percentile: number | null;
}

export interface BabyForGrowth {
  birth_date: string;
  gestational_weeks?: number | null;
}

const midnight = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** Edad en días a la fecha de la medida: la corregida si es prematura y procede, si no la cronológica. */
export function ageForMeasure(baby: BabyForGrowth, on: string): { days: number; corrected: boolean } | null {
  const chrono = Math.floor((midnight(on) - midnight(baby.birth_date)) / 86_400_000);
  if (chrono < 0) return null;
  const corr = correctedAgeDays(baby.birth_date, baby.gestational_weeks ?? null, midnight(on));
  // Una corregida negativa (aún no ha llegado a la fecha prevista de parto) no tiene referencia en la tabla: se usa 0.
  return corr === null ? { days: chrono, corrected: false } : { days: Math.max(0, corr), corrected: true };
}

/** Puntos (uno por medida anotada) de una lista de visitas. */
export function growthPoints(baby: BabyForGrowth, rows: readonly GrowthMeasureInput[]): GrowthPoint[] {
  const out: GrowthPoint[] = [];
  for (const r of rows) {
    const age = ageForMeasure(baby, r.measuredOn);
    if (age === null) continue;
    const vals: Array<[GrowthKind, number | null]> = [
      ['weight', r.weightG],
      ['length', r.lengthMm],
      ['head', r.headMm],
    ];
    for (const [kind, stored] of vals) {
      if (stored === null) continue;
      const value = toReference(kind, stored);
      const lms = lmsAt(kind, age.days);
      const z = lms === null ? null : zScore(value, lms);
      out.push({ kind, on: r.measuredOn, value, ageDays: age.days, corrected: age.corrected, z, percentile: z === null ? null : percentileOfZ(z) });
    }
  }
  return out.sort((a, b) => a.on.localeCompare(b.on));
}

export interface CurveSet {
  kind: GrowthKind;
  /** Una curva por percentil: pares [edad en días, valor de referencia]. */
  curves: Array<{ percentile: (typeof CURVE_PERCENTILES)[number]; points: Array<[number, number]> }>;
}

/** Curvas de referencia entre dos edades (en días), `null` si la tabla de esa medida no está cargada. */
export function referenceCurves(kind: GrowthKind, fromDays: number, toDays: number, stepDays = 7): CurveSet | null {
  const max = maxReferenceDays(kind);
  if (max === null) return null;
  const hi = Math.min(toDays, max);
  const curves = CURVE_PERCENTILES.map((p) => {
    const points: Array<[number, number]> = [];
    for (let d = Math.max(0, fromDays); d <= hi; d += stepDays) {
      const lms = lmsAt(kind, d) as Lms;
      points.push([d, valueAtZ(Z_OF_PERCENTILE[p], lms)]);
    }
    return { percentile: p, points };
  });
  return { kind, curves };
}

export interface GrowthChange {
  kind: GrowthKind;
  from: GrowthPoint;
  to: GrowthPoint;
  days: number;
  /** Diferencia de valor (kg o cm). */
  delta: number;
  /** Cambio de percentil en puntos; `null` si falta alguna referencia. */
  percentileChange: number | null;
}

/** Cambio entre cada par de medidas consecutivas de la misma magnitud. Solo hechos, sin interpretar. */
export function growthChanges(points: readonly GrowthPoint[]): GrowthChange[] {
  const out: GrowthChange[] = [];
  for (const kind of GROWTH_KINDS) {
    const list = points.filter((p) => p.kind === kind).sort((a, b) => a.on.localeCompare(b.on));
    for (let i = 1; i < list.length; i++) {
      const from = list[i - 1] as GrowthPoint;
      const to = list[i] as GrowthPoint;
      out.push({
        kind,
        from,
        to,
        days: Math.round((midnight(to.on) - midnight(from.on)) / 86_400_000),
        delta: to.value - from.value,
        percentileChange: from.percentile === null || to.percentile === null ? null : to.percentile - from.percentile,
      });
    }
  }
  return out.sort((a, b) => a.to.on.localeCompare(b.to.on));
}
