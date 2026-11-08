import { describe, expect, it } from 'vitest';
import { sleepDayOf } from '../src/domain/sleepDay';

const Z = 'Europe/Madrid';
const at = (local: string) => new Date(`${local}:00+01:00`).toISOString(); // enero: Madrid = UTC+1

describe('día de sueño en el Historial', () => {
  it('una siesta cuenta en su propio día', () => {
    expect(sleepDayOf({ sleep_start_utc: at('2027-01-15T10:00'), sleep_type: 'nap' }, Z)).toBe('2027-01-15');
  });
  it('la noche que empieza por la tarde cuenta en el día en que empieza, aunque termine al siguiente', () => {
    expect(sleepDayOf({ sleep_start_utc: at('2027-01-15T21:00'), sleep_type: 'night' }, Z)).toBe('2027-01-15');
  });
  it('una noche que empieza de madrugada (antes de las 5) cuenta en el día anterior', () => {
    expect(sleepDayOf({ sleep_start_utc: at('2027-01-16T00:30'), sleep_type: 'night' }, Z)).toBe('2027-01-15');
  });
  it('una siesta de madrugada no se mueve de día', () => {
    expect(sleepDayOf({ sleep_start_utc: at('2027-01-16T00:30'), sleep_type: 'nap' }, Z)).toBe('2027-01-16');
  });
});
