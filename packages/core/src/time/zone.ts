import { DateTime, IANAZone } from 'luxon';

/** Instante expresado en milisegundos desde la época Unix (UTC). */
export type EpochMs = number;

export const MS_PER_MIN = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_24H = 24 * MS_PER_HOUR;

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

function assertZone(zone: string): void {
  if (!isValidZone(zone)) throw new RangeError(`Zona IANA no válida: ${zone}`);
}

/** Convierte un instante ISO-8601 UTC (sufijo `Z`) a milisegundos. */
export function parseInstant(iso: string): EpochMs {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`Instante no válido: ${iso}`);
  return ms;
}

export function toIso(ms: EpochMs): string {
  return new Date(ms).toISOString();
}

/** Offset UTC vigente (minutos) de una zona en un instante. */
export function offsetMinutes(ms: EpochMs, zone: string): number {
  assertZone(zone);
  return DateTime.fromMillis(ms, { zone }).offset;
}

/** Fecha civil local (`YYYY-MM-DD`) de un instante en una zona. */
export function localDate(ms: EpochMs, zone: string): string {
  assertZone(zone);
  const d = DateTime.fromMillis(ms, { zone }).toISODate();
  if (d === null) throw new RangeError(`Instante fuera de rango: ${ms}`);
  return d;
}

/** Hora local de pared de un instante, `yyyy-MM-dd HH:mm:ss`, en la zona indicada. */
export function formatLocal(ms: EpochMs, zone: string): string {
  assertZone(zone);
  return DateTime.fromMillis(ms, { zone }).toFormat('yyyy-MM-dd HH:mm:ss');
}

/** Día natural local como intervalo de instantes. Puede medir 23, 24 o 25 horas. */
export interface NaturalDayWindow {
  kind: 'natural_day';
  date: string;
  zone: string;
  startMs: EpochMs;
  endMs: EpochMs;
  lengthMs: number;
  lengthHours: number;
}

export function naturalDayWindow(date: string, zone: string): NaturalDayWindow {
  assertZone(zone);
  const start = DateTime.fromISO(date, { zone });
  if (!start.isValid) throw new RangeError(`Fecha no válida: ${date}`);
  const startDay = start.startOf('day');
  const endDay = startDay.plus({ days: 1 }).startOf('day');
  const startMs = startDay.toMillis();
  const endMs = endDay.toMillis();
  const lengthMs = endMs - startMs;
  return { kind: 'natural_day', date, zone, startMs, endMs, lengthMs, lengthHours: lengthMs / MS_PER_HOUR };
}

/** Ventana móvil de 24 horas reales que termina en `endMs`. Siempre mide 24 h exactas. */
export interface Rolling24hWindow {
  kind: 'rolling_24h';
  startMs: EpochMs;
  endMs: EpochMs;
  lengthMs: number;
}

export function rolling24hWindow(endMs: EpochMs): Rolling24hWindow {
  return { kind: 'rolling_24h', startMs: endMs - MS_PER_24H, endMs, lengthMs: MS_PER_24H };
}

export type LocalResolution =
  | { status: 'ok'; ms: EpochMs }
  | { status: 'ambiguous'; candidates: [EpochMs, EpochMs] }
  | { status: 'nonexistent' };

const LOCAL_FMT = "yyyy-MM-dd'T'HH:mm:ss";

/**
 * Resuelve una hora local de pared (`YYYY-MM-DDTHH:mm[:ss]`) a instantes.
 *
 * - Hora inexistente (salto de primavera): `nonexistent`; no se corrige en silencio.
 * - Hora ambigua (retroceso de otoño): `ambiguous` con los dos instantes (el primero
 *   es el anterior, es decir, el offset de verano); el usuario debe elegir.
 */
export function resolveLocal(local: string, zone: string): LocalResolution {
  assertZone(zone);
  const asUtc = DateTime.fromISO(local, { zone: 'utc' });
  if (!asUtc.isValid) throw new RangeError(`Hora local no válida: ${local}`);
  const wanted = asUtc.toFormat(LOCAL_FMT);
  const base = asUtc.toMillis();
  const offsets = new Set([
    offsetMinutes(base - MS_PER_24H, zone),
    offsetMinutes(base + MS_PER_24H, zone),
  ]);
  const found: EpochMs[] = [];
  for (const o of offsets) {
    const cand = base - o * MS_PER_MIN;
    if (DateTime.fromMillis(cand, { zone }).toFormat(LOCAL_FMT) === wanted) found.push(cand);
  }
  found.sort((a, b) => a - b);
  const [first, second] = found;
  if (first === undefined) return { status: 'nonexistent' };
  if (second === undefined) return { status: 'ok', ms: first };
  return { status: 'ambiguous', candidates: [first, second] };
}

/** Atajo para pruebas y código que ya garantiza una hora local inequívoca. */
export function mustResolveLocal(local: string, zone: string): EpochMs {
  const r = resolveLocal(local, zone);
  if (r.status !== 'ok') throw new RangeError(`Hora local ${r.status}: ${local} (${zone})`);
  return r.ms;
}
