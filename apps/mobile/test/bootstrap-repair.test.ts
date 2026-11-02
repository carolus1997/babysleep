import { describe, expect, it } from 'vitest';
import { EventCategory, Tag } from '@babysleep/contract';
import { BabySleepDb } from '../src/db/schema';
import { createBaby, ensureBootstrap, repairDuplicateSeeds } from '../src/domain/bootstrap';
import { addLifeEvent, listLifeEvents, listTags, saveObservation, tagIdsOf } from '../src/domain/notes';
import { SEED_EVENT_CATEGORIES, SEED_TAGS } from '../src/domain/seed';
import { startSleep } from '../src/domain/sleep';
import { insertRow, newRow } from '../src/domain/write';
import { makeHarness } from './harness';

describe('doble arranque simultáneo', () => {
  it('dos ensureBootstrap a la vez crean una sola familia y un solo juego de etiquetas', async () => {
    const db = new BabySleepDb(`race-${Math.random().toString(36).slice(2)}`);
    const [a, b] = await Promise.all([ensureBootstrap(db), ensureBootstrap(db)]);
    expect(a.familyId).toBe(b.familyId);
    expect(await db.family.count()).toBe(1);
    expect(await db.caregiver.count()).toBe(1);
    expect(await db.tag.count()).toBe(SEED_TAGS.length);
    expect(await db.event_category.count()).toBe(SEED_EVENT_CATEGORIES.length);
  });
});

describe('reparación de duplicados heredados', () => {
  /** Reproduce lo que dejaba el fallo antiguo: un segundo juego de etiquetas y categorías. */
  async function withDuplicates() {
    const h = await makeHarness();
    const { ctx } = h;
    const baby = (await createBaby(ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    const s = await startSleep(ctx, baby);
    const originals = await listTags(ctx);
    const origCats = await ctx.db.event_category.toArray();
    h.advance(10);
    const orphanFamily = { ...ctx, familyId: crypto.randomUUID() };
    const dupTags = [] as string[];
    for (const t of SEED_TAGS) {
      const row = await insertRow(ctx.db.tag, Tag, Tag.parse({ ...newRow(orphanFamily), tag_slug: t.slug, category: t.category, kind: 'system', label_i18n: { es: t.es }, archived: false }));
      dupTags.push(row.id);
    }
    for (const c of SEED_EVENT_CATEGORIES) {
      await insertRow(ctx.db.event_category, EventCategory, EventCategory.parse({ ...newRow(orphanFamily), slug: c.slug, kind: 'system', label_i18n: { es: c.es } }));
    }
    return { h, ctx, baby, s, originals, origCats, dupTags };
  }

  it('deja una sola etiqueta por slug, sin borrar físicamente nada', async () => {
    const { ctx } = await withDuplicates();
    const before = await ctx.db.tag.count();
    const r = await repairDuplicateSeeds(ctx);
    expect(r.tags).toBe(SEED_TAGS.length);
    expect(r.categories).toBe(SEED_EVENT_CATEGORIES.length);
    expect(await ctx.db.tag.count()).toBe(before); // conservadas (borrado lógico)
    expect(await listTags(ctx)).toHaveLength(SEED_TAGS.length);
    expect((await listTags(ctx)).every((t) => t.family_id === ctx.familyId)).toBe(true);
  });

  it('es idempotente', async () => {
    const { ctx } = await withDuplicates();
    await repairDuplicateSeeds(ctx);
    expect(await repairDuplicateSeeds(ctx)).toEqual({ tags: 0, categories: 0, families: 0 });
  });

  it('reapunta las notas que usaban la etiqueta duplicada', async () => {
    const { ctx, s, dupTags } = await withDuplicates();
    const dupCrying = (await ctx.db.tag.toArray()).find((t) => dupTags.includes(t.id) && t.tag_slug === 'onset.in_arms')!;
    const keeperIn = (await ctx.db.tag.toArray()).find((t) => !dupTags.includes(t.id) && t.tag_slug === 'onset.in_arms')!;
    const obs = (await saveObservation(ctx, { target: { sessionId: s.id }, moment: 'onset', text: '', tagIds: [dupCrying.id] }))!;
    await repairDuplicateSeeds(ctx);
    expect(await tagIdsOf(ctx, obs.id)).toEqual([keeperIn.id]);
  });

  it('reapunta los acontecimientos de una categoría duplicada', async () => {
    const { ctx, baby, dupTags: _d } = await withDuplicates();
    const dupTrip = (await ctx.db.event_category.toArray()).find((c) => c.slug === 'trip' && c.family_id !== ctx.familyId)!;
    const keeperTrip = (await ctx.db.event_category.toArray()).find((c) => c.slug === 'trip' && c.family_id === ctx.familyId)!;
    await addLifeEvent(ctx, { babyId: baby, categoryId: dupTrip.id, startDate: '2027-02-01' });
    await repairDuplicateSeeds(ctx);
    expect((await listLifeEvents(ctx, baby))[0]?.category_id).toBe(keeperTrip.id);
  });

  it('retira solo las familias sobrantes sin datos y nunca la vigente ni una con bebés', async () => {
    const h = await makeHarness();
    const { ctx } = h;
    await createBaby(ctx, { alias: 'B', birthDate: '2026-07-01' });
    const r = await repairDuplicateSeeds(ctx);
    expect(r.families).toBe(0);
    expect((await ctx.db.family.get(ctx.familyId))?.deleted_at).toBeNull();
  });
});
