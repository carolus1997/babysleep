import { describe, expect, it } from 'vitest';
import { analyzeFeeding, dayBand, mustResolveLocal, type FeedInput } from '../src';
import { HOUR, iso, MADRID, MIN, session } from './helpers';

const feed = (id: string, start: string, end: string | null, type: FeedInput['feed_type'] = 'breast', extra: Partial<FeedInput> = {}): FeedInput => ({
  id,
  feed_type: type,
  start_utc: iso(start),
  end_utc: end === null ? null : iso(end),
  ...extra,
});
const at = (l: string) => mustResolveLocal(l, MADRID);
const run = (feedings: FeedInput[], sessions = [] as ReturnType<typeof session>[], from = '2027-01-15T00:00', to = '2027-01-17T00:00', now = '2027-01-18T12:00') =>
  analyzeFeeding({ feedings, sessions, zone: MADRID, fromMs: at(from), toMs: at(to), nowMs: at(now) });

describe('franjas del día', () => {
  it('cuatro franjas de 6 h en hora local', () => {
    expect(dayBand(at('2027-01-15T00:00'), MADRID)).toBe('small_hours');
    expect(dayBand(at('2027-01-15T05:59'), MADRID)).toBe('small_hours');
    expect(dayBand(at('2027-01-15T06:00'), MADRID)).toBe('morning');
    expect(dayBand(at('2027-01-15T12:00'), MADRID)).toBe('afternoon');
    expect(dayBand(at('2027-01-15T23:59'), MADRID)).toBe('evening');
  });
});

describe('análisis de tomas', () => {
  const feeds = [
    feed('a', '2027-01-15T07:00', '2027-01-15T07:20'),
    feed('b', '2027-01-15T10:00', '2027-01-15T10:15', 'bottle', { amount_ml: 120 }),
    feed('c', '2027-01-15T17:00', null, 'bottle'),
    feed('s', '2027-01-15T13:30', '2027-01-15T13:50', 'solids'),
    feed('d', '2027-01-16T02:00', '2027-01-16T02:10'),
  ];

  it('mide intervalos entre tomas de leche (sin sólidos), de inicio a inicio', () => {
    const r = run(feeds);
    expect(r.intervals.n).toBe(3);
    expect(r.intervals.minMs).toBe(3 * HOUR);
    expect(r.intervals.maxMs).toBe(9 * HOUR); // 17:00 → 02:00 del día siguiente
    expect(r.intervals.medianMs).toBe(7 * HOUR);
    expect(r.count).toBe(5);
    expect(r.byType).toEqual({ breast: 2, bottle: 2, mixed: 0, solids: 1 });
  });

  it('un intervalo de más de 12 h no se promedia y se cuenta aparte', () => {
    const r = run([feed('a', '2027-01-15T07:00', null), feed('b', '2027-01-15T22:00', null)]);
    expect(r.intervals.n).toBe(0);
    expect(r.intervalsTooLong).toBe(1);
  });

  it('la duración desconocida no es cero: se cuenta aparte', () => {
    const r = run(feeds);
    expect(r.duration.n).toBe(4);
    expect(r.durationUnknown).toBe(1);
    expect(r.duration.minMs).toBe(10 * MIN);
  });

  it('biberones: media de ml solo de los que lo indican', () => {
    const r = run(feeds);
    expect(r.bottle).toEqual({ n: 2, withMl: 1, meanMl: 120 });
  });

  it('tomas por franja y por día, sin contar hoy', () => {
    const r = run(feeds, [], '2027-01-15T00:00', '2027-01-17T00:00', '2027-01-20T12:00');
    expect(r.daysObserved).toBe(2);
    expect(r.meanPerDay).toBe(2.5);
    expect(Object.fromEntries(r.byBand.map((b) => [b.band, b.count]))).toEqual({ small_hours: 1, morning: 2, afternoon: 2, evening: 0 });
    const hoy = run(feeds, [], '2027-01-15T00:00', '2027-01-17T00:00', '2027-01-15T20:00');
    expect(hoy.daysObserved).toBe(1); // el 15 es «hoy»: no cuenta; solo el 16
  });

  it('cuenta las tomas anotadas dentro de cada noche cerrada, sin sólidos', () => {
    const n = session('n', '2027-01-15T21:00', '2027-01-16T07:00', 'night');
    const r = run(feeds, [n]);
    expect(r.nights).toEqual({ n: 1, total: 1, meanPerNight: 1 });
  });

  it('sin datos no inventa medias', () => {
    const r = run([]);
    expect(r).toMatchObject({ count: 0, meanPerDay: null, daysObserved: 0 });
    expect(r.intervals.meanMs).toBeNull();
    expect(r.nights.meanPerNight).toBeNull();
  });

  it('ignora eliminadas', () => {
    const r = run([...feeds.slice(0, 2), { ...feeds[2]!, deleted_at: '2027-01-15T20:00:00Z' }]);
    expect(r.count).toBe(2);
  });
});
