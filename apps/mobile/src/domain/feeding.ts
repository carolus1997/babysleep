import { Feeding } from '@babysleep/contract';
import type { BreastSideT, FeedingT, FeedTypeT } from '@babysleep/contract';
import { localDate, MS_PER_MIN, parseInstant, toIso } from '@babysleep/core';
import type { Ctx } from './context';
import { DomainError } from './context';
import { localToMs } from './sleep';
import { insertRow, newRow, restoreRow, softDelete, updateRow } from './write';

export const FEED_TYPES: readonly FeedTypeT[] = ['breast', 'bottle', 'mixed', 'solids'];

/** ¿La toma lleva pecho? (pecho o pecho y biberón). */
export const hasBreast = (type: FeedTypeT): boolean => type === 'breast' || type === 'mixed';
/** ¿La toma lleva biberón? (biberón o pecho y biberón). */
export const hasBottle = (type: FeedTypeT): boolean => type === 'bottle' || type === 'mixed';
export const MAX_MANUAL_MINUTES = 240;

// ------------------------------------------------------------ consultas

export async function listFeedings(ctx: Ctx, babyId: string, opts: { includeDeleted?: boolean } = {}): Promise<FeedingT[]> {
  const rows = await ctx.db.feeding.where('baby_id').equals(babyId).toArray();
  return rows.filter((f) => opts.includeDeleted === true || f.deleted_at === null).sort((a, b) => a.start_utc.localeCompare(b.start_utc));
}

/**
 * ¿Es una toma EN CURSO (cronómetro)? Solo lo es la que se inició con el cronómetro y aún no tiene fin. Una toma
 * anotada a mano o importada sin fin es una toma con duración DESCONOCIDA (no en curso, y nunca 0 minutos).
 */
export const isRunning = (f: Pick<FeedingT, 'end_utc' | 'source' | 'deleted_at'>): boolean =>
  f.end_utc === null && f.source === 'timer' && f.deleted_at === null;

export async function getOpenFeeding(ctx: Ctx, babyId: string): Promise<FeedingT | undefined> {
  const rows = await ctx.db.feeding.where('baby_id').equals(babyId).toArray();
  return rows.filter(isRunning).sort((a, b) => b.start_utc.localeCompare(a.start_utc))[0];
}

// --------------------------------------------------------- validaciones

/** El pecho solo en una toma con pecho y los ml solo en una con biberón; con mensajes en español. */
function checkDetails(type: FeedTypeT, side: BreastSideT | null | undefined, amountMl: number | null | undefined): void {
  if (side != null && !hasBreast(type)) throw new DomainError('invalid', 'El pecho solo se indica en una toma con pecho');
  if (amountMl != null) {
    if (!hasBottle(type)) throw new DomainError('invalid', 'Los ml solo se indican en una toma con biberón');
    if (!Number.isInteger(amountMl) || amountMl < 1 || amountMl > 500) throw new DomainError('invalid', 'La cantidad debe estar entre 1 y 500 ml');
  }
}

// ------------------------------------------------------------ cronómetro

/** «Iniciar toma»: abre una toma en curso. Solo puede haber una abierta por bebé (se devuelve la existente). */
export async function startFeeding(ctx: Ctx, babyId: string, type: FeedTypeT, opts: { side?: BreastSideT } = {}): Promise<FeedingT> {
  const open = await getOpenFeeding(ctx, babyId);
  if (open !== undefined) return open;
  checkDetails(type, opts.side, null);
  return insertRow(
    ctx.db.feeding,
    Feeding,
    Feeding.parse({
      ...newRow(ctx),
      baby_id: babyId,
      feed_type: type,
      start_utc: toIso(ctx.now()),
      start_tz: ctx.zone,
      start_quality: 'exact',
      end_utc: null,
      end_tz: null,
      end_quality: null,
      breast_side: opts.side ?? null,
      amount_ml: null,
      source: 'timer',
    }),
  );
}

/** «Terminar toma»: cierra la toma en curso y, si se sabe, anota el pecho (pecho) o los ml (biberón). */
export async function finishFeeding(
  ctx: Ctx,
  id: string,
  details: { side?: BreastSideT | null; amountMl?: number | null } = {},
): Promise<FeedingT> {
  const f = await ctx.db.feeding.get(id);
  if (f === undefined) throw new DomainError('not_found', 'Toma inexistente');
  if (!isRunning(f)) return f;
  const endMs = ctx.now();
  if (endMs <= parseInstant(f.start_utc)) throw new DomainError('invalid_range', 'El fin debe ser posterior al inicio');
  const side = details.side === undefined ? f.breast_side : details.side;
  const amount = details.amountMl === undefined ? f.amount_ml : details.amountMl;
  checkDetails(f.feed_type, side, amount);
  return updateRow(ctx, ctx.db.feeding, Feeding, id, {
    end_utc: toIso(endMs),
    end_tz: ctx.zone,
    end_quality: 'exact',
    breast_side: side,
    amount_ml: amount,
  });
}

/** Qué ha tomado → tipo guardado: pecho y biberón = «mixta»; los sólidos van solos. `null` si no se ha elegido nada. */
export function composeFeedType(w: { breast: boolean; bottle: boolean; solids: boolean }): FeedTypeT | null {
  if (w.solids) return 'solids';
  if (w.breast && w.bottle) return 'mixed';
  if (w.breast) return 'breast';
  if (w.bottle) return 'bottle';
  return null;
}

/** Pechos usados → lado guardado: los dos = «ambos». */
export function composeSide(left: boolean, right: boolean): BreastSideT | null {
  return left && right ? 'both' : left ? 'left' : right ? 'right' : null;
}

/**
 * «Terminar toma» eligiendo a la vez qué ha tomado: cierra la toma en curso con su tipo, pecho y ml definitivos
 * (el cronómetro se arranca sin preguntar nada). Lo que el tipo no admite se descarta.
 */
export async function finishFeedingAs(
  ctx: Ctx,
  id: string,
  d: { type: FeedTypeT; side?: BreastSideT | null; amountMl?: number | null },
): Promise<FeedingT> {
  const f = await ctx.db.feeding.get(id);
  if (f === undefined) throw new DomainError('not_found', 'Toma inexistente');
  if (!isRunning(f)) return f;
  const endMs = ctx.now();
  if (endMs <= parseInstant(f.start_utc)) throw new DomainError('invalid_range', 'El fin debe ser posterior al inicio');
  const side = hasBreast(d.type) ? (d.side ?? null) : null;
  const amount = hasBottle(d.type) ? (d.amountMl ?? null) : null;
  checkDetails(d.type, side, amount);
  return updateRow(ctx, ctx.db.feeding, Feeding, id, {
    feed_type: d.type,
    end_utc: toIso(endMs),
    end_tz: ctx.zone,
    end_quality: 'exact',
    breast_side: side,
    amount_ml: amount,
  });
}

/** Descarta una toma en curso que no llegó a ocurrir (papelera; se puede recuperar). */
export async function cancelFeeding(ctx: Ctx, id: string): Promise<FeedingT> {
  const f = await ctx.db.feeding.get(id);
  if (f === undefined) throw new DomainError('not_found', 'Toma inexistente');
  if (!isRunning(f)) throw new DomainError('invalid', 'Solo se cancela una toma en curso');
  return softDelete(ctx, ctx.db.feeding, Feeding, id);
}

// ----------------------------------------------------------- registro manual

export interface ManualFeedingInput {
  babyId: string;
  type: FeedTypeT;
  /** Hora local de pared `YYYY-MM-DDTHH:mm` en la zona de referencia. */
  startLocal: string;
  /** Duración en minutos (1–240). Opcional: si no se sabe queda VACÍA (sin fin, nunca 0 ni un fin inventado). */
  durationMin?: number | null;
  startChoice?: 0 | 1;
  side?: BreastSideT | null;
  amountMl?: number | null;
}

export async function addManualFeeding(ctx: Ctx, input: ManualFeedingInput): Promise<FeedingT> {
  const dur = input.durationMin ?? null;
  if (dur !== null && (!Number.isInteger(dur) || dur < 1 || dur > MAX_MANUAL_MINUTES)) {
    throw new DomainError('invalid_range', `La duración debe estar entre 1 y ${MAX_MANUAL_MINUTES} minutos`);
  }
  checkDetails(input.type, input.side, input.amountMl);
  const start = localToMs(input.startLocal, ctx.zone, input.startChoice);
  return insertRow(
    ctx.db.feeding,
    Feeding,
    Feeding.parse({
      ...newRow(ctx),
      baby_id: input.babyId,
      feed_type: input.type,
      start_utc: toIso(start),
      start_tz: ctx.zone,
      start_quality: 'approx',
      end_utc: dur === null ? null : toIso(start + dur * MS_PER_MIN),
      end_tz: dur === null ? null : ctx.zone,
      end_quality: dur === null ? null : 'approx',
      breast_side: input.side ?? null,
      amount_ml: input.amountMl ?? null,
      source: 'manual',
    }),
  );
}

// ------------------------------------------------------------------ edición

export interface FeedingPatch {
  type?: FeedTypeT;
  startMs?: number;
  endMs?: number | null;
  side?: BreastSideT | null;
  amountMl?: number | null;
}

/**
 * Edita una toma manteniéndola coherente: al cambiar el tipo se quita lo que ya no aplica (el pecho de un
 * biberón, los ml de una toma de pecho; pasar a pecho y biberón conserva ambos) y el fin no puede quedar antes del inicio.
 */
export async function editFeeding(ctx: Ctx, id: string, patch: FeedingPatch): Promise<FeedingT> {
  const cur = await ctx.db.feeding.get(id);
  if (cur === undefined) throw new DomainError('not_found', 'Toma inexistente');
  const type = patch.type ?? cur.feed_type;
  const start = patch.startMs ?? parseInstant(cur.start_utc);
  const end = patch.endMs === undefined ? (cur.end_utc === null ? null : parseInstant(cur.end_utc)) : patch.endMs;
  if (end !== null && end <= start) throw new DomainError('invalid_range', 'El fin debe ser posterior al inicio');

  // Lo explícito se valida tal cual; lo heredado se descarta si el nuevo tipo no lo admite.
  const side = patch.side !== undefined ? patch.side : hasBreast(type) ? cur.breast_side : null;
  const amount = patch.amountMl !== undefined ? patch.amountMl : hasBottle(type) ? cur.amount_ml : null;
  checkDetails(type, side, amount);

  const changes: Partial<FeedingT> = { feed_type: type, breast_side: side, amount_ml: amount };
  if (patch.startMs !== undefined) {
    changes.start_utc = toIso(start);
    changes.start_quality = 'approx';
  }
  if (patch.endMs !== undefined) {
    changes.end_utc = end === null ? null : toIso(end);
    changes.end_tz = end === null ? null : (cur.end_tz ?? ctx.zone);
    changes.end_quality = end === null ? null : 'approx';
  }
  return updateRow(ctx, ctx.db.feeding, Feeding, id, changes);
}

/** Corrección rápida «−5 / −10 / −15 min» del inicio. */
export async function nudgeFeedingStart(ctx: Ctx, id: string, deltaMin: number): Promise<FeedingT> {
  const cur = await ctx.db.feeding.get(id);
  if (cur === undefined) throw new DomainError('not_found', 'Toma inexistente');
  return editFeeding(ctx, id, { startMs: parseInstant(cur.start_utc) + deltaMin * MS_PER_MIN });
}

export const deleteFeeding = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.feeding, Feeding, id);
export const restoreFeeding = (ctx: Ctx, id: string) => restoreRow(ctx, ctx.db.feeding, Feeding, id);

// ------------------------------------------------------------------- resumen

export interface FeedingDay {
  count: number;
  /** Suma de los ml de los biberones del día, también los de pecho y biberón (sin cantidad no suman, no se estiman). */
  ml: number;
  /** Cuántos biberones llevan cantidad: sirve para decir «ml de 3 de 4». */
  bottlesWithAmount: number;
  bottles: number;
  /** Tiempo total de tomas cerradas con pecho (incluye pecho y biberón), en ms. */
  breastMs: number;
}

/** Resumen de las tomas que EMPEZARON en el día local indicado (`YYYY-MM-DD`). */
export function summarizeFeedings(feedings: readonly FeedingT[], dateLocal: string, zone: string): FeedingDay {
  const day = feedings.filter((f) => f.deleted_at === null && localDate(parseInstant(f.start_utc), zone) === dateLocal);
  const bottles = day.filter((f) => hasBottle(f.feed_type));
  return {
    count: day.length,
    ml: bottles.reduce((n, f) => n + (f.amount_ml ?? 0), 0),
    bottles: bottles.length,
    bottlesWithAmount: bottles.filter((f) => f.amount_ml !== null).length,
    breastMs: day
      .filter((f) => hasBreast(f.feed_type) && f.end_utc !== null)
      .reduce((n, f) => n + parseInstant(f.end_utc as string) - parseInstant(f.start_utc), 0),
  };
}

/** Última toma (la que empezó más tarde) y cuánto hace de su fin (o de su inicio, si sigue en curso). */
export function lastFeeding(feedings: readonly FeedingT[], nowMs: number): { feeding: FeedingT; sinceMs: number } | null {
  const live = feedings.filter((f) => f.deleted_at === null);
  const last = [...live].sort((a, b) => b.start_utc.localeCompare(a.start_utc))[0];
  if (last === undefined) return null;
  const ref = parseInstant(last.end_utc ?? last.start_utc);
  return { feeding: last, sinceMs: Math.max(0, nowMs - ref) };
}
