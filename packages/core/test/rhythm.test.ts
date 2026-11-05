import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { circularStats, dailyRhythm, localMinuteOfDay, mustResolveLocal, summarizeWakeWindows, wakeWindows } from '../src';
import { HOUR, MADRID, MIN, session } from './helpers';

const day = [
  session('n0', '2027-01-14T20:30', '2027-01-15T07:00', 'night'),
  session('a', '2027-01-15T09:00', '2027-01-15T10:00'),
  session('b', '2027-01-15T12:30', '2027-01-15T14:00'),
  session('c', '2027-01-15T16:30', '2027-01-15T17:00'),
  session('n1', '2027-01-15T20:00', '2027-01-16T06:30', 'night'),
];

describe('ventanas de vigilia', () => {
  it('mide cada hueco y lo coloca según su posición', () => {
    const { windows } = wakeWindows(day);
    expect(windows.map((w) => [w.position, w.index, w.durationMs / MIN])).toEqual([
      ['first', 1, 120], // 07:00 → 09:00
      ['between', 2, 150], // 10:00 → 12:30
      ['between', 3, 150], // 14:00 → 16:30
      ['bedtime', null, 180], // 17:00 → 20:00
    ]);
  });

  it('resume por posición', () => {
    const s = summarizeWakeWindows(wakeWindows(day));
    expect(s.first.meanMs).toBe(2 * HOUR);
    expect(s.between).toMatchObject({ n: 2, meanMs: 150 * MIN });
    expect(s.bedtime.medianMs).toBe(3 * HOUR);
    expect(s.byIndex.map((x) => x.index)).toEqual([1, 2, 3]);
  });

  it('un hueco enorme es un dato que falta, no una ventana', () => {
    const r = wakeWindows([session('a', '2027-01-15T09:00', '2027-01-15T10:00'), session('b', '2027-01-15T20:00', '2027-01-15T21:00')]);
    expect(r.windows).toEqual([]);
    expect(r.tooLong).toBe(1);
  });

  it('los solapes no generan ventana y se cuentan', () => {
    const r = wakeWindows([session('a', '2027-01-15T09:00', '2027-01-15T11:00'), session('b', '2027-01-15T10:00', '2027-01-15T12:00')]);
    expect(r.windows).toEqual([]);
    expect(r.overlapping).toBe(1);
  });

  it('un sueño abierto no abre ventana, pero sí cierra la anterior', () => {
    const open = [session('a', '2027-01-15T09:00', '2027-01-15T10:00'), session('b', '2027-01-15T12:00', null)];
    const nowMs = mustResolveLocal('2027-01-15T12:30', MADRID);
    expect(wakeWindows(open, { nowMs }).windows.map((w) => w.durationMs / MIN)).toEqual([120]);
    // Sin `nowMs` el abierto ni entra, y no se inventa nada.
    expect(wakeWindows(open).windows).toEqual([]);
  });

  it('ignora eliminados', () => {
    const r = wakeWindows([...day.slice(0, 2), { ...day[2]!, deleted_at: '2027-01-15T18:00:00Z' }, day[3]!]);
    expect(r.windows.map((w) => w.toId)).toEqual(['a', 'c']);
  });
});

describe('estadística circular', () => {
  it('23:50 y 00:10 promedian en medianoche, no en mediodía', () => {
    const s = circularStats([23 * 60 + 50, 10]);
    const m = s.meanMinute as number;
    expect(Math.min(m, 1440 - m)).toBeLessThan(1);
    expect(s.sdMinutes).toBeGreaterThan(9);
    expect(s.sdMinutes).toBeLessThan(11);
  });

  it('sin datos o con una hora repartida no hay media; con una sola no hay desviación', () => {
    expect(circularStats([])).toEqual({ n: 0, meanMinute: null, sdMinutes: null });
    expect(circularStats([0, 720]).meanMinute).toBeNull();
    expect(circularStats([600])).toMatchObject({ meanMinute: expect.closeTo(600, 6), sdMinutes: null });
  });

  it('la hora local respeta el cambio horario', () => {
    expect(localMinuteOfDay(mustResolveLocal('2027-01-15T21:30', MADRID), MADRID)).toBe(21 * 60 + 30);
    expect(localMinuteOfDay(mustResolveLocal('2027-07-15T21:30', MADRID), MADRID)).toBe(21 * 60 + 30);
  });

  it('propiedad: la media no cambia al rotar todas las horas el mismo ángulo', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1439 }), { minLength: 2, maxLength: 12 }), fc.integer({ min: 0, max: 1439 }), (xs, k) => {
        const a = circularStats(xs);
        const b = circularStats(xs.map((x) => (x + k) % 1440));
        if (a.meanMinute === null || b.meanMinute === null) return true;
        const diff = (((a.meanMinute + k - b.meanMinute) % 1440) + 1440) % 1440;
        return Math.min(diff, 1440 - diff) < 1e-6 && Math.abs((a.sdMinutes ?? 0) - (b.sdMinutes ?? 0)) < 1e-6;
      }),
    );
  });
});

describe('ritmo diario', () => {
  it('hora de acostarse, de despertar, de primera siesta y siestas por día', () => {
    const r = dailyRhythm(day, MADRID);
    expect(r.bedtime.n).toBe(2);
    expect(r.bedtime.meanMinute).toBeGreaterThan(20 * 60 + 14);
    expect(r.bedtime.meanMinute).toBeLessThan(20 * 60 + 16);
    expect(r.wakeUp.n).toBe(2);
    expect(r.firstNap).toMatchObject({ n: 1, meanMinute: expect.closeTo(9 * 60, 6) });
    expect(r.napsPerDay).toMatchObject({ n: 1, mean: 3, sd: null });
  });

  it('el tramo anterior a la primera noche no cuenta (puede estar recortado)', () => {
    const r = dailyRhythm([session('a', '2027-01-15T09:00', '2027-01-15T10:00'), session('n', '2027-01-15T20:00', '2027-01-16T06:00', 'night')], MADRID);
    expect(r.napsPerDay.n).toBe(0);
    expect(r.firstNap.n).toBe(0);
  });

  it('un día sin siestas cuenta como 0 siestas', () => {
    const r = dailyRhythm([session('n1', '2027-01-15T20:00', '2027-01-16T06:00', 'night'), session('n2', '2027-01-16T20:00', '2027-01-17T06:00', 'night')], MADRID);
    expect(r.napsPerDay).toMatchObject({ n: 1, mean: 0 });
  });

  it('las noches abiertas no aportan despertar', () => {
    const r = dailyRhythm([session('n1', '2027-01-15T20:00', null, 'night')], MADRID);
    expect(r.bedtime.n).toBe(0);
    expect(r.wakeUp.n).toBe(0);
  });
});
