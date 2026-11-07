import type { FeedTypeT } from '@babysleep/contract';
import { mean } from '../stats/descriptive';
import { localMinuteOfDay, windowStats, type WindowStats } from './rhythm';
import { activeSessions, type SessionInput } from './sleep';
import { localDate, MS_PER_HOUR, parseInstant, type EpochMs } from './zone';

export interface FeedInput {
  id: string;
  feed_type: FeedTypeT;
  start_utc: string;
  end_utc: string | null;
  amount_ml?: number | null;
  deleted_at?: string | null;
}

/** Un intervalo más largo que esto casi seguro esconde una toma sin registrar: se excluye. */
export const DEFAULT_MAX_FEED_INTERVAL_MS = 12 * MS_PER_HOUR;

export type DayBand = 'small_hours' | 'morning' | 'afternoon' | 'evening';
/** Franjas fijas de 6 h en hora local: madrugada 0–6, mañana 6–12, tarde 12–18, noche 18–24. */
export const DAY_BANDS: readonly DayBand[] = ['small_hours', 'morning', 'afternoon', 'evening'];

export function dayBand(ms: EpochMs, zone: string): DayBand {
  const h = Math.floor(localMinuteOfDay(ms, zone) / 60);
  return DAY_BANDS[Math.min(3, Math.floor(h / 6))] as DayBand;
}

export interface FeedAnalysis {
  /** Tomas en el periodo (no eliminadas), por tipo. */
  count: number;
  byType: Record<FeedTypeT, number>;
  /** Tiempo entre el inicio de una toma de leche y el de la siguiente. Los sólidos no cuentan: no sustituyen la toma. */
  intervals: WindowStats;
  intervalsTooLong: number;
  /** Duración de las tomas con fin conocido; las que no lo tienen se cuentan aparte (nunca como 0). */
  duration: WindowStats;
  durationUnknown: number;
  /** Tomas por franja horaria y su media por día observado. */
  byBand: Array<{ band: DayBand; count: number; perDay: number | null }>;
  /** Días completos del periodo con al menos una toma anotada (hoy no cuenta: aún puede crecer). */
  daysObserved: number;
  meanPerDay: number | null;
  /** Tomas anotadas que empezaron dentro de una noche cerrada. Solo las anotadas: no hay forma de saber las que faltan. */
  nights: { n: number; total: number; meanPerNight: number | null };
  bottle: { n: number; withMl: number; meanMl: number | null };
}

const isMilk = (t: FeedTypeT): boolean => t !== 'solids';

export interface FeedInterval {
  /** Inicio de la toma que abre el intervalo y de la que lo cierra. */
  startMs: EpochMs;
  endMs: EpochMs;
  gapMs: number;
}

/** Intervalos entre tomas de leche consecutivas (inicio a inicio), cronológicos; sin los de más de `maxMs` ni los de gap ≤ 0. */
export function feedIntervals(feedings: readonly FeedInput[], maxMs: number = DEFAULT_MAX_FEED_INTERVAL_MS): FeedInterval[] {
  const milk = feedings
    .filter((f) => (f.deleted_at ?? null) === null && isMilk(f.feed_type))
    .map((f) => parseInstant(f.start_utc))
    .sort((a, b) => a - b);
  const out: FeedInterval[] = [];
  for (let i = 1; i < milk.length; i++) {
    const startMs = milk[i - 1] as number;
    const endMs = milk[i] as number;
    const gapMs = endMs - startMs;
    if (gapMs > 0 && gapMs <= maxMs) out.push({ startMs, endMs, gapMs });
  }
  return out;
}

/**
 * Análisis descriptivo de tomas en `[fromMs, toMs)`. Los intervalos se miden sobre toda la historia y se asignan al
 * periodo en el que TERMINAN (inicio de la toma siguiente), igual que las ventanas de vigilia.
 */
export function analyzeFeeding(input: {
  feedings: readonly FeedInput[];
  sessions?: readonly SessionInput[];
  zone: string;
  fromMs: EpochMs;
  toMs: EpochMs;
  nowMs: EpochMs;
  maxIntervalMs?: number;
}): FeedAnalysis {
  const { zone, fromMs, toMs, nowMs } = input;
  const maxMs = input.maxIntervalMs ?? DEFAULT_MAX_FEED_INTERVAL_MS;
  const within = (ms: number) => ms >= fromMs && ms < toMs;
  const all = input.feedings
    .filter((f) => (f.deleted_at ?? null) === null)
    .map((f) => ({ f, start: parseInstant(f.start_utc) }))
    .sort((a, b) => a.start - b.start);
  const mine = all.filter((x) => within(x.start));

  const byType: Record<FeedTypeT, number> = { breast: 0, bottle: 0, mixed: 0, solids: 0 };
  for (const { f } of mine) byType[f.feed_type]++;

  const milk = all.filter((x) => isMilk(x.f.feed_type));
  const gaps: number[] = [];
  let tooLong = 0;
  for (let i = 1; i < milk.length; i++) {
    const end = (milk[i] as { start: number }).start;
    if (!within(end)) continue;
    const gap = end - (milk[i - 1] as { start: number }).start;
    if (gap <= 0) continue; // dos tomas con el mismo inicio: probable duplicado, no hay intervalo que medir
    if (gap > maxMs) tooLong++;
    else gaps.push(gap);
  }

  const known: number[] = [];
  let unknown = 0;
  for (const { f, start } of mine) {
    if (f.end_utc === null) unknown++;
    else known.push(parseInstant(f.end_utc) - start);
  }

  const todayDate = localDate(nowMs, zone);
  const perDate = new Map<string, number>();
  for (const { start } of mine) {
    const d = localDate(start, zone);
    if (d !== todayDate) perDate.set(d, (perDate.get(d) ?? 0) + 1);
  }
  const daysObserved = perDate.size;
  const completeMine = mine.filter(({ start }) => localDate(start, zone) !== todayDate);
  const byBand = DAY_BANDS.map((band) => {
    const count = completeMine.filter(({ start }) => dayBand(start, zone) === band).length;
    return { band, count, perDay: daysObserved === 0 ? null : count / daysObserved };
  });

  const nights = activeSessions(input.sessions ?? []).filter((s) => s.sleep_type === 'night' && s.sleep_end_utc !== null);
  const nightsInRange = nights.filter((s) => within(parseInstant(s.sleep_start_utc)));
  const perNight = nightsInRange.map(
    (s) =>
      all.filter((x) => x.start >= parseInstant(s.sleep_start_utc) && x.start < parseInstant(s.sleep_end_utc as string) && isMilk(x.f.feed_type)).length,
  );

  const bottles = mine.filter((x) => x.f.feed_type === 'bottle' || x.f.feed_type === 'mixed');
  const ml = bottles.map((x) => x.f.amount_ml).filter((v): v is number => typeof v === 'number');

  return {
    count: mine.length,
    byType,
    intervals: windowStats(gaps),
    intervalsTooLong: tooLong,
    duration: windowStats(known),
    durationUnknown: unknown,
    byBand,
    daysObserved,
    meanPerDay: daysObserved === 0 ? null : completeMine.length / daysObserved,
    nights: { n: nightsInRange.length, total: perNight.reduce((a, b) => a + b, 0), meanPerNight: mean(perNight) },
    bottle: { n: bottles.length, withMl: ml.length, meanMl: mean(ml) },
  };
}
