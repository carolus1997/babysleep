/**
 * Episodios de enfermedad: resúmenes de lo que la familia anotó. Solo hechos: nada de esto dice «fiebre», «normal» o
 * «grave»; las cifras las interpreta el pediatra.
 */
import { MS_PER_MIN } from '../time/zone';

export interface EntryLike {
  id: string;
  kind: 'temperature' | 'symptom' | 'intake' | 'diaper' | 'note';
  at_utc: string;
  temp_dc: number | null;
  temp_site: string | null;
  symptom: string | null;
  intake: string | null;
  diaper: string | null;
}

export interface EpisodeLike {
  start_utc: string;
  end_utc: string | null;
}

const ms = (iso: string): number => Date.parse(iso);

/** 384 → «38,4 °C». */
export function fmtTemp(dc: number): string {
  return `${(dc / 10).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`;
}

/** Anotaciones de un episodio por hora (las más antiguas primero; a igual hora, en el orden de creación del id). */
export function sortEntries<E extends Pick<EntryLike, 'id' | 'at_utc'>>(entries: readonly E[]): E[] {
  return [...entries].sort((a, b) => ms(a.at_utc) - ms(b.at_utc) || a.id.localeCompare(b.id));
}

/** El episodio sigue en curso a esa hora. */
export const isOngoing = (e: EpisodeLike, nowMs: number): boolean => e.end_utc === null || ms(e.end_utc) > nowMs;

/** Instante de fin que se usa para recortar datos: el fin del episodio o, si sigue en curso, ahora. */
export const episodeEndMs = (e: EpisodeLike, nowMs: number): number => (e.end_utc === null ? nowMs : Math.min(ms(e.end_utc), Math.max(nowMs, ms(e.start_utc))));

export interface TempPoint {
  id: string;
  atMs: number;
  dc: number;
  site: string | null;
}

/** Temperaturas anotadas, por hora. */
export function temperatureSeries(entries: readonly EntryLike[]): TempPoint[] {
  return sortEntries(entries.filter((e) => e.kind === 'temperature' && e.temp_dc !== null)).map((e) => ({ id: e.id, atMs: ms(e.at_utc), dc: e.temp_dc as number, site: e.temp_site }));
}

export interface TempSummary {
  n: number;
  max: TempPoint | null;
  min: TempPoint | null;
  first: TempPoint | null;
  last: TempPoint | null;
}

/** Resumen de las temperaturas: cuántas, la más alta y la más baja (con hora y dónde se midió), la primera y la última. */
export function temperatureSummary(entries: readonly EntryLike[]): TempSummary {
  const s = temperatureSeries(entries);
  if (s.length === 0) return { n: 0, max: null, min: null, first: null, last: null };
  let max = s[0]!;
  let min = s[0]!;
  for (const p of s) {
    if (p.dc > max.dc) max = p;
    if (p.dc < min.dc) min = p;
  }
  return { n: s.length, max, min, first: s[0]!, last: s[s.length - 1]! };
}

export interface SymptomSummary {
  symptom: string;
  count: number;
  firstMs: number;
  lastMs: number;
}

/** Cada síntoma anotado: cuántas veces y cuándo se anotó por primera y por última vez. */
export function symptomSummary(entries: readonly EntryLike[]): SymptomSummary[] {
  const by = new Map<string, SymptomSummary>();
  for (const e of sortEntries(entries.filter((x) => x.kind === 'symptom' && x.symptom !== null))) {
    const at = ms(e.at_utc);
    const cur = by.get(e.symptom as string);
    if (cur === undefined) by.set(e.symptom as string, { symptom: e.symptom as string, count: 1, firstMs: at, lastMs: at });
    else {
      cur.count++;
      cur.lastMs = at;
    }
  }
  return [...by.values()].sort((a, b) => a.firstMs - b.firstMs || a.symptom.localeCompare(b.symptom));
}

export interface IntakeCounts {
  usual: number;
  less: number;
  much_less: number;
  almost_none: number;
}

export function intakeCounts(entries: readonly EntryLike[]): IntakeCounts {
  const c: IntakeCounts = { usual: 0, less: 0, much_less: 0, almost_none: 0 };
  for (const e of entries) if (e.kind === 'intake' && e.intake !== null && e.intake in c) c[e.intake as keyof IntakeCounts]++;
  return c;
}

export interface DiaperCounts {
  wet: number;
  dirty: number;
  both: number;
}

export function diaperCounts(entries: readonly EntryLike[]): DiaperCounts {
  const c: DiaperCounts = { wet: 0, dirty: 0, both: 0 };
  for (const e of entries) if (e.kind === 'diaper' && e.diaper !== null && e.diaper in c) c[e.diaper as keyof DiaperCounts]++;
  return c;
}

/** Días naturales distintos (fecha local) que toca el episodio, de la fecha de inicio a la del fin (o hoy). */
export function episodeDayCount(startDate: string, endDate: string): number {
  const d = Math.round((Date.parse(`${endDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / (24 * 60 * MS_PER_MIN));
  return Math.max(1, d + 1);
}
