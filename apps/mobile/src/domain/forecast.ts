import type { FeedingT, SleepSessionT } from '@babysleep/contract';
import {
  activeSessions,
  backtest,
  dailyRhythm,
  DEFAULT_SLEEP_DAY_CUTOFF_HOUR,
  feedIntervals,
  forecastFromSamples,
  localMinuteOfDay,
  median,
  MS_PER_24H,
  MS_PER_HOUR,
  parseInstant,
  wakeWindows,
  FORECAST_MIN_N,
  type Backtest,
  type Forecast,
  type WakeWindowPosition,
} from '@babysleep/core';
import { isRunning } from './feeding';

/** Cuántos días hacia atrás se miran para aprender el ritmo actual. */
export const FORECAST_LOOKBACK_DAYS = 28;
/** Si el último descanso terminó hace más que esto, los datos están desactualizados y no se predice. */
export const STALE_AFTER_MS = 14 * MS_PER_HOUR;
/**
 * Una ventana de vigilia más corta que esto casi seguro es una siesta partida o un corte de registro, no tiempo despierto
 * de verdad: se deja fuera de la muestra para que no ensanche el rango (el 25 % inferior del rango intercuartílico).
 */
export const MIN_WAKE_WINDOW_MS = 30 * 60_000;
/**
 * Si una siesta acaba a menos de esto de la hora habitual de acostarse (o pasada esa hora), lo siguiente es la noche.
 * El número de siestas de cada día varía demasiado para guiarse por él.
 */
export const BEDTIME_LEAD_MS = 3 * MS_PER_HOUR;
/** Una toma que empieza antes de esto desde la anterior es la misma toma retomada, no un intervalo de verdad. */
export const MIN_FEED_INTERVAL_MS = 30 * 60_000;
/** Cada cuánto come se aprende de las tomas que empezaron a una hora parecida (±2 h). */
export const FEED_HOUR_SPREAD_MIN = 120;

const MIN_PER_DAY = 1440;
/**
 * Minutos desde que empieza el día de sueño (las 5:00): la mañana queda antes que la tarde, y las horas de acostarse a
 * un lado y otro de la medianoche quedan seguidas.
 */
const dayMinute = (ms: number, zone: string) => (localMinuteOfDay(ms, zone) - DEFAULT_SLEEP_DAY_CUTOFF_HOUR * 60 + MIN_PER_DAY) % MIN_PER_DAY;
/** Distancia entre dos horas del día, en minutos (23:30 y 00:30 están a 60). */
const hourDistance = (a: number, b: number, zone: string) => {
  const d = Math.abs(localMinuteOfDay(a, zone) - localMinuteOfDay(b, zone));
  return Math.min(d, MIN_PER_DAY - d);
};

export type SleepForecastState =
  | { state: 'sleeping' }
  | { state: 'unknown'; reason: 'no_sessions' | 'stale' }
  | {
      state: 'awake';
      awakeSinceMs: number;
      /** «Siesta o acostarse»: qué ventana se está esperando. */
      position: Exclude<WakeWindowPosition, 'other'>;
      /** `awake`: por el tiempo que suele aguantar despierta. `clock`: por la hora a la que suele acostarse. */
      basis: 'awake' | 'clock';
      /** Con `basis: 'clock'`, los valores son tiempos desde las 5:00; el instante previsto está en `range`. */
      forecast: Forecast;
      /** Instantes absolutos previstos (inicio del sueño siguiente) si hay rango. */
      range: { fromMs: number; midMs: number; toMs: number } | null;
      backtest: Backtest;
    };

export type FeedForecastState =
  | { state: 'feeding' }
  | { state: 'unknown'; reason: 'no_feeds' | 'stale' }
  | {
      state: 'waiting';
      lastStartMs: number;
      forecast: Forecast;
      range: { fromMs: number; midMs: number; toMs: number } | null;
      /** Con qué datos se calculó: los de una hora parecida, o todos si no había bastantes. */
      basis: 'same_hour' | 'all';
      backtest: Backtest;
    };

export interface ForecastView {
  sleep: SleepForecastState;
  feed: FeedForecastState;
  minN: number;
}

const toRange = (f: Forecast, base: number) =>
  f.kind === 'range' ? { fromMs: base + f.lowMs, midMs: base + f.midMs, toMs: base + f.highMs } : null;

/**
 * Previsión orientativa de la próxima ventana de sueño y de la próxima toma, a partir del propio historial reciente.
 * Es descriptiva («lo habitual en los últimos días»), no una instrucción; se abstiene con pocos datos o con ritmos irregulares.
 */
export function buildForecast(input: {
  sessions: readonly SleepSessionT[];
  feedings: readonly FeedingT[];
  zone: string;
  nowMs: number;
}): ForecastView {
  const { zone, nowMs } = input;
  const since = nowMs - FORECAST_LOOKBACK_DAYS * MS_PER_24H;
  return { sleep: sleepForecast(input.sessions, zone, nowMs, since), feed: feedForecast(input.feedings, zone, nowMs, since), minN: FORECAST_MIN_N };
}

function sleepForecast(sessions: readonly SleepSessionT[], zone: string, nowMs: number, since: number): SleepForecastState {
  const live = activeSessions(sessions);
  if (live.some((s) => s.sleep_end_utc === null)) return { state: 'sleeping' };
  const closed = live.sort((a, b) => parseInstant(a.sleep_start_utc) - parseInstant(b.sleep_start_utc));
  const last = closed[closed.length - 1];
  if (last === undefined) return { state: 'unknown', reason: 'no_sessions' };
  const awakeSince = parseInstant(last.sleep_end_utc as string);
  if (nowMs - awakeSince > STALE_AFTER_MS) return { state: 'unknown', reason: 'stale' };

  // ¿Qué ventana se espera? Tras una noche, la primera; tras una siesta, otra siesta o, si ya lleva las habituales, acostarse.
  const bedtimes = closed
    .filter((s) => s.sleep_type === 'night' && parseInstant(s.sleep_start_utc) >= since)
    .map((s) => dayMinute(parseInstant(s.sleep_start_utc), zone));
  const usualBed = bedtimes.length >= FORECAST_MIN_N ? (median(bedtimes) as number) : null;

  let position: Exclude<WakeWindowPosition, 'other'> = 'first';
  if (last.sleep_type === 'nap' && usualBed !== null) {
    position = dayMinute(awakeSince, zone) >= usualBed - BEDTIME_LEAD_MS / 60_000 ? 'bedtime' : 'between';
  } else if (last.sleep_type === 'nap') {
    // Con pocas noches anotadas aún no hay hora habitual: se cuentan las siestas del día.
    let napsToday = 0;
    for (let i = closed.length - 1; i >= 0 && (closed[i] as SleepSessionT).sleep_type === 'nap'; i--) napsToday++;
    const usual = dailyRhythm(closed.filter((s) => parseInstant(s.sleep_start_utc) >= since), zone).napsPerDay.mean;
    position = usual !== null && napsToday >= Math.round(usual) ? 'bedtime' : 'between';
  }

  // La hora de acostarse se repite mucho más que el rato que aguanta despierta antes de la noche.
  if (position === 'bedtime' && usualBed !== null) {
    const clock = bedtimes.map((m) => m * 60_000);
    const forecast = forecastFromSamples(clock);
    const dayStart = awakeSince - dayMinute(awakeSince, zone) * 60_000;
    return { state: 'awake', awakeSinceMs: awakeSince, position, basis: 'clock', forecast, range: toRange(forecast, dayStart), backtest: backtest(clock) };
  }

  const samples = wakeWindows(closed.filter((s) => s.sleep_end_utc !== null), { nowMs })
    .windows.filter((w) => w.position === position && w.endMs >= since && w.durationMs >= MIN_WAKE_WINDOW_MS)
    .sort((a, b) => a.endMs - b.endMs)
    .map((w) => w.durationMs);
  const forecast = forecastFromSamples(samples);
  return { state: 'awake', awakeSinceMs: awakeSince, position, basis: 'awake', forecast, range: toRange(forecast, awakeSince), backtest: backtest(samples) };
}

function feedForecast(feedings: readonly FeedingT[], zone: string, nowMs: number, since: number): FeedForecastState {
  const live = feedings.filter((f) => f.deleted_at === null);
  if (live.some(isRunning)) return { state: 'feeding' };
  const milk = live.filter((f) => f.feed_type !== 'solids').sort((a, b) => a.start_utc.localeCompare(b.start_utc));
  // Una toma retomada al poco cuenta como una sola, desde que empezó la primera parte.
  const meals: typeof milk = [];
  let previous = -Infinity;
  for (const f of milk) {
    const at = parseInstant(f.start_utc);
    if (at - previous >= MIN_FEED_INTERVAL_MS) meals.push(f);
    previous = at;
  }
  const lastFeed = meals[meals.length - 1];
  if (lastFeed === undefined) return { state: 'unknown', reason: 'no_feeds' };
  const lastStart = parseInstant(lastFeed.start_utc);
  if (nowMs - lastStart > STALE_AFTER_MS) return { state: 'unknown', reason: 'stale' };

  const recent = feedIntervals(meals).filter((i) => i.endMs >= since);
  const sameHour = recent.filter((i) => hourDistance(i.startMs, lastStart, zone) <= FEED_HOUR_SPREAD_MIN).map((i) => i.gapMs);
  const useHour = sameHour.length >= FORECAST_MIN_N;
  const samples = useHour ? sameHour : recent.map((i) => i.gapMs);
  const forecast = forecastFromSamples(samples);
  return {
    state: 'waiting',
    lastStartMs: lastStart,
    forecast,
    range: toRange(forecast, lastStart),
    basis: useHour ? 'same_hour' : 'all',
    backtest: backtest(samples),
  };
}
