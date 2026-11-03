import { CONTRACT_VERSION, Baby, Caregiver, EventCategory, Family, LifeEvent, ObservationTag, Tag } from '@babysleep/contract';
import { toIso, uuidv7 } from '@babysleep/core';
import type { BabySleepDb } from '../db/schema';
import type { Ctx } from './context';
import { DomainError } from './context';
import { SEED_EVENT_CATEGORIES, SEED_TAGS } from './seed';
import { insertRow, newRow, restoreRow, softDelete, updateRow } from './write';

const PALETTE = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899', '#0ea5e9', '#84cc16'];

/**
 * Primer arranque: crea la familia local, el cuidador local, el identificador de
 * dispositivo y las etiquetas/categorías de sistema. Es idempotente.
 *
 * El cuidador local es provisional (sin cuenta). En la Fase 2 se vinculará con la
 * cuenta del progenitor mediante el procedimiento de reclamación controlada.
 */
export async function ensureBootstrap(db: BabySleepDb, now: () => number = Date.now): Promise<Ctx> {
  const done = await db.meta.get('bootstrap');
  if (done === undefined) {
    await db.transaction('rw', db.tables, async () => {
      // Se vuelve a comprobar DENTRO de la transacción: dos arranques simultáneos (React StrictMode
      // en desarrollo, dos pestañas) pasan la comprobación de arriba, pero solo el primero debe crear.
      if ((await db.meta.get('bootstrap')) !== undefined) return;
      const at = toIso(now());
      const familyId = uuidv7(now());
      const caregiverId = uuidv7(now());
      const deviceId = uuidv7(now());
      const base = {
        rev: 1,
        change_seq: null,
        created_at: at,
        updated_at: at,
        created_by: null,
        updated_by: null,
        origin_device_id: deviceId,
        deleted_at: null,
      };
      await db.family.add(
        Family.parse({ ...base, id: familyId, family_id: familyId, name: 'Mi familia', home_tz: 'Europe/Madrid' }),
      );
      await db.caregiver.add(
        Caregiver.parse({
          ...base,
          id: caregiverId,
          family_id: familyId,
          display_name: 'Progenitor A',
          email_normalized: 'local@babysleep.invalid',
          auth_user_id: null,
          role: 'admin',
          status: 'active',
        }),
      );
      await db.meta.bulkPut([
        { key: 'device_id', value: deviceId },
        { key: 'family_id', value: familyId },
        { key: 'caregiver_id', value: caregiverId },
      ]);
      const ctx: Ctx = { db, now, zone: 'Europe/Madrid', familyId, caregiverId, deviceId };
      for (const t of SEED_TAGS) {
        await insertRow(
          db.tag,
          Tag,
          Tag.parse({
            ...newRow(ctx),
            tag_slug: t.slug,
            category: t.category,
            kind: 'system',
            label_i18n: { es: t.es },
            archived: false,
          }),
        );
      }
      for (const c of SEED_EVENT_CATEGORIES) {
        await insertRow(
          db.event_category,
          EventCategory,
          EventCategory.parse({ ...newRow(ctx), slug: c.slug, kind: 'system', label_i18n: { es: c.es } }),
        );
      }
      await db.meta.put({ key: 'bootstrap', value: { at, contract_version: CONTRACT_VERSION } });
    });
  }
  db.syncEnabled = (await db.meta.get('sync_enabled'))?.value === true;
  const ctx = await loadCtx(db, now);
  await ensureSystemSeeds(ctx);
  await repairDuplicateSeeds(ctx);
  return ctx;
}

/**
 * Añade las etiquetas y categorías de sistema que falten (por `slug`). Las versiones nuevas de
 * la app pueden traer etiquetas nuevas, y la siembra del primer arranque no las crea en
 * instalaciones existentes. Es idempotente y no toca lo que ya existe.
 */
export async function ensureSystemSeeds(ctx: Ctx): Promise<number> {
  const { db } = ctx;
  let added = 0;
  await db.transaction('rw', db.tables, async () => {
    const tags = await db.tag.toArray();
    for (const t of SEED_TAGS) {
      if (tags.some((x) => x.kind === 'system' && x.tag_slug === t.slug && x.deleted_at === null)) continue;
      await insertRow(
        db.tag,
        Tag,
        Tag.parse({
          ...newRow(ctx),
          tag_slug: t.slug,
          category: t.category,
          kind: 'system',
          label_i18n: { es: t.es },
          archived: false,
        }),
      );
      added++;
    }
    const cats = await db.event_category.toArray();
    for (const c of SEED_EVENT_CATEGORIES) {
      if (cats.some((x) => x.kind === 'system' && x.slug === c.slug && x.deleted_at === null)) continue;
      await insertRow(
        db.event_category,
        EventCategory,
        EventCategory.parse({ ...newRow(ctx), slug: c.slug, kind: 'system', label_i18n: { es: c.es } }),
      );
      added++;
    }
  });
  return added;
}

/**
 * Reparación idempotente de un fallo anterior: un doble arranque simultáneo pudo crear
 * dos familias/cuidadores y dos juegos de etiquetas y categorías de sistema. No borra
 * nada: conserva una copia por `slug` (preferentemente la de la familia vigente), reapunta
 * las referencias existentes y marca las sobrantes con borrado lógico.
 */
export async function repairDuplicateSeeds(ctx: Ctx): Promise<{ tags: number; categories: number; families: number }> {
  const { db } = ctx;
  const pick = <T extends { id: string; family_id: string; created_at: string }>(rows: T[]): T =>
    [...rows].sort(
      (a, b) =>
        Number(b.family_id === ctx.familyId) - Number(a.family_id === ctx.familyId) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    )[0] as T;
  const result = { tags: 0, categories: 0, families: 0 };

  await db.transaction('rw', db.tables, async () => {
    // Etiquetas de sistema repetidas por slug
    const tags = (await db.tag.toArray()).filter((t) => t.deleted_at === null && t.kind === 'system');
    const bySlug = new Map<string, typeof tags>();
    for (const t of tags) bySlug.set(t.tag_slug, [...(bySlug.get(t.tag_slug) ?? []), t]);
    for (const group of bySlug.values()) {
      if (group.length < 2) continue;
      const keeper = pick(group);
      for (const dup of group.filter((t) => t.id !== keeper.id)) {
        for (const rel of await db.observation_tag.toArray()) {
          if (rel.tag_id !== dup.id) continue;
          const sibling = (await db.observation_tag.where('observation_id').equals(rel.observation_id).toArray()).find(
            (r) => r.tag_id === keeper.id,
          );
          if (rel.deleted_at === null && sibling === undefined) {
            await updateRow(ctx, db.observation_tag, ObservationTag, rel.id, { tag_id: keeper.id });
          } else if (rel.deleted_at === null && sibling !== undefined && sibling.deleted_at !== null) {
            await updateRow(ctx, db.observation_tag, ObservationTag, sibling.id, { deleted_at: null });
            await updateRow(ctx, db.observation_tag, ObservationTag, rel.id, { deleted_at: toIso(ctx.now()) });
          } else if (rel.deleted_at === null) {
            await updateRow(ctx, db.observation_tag, ObservationTag, rel.id, { deleted_at: toIso(ctx.now()) });
          }
        }
        await updateRow(ctx, db.tag, Tag, dup.id, { deleted_at: toIso(ctx.now()) });
        result.tags++;
      }
    }

    // Categorías de acontecimiento repetidas por slug
    const cats = (await db.event_category.toArray()).filter((c) => c.deleted_at === null && c.kind === 'system');
    const catBySlug = new Map<string, typeof cats>();
    for (const c of cats) catBySlug.set(c.slug, [...(catBySlug.get(c.slug) ?? []), c]);
    for (const group of catBySlug.values()) {
      if (group.length < 2) continue;
      const keeper = pick(group);
      for (const dup of group.filter((c) => c.id !== keeper.id)) {
        for (const ev of (await db.life_event.toArray()).filter((e) => e.category_id === dup.id)) {
          await updateRow(ctx, db.life_event, LifeEvent, ev.id, { category_id: keeper.id });
        }
        await updateRow(ctx, db.event_category, EventCategory, dup.id, { deleted_at: toIso(ctx.now()) });
        result.categories++;
      }
    }

    // Familias y cuidadores sobrantes sin ningún dato asociado
    const babies = await db.baby.toArray();
    for (const f of await db.family.toArray()) {
      if (f.id === ctx.familyId || f.deleted_at !== null || babies.some((b) => b.family_id === f.id)) continue;
      await updateRow(ctx, db.family, Family, f.id, { deleted_at: toIso(ctx.now()) });
      for (const cg of await db.caregiver.where('family_id').equals(f.id).toArray()) {
        if (cg.deleted_at === null) await updateRow(ctx, db.caregiver, Caregiver, cg.id, { deleted_at: toIso(ctx.now()) });
      }
      result.families++;
    }
  });
  return result;
}

export async function loadCtx(db: BabySleepDb, now: () => number = Date.now): Promise<Ctx> {
  const [familyId, caregiverId, deviceId] = await Promise.all(
    ['family_id', 'caregiver_id', 'device_id'].map(async (k) => (await db.meta.get(k))?.value as string | undefined),
  );
  if (!familyId || !caregiverId || !deviceId) throw new DomainError('invalid', 'Base local sin inicializar');
  const family = await db.family.get(familyId);
  if (family === undefined) throw new DomainError('not_found', 'Falta la familia local');
  return { db, now, zone: family.home_tz, familyId, caregiverId, deviceId };
}

// ------------------------------------------------------------------ bebés

export async function listBabies(ctx: Ctx) {
  const all = await ctx.db.baby.where('family_id').equals(ctx.familyId).toArray();
  return all.filter((b) => b.deleted_at === null).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Datos opcionales del perfil; `null` = desconocido (nunca 0). */
export interface BabyProfileFields {
  sex?: 'female' | 'male' | null;
  gestational_weeks?: number | null;
  birth_weight_g?: number | null;
  birth_length_cm?: number | null;
  notes?: string | null;
}

const RANGES = {
  gestational_weeks: { min: 22, max: 44, int: true, label: 'Las semanas de gestación' },
  birth_weight_g: { min: 300, max: 7000, int: true, label: 'El peso al nacer (g)' },
  birth_length_cm: { min: 20, max: 70, int: false, label: 'La talla al nacer (cm)' },
} as const;

/** Valida y normaliza el perfil con mensajes en español (el contrato también valida, pero con errores técnicos). */
function cleanProfile(p: BabyProfileFields): BabyProfileFields {
  const out: BabyProfileFields = {};
  if (p.sex !== undefined) out.sex = p.sex;
  for (const key of ['gestational_weeks', 'birth_weight_g', 'birth_length_cm'] as const) {
    const v = p[key];
    if (v === undefined) continue;
    if (v !== null) {
      const r = RANGES[key];
      if (!Number.isFinite(v) || v < r.min || v > r.max || (r.int && !Number.isInteger(v))) {
        throw new DomainError('invalid', `${r.label} debe estar entre ${r.min} y ${r.max}${r.int ? ' (número entero)' : ''}`);
      }
    }
    out[key] = v;
  }
  if (p.notes !== undefined) {
    const n = p.notes === null ? '' : p.notes.trim();
    if (n.length > 1000) throw new DomainError('invalid', 'Las notas admiten 1000 caracteres como máximo');
    out.notes = n === '' ? null : n;
  }
  return out;
}

export async function createBaby(
  ctx: Ctx,
  input: { alias: string; birthDate: string; color?: string } & BabyProfileFields,
) {
  const alias = input.alias.trim();
  if (alias.length === 0) throw new DomainError('invalid', 'El alias es obligatorio');
  const { alias: _a, birthDate, color, ...profile } = input;
  const count = (await listBabies(ctx)).length;
  const baby = await insertRow(
    ctx.db.baby,
    Baby,
    Baby.parse({
      ...newRow(ctx),
      alias,
      birth_date: birthDate,
      color: color ?? PALETTE[count % PALETTE.length] ?? null,
      ...cleanProfile(profile),
    }),
  );
  await setActiveBabyId(ctx, baby.id);
  return baby;
}

export async function renameBaby(
  ctx: Ctx,
  id: string,
  patch: { alias?: string; birth_date?: string; color?: string | null } & BabyProfileFields,
) {
  const { alias, birth_date, color, ...profile } = patch;
  const changes: Record<string, unknown> = { ...cleanProfile(profile) };
  if (alias !== undefined) {
    if (alias.trim() === '') throw new DomainError('invalid', 'El alias es obligatorio');
    changes['alias'] = alias.trim();
  }
  if (birth_date !== undefined) changes['birth_date'] = birth_date;
  if (color !== undefined) changes['color'] = color;
  return updateRow(ctx, ctx.db.baby, Baby, id, changes);
}

/**
 * Elimina un perfil: deja de verse, pero se CONSERVA (papelera de perfiles) con todos sus registros, de modo que
 * puede recuperarse. Con la sincronización activada, desaparece también en los demás móviles. No se permite
 * eliminar el único perfil: la app quedaría en el alta de un perfil nuevo sin forma de recuperar el anterior.
 */
export async function deleteBaby(ctx: Ctx, id: string): Promise<void> {
  const baby = await ctx.db.baby.get(id);
  if (baby === undefined || baby.deleted_at !== null) throw new DomainError('not_found', 'Ese perfil no existe');
  const live = await listBabies(ctx);
  if (live.length <= 1) throw new DomainError('invalid', 'No se puede eliminar el único perfil. Crea otro antes, o fusiónalos si es un duplicado.');
  await ctx.db.transaction('rw', ctx.db.tables, async () => {
    await softDelete(ctx, ctx.db.baby, Baby, id);
    if ((await ctx.db.meta.get('active_baby_id'))?.value === id) {
      const next = live.find((b) => b.id !== id);
      if (next !== undefined) await setActiveBabyId(ctx, next.id);
    }
  });
}

export async function restoreBaby(ctx: Ctx, id: string) {
  const baby = await ctx.db.baby.get(id);
  if (baby === undefined) throw new DomainError('not_found', 'Ese perfil no existe');
  return restoreRow(ctx, ctx.db.baby, Baby, id);
}

/** Perfiles eliminados (o archivados al fusionar), los más recientes primero. */
export async function listDeletedBabies(ctx: Ctx) {
  const all = await ctx.db.baby.where('family_id').equals(ctx.familyId).toArray();
  return all.filter((b) => b.deleted_at !== null).sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? ''));
}

export async function getActiveBabyId(ctx: Ctx): Promise<string | null> {
  const stored = (await ctx.db.meta.get('active_baby_id'))?.value as string | undefined;
  const babies = await listBabies(ctx);
  if (stored !== undefined && babies.some((b) => b.id === stored)) return stored;
  return babies[0]?.id ?? null;
}

export async function setActiveBabyId(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.meta.put({ key: 'active_baby_id', value: id });
}
