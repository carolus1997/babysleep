import type { AwakeningsCompletenessT, WakeEpisodeT } from '@babysleep/contract';
import { clip, intervalLength, mergeIntervals, type Interval } from './interval';
import { parseInstant } from './zone';

export type EpisodeInput = Pick<WakeEpisodeT, 'kind' | 'start_utc' | 'end_utc' | 'duration_s'> & {
  deleted_at?: string | null;
};

export interface EffectiveSleep {
  /** Duración registrada: de «observado dormido» a «observado despierto». */
  recordedMs: number;
  /** Tiempo despierto conocido (episodios con extensión conocida, sin solapes). */
  awakeKnownMs: number;
  /** `recordedMs − awakeKnownMs`. Cota superior del tiempo realmente dormido. */
  asleepUpperBoundMs: number;
  /** Valor puntual SOLO si el cuidador marcó los despertares como `complete`. */
  asleepPointMs: number | null;
  /** Episodios sin extensión utilizable (abiertos o incompletos) que no se contaron. */
  ignoredEpisodes: number;
  /** Se sumaron episodios solo con duración: no se pudo comprobar su posición ni su solape. */
  awakeIncludesDurationOnly: boolean;
}

/**
 * Tiempo efectivo dormido como RANGO. Con exhaustividad `unknown`/`partial` solo
 * existe cota superior; la inferior no se calcula. Nunca se modifica la duración
 * registrada ni se inventan interrupciones.
 */
export function effectiveSleep(
  session: { sleep_start_utc: string; sleep_end_utc: string | null },
  episodes: readonly EpisodeInput[],
  completeness: AwakeningsCompletenessT,
): EffectiveSleep | null {
  if (session.sleep_end_utc === null) return null;
  const span: Interval = { start: parseInstant(session.sleep_start_utc), end: parseInstant(session.sleep_end_utc) };
  const recordedMs = intervalLength(span);

  let ignored = 0;
  let durationOnlyMs = 0;
  let hasDurationOnly = false;
  const timed: Interval[] = [];
  for (const e of episodes) {
    if ((e.deleted_at ?? null) !== null) continue;
    if (e.kind === 'timed') {
      if (e.start_utc === null || e.end_utc === null) {
        ignored++;
        continue;
      }
      const c = clip({ start: parseInstant(e.start_utc), end: parseInstant(e.end_utc) }, span);
      if (c !== null) timed.push(c);
    } else if (e.duration_s !== null) {
      durationOnlyMs += e.duration_s * 1000;
      hasDurationOnly = true;
    } else {
      ignored++;
    }
  }

  const timedMs = mergeIntervals(timed).reduce((acc, i) => acc + intervalLength(i), 0);
  const awakeKnownMs = Math.min(recordedMs, timedMs + durationOnlyMs);
  const asleepUpperBoundMs = recordedMs - awakeKnownMs;
  return {
    recordedMs,
    awakeKnownMs,
    asleepUpperBoundMs,
    asleepPointMs: completeness === 'complete' ? asleepUpperBoundMs : null,
    ignoredEpisodes: ignored,
    awakeIncludesDurationOnly: hasDurationOnly,
  };
}
