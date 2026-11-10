/**
 * ¿Es un arranque en frío (la app estaba cerrada del todo) o solo se vuelve a ella tras mirar otra app?
 * La animación de entrada y la elección de bebé solo van en el primero.
 *
 * Una web no puede saber si el usuario cerró la app o si el sistema la descartó en segundo plano: al volver, la
 * página se recarga igual. Por eso se mira de dos formas:
 *  1. Cómo se cargó: una recarga, una restauración del historial o una pestaña que el navegador descartó en
 *     segundo plano son «volver», no «abrir».
 *  2. Cuándo se vio activa por última vez (se guarda mientras está abierta): si fue hace poco, se sigue en lo mismo.
 * Cerrarla y abrirla otra vez dentro de la ventana también cuenta como volver: es el precio de no molestar a
 * quien solo ha ido a mirar el móvil un momento.
 */

const KEY = 'bs-last-active';
/** Dentro de este margen desde la última vez que estuvo activa, abrirla es «volver». */
export const RESUME_WINDOW_MS = 10 * 60_000;
const HEARTBEAT_MS = 15_000;

export interface StartSignals {
  /** Instante (ms) de la última actividad guardada; `null` si no hay (primer uso o datos borrados). */
  lastActiveMs: number | null;
  nowMs: number;
  /** `PerformanceNavigationTiming.type` de esta carga. */
  navigationType: string | undefined;
  /** El navegador descartó la pestaña en segundo plano y la ha vuelto a cargar (`document.wasDiscarded`). */
  wasDiscarded: boolean;
}

/** Pura y probada: decide a partir de las señales. */
export function isColdStart(s: StartSignals): boolean {
  if (s.wasDiscarded) return false;
  if (s.navigationType === 'reload' || s.navigationType === 'back_forward') return false;
  if (s.lastActiveMs === null) return true;
  const away = s.nowMs - s.lastActiveMs;
  if (away < 0) return true; // reloj cambiado: ante la duda, bienvenida completa
  return away > RESUME_WINDOW_MS;
}

function readStamp(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeStamp(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* sin almacenamiento: solo se pierde la ventana de «volver» */
  }
}

function detect(): boolean {
  if (typeof window === 'undefined') return true;
  const nav = typeof performance !== 'undefined' ? (performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined) : undefined;
  return isColdStart({
    lastActiveMs: readStamp(),
    nowMs: Date.now(),
    navigationType: nav?.type,
    wasDiscarded: (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true,
  });
}

/** Se calcula UNA vez, al cargar el módulo y antes de empezar a guardar la actividad de esta carga. */
export const COLD_START: boolean = detect();

/** Guarda «sigo aquí» mientras la app está abierta y al pasar a segundo plano. Se llama una vez al arrancar. */
export function trackActivity(): void {
  writeStamp();
  const timer = window.setInterval(() => document.visibilityState === 'visible' && writeStamp(), HEARTBEAT_MS);
  const onHide = () => writeStamp();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onHide);
  void timer;
}
