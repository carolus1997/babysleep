import { describe, expect, it } from 'vitest';
import {
  attributedTotals,
  METRIC_KIND_LABELS_ES,
  mustResolveLocal,
  naturalDayTotals,
  naturalDayWindow,
  offsetMinutes,
  recordedDurationMs,
  resolveLocal,
  rolling24hTotals,
  rolling24hWindow,
  sleepDayTotals,
  toIso,
} from '../src';
import { HOUR, iso, MADRID, session } from './helpers';

describe('resolución de horas locales (DST)', () => {
  it('hora ambigua del retroceso de otoño devuelve los dos instantes', () => {
    const r = resolveLocal('2026-10-25T02:30', MADRID);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.candidates.map(toIso)).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
    }
  });

  it('hora inexistente del salto de primavera se rechaza', () => {
    expect(resolveLocal('2027-03-28T02:30', MADRID)).toEqual({ status: 'nonexistent' });
  });

  it('horas contiguas al salto son válidas', () => {
    expect(resolveLocal('2027-03-28T01:59', MADRID).status).toBe('ok');
    expect(resolveLocal('2027-03-28T03:00', MADRID).status).toBe('ok');
  });

  it('zonas inválidas lanzan error', () => {
    expect(() => resolveLocal('2027-01-01T10:00', 'Mars/Olympus')).toThrow();
  });

  it('offsets de Madrid: invierno +60, verano +120', () => {
    expect(offsetMinutes(mustResolveLocal('2027-01-15T12:00', MADRID), MADRID)).toBe(60);
    expect(offsetMinutes(mustResolveLocal('2027-07-15T12:00', MADRID), MADRID)).toBe(120);
  });
});

describe('día natural frente a ventana móvil de 24 h', () => {
  it('el día natural mide 23, 24 o 25 h según el cambio de hora', () => {
    expect(naturalDayWindow('2027-03-28', MADRID).lengthHours).toBe(23);
    expect(naturalDayWindow('2026-10-25', MADRID).lengthHours).toBe(25);
    expect(naturalDayWindow('2027-01-15', MADRID).lengthHours).toBe(24);
  });

  it('la ventana móvil mide siempre 24 h reales, incluso alrededor de un cambio de hora', () => {
    for (const end of ['2027-03-28T12:00', '2026-10-25T12:00', '2027-01-15T12:00']) {
      expect(rolling24hWindow(mustResolveLocal(end, MADRID)).lengthMs).toBe(24 * HOUR);
    }
  });

  it('las etiquetas distinguen las tres vistas', () => {
    expect(Object.keys(METRIC_KIND_LABELS_ES)).toEqual(['natural_day', 'rolling_24h', 'attributed_by_wake_date', 'sleep_day']);
    const day = naturalDayTotals([], '2027-03-28', MADRID);
    const roll = rolling24hTotals([], mustResolveLocal('2027-03-28T12:00', MADRID));
    expect(day.kind).toBe('natural_day');
    expect(day.lengthHours).toBe(23);
    expect(roll.kind).toBe('rolling_24h');
    expect(roll.lengthHours).toBe(24);
  });
});

describe('día de sueño (primera siesta → despertar de la noche siguiente)', () => {
  const lastNight = session('n0', '2027-01-14T21:00', '2027-01-15T07:00', 'night');
  const nap1 = session('p1', '2027-01-15T09:30', '2027-01-15T10:30');
  const nap2 = session('p2', '2027-01-15T13:00', '2027-01-15T14:30');
  const night = session('n1', '2027-01-15T21:00', '2027-01-16T07:30', 'night');
  const all = [lastNight, nap1, nap2, night];

  it('no cuenta la cola de la noche anterior: empieza en la primera siesta', () => {
    const d = sleepDayTotals(all, '2027-01-15', MADRID);
    expect(d.napMs).toBe(2.5 * HOUR);
    expect(d.napCount).toBe(2);
    expect(d.nightMs).toBe(10.5 * HOUR); // la noche entera, también lo que cae tras la medianoche
    expect(d.totalMs).toBe(13 * HOUR);
    expect(d.complete).toBe(true);
    // el día natural, en cambio, sí mezclaba la noche anterior
    expect(naturalDayTotals(all, '2027-01-15', MADRID).nightMs).toBe(7 * HOUR + 3 * HOUR);
  });

  it('la noche de ayer pertenece al día de ayer, con su despertar de hoy', () => {
    const d = sleepDayTotals(all, '2027-01-14', MADRID);
    expect(d.nightMs).toBe(10 * HOUR);
    expect(d.napCount).toBe(0);
  });

  it('una noche que empieza de madrugada (antes de las 5) cuenta en el día anterior', () => {
    const late = session('n2', '2027-01-16T00:30', '2027-01-16T07:00', 'night');
    expect(sleepDayTotals([late], '2027-01-15', MADRID).nightMs).toBe(6.5 * HOUR);
    expect(sleepDayTotals([late], '2027-01-16', MADRID).nightMs).toBe(0);
  });

  it('con la noche en curso suma hasta ahora y el día se marca incompleto; sin «ahora» no suma y sigue incompleto', () => {
    const open = session('n3', '2027-01-15T21:00', null, 'night');
    const now = mustResolveLocal('2027-01-15T23:00', MADRID);
    const a = sleepDayTotals([nap1, open], '2027-01-15', MADRID, { nowMs: now });
    expect(a.nightMs).toBe(2 * HOUR);
    expect(a.complete).toBe(false);
    const b = sleepDayTotals([nap1, open], '2027-01-15', MADRID);
    expect(b.nightMs).toBe(0);
    expect(b.openIds).toEqual(['n3']);
    expect(b.complete).toBe(false);
  });

  it('dos cuidadores que anotan lo mismo no duplican el total (unión)', () => {
    const dup = session('p1b', '2027-01-15T09:30', '2027-01-15T10:30');
    expect(sleepDayTotals([nap1, dup], '2027-01-15', MADRID).napMs).toBe(HOUR);
  });

  it('ignora sesiones eliminadas', () => {
    const del = { ...nap2, deleted_at: '2027-01-15T15:00:00.000Z' };
    expect(sleepDayTotals([nap1, del], '2027-01-15', MADRID).napCount).toBe(1);
  });
});

describe('caso 1: sesión que atraviesa la medianoche', () => {
  const night = session('n1', '2027-01-14T21:30', '2027-01-15T06:30', 'night');

  it('la duración registrada es de 9 h', () => {
    expect(recordedDurationMs(night)).toBe(9 * HOUR);
  });

  it('el recorte por día natural parte 2,5 h + 6,5 h', () => {
    expect(naturalDayTotals([night], '2027-01-14', MADRID).totalMs).toBe(2.5 * HOUR);
    expect(naturalDayTotals([night], '2027-01-15', MADRID).totalMs).toBe(6.5 * HOUR);
  });

  it('la atribución por despertar suma las 9 h completas al día 15', () => {
    const { days } = attributedTotals([night], MADRID);
    expect(days).toHaveLength(1);
    expect(days[0]?.date).toBe('2027-01-15');
    expect(days[0]?.totalMs).toBe(9 * HOUR);
  });
});

describe('caso 2: salto de primavera (27→28 mar 2027)', () => {
  const night = session('n2', '2027-03-27T21:00', '2027-03-28T07:00', 'night');

  it('son 9 h reales aunque el reloj marque 10', () => {
    expect(recordedDurationMs(night)).toBe(9 * HOUR);
  });

  it('el recorte por día natural es 3 h + 6 h y el día 28 mide 23 h', () => {
    const d27 = naturalDayTotals([night], '2027-03-27', MADRID);
    const d28 = naturalDayTotals([night], '2027-03-28', MADRID);
    expect(d27.totalMs).toBe(3 * HOUR);
    expect(d28.totalMs).toBe(6 * HOUR);
    expect(d28.lengthHours).toBe(23);
  });
});

describe('caso 3: retroceso de otoño (24→25 oct 2026)', () => {
  const night = session('n3', '2026-10-24T21:00', '2026-10-25T07:00', 'night');

  it('son 11 h reales aunque el reloj marque 10', () => {
    expect(recordedDurationMs(night)).toBe(11 * HOUR);
  });

  it('el recorte por día natural es 3 h + 8 h y el día 25 mide 25 h', () => {
    const d24 = naturalDayTotals([night], '2026-10-24', MADRID);
    const d25 = naturalDayTotals([night], '2026-10-25', MADRID);
    expect(d24.totalMs).toBe(3 * HOUR);
    expect(d25.totalMs).toBe(8 * HOUR);
    expect(d25.lengthHours).toBe(25);
  });
});

describe('caso 5: cambio de zona horaria', () => {
  const night = {
    id: 'n5',
    sleep_start_utc: iso('2027-01-15T22:00', MADRID),
    sleep_end_utc: iso('2027-01-16T06:00', 'America/Bogota'),
    sleep_type: 'night' as const,
  };

  it('la duración se mide sobre instantes: 14 h', () => {
    expect(recordedDurationMs(night)).toBe(14 * HOUR);
  });

  it('la atribución usa la fecha local de despertar en la zona de referencia', () => {
    // fin = 11:00 UTC del 16-ene → 12:00 en Madrid → 2027-01-16
    const { days } = attributedTotals([night], MADRID);
    expect(days[0]?.date).toBe('2027-01-16');
    expect(days[0]?.totalMs).toBe(14 * HOUR);
  });
});

describe('caso 6: sesiones abiertas', () => {
  const open = session('open', '2027-01-15T13:00', null, 'nap');
  const now = mustResolveLocal('2027-01-15T13:40', MADRID);

  it('sin nowMs se excluyen y se listan', () => {
    const t = naturalDayTotals([open], '2027-01-15', MADRID);
    expect(t.totalMs).toBe(0);
    expect(t.openExcluded).toEqual(['open']);
  });

  it('con nowMs se cierran virtualmente y se marca includesOpen', () => {
    const t = naturalDayTotals([open], '2027-01-15', MADRID, { nowMs: now });
    expect(t.totalMs).toBe(40 * 60_000);
    expect(t.includesOpen).toBe(true);
  });

  it('una noche abierta no se atribuye a ninguna fecha', () => {
    const openNight = session('on', '2027-01-15T21:00', null, 'night');
    const r = attributedTotals([openNight], MADRID, { nowMs: mustResolveLocal('2027-01-15T23:00', MADRID) });
    expect(r.days).toHaveLength(0);
    expect(r.unattributed).toEqual(['on']);
  });

  it('recordedDurationMs de una sesión abierta es null', () => {
    expect(recordedDurationMs(open)).toBeNull();
  });
});

describe('caso 7: anomalías', () => {
  it('duración no positiva: se marca y no suma', () => {
    const bad = session('bad', '2027-01-15T10:00', '2027-01-15T10:00');
    const t = naturalDayTotals([bad], '2027-01-15', MADRID);
    expect(t.totalMs).toBe(0);
    expect(t.anomalies).toEqual([{ id: 'bad', kind: 'non_positive_duration' }]);
  });

  it('más de 24 h: se marca pero NO se elimina', () => {
    const long = session('long', '2027-01-14T08:00', '2027-01-15T10:00', 'night');
    const t = naturalDayTotals([long], '2027-01-15', MADRID);
    expect(t.anomalies).toContainEqual({ id: 'long', kind: 'exceeds_24h' });
    expect(t.totalMs).toBe(10 * HOUR);
  });

  it('mezclar bebés lanza error', () => {
    const a = session('a', '2027-01-15T10:00', '2027-01-15T11:00', 'nap', { baby_id: 'b1' });
    const b = session('b', '2027-01-15T12:00', '2027-01-15T13:00', 'nap', { baby_id: 'b2' });
    expect(() => naturalDayTotals([a, b], '2027-01-15', MADRID)).toThrow(/varios bebés/);
  });
});

describe('atribución de siestas y noches', () => {
  it('la siesta pertenece a la fecha de su inicio; la noche, a la de su despertar', () => {
    const nap = session('s', '2027-01-15T10:00', '2027-01-15T11:00', 'nap');
    const night = session('n', '2027-01-14T21:00', '2027-01-15T06:00', 'night');
    const { days } = attributedTotals([nap, night], MADRID);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ date: '2027-01-15', totalMs: 10 * HOUR, napMs: HOUR, nightMs: 9 * HOUR });
  });
});
