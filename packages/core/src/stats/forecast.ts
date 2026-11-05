import { median, quantile } from './descriptive';

/** Datos mínimos para atreverse a opinar. Por debajo, el modelo se abstiene: «no lo sé» es una respuesta válida. */
export const FORECAST_MIN_N = 5;
/** Si la mitad central de los datos es más ancha que esto, el patrón es demasiado irregular para anticipar nada. */
export const FORECAST_MAX_IQR_MS = 90 * 60_000;
/** Solo se miran las últimas muestras: el ritmo de un bebé cambia con las semanas. */
export const FORECAST_LOOKBACK = 30;

export interface ForecastOptions {
  minN?: number;
  maxIqrMs?: number;
  lookback?: number;
}

export type Forecast =
  /** La duración esperada está entre `lowMs` y `highMs` (la mitad central de lo observado; cubre ~50 %), con `midMs` como mediana. */
  | { kind: 'range'; lowMs: number; midMs: number; highMs: number; n: number }
  | { kind: 'abstain'; reason: 'few_data' | 'irregular'; n: number; needed: number };

/**
 * Previsión de una duración (ventana de vigilia, intervalo entre tomas) a partir de las anteriores del mismo tipo, de
 * la más antigua a la más reciente. Es deliberadamente simple y explicable: mediana y rango intercuartílico (tipo 7)
 * de las últimas muestras. Se abstiene con pocos datos o con un patrón demasiado irregular.
 */
export function forecastFromSamples(samples: readonly number[], opts: ForecastOptions = {}): Forecast {
  const minN = opts.minN ?? FORECAST_MIN_N;
  const recent = samples.slice(-(opts.lookback ?? FORECAST_LOOKBACK));
  const n = recent.length;
  if (n < minN) return { kind: 'abstain', reason: 'few_data', n, needed: minN };
  const low = quantile(recent, 0.25) as number;
  const high = quantile(recent, 0.75) as number;
  if (high - low > (opts.maxIqrMs ?? FORECAST_MAX_IQR_MS)) return { kind: 'abstain', reason: 'irregular', n, needed: minN };
  return { kind: 'range', lowMs: low, midMs: median(recent) as number, highMs: high, n };
}

export interface Backtest {
  /** Muestras que se intentaron predecir (a partir de la `minN`+1-ésima). */
  attempts: number;
  /** Veces que el modelo se abstuvo (no cuentan como acierto ni como fallo). */
  abstained: number;
  /** Predicciones hechas y cuántas cayeron dentro del rango anunciado. */
  predicted: number;
  hits: number;
  hitRate: number | null;
  /** Error absoluto mediano de la mediana prevista frente a lo ocurrido. */
  medianAbsErrMs: number | null;
  /** Error de la referencia más ingenua posible («será igual que la última vez») en las mismas muestras. */
  naiveMedianAbsErrMs: number | null;
}

/**
 * Prueba hacia atrás: para cada muestra se predice usando SOLO las anteriores (nunca la propia ni las posteriores) y
 * se compara con lo que ocurrió. Permite saber si la previsión vale algo antes de fiarse de ella, y frente a una
 * referencia ingenua.
 */
export function backtest(samples: readonly number[], opts: ForecastOptions = {}): Backtest {
  const minN = opts.minN ?? FORECAST_MIN_N;
  let abstained = 0;
  let hits = 0;
  const errs: number[] = [];
  const naive: number[] = [];
  let predicted = 0;
  let attempts = 0;
  for (let i = minN; i < samples.length; i++) {
    attempts++;
    const actual = samples[i] as number;
    const f = forecastFromSamples(samples.slice(0, i), opts);
    if (f.kind === 'abstain') {
      abstained++;
      continue;
    }
    predicted++;
    if (actual >= f.lowMs && actual <= f.highMs) hits++;
    errs.push(Math.abs(actual - f.midMs));
    naive.push(Math.abs(actual - (samples[i - 1] as number)));
  }
  return {
    attempts,
    abstained,
    predicted,
    hits,
    hitRate: predicted === 0 ? null : hits / predicted,
    medianAbsErrMs: median(errs),
    naiveMedianAbsErrMs: median(naive),
  };
}
