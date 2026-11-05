import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AWAKENING_THRESHOLD_MS, mustResolveLocal, sleepDayTotals, subtractIntervals, type AwakeningInput } from '../src';
import { HOUR, iso, MADRID, MIN, session } from './helpers';

const night = session('n1', '2027-01-15T21:00', '2027-01-16T07:00', 'night'); // 10 h en cama
const aw = (id: string, from: string, to: string | null, extra: Partial<AwakeningInput> = {}): AwakeningInput => ({
  id,
  session_id: 'n1',
  start_utc: iso(from),
  end_utc: to === null ? null : iso(to),
  source: 'manual',
  ...extra,
});
const day = (awakenings: AwakeningInput[], opts: { thresholdMin?: number; nowMs?: number; sessions?: ReturnType<typeof session>[] } = {}) =>
  sleepDayTotals(opts.sessions ?? [night], '2027-01-15', MADRID, {
    awakenings,
    ...(opts.thresholdMin === undefined ? {} : { awakeningThresholdMs: opts.thresholdMin * MIN }),
    ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
  });

describe('restar intervalos', () => {
  it('quita tramos del medio, de los bordes y los que no tocan', () => {
    const base = [{ start: 0, end: 100 }];
    expect(subtractIntervals(base, [{ start: 20, end: 30 }])).toEqual([{ start: 0, end: 20 }, { start: 30, end: 100 }]);
    expect(subtractIntervals(base, [{ start: -5, end: 10 }, { start: 90, end: 120 }])).toEqual([{ start: 10, end: 90 }]);
    expect(subtractIntervals(base, [{ start: 200, end: 300 }])).toEqual(base);
    expect(subtractIntervals(base, [{ start: 0, end: 100 }])).toEqual([]);
  });
});

describe('despertares nocturnos', () => {
  it('sin despertares, el sueño real es el tiempo en cama', () => {
    const d = day([]);
    expect(d).toMatchObject({ nightMs: 10 * HOUR, nightBedMs: 10 * HOUR, awakeningCount: 0, longAwakeningCount: 0, awakeMs: 0 });
  });

  it('un despertar de menos del umbral cuenta, pero no descuenta tiempo', () => {
    const d = day([aw('a', '2027-01-16T01:00', '2027-01-16T01:20')]);
    expect(d).toMatchObject({ awakeningCount: 1, longAwakeningCount: 0, nightMs: 10 * HOUR, awakeMs: 0 });
  });

  it('uno de 30 min o más cuenta y se descuenta de la noche (el umbral es «igual o mayor»)', () => {
    const d = day([aw('a', '2027-01-16T01:00', '2027-01-16T01:30'), aw('b', '2027-01-16T04:00', '2027-01-16T04:45')]);
    expect(d).toMatchObject({ awakeningCount: 2, longAwakeningCount: 2, awakeMs: 75 * MIN, nightBedMs: 10 * HOUR });
    expect(d.nightMs).toBe(10 * HOUR - 75 * MIN);
    expect(d.totalMs).toBe(d.nightMs); // el total del día también es el real
  });

  it('el umbral es ajustable: con 15 min, el de 20 min ya descuenta', () => {
    const list = [aw('a', '2027-01-16T01:00', '2027-01-16T01:20')];
    expect(day(list, { thresholdMin: 15 })).toMatchObject({ longAwakeningCount: 1, awakeMs: 20 * MIN });
    expect(day(list, { thresholdMin: 45 })).toMatchObject({ longAwakeningCount: 0, awakeMs: 0 });
    expect(DEFAULT_AWAKENING_THRESHOLD_MS).toBe(30 * MIN);
  });

  it('un despertar sin duración conocida cuenta como despertar y no descuenta nada (desconocido ≠ 0)', () => {
    const d = day([aw('a', '2027-01-16T01:00', null)]);
    expect(d).toMatchObject({ awakeningCount: 1, unknownAwakeningCount: 1, longAwakeningCount: 0, awakeMs: 0, nightMs: 10 * HOUR });
  });

  it('un despertar en curso (cronómetro) se mide hasta ahora', () => {
    const now = mustResolveLocal('2027-01-16T02:00', MADRID);
    const d = day([aw('a', '2027-01-16T01:00', null, { source: 'timer' })], { nowMs: now, sessions: [session('n1', '2027-01-15T21:00', null, 'night')] });
    expect(d).toMatchObject({ awakeningCount: 1, longAwakeningCount: 1, awakeMs: HOUR });
    expect(d.nightBedMs).toBe(5 * HOUR);
    expect(d.nightMs).toBe(4 * HOUR);
  });

  it('despertares solapados no se descuentan dos veces', () => {
    const d = day([aw('a', '2027-01-16T01:00', '2027-01-16T02:00'), aw('b', '2027-01-16T01:30', '2027-01-16T02:30')]);
    expect(d.awakeMs).toBe(90 * MIN);
  });

  it('ignora los eliminados y los de otras sesiones o de siestas', () => {
    const nap = session('p1', '2027-01-15T14:00', '2027-01-15T15:30');
    const d = day(
      [
        aw('a', '2027-01-16T01:00', '2027-01-16T02:00', { deleted_at: '2027-01-16T08:00:00.000Z' }),
        aw('b', '2027-01-15T14:10', '2027-01-15T15:00', { session_id: 'p1' }), // en una siesta: no cuenta
        aw('c', '2027-01-16T03:00', '2027-01-16T04:00', { session_id: 'otra' }),
      ],
      { sessions: [nap, night] },
    );
    expect(d).toMatchObject({ awakeningCount: 0, awakeMs: 0, napMs: 90 * MIN, nightMs: 10 * HOUR });
  });

  it('el tramo se recorta a su noche: un fin posterior al despertar no descuenta de más', () => {
    const d = day([aw('a', '2027-01-16T06:30', '2027-01-16T09:00')]);
    expect(d.awakeMs).toBe(30 * MIN);
  });

  it('propiedad: el sueño real nunca supera el tiempo en cama ni baja de cero', () => {
    const base = mustResolveLocal('2027-01-15T21:00', MADRID);
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 700 }), fc.integer({ min: 1, max: 300 }), fc.boolean()), { maxLength: 12 }),
        fc.integer({ min: 5, max: 180 }),
        (items, thr) => {
          const list: AwakeningInput[] = items.map(([off, len, known], i) => ({
            id: `a${i}`, session_id: 'n1', start_utc: new Date(base + off * MIN).toISOString(),
            end_utc: known ? new Date(base + (off + len) * MIN).toISOString() : null, source: 'manual',
          }));
          const d = day(list, { thresholdMin: thr });
          expect(d.nightMs).toBeGreaterThanOrEqual(0);
          expect(d.nightMs).toBeLessThanOrEqual(d.nightBedMs);
          expect(d.nightMs + d.awakeMs).toBe(d.nightBedMs);
          expect(d.longAwakeningCount + d.unknownAwakeningCount).toBeLessThanOrEqual(d.awakeningCount);
        },
      ),
      { numRuns: 200 },
    );
  });
});
