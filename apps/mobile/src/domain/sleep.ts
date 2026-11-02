import { SettlingAttempt, SleepSession } from '@babysleep/contract';
import type { SettlingAttemptT, SleepSessionT } from '@babysleep/contract';
import { MS_PER_HOUR, MS_PER_MIN, parseInstant, resolveLocal, suggestSleepType, toIso } from '@babysleep/core';
import type { Ctx } from './context';
import { DomainError } from './context';
import { insertRow, newRow, restoreRow, softDelete, updateRow } from './write';

/** Un intento abierto con más de 6 h se considera caducado y se abandona al iniciar sueño. */
export const STALE_ATTEMPT_MS = 6 * MS_PER_HOUR;

// ------------------------------------------------------------ consultas

export async function listSessions(ctx: Ctx, babyId: string, opts: { includeDeleted?: boolean } = {}) {
  const rows = await ctx.db.sleep_session.where('baby_id').equals(babyId).toArray();
  return rows
    .filter((s) => opts.includeDeleted === true || s.deleted_at === null)
    .sort((a, b) => a.sleep_start_utc.localeCompare(b.sleep_start_utc));
}

export async function getOpenSession(ctx: Ctx, babyId: string): Promise<SleepSessionT | undefined> {
  const rows = await ctx.db.sleep_session.where('baby_id').equals(babyId).toArray();
  return rows
    .filter((s) => s.sleep_end_utc === null && s.deleted_at === null)
    .sort((a, b) => b.sleep_start_utc.localeCompare(a.sleep_start_utc))[0];
}

export async function getOpenAttempt(ctx: Ctx, babyId: string): Promise<SettlingAttemptT | undefined> {
  const rows = await ctx.db.settling_attempt.where('baby_id').equals(babyId).toArray();
  return rows
    .filter((a) => a.status === 'open' && a.deleted_at === null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

// ----------------------------------------------------------- conciliación

/** «Empezar a dormirlo»: registra el inicio del intento (opcional y rápido). */
export async function startSettling(ctx: Ctx, babyId: string): Promise<SettlingAttemptT> {
  const open = await getOpenAttempt(ctx, babyId);
  if (open !== undefined && ctx.now() - Date.parse(open.created_at) <= STALE_ATTEMPT_MS) return open;
  if (open !== undefined) await updateRow(ctx, ctx.db.settling_attempt, SettlingAttempt, open.id, { status: 'abandoned' });
  return insertRow(
    ctx.db.settling_attempt,
    SettlingAttempt,
    SettlingAttempt.parse({
      ...newRow(ctx),
      baby_id: babyId,
      started_utc: toIso(ctx.now()),
      put_down_utc: null,
      started_quality: 'exact',
      put_down_quality: null,
      tz: ctx.zone,
      status: 'open',
    }),
  );
}

/** «Colocado en la cuna». No interviene en la latencia. */
export function markPutDown(ctx: Ctx, attemptId: string) {
  return updateRow(ctx, ctx.db.settling_attempt, SettlingAttempt, attemptId, {
    put_down_utc: toIso(ctx.now()),
    put_down_quality: 'exact',
  });
}

export function cancelSettling(ctx: Ctx, attemptId: string) {
  return updateRow(ctx, ctx.db.settling_attempt, SettlingAttempt, attemptId, { status: 'abandoned' });
}

/** Deshace «No quiere dormir» sobre un intento, salvo que ya haya otro abierto. */
export async function reopenSettling(ctx: Ctx, attemptId: string) {
  const attempt = await ctx.db.settling_attempt.get(attemptId);
  if (attempt === undefined) throw new DomainError('not_found', 'Intento inexistente');
  const open = await getOpenAttempt(ctx, attempt.baby_id);
  if (open !== undefined && open.id !== attemptId) throw new DomainError('invalid', 'Ya hay otro intento abierto');
  return updateRow(ctx, ctx.db.settling_attempt, SettlingAttempt, attemptId, { status: 'open' });
}

/** Añade o corrige a posteriori la hora de inicio del intento (aproximada). */
export function setAttemptStart(ctx: Ctx, attemptId: string, startedMs: number | null) {
  return updateRow(ctx, ctx.db.settling_attempt, SettlingAttempt, attemptId, {
    started_utc: startedMs === null ? null : toIso(startedMs),
    started_quality: startedMs === null ? null : 'approx',
  });
}

// ------------------------------------------------------------------ sueño

/**
 * «Iniciar sueño» = hemos comprobado que el bebé está dormido (siestas y noche por
 * igual). Si hay un intento abierto y reciente, se enlaza automáticamente.
 */
export async function startSleep(ctx: Ctx, babyId: string): Promise<SleepSessionT> {
  const existing = await getOpenSession(ctx, babyId);
  if (existing !== undefined) return existing;

  const nowMs = ctx.now();
  let attemptId: string | null = null;
  const attempt = await getOpenAttempt(ctx, babyId);
  if (attempt !== undefined) {
    if (nowMs - Date.parse(attempt.created_at) <= STALE_ATTEMPT_MS) {
      attemptId = attempt.id;
      await updateRow(ctx, ctx.db.settling_attempt, SettlingAttempt, attempt.id, { status: 'linked' });
    } else {
      await updateRow(ctx, ctx.db.settling_attempt, SettlingAttempt, attempt.id, { status: 'abandoned' });
    }
  }

  return insertRow(
    ctx.db.sleep_session,
    SleepSession,
    SleepSession.parse({
      ...newRow(ctx),
      baby_id: babyId,
      sleep_start_utc: toIso(nowMs),
      sleep_end_utc: null,
      start_tz: ctx.zone,
      end_tz: null,
      start_quality: 'exact',
      end_quality: null,
      sleep_type: suggestSleepType(nowMs, ctx.zone),
      type_source: 'auto',
      settling_attempt_id: attemptId,
      merged_into: null,
      source: 'timer',
    }),
  );
}

export async function finishSleep(ctx: Ctx, sessionId: string): Promise<SleepSessionT> {
  const s = await ctx.db.sleep_session.get(sessionId);
  if (s === undefined) throw new DomainError('not_found', 'Sesión inexistente');
  if (s.sleep_end_utc !== null) return s;
  const endMs = ctx.now();
  if (endMs <= parseInstant(s.sleep_start_utc)) throw new DomainError('invalid_range', 'El fin debe ser posterior al inicio');
  return updateRow(ctx, ctx.db.sleep_session, SleepSession, sessionId, {
    sleep_end_utc: toIso(endMs),
    end_tz: ctx.zone,
    end_quality: 'exact',
  });
}

/**
 * «No llegó a dormirse»: se inició el sueño pero el bebé se despertó y no durmió. La sesión
 * pasa a la papelera (reversible) y no cuenta en ninguna estadística; el intento enlazado
 * vuelve a `abandoned`, de modo que el intento fallido se conserva como tal.
 */
export async function cancelSleep(ctx: Ctx, sessionId: string): Promise<SleepSessionT> {
  const s = await ctx.db.sleep_session.get(sessionId);
  if (s === undefined) throw new DomainError('not_found', 'Sesión inexistente');
  if (s.sleep_end_utc !== null) throw new DomainError('invalid', 'Solo se cancela un sueño en curso');
  if (s.deleted_at !== null) return s;
  return ctx.db.transaction('rw', ctx.db.tables, async () => {
    const deleted = await softDelete(ctx, ctx.db.sleep_session, SleepSession, sessionId);
    if (s.settling_attempt_id !== null) {
      await updateRow(ctx, ctx.db.settling_attempt, SettlingAttempt, s.settling_attempt_id, { status: 'abandoned' });
    }
    return deleted;
  });
}

/** Deshace `cancelSleep`: devuelve la sesión y vuelve a enlazar su intento. */
export async function undoCancelSleep(ctx: Ctx, sessionId: string): Promise<SleepSessionT> {
  const s = await ctx.db.sleep_session.get(sessionId);
  if (s === undefined) throw new DomainError('not_found', 'Sesión inexistente');
  if (s.deleted_at === null) return s;
  if (s.sleep_end_utc === null && (await getOpenSession(ctx, s.baby_id)) !== undefined) {
    throw new DomainError('invalid', 'Ya hay otro sueño en curso');
  }
  return ctx.db.transaction('rw', ctx.db.tables, async () => {
    const restored = await restoreRow(ctx, ctx.db.sleep_session, SleepSession, sessionId);
    if (s.settling_attempt_id !== null) {
      await updateRow(ctx, ctx.db.settling_attempt, SettlingAttempt, s.settling_attempt_id, { status: 'linked' });
    }
    return restored;
  });
}

// ----------------------------------------------------------- registro manual

export interface ManualInput {
  babyId: string;
  /** Hora local de pared `YYYY-MM-DDTHH:mm` en la zona de referencia. */
  startLocal: string;
  endLocal: string;
  type: 'nap' | 'night';
  /** Elección ante una hora ambigua (retroceso de otoño): 0 = primera, 1 = segunda. */
  startChoice?: 0 | 1;
  endChoice?: 0 | 1;
}

/** Hora local de pared → instante, o `DomainError` si es inexistente o ambigua sin elección. */
export function localToMs(local: string, zone: string, choice?: 0 | 1): number {
  return resolveOrThrow(local, zone, choice);
}

function resolveOrThrow(local: string, zone: string, choice: 0 | 1 | undefined): number {
  const r = resolveLocal(local, zone);
  if (r.status === 'ok') return r.ms;
  if (r.status === 'nonexistent') {
    throw new DomainError('nonexistent_time', `La hora ${local} no existe en ${zone} (salto de hora)`);
  }
  if (choice === undefined) {
    throw new DomainError('ambiguous_time', `La hora ${local} es ambigua en ${zone}; elige cuál`);
  }
  return r.candidates[choice];
}

export async function addManualSession(ctx: Ctx, input: ManualInput): Promise<SleepSessionT> {
  const start = resolveOrThrow(input.startLocal, ctx.zone, input.startChoice);
  const end = resolveOrThrow(input.endLocal, ctx.zone, input.endChoice);
  if (end <= start) throw new DomainError('invalid_range', 'El fin debe ser posterior al inicio');
  return insertRow(
    ctx.db.sleep_session,
    SleepSession,
    SleepSession.parse({
      ...newRow(ctx),
      baby_id: input.babyId,
      sleep_start_utc: toIso(start),
      sleep_end_utc: toIso(end),
      start_tz: ctx.zone,
      end_tz: ctx.zone,
      start_quality: 'approx',
      end_quality: 'approx',
      sleep_type: input.type,
      type_source: 'manual',
      settling_attempt_id: null,
      merged_into: null,
      source: 'manual',
    }),
  );
}

// ------------------------------------------------------------------ edición

export interface SessionPatch {
  startMs?: number;
  endMs?: number | null;
  type?: 'nap' | 'night';
  awakeningsCompleteness?: SleepSessionT['awakenings_completeness'];
}

export async function editSession(ctx: Ctx, id: string, patch: SessionPatch): Promise<SleepSessionT> {
  const cur = await ctx.db.sleep_session.get(id);
  if (cur === undefined) throw new DomainError('not_found', 'Sesión inexistente');
  const start = patch.startMs ?? parseInstant(cur.sleep_start_utc);
  const end = patch.endMs === undefined ? (cur.sleep_end_utc === null ? null : parseInstant(cur.sleep_end_utc)) : patch.endMs;
  if (end !== null && end <= start) throw new DomainError('invalid_range', 'El fin debe ser posterior al inicio');

  const changes: Partial<SleepSessionT> = {};
  if (patch.startMs !== undefined) {
    changes.sleep_start_utc = toIso(start);
    changes.start_quality = 'approx';
  }
  if (patch.endMs !== undefined) {
    changes.sleep_end_utc = end === null ? null : toIso(end);
    changes.end_tz = end === null ? null : (cur.end_tz ?? ctx.zone);
    changes.end_quality = end === null ? null : 'approx';
  }
  if (patch.type !== undefined) {
    changes.sleep_type = patch.type;
    changes.type_source = 'manual';
  }
  if (patch.awakeningsCompleteness !== undefined) changes.awakenings_completeness = patch.awakeningsCompleteness;
  return updateRow(ctx, ctx.db.sleep_session, SleepSession, id, changes);
}

/** Corrección rápida «−5 / −10 / −15 min» del inicio o del fin, sin abrir un selector de hora. */
export async function nudgeTime(ctx: Ctx, id: string, which: 'start' | 'end', deltaMin: number): Promise<SleepSessionT> {
  const cur = await ctx.db.sleep_session.get(id);
  if (cur === undefined) throw new DomainError('not_found', 'Sesión inexistente');
  if (which === 'start') return editSession(ctx, id, { startMs: parseInstant(cur.sleep_start_utc) + deltaMin * MS_PER_MIN });
  if (cur.sleep_end_utc === null) throw new DomainError('invalid', 'La sesión sigue abierta');
  return editSession(ctx, id, { endMs: parseInstant(cur.sleep_end_utc) + deltaMin * MS_PER_MIN });
}

export const deleteSession = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.sleep_session, SleepSession, id);
export const restoreSession = (ctx: Ctx, id: string) => restoreRow(ctx, ctx.db.sleep_session, SleepSession, id);
