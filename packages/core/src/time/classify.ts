import { DateTime } from 'luxon';
import type { EpochMs } from './zone';

/** Hora local (0–23) de un instante en una zona. */
export function localHour(ms: EpochMs, zone: string): number {
  return DateTime.fromMillis(ms, { zone }).hour;
}

/**
 * Sugerencia ORIENTATIVA de tipo de sueño según la hora local de inicio:
 * entre las 19:00 y las 04:59 → noche; el resto → siesta. No depende de que la
 * sesión cruce la medianoche. El usuario siempre puede corregirla (type_source = manual).
 */
export function suggestSleepType(startMs: EpochMs, zone: string): 'nap' | 'night' {
  const h = localHour(startMs, zone);
  return h >= 19 || h < 5 ? 'night' : 'nap';
}
