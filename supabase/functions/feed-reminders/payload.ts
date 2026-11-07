// Lógica pura de los avisos (sin APIs de Deno), para poder probarla con Vitest.

export interface DueReminder {
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  baby_id: string;
  baby_alias: string;
  feeding_id: string;
  interval_min: number;
  last_start_utc: string;
}

/** Un aviso de cita que ya toca (lo devuelve `claim_due_appointment_reminders`). */
export interface DueAppointmentReminder {
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  appointment_id: string;
  baby_id: string;
  baby_alias: string;
  title: string;
  kind: string;
  start_utc: string;
  start_tz: string;
  place: string | null;
  minutes_before: number;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Una notificación por bebé: una nueva sustituye a la anterior en vez de apilarse. */
  tag: string;
  /** Qué abrir al tocar el aviso (relativo a la app). */
  url: string;
  babyId: string;
  /** `feed` lleva los botones Pecho/Biberón; `appointment` no lleva botones. */
  kind: 'feed' | 'appointment';
}

/** «hace 3 h 10 min» a partir de minutos. */
export function sinceText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

export function buildPayload(r: DueReminder, nowMs: number): PushPayload {
  const since = (nowMs - Date.parse(r.last_start_utc)) / 60_000;
  return {
    title: `Toca toma · ${r.baby_alias}`,
    body: `La última empezó hace ${sinceText(since)}.`,
    tag: `feed-${r.baby_id}`,
    url: './?feed=ask',
    babyId: r.baby_id,
    kind: 'feed',
  };
}

/** «en 1 día», «en 2 h», «en 30 min» o «ahora», según la antelación del aviso. */
export function leadText(minutesBefore: number): string {
  if (minutesBefore <= 0) return 'ahora';
  if (minutesBefore % 1440 === 0) {
    const d = minutesBefore / 1440;
    return d === 1 ? 'mañana' : `en ${d} días`;
  }
  return `en ${sinceText(minutesBefore)}`;
}

/** Día y hora de la cita en la zona en que se anotó: «vie 15 ene, 09:30». */
export function whenText(startUtc: string, tz: string): string {
  let zone = tz;
  try {
    new Intl.DateTimeFormat('es-ES', { timeZone: zone });
  } catch {
    zone = 'Europe/Madrid';
  }
  const fmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone });
  return fmt.format(new Date(startUtc)).replace(',', '');
}

export function buildAppointmentPayload(r: DueAppointmentReminder): PushPayload {
  const where = r.place ? ` · ${r.place}` : '';
  return {
    title: `Cita ${leadText(r.minutes_before)} · ${r.baby_alias}`,
    body: `${r.title}. ${whenText(r.start_utc, r.start_tz)}${where}`,
    // Un aviso distinto por antelación, para que el de «1 h antes» no borre al de «1 día antes» sin que se vea.
    tag: `appt-${r.appointment_id}-${r.minutes_before}`,
    url: './?go=health',
    babyId: r.baby_id,
    kind: 'appointment',
  };
}

/** Una dirección que el servicio de avisos da por inexistente (404/410) se borra; el resto de fallos se cuentan. */
export const isGone = (statusCode: number | undefined): boolean => statusCode === 404 || statusCode === 410;
