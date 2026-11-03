import { LifeEvent, Observation, ObservationTag } from '@babysleep/contract';
import type { ObservationMomentT, ObservationT } from '@babysleep/contract';
import { toIso } from '@babysleep/core';
import type { Ctx } from './context';
import { DomainError } from './context';
import { insertRow, newRow, softDelete, updateRow } from './write';

export type ObservationTarget = { sessionId: string } | { attemptId: string } | { feedingId: string };

const targetFields = (t: ObservationTarget) =>
  'sessionId' in t
    ? { session_id: t.sessionId, settling_attempt_id: null, feeding_id: null }
    : 'attemptId' in t
      ? { session_id: null, settling_attempt_id: t.attemptId, feeding_id: null }
      : { session_id: null, settling_attempt_id: null, feeding_id: t.feedingId };

export async function findObservation(ctx: Ctx, target: ObservationTarget, moment: ObservationMomentT) {
  const rows =
    'sessionId' in target
      ? await ctx.db.observation.where('session_id').equals(target.sessionId).toArray()
      : 'attemptId' in target
        ? await ctx.db.observation.where('settling_attempt_id').equals(target.attemptId).toArray()
        : await ctx.db.observation.where('feeding_id').equals(target.feedingId).toArray();
  return rows.find((o) => o.moment === moment && o.deleted_at === null);
}

export async function tagIdsOf(ctx: Ctx, observationId: string): Promise<string[]> {
  const rels = await ctx.db.observation_tag.where('observation_id').equals(observationId).toArray();
  return rels.filter((r) => r.deleted_at === null).map((r) => r.tag_id);
}

/**
 * Guarda (crea o actualiza) la observación de un momento, con etiquetas opcionales y
 * texto libre. Las notas nunca son obligatorias y pueden añadirse después. Las
 * etiquetas quitadas se marcan con borrado lógico (tombstone), no se destruyen.
 */
export async function saveObservation(
  ctx: Ctx,
  input: { target: ObservationTarget; moment: ObservationMomentT; text: string; tagIds: string[] },
): Promise<ObservationT | null> {
  const text = input.text.trim();
  const existing = await findObservation(ctx, input.target, input.moment);
  if (existing === undefined && text === '' && input.tagIds.length === 0) return null;

  const obs =
    existing === undefined
      ? await insertRow(
          ctx.db.observation,
          Observation,
          Observation.parse({
            ...newRow(ctx),
            ...targetFields(input.target),
            moment: input.moment,
            occurred_utc: toIso(ctx.now()),
            note_text: text === '' ? null : text,
          }),
        )
      : await updateRow(ctx, ctx.db.observation, Observation, existing.id, { note_text: text === '' ? null : text });

  const rels = await ctx.db.observation_tag.where('observation_id').equals(obs.id).toArray();
  const wanted = new Set(input.tagIds);
  for (const r of rels) {
    const active = r.deleted_at === null;
    if (active && !wanted.has(r.tag_id)) await softDelete(ctx, ctx.db.observation_tag, ObservationTag, r.id);
    if (!active && wanted.has(r.tag_id)) await updateRow(ctx, ctx.db.observation_tag, ObservationTag, r.id, { deleted_at: null });
    wanted.delete(r.tag_id);
  }
  for (const tagId of wanted) {
    if (rels.some((r) => r.tag_id === tagId)) continue;
    await insertRow(
      ctx.db.observation_tag,
      ObservationTag,
      ObservationTag.parse({ ...newRow(ctx), observation_id: obs.id, tag_id: tagId }),
    );
  }
  return obs;
}

export async function listTags(ctx: Ctx) {
  const tags = await ctx.db.tag.toArray();
  return tags.filter((t) => t.deleted_at === null && !t.archived);
}

// ------------------------------------------------------ diario de acontecimientos

export async function addLifeEvent(
  ctx: Ctx,
  input: { babyId: string | null; categoryId: string; startDate: string; endDate?: string | null; description?: string },
) {
  if (input.endDate != null && input.endDate < input.startDate) {
    throw new DomainError('invalid_range', 'La fecha de fin no puede ser anterior a la de inicio');
  }
  return insertRow(
    ctx.db.life_event,
    LifeEvent,
    LifeEvent.parse({
      ...newRow(ctx),
      baby_id: input.babyId,
      category_id: input.categoryId,
      start_date: input.startDate,
      end_date: input.endDate ?? null,
      description: input.description?.trim() || null,
      notes: null,
    }),
  );
}

export async function listLifeEvents(ctx: Ctx, babyId: string) {
  const rows = await ctx.db.life_event.toArray();
  return rows
    .filter((e) => e.deleted_at === null && (e.baby_id === null || e.baby_id === babyId))
    .sort((a, b) => b.start_date.localeCompare(a.start_date));
}

export const deleteLifeEvent = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.life_event, LifeEvent, id);
