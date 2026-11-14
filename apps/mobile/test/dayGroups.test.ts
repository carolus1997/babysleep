import { describe, expect, it } from 'vitest';
import { splitRecentAndWeeks, weekStart } from '../src/domain/dayGroups';

describe('listas por días: recientes y semanas', () => {
  it('el lunes de cada semana', () => {
    expect(weekStart('2027-01-18')).toBe('2027-01-18'); // lunes
    expect(weekStart('2027-01-24')).toBe('2027-01-18'); // domingo
    expect(weekStart('2027-01-25')).toBe('2027-01-25');
    expect(weekStart('2027-03-01')).toBe('2027-03-01');
  });

  it('los últimos 7 días van sueltos y lo anterior se agrupa por semana', () => {
    const dates = ['2027-01-20', '2027-01-19', '2027-01-15', '2027-01-14', '2027-01-13', '2027-01-12', '2027-01-08', '2027-01-07', '2027-01-04', '2026-12-31'];
    const { recent, weeks } = splitRecentAndWeeks(dates, '2027-01-20');
    expect(recent).toEqual(['2027-01-20', '2027-01-19', '2027-01-15', '2027-01-14']); // 7 días: del 14 al 20
    expect(weeks.map((w) => [w.start, w.end, w.dates])).toEqual([
      ['2027-01-11', '2027-01-17', ['2027-01-13', '2027-01-12']],
      ['2027-01-04', '2027-01-10', ['2027-01-08', '2027-01-07', '2027-01-04']],
      ['2026-12-28', '2027-01-03', ['2026-12-31']],
    ]);
  });

  it('sin datos, nada', () => {
    expect(splitRecentAndWeeks([], '2027-01-20')).toEqual({ recent: [], weeks: [] });
  });

  it('con pocos días, todo va suelto y no hay semanas', () => {
    const { recent, weeks } = splitRecentAndWeeks(['2027-01-20', '2027-01-18'], '2027-01-20');
    expect(recent).toHaveLength(2);
    expect(weeks).toHaveLength(0);
  });
});
