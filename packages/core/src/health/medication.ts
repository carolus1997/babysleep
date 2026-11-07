/**
 * Medicación: solo cuentas sobre lo que la familia anotó. Nada de esto propone una dosis ni un intervalo:
 * la pauta (nombre, dosis, cada cuánto, máximo diario) la escribe la familia a partir de la receta.
 */
import { MS_PER_MIN } from '../time/zone';

export interface MedLike {
  start_utc: string;
  end_utc: string | null;
  interval_min: number | null;
  daily_max: number | null;
}

export interface DoseLike {
  given_utc: string;
}

/** Sin intervalo pautado, dos dosis con menos de este tiempo entre sí se señalan como seguidas. */
export const CLOSE_DOSE_MIN = 30;

const ms = (iso: string): number => Date.parse(iso);

/** El tratamiento ya empezó y no ha terminado. */
export function isActive(med: Pick<MedLike, 'start_utc' | 'end_utc'>, nowMs: number): boolean {
  return ms(med.start_utc) <= nowMs && (med.end_utc === null || ms(med.end_utc) > nowMs);
}

/** Última dosis dada (la de hora más reciente), o `null`. */
export function lastDose<D extends DoseLike>(doses: readonly D[]): D | null {
  let best: D | null = null;
  for (const d of doses) if (best === null || ms(d.given_utc) > ms(best.given_utc)) best = d;
  return best;
}

/** Dosis dadas en las 24 h anteriores a `nowMs` (la más antigua cuenta si cae justo en el límite por dentro). */
export function dosesInLast24h(doses: readonly DoseLike[], nowMs: number): number {
  return doses.filter((d) => ms(d.given_utc) <= nowMs && ms(d.given_utc) > nowMs - 24 * 60 * MS_PER_MIN).length;
}

export interface NextDue {
  /** Instante en que toca la siguiente dosis, según la pauta que escribió la familia. */
  dueMs: number;
  /** Minutos que faltan; negativo si ya pasó la hora. */
  minutesLeft: number;
}

/**
 * Cuándo toca la siguiente dosis: la última dada + el intervalo; si no hay ninguna, el inicio del tratamiento.
 * `null` si no hay intervalo (a demanda), si el tratamiento terminó o si aún no ha empezado.
 */
export function nextDue(med: MedLike, doses: readonly DoseLike[], nowMs: number): NextDue | null {
  if (med.interval_min === null || !isActive(med, nowMs)) return null;
  const last = lastDose(doses);
  const dueMs = last === null ? ms(med.start_utc) : ms(last.given_utc) + med.interval_min * MS_PER_MIN;
  return { dueMs, minutesLeft: Math.round((dueMs - nowMs) / MS_PER_MIN) };
}

export type DoseWarning =
  | { kind: 'recent'; minutesAgo: number; intervalMin: number | null }
  | { kind: 'daily_max'; count: number; max: number };

/**
 * Qué decir ANTES de registrar una dosis (hechos, sin recomendar nada):
 *  - ya hay una dosis anotada hace menos del intervalo pautado (o hace menos de 30 min si no hay intervalo);
 *  - ya se han anotado tantas dosis en las últimas 24 h como el máximo diario escrito.
 * Cada aviso se muestra con la opción de registrar de todos modos: la decisión es de la familia.
 */
export function checkBeforeDose(med: MedLike, doses: readonly DoseLike[], atMs: number): DoseWarning[] {
  const out: DoseWarning[] = [];
  const last = lastDose(doses.filter((d) => ms(d.given_utc) <= atMs));
  if (last !== null) {
    const minutesAgo = Math.round((atMs - ms(last.given_utc)) / MS_PER_MIN);
    const gap = med.interval_min ?? CLOSE_DOSE_MIN;
    if (minutesAgo < gap) out.push({ kind: 'recent', minutesAgo, intervalMin: med.interval_min });
  }
  if (med.daily_max !== null) {
    const count = dosesInLast24h(doses, atMs);
    if (count >= med.daily_max) out.push({ kind: 'daily_max', count, max: med.daily_max });
  }
  return out;
}

/**
 * Dosis seguidas entre sí: si dos móviles sin conexión registran la misma dosis, al sincronizar quedan dos con pocos
 * minutos de diferencia. No se borra nada: se devuelven los ids para señalarlo como un hecho («2 dosis con 4 min de
 * diferencia») y que una persona decida.
 */
export function closeDoseIds<D extends DoseLike & { id: string }>(doses: readonly D[], gapMin: number = CLOSE_DOSE_MIN): Set<string> {
  const sorted = [...doses].sort((a, b) => ms(a.given_utc) - ms(b.given_utc));
  const out = new Set<string>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (ms(cur.given_utc) - ms(prev.given_utc) < gapMin * MS_PER_MIN) {
      out.add(prev.id);
      out.add(cur.id);
    }
  }
  return out;
}
