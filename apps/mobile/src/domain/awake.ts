import type { SleepSessionT } from '@babysleep/contract';
import { activeSessions, MS_PER_HOUR, parseInstant } from '@babysleep/core';
import { buildForecast } from './forecast';

/** Más de esto sin ningún descanso anotado casi seguro es un hueco de registro, no tiempo despierta de verdad. */
export const AWAKE_STALE_AFTER_MS = 14 * MS_PER_HOUR;

export type AwakeStatus =
  | { state: 'none' }
  | { state: 'sleeping'; sinceMs: number; type: 'nap' | 'night' }
  | {
      state: 'awake';
      /** Fin del último descanso cerrado. */
      sinceMs: number;
      elapsedMs: number;
      after: 'nap' | 'night';
      /** Hace tanto que no hay registros que el dato puede no ser fiable. */
      stale: boolean;
      /** Duración habitual de esta ventana de vigilia (rango, en ms desde que despertó) si hay datos suficientes; `null` si el modelo se abstiene. */
      usual: { fromMs: number; toMs: number } | null;
    };

/**
 * ¿Duerme o está despierta, y desde cuándo? Despierta = tiempo desde que terminó el último descanso (siesta o noche).
 * Un descanso abierto manda: si hay uno en curso está durmiendo, aunque haya otros cerrados después.
 */
export function awakeStatus(input: { sessions: readonly SleepSessionT[]; zone: string; nowMs: number }): AwakeStatus {
  const live = activeSessions(input.sessions);
  const open = live.filter((s) => s.sleep_end_utc === null).sort((a, b) => b.sleep_start_utc.localeCompare(a.sleep_start_utc))[0];
  if (open !== undefined) return { state: 'sleeping', sinceMs: parseInstant(open.sleep_start_utc), type: open.sleep_type };

  let last: SleepSessionT | undefined;
  for (const s of live) {
    if (last === undefined || parseInstant(s.sleep_end_utc as string) > parseInstant(last.sleep_end_utc as string)) last = s;
  }
  if (last === undefined) return { state: 'none' };

  const sinceMs = parseInstant(last.sleep_end_utc as string);
  const elapsedMs = Math.max(0, input.nowMs - sinceMs);
  const f = buildForecast({ sessions: input.sessions, feedings: [], zone: input.zone, nowMs: input.nowMs }).sleep;
  return {
    state: 'awake',
    sinceMs,
    elapsedMs,
    after: last.sleep_type,
    stale: elapsedMs > AWAKE_STALE_AFTER_MS,
    usual: f.state === 'awake' && f.range !== null ? { fromMs: f.range.fromMs - f.awakeSinceMs, toMs: f.range.toMs - f.awakeSinceMs } : null,
  };
}
