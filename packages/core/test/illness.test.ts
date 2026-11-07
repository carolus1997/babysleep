import { describe, expect, it } from 'vitest';
import { diaperCounts, episodeDayCount, episodeEndMs, fmtTemp, intakeCounts, isOngoing, sortEntries, symptomSummary, temperatureSeries, temperatureSummary, type EntryLike } from '../src/health/illness';

const T0 = Date.parse('2027-01-20T20:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let n = 0;
const e = (kind: EntryLike['kind'], min: number, o: Partial<EntryLike> = {}): EntryLike => ({
  id: `e${String(++n).padStart(3, '0')}`,
  kind,
  at_utc: at(min),
  temp_dc: null,
  temp_site: null,
  symptom: null,
  intake: null,
  diaper: null,
  ...o,
});

describe('episodios de enfermedad: resúmenes', () => {
  it('formatea la temperatura con coma y una décima', () => {
    expect(fmtTemp(384)).toBe('38,4 °C');
    expect(fmtTemp(370)).toBe('37,0 °C');
  });

  it('resume las temperaturas: cuántas, máxima, mínima, primera y última, con hora y lugar; sin ninguna no inventa nada', () => {
    expect(temperatureSummary([])).toEqual({ n: 0, max: null, min: null, first: null, last: null });
    const list = [
      e('temperature', 120, { temp_dc: 381, temp_site: 'axillary' }),
      e('temperature', 0, { temp_dc: 372, temp_site: 'axillary' }),
      e('temperature', 240, { temp_dc: 395, temp_site: 'rectal' }),
      e('symptom', 30, { symptom: 'cough' }),
    ];
    const s = temperatureSummary(list);
    expect(s.n).toBe(3);
    expect(s.max).toMatchObject({ dc: 395, site: 'rectal', atMs: T0 + 240 * 60_000 });
    expect(s.min).toMatchObject({ dc: 372 });
    expect(s.first).toMatchObject({ dc: 372 });
    expect(s.last).toMatchObject({ dc: 395 });
    expect(temperatureSeries(list).map((p) => p.dc)).toEqual([372, 381, 395]);
  });

  it('los síntomas salen una vez cada uno con cuántas veces, desde cuándo y hasta cuándo', () => {
    const list = [e('symptom', 60, { symptom: 'cough' }), e('symptom', 0, { symptom: 'runny_nose' }), e('symptom', 300, { symptom: 'cough' }), e('note', 10)];
    expect(symptomSummary(list)).toEqual([
      { symptom: 'runny_nose', count: 1, firstMs: T0, lastMs: T0 },
      { symptom: 'cough', count: 2, firstMs: T0 + 60 * 60_000, lastMs: T0 + 300 * 60_000 },
    ]);
  });

  it('cuenta lo que comió y los pañales por tipo', () => {
    const list = [e('intake', 0, { intake: 'usual' }), e('intake', 60, { intake: 'less' }), e('intake', 120, { intake: 'less' }), e('diaper', 0, { diaper: 'wet' }), e('diaper', 30, { diaper: 'both' })];
    expect(intakeCounts(list)).toEqual({ usual: 1, less: 2, much_less: 0, almost_none: 0 });
    expect(diaperCounts(list)).toEqual({ wet: 1, dirty: 0, both: 1 });
  });

  it('ordena por hora y, a igual hora, de forma estable por id', () => {
    const a = e('note', 10);
    const b = e('note', 10);
    const c = e('note', 0);
    expect(sortEntries([b, a, c]).map((x) => x.id)).toEqual([c.id, a.id, b.id]);
  });

  it('en curso mientras no tenga fin; el fin recorta; los días cuentan el primero y el último', () => {
    expect(isOngoing({ start_utc: at(0), end_utc: null }, T0 + 5 * 3_600_000)).toBe(true);
    expect(isOngoing({ start_utc: at(0), end_utc: at(60) }, T0 + 2 * 3_600_000)).toBe(false);
    expect(episodeEndMs({ start_utc: at(0), end_utc: null }, T0 + 1000)).toBe(T0 + 1000);
    expect(episodeEndMs({ start_utc: at(0), end_utc: at(60) }, T0 + 5 * 3_600_000)).toBe(T0 + 60 * 60_000);
    expect(episodeDayCount('2027-01-20', '2027-01-20')).toBe(1);
    expect(episodeDayCount('2027-01-20', '2027-01-23')).toBe(4);
    expect(episodeDayCount('2027-01-20', '2027-01-19')).toBe(1);
  });
});
