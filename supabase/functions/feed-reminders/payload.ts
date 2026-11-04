// Lógica pura de los avisos de toma (sin APIs de Deno), para poder probarla con Vitest.

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

export interface PushPayload {
  title: string;
  body: string;
  /** Una notificación por bebé: una nueva sustituye a la anterior en vez de apilarse. */
  tag: string;
  /** Qué abrir al tocar el aviso (relativo a la app). */
  url: string;
  babyId: string;
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
  };
}

/** Una dirección que el servicio de avisos da por inexistente (404/410) se borra; el resto de fallos se cuentan. */
export const isGone = (statusCode: number | undefined): boolean => statusCode === 404 || statusCode === 410;
