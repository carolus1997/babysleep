import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  activeSessions,
  attributedTotals,
  mustResolveLocal,
  naturalDayTotals,
  naturalDayWindow,
  sleepInWindow,
  toIso,
  unionLength,
  type SessionInput,
} from '../src';
import { HOUR, MADRID, MIN, session } from './helpers';

const DAY = '2027-01-14';
const day = (s: readonly SessionInput[], opts = {}) => naturalDayTotals(s, DAY, MADRID, opts);

describe('duplicados de dos cuidadores (p. ej. generados sin conexión)', () => {
  it('la misma siesta registrada dos veces con 2 min de diferencia cuenta una sola vez', () => {
    const a = session('A', '2027-01-14T14:00', '2027-01-14T15:00');
    const b = session('B', '2027-01-14T14:02', '2027-01-14T15:01');
    const t = day([a, b]);
    expect(t.totalMs).toBe(61 * MIN); // unión, no 119 min
    expect(t.overlaps).toEqual([
      { a: 'A', b: 'B', overlapMs: 58 * MIN, probableDuplicate: true, status: 'pending_review' },
    ]);
  });

  it('duplicado exacto: el total no cambia y queda pendiente de revisión', () => {
    const a = session('A', '2027-01-14T14:00', '2027-01-14T15:00');
    const b = session('B', '2027-01-14T14:00', '2027-01-14T15:00');
    const t = day([a, b]);
    expect(t.totalMs).toBe(HOUR);
    expect(t.overlaps[0]?.probableDuplicate).toBe(true);
  });

  it('solape parcial lejano: se une, pero no se propone como duplicado', () => {
    const a = session('A', '2027-01-14T14:00', '2027-01-14T15:00');
    const b = session('B', '2027-01-14T14:30', '2027-01-14T16:00');
    const t = day([a, b]);
    expect(t.totalMs).toBe(2 * HOUR);
    expect(t.overlaps).toHaveLength(1);
    expect(t.overlaps[0]?.probableDuplicate).toBe(false);
  });

  it('inicios a 5 min exactos siguen siendo probable duplicado; a 6 min no', () => {
    const base = session('A', '2027-01-14T14:00', '2027-01-14T15:00');
    const at5 = session('B', '2027-01-14T14:05', '2027-01-14T15:00');
    const at6 = session('C', '2027-01-14T14:06', '2027-01-14T15:00');
    expect(day([base, at5]).overlaps[0]?.probableDuplicate).toBe(true);
    expect(day([base, at6]).overlaps[0]?.probableDuplicate).toBe(false);
  });

  it('contención: una sesión dentro de otra no aumenta el total', () => {
    const a = session('A', '2027-01-14T14:00', '2027-01-14T16:00');
    const b = session('B', '2027-01-14T14:30', '2027-01-14T15:00');
    expect(day([a, b]).totalMs).toBe(2 * HOUR);
  });

  it('cadena de solapes: 10–11, 10:30–11:30 y 11:15–12:00 unen a 2 h con dos pares', () => {
    const s1 = session('1', '2027-01-14T10:00', '2027-01-14T11:00');
    const s2 = session('2', '2027-01-14T10:30', '2027-01-14T11:30');
    const s3 = session('3', '2027-01-14T11:15', '2027-01-14T12:00');
    const t = day([s1, s2, s3]);
    expect(t.totalMs).toBe(2 * HOUR);
    expect(t.overlaps.map((o) => `${o.a}-${o.b}`)).toEqual(['1-2', '2-3']);
  });

  it('sesiones que solo se tocan no son solape y suman completas', () => {
    const a = session('A', '2027-01-14T14:00', '2027-01-14T15:00');
    const b = session('B', '2027-01-14T15:00', '2027-01-14T16:00');
    const t = day([a, b]);
    expect(t.totalMs).toBe(2 * HOUR);
    expect(t.overlaps).toHaveLength(0);
  });

  it('una sesión abierta duplicada de otra cerrada no suma más', () => {
    const closed = session('A', '2027-01-14T14:00', '2027-01-14T15:00');
    const open = session('B', '2027-01-14T14:01', null);
    const now = mustResolveLocal('2027-01-14T14:30', MADRID);
    const t = day([closed, open], { nowMs: now });
    expect(t.totalMs).toBe(HOUR);
    expect(t.includesOpen).toBe(true);
    expect(t.overlaps).toHaveLength(1);
  });

  it('siesta y noche solapadas: el total las une; cada tipo conserva su unión', () => {
    const night = session('N', '2027-01-14T00:00', '2027-01-14T07:00', 'night');
    const nap = session('S', '2027-01-14T06:00', '2027-01-14T08:00', 'nap');
    const t = day([night, nap]);
    expect(t.totalMs).toBe(8 * HOUR);
    expect(t.nightMs).toBe(7 * HOUR);
    expect(t.napMs).toBe(2 * HOUR);
    expect(t.overlaps).toHaveLength(1);
  });

  it('las sesiones fusionadas o eliminadas se conservan pero no cuentan', () => {
    const keep = session('K', '2027-01-14T14:00', '2027-01-14T15:00');
    const merged = session('M', '2027-01-14T14:01', '2027-01-14T15:00', 'nap', { merged_into: 'K' });
    const deleted = session('D', '2027-01-14T14:02', '2027-01-14T15:00', 'nap', { deleted_at: '2027-01-14T16:00:00.000Z' });
    const all = [keep, merged, deleted];
    expect(activeSessions(all).map((s) => s.id)).toEqual(['K']);
    expect(all).toHaveLength(3); // la trazabilidad no se destruye
    const t = day(all);
    expect(t.totalMs).toBe(HOUR);
    expect(t.overlaps).toHaveLength(0);
  });

  it('el duplicado también se une en la atribución por despertar', () => {
    const a = session('A', '2027-01-13T21:00', '2027-01-14T06:00', 'night');
    const b = session('B', '2027-01-13T21:03', '2027-01-14T06:01', 'night');
    const { days } = attributedTotals([a, b], MADRID);
    expect(days).toHaveLength(1);
    expect(days[0]?.totalMs).toBe(9 * HOUR + MIN);
  });

  it('el duplicado se une al recortar por día natural entre dos días', () => {
    const a = session('A', '2027-01-13T21:00', '2027-01-14T06:00', 'night');
    const b = session('B', '2027-01-13T21:03', '2027-01-14T06:01', 'night');
    const d13 = naturalDayTotals([a, b], '2027-01-13', MADRID);
    const d14 = naturalDayTotals([a, b], '2027-01-14', MADRID);
    expect(d13.totalMs + d14.totalMs).toBe(9 * HOUR + MIN);
  });
});

// ---------------------------------------------------------------- propiedades

const T0 = mustResolveLocal('2026-10-20T00:00', MADRID);
const T1 = mustResolveLocal('2026-10-31T00:00', MADRID);

/** Intervalos arbitrarios (posiblemente solapados) en un periodo que incluye el cambio de hora. */
const arbSpans = fc
  .array(
    fc.record({
      startMin: fc.integer({ min: 0, max: Math.floor((T1 - T0) / MIN) - 5 }),
      durMin: fc.integer({ min: 1, max: 14 * 60 }),
      type: fc.constantFrom('nap' as const, 'night' as const),
    }),
    { minLength: 0, maxLength: 12 },
  )
  .map((xs) =>
    xs.map(
      (x, i): SessionInput => ({
        id: `p${i}`,
        sleep_start_utc: toIso(T0 + x.startMin * MIN),
        sleep_end_utc: toIso(T0 + (x.startMin + x.durMin) * MIN),
        sleep_type: x.type,
      }),
    ),
  );

const dayList = (): string[] => {
  const out: string[] = [];
  for (let d = 19; d <= 31; d++) out.push(`2026-10-${String(d).padStart(2, '0')}`);
  return out;
};

describe('propiedades de la unión de intervalos', () => {
  const win = { start: T0 - 30 * HOUR, end: T1 + 30 * HOUR };

  it('unión ≤ suma de duraciones y ≥ la mayor', () => {
    fc.assert(
      fc.property(arbSpans, (ss) => {
        const total = sleepInWindow(ss, win).totalMs;
        const durs = ss.map((s) => Date.parse(s.sleep_end_utc as string) - Date.parse(s.sleep_start_utc));
        expect(total).toBeLessThanOrEqual(durs.reduce((a, b) => a + b, 0));
        expect(total).toBeGreaterThanOrEqual(Math.max(0, ...durs));
      }),
    );
  });

  it('añadir copias duplicadas no cambia el total', () => {
    fc.assert(
      fc.property(arbSpans, (ss) => {
        const dup = [...ss, ...ss.map((s) => ({ ...s, id: `dup-${s.id}` }))];
        expect(sleepInWindow(dup, win).totalMs).toBe(sleepInWindow(ss, win).totalMs);
      }),
    );
  });

  it('el orden de entrada no importa', () => {
    fc.assert(
      fc.property(arbSpans, (ss) => {
        expect(sleepInWindow([...ss].reverse(), win).totalMs).toBe(sleepInWindow(ss, win).totalMs);
      }),
    );
  });

  it('Σ de totales por día natural (con cambio de hora) = unión total', () => {
    fc.assert(
      fc.property(arbSpans, (ss) => {
        const perDay = dayList().reduce((acc, d) => acc + naturalDayTotals(ss, d, MADRID).totalMs, 0);
        expect(perDay).toBe(sleepInWindow(ss, win).totalMs);
      }),
    );
  });

  it('el recorte nunca supera la longitud del día natural', () => {
    fc.assert(
      fc.property(arbSpans, (ss) => {
        for (const d of dayList()) {
          expect(naturalDayTotals(ss, d, MADRID).totalMs).toBeLessThanOrEqual(naturalDayWindow(d, MADRID).lengthMs);
        }
      }),
    );
  });

  it('la agrupación nunca altera las duraciones: sin solapes, Σ atribuido = Σ duraciones', () => {
    const arbDisjoint = fc
      .array(fc.record({ gapMin: fc.integer({ min: 1, max: 600 }), durMin: fc.integer({ min: 1, max: 14 * 60 }), type: fc.constantFrom('nap' as const, 'night' as const) }), {
        maxLength: 10,
      })
      .map((xs) => {
        let cursor = T0;
        return xs.map((x, i): SessionInput => {
          const start = cursor + x.gapMin * MIN;
          const end = start + x.durMin * MIN;
          cursor = end;
          return { id: `d${i}`, sleep_start_utc: toIso(start), sleep_end_utc: toIso(end), sleep_type: x.type };
        });
      });
    fc.assert(
      fc.property(arbDisjoint, (ss) => {
        const sumDur = ss.reduce((a, s) => a + (Date.parse(s.sleep_end_utc as string) - Date.parse(s.sleep_start_utc)), 0);
        const attributed = attributedTotals(ss, MADRID).days.reduce((a, d) => a + d.totalMs, 0);
        expect(attributed).toBe(sumDur);
        expect(unionLength(ss.map((s) => ({ start: Date.parse(s.sleep_start_utc), end: Date.parse(s.sleep_end_utc as string) })))).toBe(sumDur);
      }),
    );
  });
});
