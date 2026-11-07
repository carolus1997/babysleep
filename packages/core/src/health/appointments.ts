import { parseInstant } from '../time/zone';

/** Lo que necesitan el archivo de calendario y el enlace de una cita. */
export interface CalendarEventInput {
  id: string;
  title: string;
  start_utc: string;
  duration_min?: number | null;
  place?: string | null;
  notes?: string | null;
  status?: 'scheduled' | 'done' | 'cancelled';
  /** Avisos en minutos antes del inicio (0 = a la hora). */
  remind_before_min?: readonly number[];
}

/** Duración que se asume si la cita no la indica: lo mínimo para que el calendario la dibuje. */
export const DEFAULT_APPOINTMENT_MIN = 30;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `2027-01-15T09:30:00.000Z` → `20270115T093000Z` (formato de fecha-hora UTC de iCalendar y de Google). */
export function icsUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Escape de un valor de texto según RFC 5545: barra, punto y coma, coma y saltos de línea. */
export function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Pliega una línea a 75 octetos (RFC 5545 §3.1) sin partir un carácter UTF-8 por la mitad. */
export function icsFold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74; // las líneas de continuación empiezan con un espacio, que también cuenta
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const triggerOf = (min: number): string => (min <= 0 ? 'PT0S' : `-PT${Math.round(min)}M`);

export interface IcsOptions {
  /** Instante de generación (DTSTAMP). */
  nowMs: number;
  /** Texto de cada aviso (se muestra en el calendario). */
  alarmText?: string;
}

/**
 * Archivo `.ics` con las citas dadas: un VEVENT por cita y un VALARM por cada aviso. Los eventos llevan un UID estable
 * (`<id>@babysleep`), así que importar el mismo archivo otra vez actualiza el evento en vez de duplicarlo. Los
 * calendarios deciden si respetan los VALARM de un archivo importado; el aviso por notificación de la propia app no
 * depende de eso.
 */
export function buildIcs(events: readonly CalendarEventInput[], opts: IcsOptions): string {
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BabySleep//Citas//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const e of events) {
    const start = parseInstant(e.start_utc);
    const end = start + (e.duration_min ?? DEFAULT_APPOINTMENT_MIN) * 60_000;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id}@babysleep`,
      `DTSTAMP:${icsUtc(opts.nowMs)}`,
      `DTSTART:${icsUtc(start)}`,
      `DTEND:${icsUtc(end)}`,
      `SUMMARY:${icsEscape(e.title)}`,
    );
    if (e.place) lines.push(`LOCATION:${icsEscape(e.place)}`);
    if (e.notes) lines.push(`DESCRIPTION:${icsEscape(e.notes)}`);
    lines.push(`STATUS:${e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`);
    for (const m of [...new Set(e.remind_before_min ?? [])].sort((a, b) => b - a)) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(opts.alarmText ?? e.title)}`, `TRIGGER:${triggerOf(m)}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/**
 * Enlace «Añadir a Google Calendar» sin permisos ni cuenta de desarrollador: abre el formulario de un evento ya
 * relleno. Este formato no permite fijar avisos (Google aplica los suyos por defecto); para llevar los avisos de la
 * cita se usa el archivo `.ics`.
 */
export function googleCalendarUrl(e: CalendarEventInput): string {
  const start = parseInstant(e.start_utc);
  const end = start + (e.duration_min ?? DEFAULT_APPOINTMENT_MIN) * 60_000;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${icsUtc(start)}/${icsUtc(end)}` });
  if (e.notes) q.set('details', e.notes);
  if (e.place) q.set('location', e.place);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/** ¿Cuándo se enviará cada aviso de una cita? Instantes en ms; ya ordenados y sin repetidos. */
export function reminderTimes(startUtc: string, remindBeforeMin: readonly number[]): number[] {
  const start = parseInstant(startUtc);
  return [...new Set(remindBeforeMin)].map((m) => start - m * 60_000).sort((a, b) => a - b);
}

