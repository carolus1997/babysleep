import type { SleepSessionT } from '@babysleep/contract';
import { DEFAULT_SLEEP_DAY_CUTOFF_HOUR, localDate, localHour, naturalDayWindow, parseInstant } from '@babysleep/core';

/**
 * Día de sueño al que pertenece un descanso en el Historial: el de su inicio, salvo una noche que empieza de
 * madrugada (antes de las 5), que cuenta en el día anterior. Es la misma regla que usa `sleepDayTotals`, así que
 * el total de cada día coincide con las filas que se ven debajo.
 */
export function sleepDayOf(s: Pick<SleepSessionT, 'sleep_start_utc' | 'sleep_type'>, zone: string): string {
  const start = parseInstant(s.sleep_start_utc);
  const d = localDate(start, zone);
  if (s.sleep_type === 'night' && localHour(start, zone) < DEFAULT_SLEEP_DAY_CUTOFF_HOUR) return localDate(naturalDayWindow(d, zone).startMs - 1, zone);
  return d;
}
