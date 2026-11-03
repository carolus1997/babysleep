import { describe, expect, it } from 'vitest';
import { fmtAge, fmtAgeDays, fmtAges } from '../src/ui/format';

const at = (date: string) => Date.parse(`${date}T12:00:00Z`);

describe('etiquetas de edad', () => {
  it('días, semanas y meses', () => {
    expect(fmtAgeDays(5)).toBe('5 días');
    expect(fmtAgeDays(30)).toBe('4 semanas');
    expect(fmtAgeDays(61)).toBe('2 meses');
    expect(fmtAgeDays(100)).toBe('3 meses y 1 sem');
    expect(fmtAge('2026-07-01', at('2026-11-03'))).toBe('4 meses'); // 125 días
  });

  it('a término: solo la edad real, sin corregida', () => {
    expect(fmtAges('2026-07-01', null, at('2026-11-03'))).toEqual({ age: '4 meses', corrected: null });
    expect(fmtAges('2026-07-01', 39, at('2026-11-03')).corrected).toBeNull();
  });

  it('prematuro: edad real y corregida', () => {
    // nació a las 32 semanas (8 semanas antes): 127 días de vida → 71 de edad corregida
    const r = fmtAges('2026-06-27', 32, at('2026-11-01'));
    expect(r.age).toBe('4 meses'); // 127 días
    expect(r.corrected).toBe('2 meses y 1 sem');
  });

  it('antes de su fecha prevista de parto lo dice con palabras, no con un número negativo', () => {
    expect(fmtAges('2027-01-01', 30, at('2027-01-21')).corrected).toBe('aún no llega a su fecha prevista');
  });

  it('con más de 24 meses ya no se corrige', () => {
    expect(fmtAges('2025-01-01', 33, at('2027-03-01')).corrected).toBeNull();
  });
});
