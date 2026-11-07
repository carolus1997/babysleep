import { describe, expect, it } from 'vitest';
import {
  ageForMeasure,
  growthChanges,
  growthPoints,
  lmsAt,
  maxReferenceDays,
  normalCdf,
  percentileOfZ,
  referenceCurves,
  toReference,
  valueAtZ,
  zScore,
} from '../src/index';
import { HCFA_GIRLS, WFA_GIRLS } from '../src/health/whoGirlsData';

describe('tablas de la OMS cargadas', () => {
  it('peso: un renglón por día, de 0 a 1856, y valores publicados al nacer', () => {
    expect(WFA_GIRLS.M).toHaveLength(1857);
    expect(WFA_GIRLS.L[0]).toBeCloseTo(0.3809, 4);
    expect(WFA_GIRLS.M[0]).toBeCloseTo(3.2322, 4);
    expect(WFA_GIRLS.S[0]).toBeCloseTo(0.14171, 5);
  });
  it('perímetro cefálico: un renglón por mes, de 0 a 60', () => {
    expect(HCFA_GIRLS.M).toHaveLength(61);
    expect(HCFA_GIRLS.M[0]).toBeCloseTo(33.8787, 4);
    expect(HCFA_GIRLS.S[0]).toBeCloseTo(0.03496, 5);
    expect(HCFA_GIRLS.L.every((l) => l === 1)).toBe(true);
  });
  it('la talla aún no está cargada: sin referencia, sin curva', () => {
    expect(maxReferenceDays('length')).toBeNull();
    expect(lmsAt('length', 100)).toBeNull();
    expect(referenceCurves('length', 0, 365)).toBeNull();
  });
});

describe('LMS → z y percentil', () => {
  it('reproduce las columnas de desviaciones estándar que publica la OMS (peso, día 0 y día 1856)', () => {
    const d0 = lmsAt('weight', 0)!;
    expect(zScore(2.395, d0)).toBeCloseTo(-2, 1);
    expect(zScore(4.23, d0)).toBeCloseTo(2, 1);
    const d1856 = lmsAt('weight', 1856)!;
    expect(zScore(13.854, d1856)).toBeCloseTo(-2, 1);
    expect(zScore(25.19, d1856)).toBeCloseTo(2, 1);
  });
  it('la mediana es z 0 y percentil 50; valueAtZ es la inversa de zScore', () => {
    const lms = lmsAt('weight', 120)!;
    expect(zScore(lms.M, lms)).toBeCloseTo(0, 10);
    expect(percentileOfZ(0)).toBeCloseTo(50, 6);
    for (const z of [-2.5, -1, 0, 0.7, 2]) expect(zScore(valueAtZ(z, lms), lms)).toBeCloseTo(z, 8);
    const hc = lmsAt('head', 30.4375)!; // 1 mes
    expect(hc.M).toBeCloseTo(36.5463, 3);
  });
  it('distribución normal: valores conocidos', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(percentileOfZ(1.036433389)).toBeCloseTo(85, 2);
  });
  it('interpola entre meses del perímetro cefálico y rechaza fuera de rango', () => {
    const mid = lmsAt('head', 30.4375 * 1.5)!;
    expect(mid.M).toBeCloseTo((36.5463 + 38.2521) / 2, 3);
    expect(lmsAt('weight', -1)).toBeNull();
    expect(lmsAt('weight', 1857)).toBeNull();
    expect(lmsAt('head', 1827)).toBeNull();
    expect(lmsAt('weight', Number.NaN)).toBeNull();
  });
});

describe('edad usada para situar una medida', () => {
  it('a término: edad cronológica', () => {
    expect(ageForMeasure({ birth_date: '2026-07-01' }, '2026-11-01')).toEqual({ days: 123, corrected: false });
    expect(ageForMeasure({ birth_date: '2026-07-01', gestational_weeks: 39 }, '2026-11-01')).toEqual({ days: 123, corrected: false });
  });
  it('prematura: edad corregida; si todavía no ha llegado a la fecha prevista, se usa 0', () => {
    expect(ageForMeasure({ birth_date: '2026-07-01', gestational_weeks: 32 }, '2026-11-01')).toEqual({ days: 123 - 56, corrected: true });
    expect(ageForMeasure({ birth_date: '2026-07-01', gestational_weeks: 28 }, '2026-08-01')).toEqual({ days: 0, corrected: true });
  });
  it('medida anterior al nacimiento: no vale', () => {
    expect(ageForMeasure({ birth_date: '2026-07-01' }, '2026-06-30')).toBeNull();
  });
});

describe('puntos, cambios y curvas', () => {
  const baby = { birth_date: '2026-07-01', gestational_weeks: 40 };
  const rows = [
    { measuredOn: '2026-10-01', weightG: 5600, lengthMm: 600, headMm: 400 },
    { measuredOn: '2026-07-01', weightG: 3300, lengthMm: null, headMm: 340 },
    { measuredOn: '2026-08-01', weightG: 4300, lengthMm: null, headMm: null },
  ];
  it('una medida por magnitud anotada, ordenadas por fecha; unknown no es 0', () => {
    const pts = growthPoints(baby, rows);
    expect(pts.map((p) => `${p.on}:${p.kind}`)).toEqual(['2026-07-01:weight', '2026-07-01:head', '2026-08-01:weight', '2026-10-01:weight', '2026-10-01:length', '2026-10-01:head']);
    const w0 = pts[0]!;
    expect(w0.value).toBeCloseTo(3.3, 6);
    expect(w0.ageDays).toBe(0);
    expect(w0.z).toBeGreaterThan(0); // 3,3 kg al nacer está por encima de la mediana de 3,23
    expect(w0.percentile).toBeGreaterThan(50);
    const len = pts.find((p) => p.kind === 'length')!;
    expect(len.z).toBeNull();
    expect(len.percentile).toBeNull();
  });
  it('cambios entre medidas consecutivas de la misma magnitud', () => {
    const ch = growthChanges(growthPoints(baby, rows)).filter((c) => c.kind === 'weight');
    expect(ch).toHaveLength(2);
    expect(ch[0]).toMatchObject({ days: 31 });
    expect(ch[0]!.delta).toBeCloseTo(1.0, 6);
    expect(ch[1]!.delta).toBeCloseTo(1.3, 6);
    expect(ch[0]!.percentileChange).not.toBeNull();
  });
  it('las curvas de referencia suben con la edad y están ordenadas por percentil', () => {
    const set = referenceCurves('weight', 0, 365)!;
    expect(set.curves.map((c) => c.percentile)).toEqual([3, 15, 50, 85, 97]);
    for (const c of set.curves) for (let i = 1; i < c.points.length; i++) expect(c.points[i]![1]).toBeGreaterThan(c.points[i - 1]![1]);
    const at = (p: number, i: number) => set.curves.find((c) => c.percentile === p)!.points[i]![1];
    for (const i of [0, 10, 30]) expect(at(3, i)).toBeLessThan(at(50, i));
    expect(at(50, 0)).toBeCloseTo(3.2322, 3);
  });
  it('conversión de unidades guardadas', () => {
    expect(toReference('weight', 5600)).toBe(5.6);
    expect(toReference('head', 405)).toBe(40.5);
  });
});
