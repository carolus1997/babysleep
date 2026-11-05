import { Awakening, SleepSession } from '@babysleep/contract';
import type { AwakeningReasonT, AwakeningT, BabyT, SleepSessionT } from '@babysleep/contract';
import { DEFAULT_AWAKENING_THRESHOLD_MS, MS_PER_MIN, parseInstant, toIso } from '@babysleep/core';
import type { Ctx } from './context';
import { DomainError } from './context';
import { localToMs } from './sleep';
import { insertRow, newRow, restoreRow, softDelete, updateRow } from './write';

export const AWAKENING_REASONS: readonly AwakeningReasonT[] = ['feeding', 'diaper', 'crying', 'other'];
export const MAX_AWAKENING_MINUTES = 600;

/** Umbral del bebé en ms: desde esa duración un despertar se descuenta del sueño (por defecto 30 min). */
export const thresholdMs = (baby: Pick<BabyT, 'awakening_threshold_min'> | undefined): number =>
  baby?.awakening_threshold_min == null ? DEFAULT_AWAKENING_THRESHOLD_MS : baby.awakening_threshold_min * MS_PER_MIN;

// ------------------------------------------------------------ consultas

export async function listAwakenings(ctx: Ctx, babyId: string): Promise<AwakeningT[]> {
  const rows = await ctx.db.awakening.where('baby_id').equals(babyId).toArray();
  return rows.filter((a) => a.deleted_at === null).sort((a, b) => a.start_utc.localeCompare(b.start_utc));
}

export const awakeningsOf = (all: readonly AwakeningT[], sessionId: string): AwakeningT[] =>
  all.filter((a) => a.session_id === sessionId && a.deleted_at === null);

/** Despertar EN CURSO (cronómetro, sin fin). Uno sin fin y manual es de duración desconocida, no «en curso». */
export const isAwake = (a: Pick<AwakeningT, 'end_utc' | 'source' | 'deleted_at'>): boolean =>
  a.end_utc === null && a.source === 'timer' && a.deleted_at === null;

export async function getOpenAwakening(ctx: Ctx, sessionId: string): Promise<AwakeningT | undefined> {
  const rows = await ctx.db.awakening.where('session_id').equals(sessionId).toArray();
  return rows.filter(isAwake).sort((a, b) => b.start_utc.localeCompare(a.start_utc))[0];
}

// --------------------------------------------------------- validaciones

async function nightSession(ctx: Ctx, sessionId: string): Promise<SleepSessionT> {
  const s = await ctx.db.sleep_session.get(sessionId);
  if (s === undefined || s.deleted_at !== null) throw new DomainError('not_found', 'Ese descanso no existe');
  if (s.sleep_type !== 'night') throw new DomainError('invalid', 'Los despertares solo se registran en las noches');
  return s;
}

/** El despertar debe empezar dentro del descanso (de dormirse a despertar, o hasta ahora si sigue abierto). */
function checkInside(s: SleepSessionT, startMs: number, nowMs: number): void {
  const from = parseInstant(s.sleep_start_utc);
  const to = s.sleep_end_utc === null ? nowMs : parseInstant(s.sleep_end_utc);
  if (startMs < from || startMs >= to) {
    throw new DomainError('invalid_range', 'El despertar debe empezar durante la noche (entre que se durmió y se despertó)');
  }
}

/** Anotar un despertar implica que los despertares de esa noche ya no son «desconocidos»: pasan a «algunos». */
async function markPartial(ctx: Ctx, s: SleepSessionT): Promise<void> {
  if (s.awakenings_completeness === 'unknown') {
    await updateRow(ctx, ctx.db.sleep_session, SleepSession, s.id, { awakenings_completeness: 'partial' });
  }
}

const cleanReason = (r: AwakeningReasonT | null | undefined): AwakeningReasonT | null => {
  if (r == null) return null;
  if (!AWAKENING_REASONS.includes(r)) throw new DomainError('invalid', 'Motivo no válido');
  return r;
};

// ------------------------------------------------------------ cronómetro

/** «Se despertó»: abre un despertar en la noche indicada. Solo uno abierto por noche (se devuelve el existente). */
export async function startAwakening(ctx: Ctx, sessionId: string, reason?: AwakeningReasonT | null): Promise<AwakeningT> {
  const s = await nightSession(ctx, sessionId);
  const open = await getOpenAwakening(ctx, sessionId);
  if (open !== undefined) return open;
  const now = ctx.now();
  checkInside(s, now, now + 1);
  const a = await insertRow(
    ctx.db.awakening,
    Awakening,
    Awakening.parse({
      ...newRow(ctx),
      baby_id: s.baby_id,
      session_id: s.id,
      start_utc: toIso(now),
      start_tz: ctx.zone,
      start_quality: 'exact',
      end_utc: null,
      end_tz: null,
      end_quality: null,
      reason: cleanReason(reason),
      source: 'timer',
    }),
  );
  await markPartial(ctx, s);
  return a;
}

/** «Se durmió de nuevo»: cierra el despertar en curso con la hora actual. */
export async function finishAwakening(ctx: Ctx, id: string, reason?: AwakeningReasonT | null): Promise<AwakeningT> {
  const a = await ctx.db.awakening.get(id);
  if (a === undefined) throw new DomainError('not_found', 'Despertar inexistente');
  if (!isAwake(a)) return a;
  const endMs = ctx.now();
  if (endMs <= parseInstant(a.start_utc)) throw new DomainError('invalid_range', 'El fin debe ser posterior al inicio');
  const changes: Partial<AwakeningT> = { end_utc: toIso(endMs), end_tz: ctx.zone, end_quality: 'exact' };
  if (reason !== undefined) changes.reason = cleanReason(reason);
  return updateRow(ctx, ctx.db.awakening, Awakening, id, changes);
}

// ----------------------------------------------------------- registro manual

export interface ManualAwakeningInput {
  sessionId: string;
  /** Hora local de pared `YYYY-MM-DDTHH:mm`. */
  startLocal: string;
  startChoice?: 0 | 1;
  /** Duración en minutos. Opcional: si no se sabe queda VACÍA (cuenta como despertar, no descuenta tiempo). */
  durationMin?: number | null;
  reason?: AwakeningReasonT | null;
}

export async function addManualAwakening(ctx: Ctx, input: ManualAwakeningInput): Promise<AwakeningT> {
  const s = await nightSession(ctx, input.sessionId);
  const dur = input.durationMin ?? null;
  if (dur !== null && (!Number.isInteger(dur) || dur < 1 || dur > MAX_AWAKENING_MINUTES)) {
    throw new DomainError('invalid_range', `La duración debe estar entre 1 y ${MAX_AWAKENING_MINUTES} minutos`);
  }
  const start = localToMs(input.startLocal, ctx.zone, input.startChoice);
  checkInside(s, start, ctx.now());
  const a = await insertRow(
    ctx.db.awakening,
    Awakening,
    Awakening.parse({
      ...newRow(ctx),
      baby_id: s.baby_id,
      session_id: s.id,
      start_utc: toIso(start),
      start_tz: ctx.zone,
      start_quality: 'approx',
      end_utc: dur === null ? null : toIso(start + dur * MS_PER_MIN),
      end_tz: dur === null ? null : ctx.zone,
      end_quality: dur === null ? null : 'approx',
      reason: cleanReason(input.reason),
      source: 'manual',
    }),
  );
  await markPartial(ctx, s);
  return a;
}

// ------------------------------------------------------------------ edición

export interface AwakeningPatch {
  startMs?: number;
  /** `null` = duración desconocida. */
  endMs?: number | null;
  reason?: AwakeningReasonT | null;
}

export async function editAwakening(ctx: Ctx, id: string, patch: AwakeningPatch): Promise<AwakeningT> {
  const cur = await ctx.db.awakening.get(id);
  if (cur === undefined) throw new DomainError('not_found', 'Despertar inexistente');
  const start = patch.startMs ?? parseInstant(cur.start_utc);
  const end = patch.endMs === undefined ? (cur.end_utc === null ? null : parseInstant(cur.end_utc)) : patch.endMs;
  if (end !== null && end <= start) throw new DomainError('invalid_range', 'El fin debe ser posterior al inicio');
  if (patch.startMs !== undefined) {
    const s = await nightSession(ctx, cur.session_id);
    checkInside(s, start, ctx.now());
  }
  const changes: Partial<AwakeningT> = {};
  if (patch.startMs !== undefined) {
    changes.start_utc = toIso(start);
    changes.start_quality = 'approx';
  }
  if (patch.endMs !== undefined) {
    changes.end_utc = end === null ? null : toIso(end);
    changes.end_tz = end === null ? null : (cur.end_tz ?? ctx.zone);
    changes.end_quality = end === null ? null : 'approx';
    // Sin fin y de cronómetro sería «en curso»: al dejarlo sin duración pasa a manual (duración desconocida).
    if (end === null && cur.source === 'timer') changes.source = 'manual';
  }
  if (patch.reason !== undefined) changes.reason = cleanReason(patch.reason);
  return updateRow(ctx, ctx.db.awakening, Awakening, id, changes);
}

export const deleteAwakening = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.awakening, Awakening, id);
export const restoreAwakening = (ctx: Ctx, id: string) => restoreRow(ctx, ctx.db.awakening, Awakening, id);

/**
 * «Estos son todos»: la persona confirma que anotó todos los despertares de la noche (puede ser ninguno).
 * Solo las noches confirmadas entran en el promedio de despertares; el resto son «sin confirmar», nunca 0.
 */
export async function confirmAwakenings(ctx: Ctx, sessionId: string, complete: boolean): Promise<SleepSessionT> {
  const s = await nightSession(ctx, sessionId);
  const n = (await awakeningsOf(await listAwakenings(ctx, s.baby_id), s.id)).length;
  const next = complete ? 'complete' : n > 0 ? 'partial' : 'unknown';
  return updateRow(ctx, ctx.db.sleep_session, SleepSession, s.id, { awakenings_completeness: next });
}
