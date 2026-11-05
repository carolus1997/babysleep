import { describe, expect, it } from 'vitest';
import { buildTimeline, mustResolveLocal } from '../src';
import { MADRID, session } from './helpers';

const at = (local: string) => mustResolveLocal(local, MADRID);
const near = (n: number, x: number) => expect(n).toBeCloseTo(x, 6);

describe('línea de tiempo por días', () => {
  it('coloca una siesta en su fracción del día', () => {
    const [row] = buildTimeline({ sessions: [session('a', '2027-01-15T06:00', '2027-01-15T12:00')], dates: ['2027-01-15'], zone: MADRID, nowMs: at('2027-01-16T00:00') });
    near(row!.bars[0]!.from, 0.25);
    near(row!.bars[0]!.to, 0.5);
    expect(row!.bars[0]).toMatchObject({ continuesBefore: false, continuesAfter: false, open: false });
  });

  it('una noche que cruza la medianoche sale en las dos filas, cortada en el borde', () => {
    const n = session('n', '2027-01-15T21:00', '2027-01-16T07:00', 'night');
    const [d1, d2] = buildTimeline({ sessions: [n], dates: ['2027-01-15', '2027-01-16'], zone: MADRID, nowMs: at('2027-01-17T00:00') });
    expect(d1!.bars[0]).toMatchObject({ continuesAfter: true, continuesBefore: false, to: 1 });
    near(d1!.bars[0]!.from, 21 / 24);
    expect(d2!.bars[0]).toMatchObject({ continuesBefore: true, continuesAfter: false, from: 0 });
    near(d2!.bars[0]!.to, 7 / 24);
  });

  it('el día del cambio de hora mide 23 h y la fracción lo absorbe', () => {
    const [row] = buildTimeline({ sessions: [session('a', '2027-03-28T00:00', '2027-03-28T12:00')], dates: ['2027-03-28'], zone: MADRID, nowMs: at('2027-03-29T00:00') });
    // 12 h de reloj de pared pero 11 h reales sobre un día de 23 h.
    near(row!.bars[0]!.to, 11 / 23);
  });

  it('una sesión abierta llega hasta ahora; las eliminadas no se dibujan', () => {
    const rows = buildTimeline({
      sessions: [session('o', '2027-01-15T10:00', null), session('x', '2027-01-15T01:00', '2027-01-15T02:00', 'nap', { deleted_at: '2027-01-15T05:00:00Z' })],
      dates: ['2027-01-15'],
      zone: MADRID,
      nowMs: at('2027-01-15T12:00'),
    });
    expect(rows[0]!.bars).toHaveLength(1);
    expect(rows[0]!.bars[0]).toMatchObject({ id: 'o', open: true });
    near(rows[0]!.bars[0]!.to, 0.5);
  });

  it('las tomas y despertares con duración desconocida quedan como marca puntual, no como duración 0', () => {
    const [row] = buildTimeline({
      sessions: [],
      events: [
        { id: 'f1', kind: 'feed', startMs: at('2027-01-15T08:00'), endMs: at('2027-01-15T08:20') },
        { id: 'f2', kind: 'feed', startMs: at('2027-01-15T12:00'), endMs: null },
        { id: 'other', kind: 'feed', startMs: at('2027-01-16T08:00'), endMs: null },
      ],
      dates: ['2027-01-15'],
      zone: MADRID,
      nowMs: at('2027-01-16T00:00'),
    });
    expect(row!.marks.map((m) => [m.id, m.to === null])).toEqual([['f1', false], ['f2', true]]);
  });
});
