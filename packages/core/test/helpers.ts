import { mustResolveLocal, toIso, type SessionInput } from '../src';

export const MADRID = 'Europe/Madrid';
export const MIN = 60_000;
export const HOUR = 3_600_000;

/** Instante ISO UTC a partir de una hora local de pared inequívoca. */
export const iso = (local: string, zone = MADRID): string => toIso(mustResolveLocal(local, zone));

/** Sesión de prueba. `end = null` crea una sesión abierta. */
export function session(
  id: string,
  startLocal: string,
  endLocal: string | null,
  type: 'nap' | 'night' = 'nap',
  extra: Partial<SessionInput> = {},
  zone = MADRID,
): SessionInput {
  return {
    id,
    sleep_start_utc: iso(startLocal, zone),
    sleep_end_utc: endLocal === null ? null : iso(endLocal, zone),
    sleep_type: type,
    ...extra,
  };
}
