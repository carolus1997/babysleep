import { describe, expect, it } from 'vitest';
import { Uuid } from '@babysleep/contract';
import { mustResolveLocal, suggestSleepType, uuidv7 } from '../src';
import { MADRID } from './helpers';

describe('uuidv7', () => {
  it('tiene formato v7 y variante RFC, y lo acepta el contrato', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Uuid.safeParse(id).success).toBe(true);
  });

  it('codifica la marca de tiempo en los primeros 48 bits', () => {
    const ms = Date.UTC(2027, 0, 15, 12, 0, 0);
    const id = uuidv7(ms);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(ms);
  });

  it('es ordenable por creación y no repite', () => {
    const ids = Array.from({ length: 500 }, (_, i) => uuidv7(1_800_000_000_000 + i));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(500);
  });

  it('rechaza una fuente aleatoria de longitud incorrecta', () => {
    expect(() => uuidv7(0, new Uint8Array(8))).toThrow();
  });
});

describe('sugerencia de tipo de sueño', () => {
  const at = (local: string) => suggestSleepType(mustResolveLocal(local, MADRID), MADRID);
  it('noche entre las 19:00 y las 04:59', () => {
    expect(at('2027-01-14T19:00')).toBe('night');
    expect(at('2027-01-14T23:30')).toBe('night');
    expect(at('2027-01-15T00:10')).toBe('night');
    expect(at('2027-01-15T04:59')).toBe('night');
  });
  it('siesta el resto del día', () => {
    expect(at('2027-01-15T05:00')).toBe('nap');
    expect(at('2027-01-15T13:00')).toBe('nap');
    expect(at('2027-01-14T18:59')).toBe('nap');
  });
  it('usa la hora local, no la UTC (verano)', () => {
    // 20:30 UTC = 22:30 en Madrid en verano → noche; 16:30 UTC = 18:30 local → siesta
    expect(suggestSleepType(Date.UTC(2027, 6, 15, 20, 30), MADRID)).toBe('night');
    expect(suggestSleepType(Date.UTC(2027, 6, 15, 16, 30), MADRID)).toBe('nap');
  });
});
