import { describe, expect, it } from 'vitest';
import { checkBeforeDose, closeDoseIds, dosesInLast24h, isActive, lastDose, nextDue } from '../src/health/medication';

const T0 = Date.parse('2027-01-20T08:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const med = (o: Partial<{ start_utc: string; end_utc: string | null; interval_min: number | null; daily_max: number | null }> = {}) => ({
  start_utc: at(0),
  end_utc: null,
  interval_min: 360,
  daily_max: null,
  ...o,
});

describe('medicación: cuenta atrás', () => {
  it('sin dosis, toca al inicio; con dosis, la última más el intervalo', () => {
    expect(nextDue(med(), [], T0 + 10 * 60_000)).toEqual({ dueMs: T0, minutesLeft: -10 });
    const doses = [{ given_utc: at(0) }, { given_utc: at(370) }];
    expect(nextDue(med(), doses, T0 + 400 * 60_000)).toEqual({ dueMs: T0 + 730 * 60_000, minutesLeft: 330 });
  });

  it('a demanda, terminado o sin empezar: no hay cuenta atrás', () => {
    expect(nextDue(med({ interval_min: null }), [], T0)).toBeNull();
    expect(nextDue(med({ end_utc: at(100) }), [], T0 + 200 * 60_000)).toBeNull();
    expect(nextDue(med({ start_utc: at(60) }), [], T0)).toBeNull();
  });

  it('activo = empezó y no terminó', () => {
    expect(isActive(med(), T0)).toBe(true);
    expect(isActive(med({ end_utc: at(10) }), T0 + 10 * 60_000)).toBe(false);
    expect(isActive(med({ start_utc: at(5) }), T0)).toBe(false);
  });

  it('la última dosis es la de hora más reciente, no la última anotada', () => {
    expect(lastDose([{ given_utc: at(50) }, { given_utc: at(10) }])?.given_utc).toBe(at(50));
    expect(lastDose([])).toBeNull();
  });
});

describe('medicación: antes de registrar otra dosis', () => {
  it('avisa si hay una dosis anotada hace menos del intervalo pautado', () => {
    const w = checkBeforeDose(med(), [{ given_utc: at(0) }], T0 + 200 * 60_000);
    expect(w).toEqual([{ kind: 'recent', minutesAgo: 200, intervalMin: 360 }]);
    expect(checkBeforeDose(med(), [{ given_utc: at(0) }], T0 + 360 * 60_000)).toEqual([]);
  });

  it('sin intervalo, «hace poco» son menos de 30 min', () => {
    const m = med({ interval_min: null });
    expect(checkBeforeDose(m, [{ given_utc: at(0) }], T0 + 29 * 60_000)).toHaveLength(1);
    expect(checkBeforeDose(m, [{ given_utc: at(0) }], T0 + 30 * 60_000)).toEqual([]);
  });

  it('avisa del máximo diario escrito; sin máximo no dice nada', () => {
    const doses = [0, 360, 720, 1080].map((m) => ({ given_utc: at(m) }));
    const now = T0 + 1450 * 60_000; // la dosis de las 0 h ya queda fuera de las 24 h
    expect(checkBeforeDose(med({ daily_max: 3 }), doses, now)).toEqual([{ kind: 'daily_max', count: 3, max: 3 }]);
    expect(checkBeforeDose(med({ daily_max: 4 }), doses, now)).toEqual([]);
    expect(checkBeforeDose(med(), doses, now)).toEqual([]);
  });

  it('las dosis de hace más de 24 h no cuentan para el máximo', () => {
    const doses = [{ given_utc: at(0) }, { given_utc: at(300) }];
    expect(dosesInLast24h(doses, T0 + 24 * 60 * 60_000)).toBe(1);
    expect(dosesInLast24h(doses, T0 + 24 * 60 * 60_000 + 300 * 60_000 + 1)).toBe(0);
  });

  it('una dosis posterior a la hora indicada no cuenta como «reciente»', () => {
    expect(checkBeforeDose(med(), [{ given_utc: at(100) }], T0 + 50 * 60_000)).toEqual([]);
  });
});

describe('medicación: dosis seguidas tras sincronizar', () => {
  it('señala las que están a menos de 30 min entre sí, sin tocar las demás', () => {
    const doses = [
      { id: 'a', given_utc: at(0) },
      { id: 'b', given_utc: at(4) },
      { id: 'c', given_utc: at(360) },
    ];
    expect([...closeDoseIds(doses)].sort()).toEqual(['a', 'b']);
    expect(closeDoseIds([doses[0]!, doses[2]!]).size).toBe(0);
  });
});
