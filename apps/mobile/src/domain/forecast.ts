import type { FeedingT, SleepSessionT } from '@babysleep/contract';
import {
  activeSessions,
  backtest,
  dailyRhythm,
  dayBand,
  feedIntervals,
  forecastFromSamples,
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

export type SleepForecastState =
  | { state: 'sleeping' }
  | { state: 'unknown'; reason: 'no_sessions' | 'stale' }
  | {
      state: 'awake';
      awakeSinceMs: number;
      /** «Siesta o acostarse»: qué ventana se está esperando. */
      position: Exclude<WakeWindowPosition, 'other'>;
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
      /** Con qué datos se calculó: los de la misma franja horaria, o todos si no había bastantes. */
      basis: 'same_band' | 'all';
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
  let position: Exclude<WakeWindowPosition, 'other'> = 'first';
  if (last.sleep_type === 'nap') {
    let napsToday = 0;
    for (let i = closed.length - 1; i >= 0 && (closed[i] as SleepSessionT).sleep_type === 'nap'; i--) napsToday++;
    const usual = dailyRhythm(closed.filter((s) => parseInstant(s.sleep_start_utc) >= since), zone).napsPerDay.mean;
    position = usual !== null && napsToday >= Math.round(usual) ? 'bedtime' : 'between';
  }

  const samples = wakeWindows(closed.filter((s) => s.sleep_end_utc !== null), { nowMs })
    .windows.filter((w) => w.position === position && w.endMs >= since)
    .sort((a, b) => a.endMs - b.endMs)
    .map((w) => w.durationMs);
  const forecast = forecastFromSamples(samples);
  return { state: 'awake', awakeSinceMs: awakeSince, position, forecast, range: toRange(forecast, awakeSince), backtest: backtest(samples) };
}

function feedForecast(feedings: readonly FeedingT[], zone: string, nowMs: number, since: number): FeedForecastState {
  const live = feedings.filter((f) => f.deleted_at === null);
  if (live.some(isRunning)) return { state: 'feeding' };
  const milk = live.filter((f) => f.feed_type !== 'solids').sort((a, b) => a.start_utc.localeCompare(b.start_utc));
  const lastFeed = milk[milk.length - 1];
  if (lastFeed === undefined) return { state: 'unknown', reason: 'no_feeds' };
  const lastStart = parseInstant(lastFeed.start_utc);
  if (nowMs - lastStart > STALE_AFTER_MS) return { state: 'unknown', reason: 'stale' };

  const recent = feedIntervals(live).filter((i) => i.endMs >= since);
  const band = dayBand(lastStart, zone);
  const sameBand = recent.filter((i) => dayBand(i.startMs, zone) === band).map((i) => i.gapMs);
  const useBand = sameBand.length >= FORECAST_MIN_N;
  const samples = useBand ? sameBand : recent.map((i) => i.gapMs);
  const forecast = forecastFromSamples(samples);
  return {
    state: 'waiting',
    lastStartMs: lastStart,
    forecast,
    range: toRange(forecast, lastStart),
    basis: useBand ? 'same_band' : 'all',
    backtest: backtest(samples),
  };
}
