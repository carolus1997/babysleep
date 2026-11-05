import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { backtest, feedIntervals, forecastFromSamples, type FeedInput } from '../src';
import { HOUR, iso, MIN } from './helpers';

describe('previsión por mediana y rango', () => {
  it('se abstiene con pocos datos y lo dice', () => {
    expect(forecastFromSamples([100, 110, 120])).toEqual({ kind: 'abstain', reason: 'few_data', n: 3, needed: 5 });
  });

  it('con datos regulares da la mediana y la mitad central', () => {
    const f = forecastFromSamples([100, 110, 120, 130, 140].map((m) => m * MIN));
    expect(f).toMatchObject({ kind: 'range', n: 5, midMs: 120 * MIN, lowMs: 110 * MIN, highMs: 130 * MIN });
  });

  it('se abstiene si el patrón es demasiado irregular', () => {
    const f = forecastFromSamples([30, 60, 120, 240, 300, 360].map((m) => m * MIN));
    expect(f).toMatchObject({ kind: 'abstain', reason: 'irregular' });
  });

  it('solo mira las últimas muestras (el ritmo cambia)', () => {
    const old = Array.from({ length: 40 }, () => 60 * MIN);
    const recent = Array.from({ length: 30 }, () => 150 * MIN);
    expect(forecastFromSamples([...old, ...recent])).toMatchObject({ kind: 'range', midMs: 150 * MIN });
  });

  it('propiedad: el rango contiene a la mediana y los extremos van ordenados', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 5, maxLength: 40 }), (xs) => {
        const f = forecastFromSamples(xs.map((m) => m * MIN), { maxIqrMs: Infinity });
        return f.kind === 'range' && f.lowMs <= f.midMs && f.midMs <= f.highMs;
      }),
    );
  });
});

describe('prueba hacia atrás', () => {
  it('usa solo lo anterior y compara con la referencia ingenua', () => {
    // Serie estable con una muestra rara al final: no puede «haberla visto» al predecirla.
    const s = [120, 118, 122, 120, 121, 119, 120, 200].map((m) => m * MIN);
    const b = backtest(s);
    expect(b).toMatchObject({ attempts: 3, abstained: 0, predicted: 3, hits: 1 }); // el rango es la mitad central: acierta ~la mitad, no casi siempre
    expect(b.hitRate).toBeCloseTo(1 / 3, 9);
    expect(b.medianAbsErrMs).toBeLessThanOrEqual(b.naiveMedianAbsErrMs as number);
  });

  it('las abstenciones se cuentan aparte y sin datos suficientes no hay nada que probar', () => {
    expect(backtest([1, 2, 3].map((m) => m * MIN))).toMatchObject({ attempts: 0, predicted: 0, hitRate: null, medianAbsErrMs: null });
    const irregular = backtest([30, 300, 30, 300, 30, 300, 30, 300].map((m) => m * MIN));
    expect(irregular.predicted + irregular.abstained).toBe(irregular.attempts);
    expect(irregular.abstained).toBeGreaterThan(0);
  });
});

describe('intervalos entre tomas', () => {
  const f = (id: string, start: string, type: FeedInput['feed_type'] = 'breast'): FeedInput => ({ id, feed_type: type, start_utc: iso(start), end_utc: null });
  it('ordena, salta sólidos y descarta huecos de más de 12 h', () => {
    const r = feedIntervals([
      f('c', '2027-01-15T13:00'),
      f('a', '2027-01-15T07:00'),
      f('s', '2027-01-15T10:00', 'solids'),
      f('d', '2027-01-16T08:00'),
    ]);
    expect(r.map((x) => x.gapMs / HOUR)).toEqual([6]); // 07→13; 13→08 del día siguiente son 19 h: fuera
    expect(r[0]!.endMs).toBeGreaterThan(r[0]!.startMs);
  });
});
