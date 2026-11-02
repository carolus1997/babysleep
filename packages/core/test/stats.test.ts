import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatHms, iqr, mean, median, quantile, sampleSd, sampleVariance, summarizeAggregate } from '../src';

const fx = (rel: string): string => fileURLToPath(new URL(`../../../tests/fixtures/${rel}`, import.meta.url));
const readJson = (rel: string) => JSON.parse(readFileSync(fx(rel), 'utf8'));

describe('estadística descriptiva frente al oráculo numpy', () => {
  const golden = readJson('golden/stats-golden.json') as {
    quantile_points: number[];
    cases: Record<string, { values: number[]; mean: number; quantiles: number[]; variance: number | null; sd: number | null }>;
  };

  for (const [name, c] of Object.entries(golden.cases)) {
    it(`caso «${name}»`, () => {
      expect(mean(c.values)).toBeCloseTo(c.mean, 9);
      golden.quantile_points.forEach((q, i) => expect(quantile(c.values, q)).toBeCloseTo(c.quantiles[i] as number, 9));
      if (c.variance === null) {
        expect(sampleVariance(c.values)).toBeNull();
        expect(sampleSd(c.values)).toBeNull();
      } else {
        expect(sampleVariance(c.values)).toBeCloseTo(c.variance, 9);
        expect(sampleSd(c.values)).toBeCloseTo(c.sd as number, 9);
      }
    });
  }

  it('sin datos devuelve null', () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
    expect(quantile([], 0.5)).toBeNull();
    expect(iqr([])).toBeNull();
  });

  it('q fuera de [0,1] lanza error', () => {
    expect(() => quantile([1, 2], 1.1)).toThrow();
  });
});

describe('resumen de agregados (sintético, resultados calculados a mano)', () => {
  const fixture = readJson('synthetic/aggregate-three-days.json');
  const s = summarizeAggregate(fixture.periods);
  it.each(Object.entries(fixture.expected as Record<string, number>))('%s', (key, value) => {
    expect((s as unknown as Record<string, number>)[key]).toBeCloseTo(value, 9);
  });
});

describe('formato de duraciones', () => {
  it('formatea H h MM min SS s', () => {
    expect(formatHms(41808)).toBe('11 h 36 min 48 s');
    expect(formatHms(58296)).toBe('16 h 11 min 36 s');
    expect(formatHms(0)).toBe('0 h 00 min 00 s');
  });
});

// Datos reales: solo existen en el equipo local (carpeta ignorada por git). En CI se omite.
const privatePath = fx('private/five-days-aggregate.json');
describe.skipIf(!existsSync(privatePath))('cinco días reales agregados (privado, solo local)', () => {
  const fixture = existsSync(privatePath) ? readJson('private/five-days-aggregate.json') : null;

  it('reproduce los resultados esperados del documento', () => {
    const s = summarizeAggregate(fixture.periods);
    for (const [k, v] of Object.entries(fixture.expected as Record<string, number>)) {
      expect((s as unknown as Record<string, number>)[k]).toBeCloseTo(v, 9);
    }
  });

  it('coincide con los textos del documento maestro', () => {
    const s = summarizeAggregate(fixture.periods);
    expect(formatHms(s.nightMeanS as number)).toBe('11 h 36 min 48 s');
    expect(formatHms(s.napMeanS as number)).toBe('4 h 34 min 48 s');
    expect(formatHms(s.totalMeanS as number)).toBe('16 h 11 min 36 s');
    expect(formatHms(s.napTotalS)).toBe('22 h 54 min 00 s');
    expect(formatHms(s.nightTotalS)).toBe('58 h 04 min 00 s');
    expect(s.napCountTotal).toBe(19);
  });
});
