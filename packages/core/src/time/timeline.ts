import { activeSessions, type SessionInput } from './sleep';
import { naturalDayWindow, parseInstant, type EpochMs } from './zone';

/** Suceso puntual o con duración que se dibuja sobre el sueño (tomas, despertares). `endMs` nulo = duración desconocida. */
export interface TimelineEventInput {
  id: string;
  kind: 'feed' | 'awakening';
  startMs: EpochMs;
  endMs: EpochMs | null;
}

export interface TimelineBar {
  id: string;
  type: 'nap' | 'night';
  /** Posición en el día natural, 0–1 (el día puede medir 23, 24 o 25 h: la fracción absorbe el cambio de hora). */
  from: number;
  to: number;
  /** El descanso empezó antes de las 00:00 / sigue después de las 24:00 (se dibuja cortado en ese borde). */
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** Sigue en curso: su fin visible es «ahora». */
  open: boolean;
}

export interface TimelineMark {
  id: string;
  kind: 'feed' | 'awakening';
  from: number;
  /** `null` = duración desconocida: se dibuja como marca puntual, nunca como duración 0. */
  to: number | null;
}

export interface TimelineRow {
  date: string;
  bars: TimelineBar[];
  marks: TimelineMark[];
}

const frac = (ms: EpochMs, start: EpochMs, len: number): number => Math.min(1, Math.max(0, (ms - start) / len));

/**
 * Una fila por día natural local (de `dates`), con los descansos recortados al día. Una noche que cruza la
 * medianoche aparece en las dos filas, cortada en el borde. Las sesiones abiertas se cierran visualmente en
 * `nowMs`; las eliminadas y fusionadas no se dibujan.
 */
export function buildTimeline(input: {
  sessions: readonly SessionInput[];
  events?: readonly TimelineEventInput[];
  dates: readonly string[];
  zone: string;
  nowMs: EpochMs;
}): TimelineRow[] {
  const { zone, nowMs } = input;
  const sessions = activeSessions(input.sessions);
  const events = input.events ?? [];
  return input.dates.map((date) => {
    const w = naturalDayWindow(date, zone);
    const len = w.endMs - w.startMs;
    const bars: TimelineBar[] = [];
    for (const s of sessions) {
      const open = s.sleep_end_utc === null;
      const start = parseInstant(s.sleep_start_utc);
      const end = open ? nowMs : parseInstant(s.sleep_end_utc as string);
      if (end <= start || end <= w.startMs || start >= w.endMs) continue;
      bars.push({
        id: s.id,
        type: s.sleep_type,
        from: frac(start, w.startMs, len),
        to: frac(end, w.startMs, len),
        continuesBefore: start < w.startMs,
        continuesAfter: end > w.endMs,
        open,
      });
    }
    const marks: TimelineMark[] = [];
    for (const e of events) {
      const end = e.endMs;
      const inside = e.startMs >= w.startMs && e.startMs < w.endMs;
      if (!inside) continue;
      marks.push({ id: e.id, kind: e.kind, from: frac(e.startMs, w.startMs, len), to: end === null ? null : frac(end, w.startMs, len) });
    }
    bars.sort((a, b) => a.from - b.from);
    marks.sort((a, b) => a.from - b.from);
    return { date, bars, marks };
  });
}
