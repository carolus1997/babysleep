import { describe, expect, it } from 'vitest';
import { ageDays, correctedAgeDays } from '../src';

const at = (date: string) => Date.parse(`${date}T12:00:00Z`);

describe('edad en días', () => {
  it('cuenta los días cumplidos y nunca es negativa', () => {
    expect(ageDays('2027-01-01', at('2027-01-01'))).toBe(0);
    expect(ageDays('2027-01-01', at('2027-01-11'))).toBe(10);
    expect(ageDays('2027-01-10', at('2027-01-01'))).toBe(0);
  });
});

describe('edad corregida', () => {
  it('no procede si la gestación es desconocida o a término', () => {
    expect(correctedAgeDays('2026-07-01', null, at('2026-11-01'))).toBeNull();
    expect(correctedAgeDays('2026-07-01', undefined, at('2026-11-01'))).toBeNull();
    expect(correctedAgeDays('2026-07-01', 37, at('2026-11-01'))).toBeNull(); // 37 ya es a término
    expect(correctedAgeDays('2026-07-01', 40, at('2026-11-01'))).toBeNull();
  });

  it('resta lo que faltó hasta las 40 semanas', () => {
    // 32 semanas → 8 semanas = 56 días antes de lo previsto
    expect(correctedAgeDays('2027-01-01', 32, at('2027-04-11'))).toBe(100 - 56);
    // 36 semanas → 28 días
    expect(correctedAgeDays('2027-01-01', 36, at('2027-03-02'))).toBe(60 - 28);
  });

  it('antes de la fecha prevista de parto sale negativa (el bebé aún no ha «llegado»)', () => {
    expect(correctedAgeDays('2027-01-01', 30, at('2027-01-21'))).toBe(20 - 70);
  });

  it('se deja de aplicar a partir de los 24 meses cronológicos', () => {
    expect(correctedAgeDays('2025-01-01', 33, at('2026-12-31'))).not.toBeNull(); // 729 días
    expect(correctedAgeDays('2025-01-01', 33, at('2027-01-02'))).toBeNull(); // 731 días
  });
});
