/**
 * «Modo de sueño»: lo que se elige antes de que se duerma (siesta o noche, y cómo se duerme: en brazos, porteo…).
 * Si se elige «Prepararlo para dormir», esa elección espera hasta el «Ya duerme» y se guarda solo en este móvil
 * (no es un dato de la familia: se aplica al sueño real cuando empieza y desaparece).
 */

/** Cómo se duerme, en el orden en que se ofrecen: son etiquetas de «al dormirse» del catálogo de sistema. */
export const SLEEP_HOW_SLUGS: readonly string[] = [
  'onset.in_arms',
  'onset.babywearing',
  'onset.in_crib',
  'onset.during_walk',
  'onset.in_car',
  'onset.after_feeding',
];

/** Las que además existen entre las etiquetas de «conciliación» (la preparación guarda estas). */
export const SETTLING_FROM_ONSET: Readonly<Record<string, string>> = {
  'onset.in_arms': 'settling.in_arms',
  'onset.babywearing': 'settling.babywearing',
  'onset.after_feeding': 'settling.after_feeding',
};

/** Lo que se ofrece mientras se prepara: cómo va (etiquetas de «conciliación» existentes). */
export const SETTLING_CHIP_SLUGS: readonly string[] = [
  'settling.babywearing',
  'settling.in_arms',
  'settling.crying',
  'settling.restless',
  'settling.very_tired',
  'settling.after_feeding',
];

/** Inversa de `SETTLING_FROM_ONSET`: al pasar de preparar a dormir, lo que ayudó se vuelve «cómo se durmió». */
export const ONSET_FROM_SETTLING: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(SETTLING_FROM_ONSET).map(([o, s]) => [s, o]));

export interface SleepIntent {
  attemptId: string;
  type: 'nap' | 'night';
  /** Etiquetas de «al dormirse» elegidas (por `slug`). */
  onsetSlugs: string[];
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const INTENT_KEY = 'bs-sleep-intent';
const LAST_KEY = 'bs-last-onset';

function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson(key: string, s: Store | null): unknown {
  try {
    const raw = s?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const isSlugList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Cómo se durmió la última vez (se ofrece preseleccionado; solo slugs que hoy se ofrecen). */
export function loadLastOnset(s: Store | null = defaultStore()): string[] {
  const v = readJson(LAST_KEY, s);
  return isSlugList(v) ? v.filter((x) => SLEEP_HOW_SLUGS.includes(x)) : [];
}

export function saveLastOnset(slugs: readonly string[], s: Store | null = defaultStore()): void {
  try {
    s?.setItem(LAST_KEY, JSON.stringify(slugs));
  } catch {
    /* sin almacenamiento: no se recuerda */
  }
}

export function saveIntent(i: SleepIntent, s: Store | null = defaultStore()): void {
  try {
    s?.setItem(INTENT_KEY, JSON.stringify(i));
  } catch {
    /* sin almacenamiento: se usará la sugerencia por la hora */
  }
}

/** La elección pendiente de ese intento de dormirlo, o `null` (otro intento, otro móvil o datos borrados). */
export function loadIntent(attemptId: string, s: Store | null = defaultStore()): SleepIntent | null {
  const v = readJson(INTENT_KEY, s) as Partial<SleepIntent> | null;
  if (v === null || typeof v !== 'object' || v.attemptId !== attemptId) return null;
  if (v.type !== 'nap' && v.type !== 'night') return null;
  return { attemptId, type: v.type, onsetSlugs: isSlugList(v.onsetSlugs) ? v.onsetSlugs : [] };
}

export function clearIntent(s: Store | null = defaultStore()): void {
  try {
    s?.removeItem(INTENT_KEY);
  } catch {
    /* nada que limpiar */
  }
}
