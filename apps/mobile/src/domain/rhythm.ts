import type { SleepSessionT } from '@babysleep/contract';
import {
  activeSessions,
  dailyRhythm,
  MS_PER_24H,
  parseInstant,
  summarizeWakeWindows,
  wakeWindows,
  type DailyRhythm,
  type WakeWindowSummary,
} from '@babysleep/core';

/** Con menos datos que esto no se compara con el periodo anterior: una diferencia así sería ruido. */
export const MIN_N_TO_COMPARE = 3;

export interface RhythmPeriod {
  windows: WakeWindowSummary;
  rhythm: DailyRhythm;
}

export interface RhythmView {
  days: number;
  current: RhythmPeriod;
  previous: RhythmPeriod;
  /** Sesiones abiertas en el periodo: su fin aún no existe, así que no entran en ventanas ni en horas de despertar. */
  openSessions: number;
}

function period(sessions: readonly SleepSessionT[], fromMs: number, toMs: number, zone: string, nowMs: number): RhythmPeriod {
  // Las ventanas se miden sobre TODA la historia (para no perder la que cruza el borde del periodo) y
  // se asignan al periodo en el que TERMINAN, igual que el día de sueño atribuye por inicio.
  const all = wakeWindows(sessions, { nowMs });
  const within = (ms: number) => ms >= fromMs && ms < toMs;
  // Los huecos descartados se acotan al periodo con la misma regla: sin esto, un hueco de hace un mes
  // aparecería como «dato que falta» en la última semana.
  const skipped = all.skipped.filter((x) => within(x.endMs));
  const inPeriod = {
    windows: all.windows.filter((w) => within(w.endMs)),
    skipped,
    tooLong: skipped.filter((x) => x.kind === 'too_long').length,
    overlapping: skipped.filter((x) => x.kind === 'overlap').length,
  };
  const inRange = activeSessions(sessions).filter((s) => within(parseInstant(s.sleep_start_utc)));
  return { windows: summarizeWakeWindows(inPeriod), rhythm: dailyRhythm(inRange, zone) };
}

/** Ventanas de vigilia y ritmo diario de los últimos `days` días frente a los `days` anteriores. */
export function buildRhythm(input: { sessions: readonly SleepSessionT[]; zone: string; nowMs: number; days: number }): RhythmView {
  const { sessions, zone, nowMs, days } = input;
  const from = nowMs - days * MS_PER_24H;
  const prevFrom = from - days * MS_PER_24H;
  return {
    days,
    current: period(sessions, from, nowMs + 1, zone, nowMs),
    previous: period(sessions, prevFrom, from, zone, nowMs),
    openSessions: activeSessions(sessions).filter((s) => s.sleep_end_utc === null && parseInstant(s.sleep_start_utc) >= from).length,
  };
}
