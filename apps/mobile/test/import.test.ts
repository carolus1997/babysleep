import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { buildBackupJson } from '../src/domain/export';
import { applyImport, planImport } from '../src/domain/import';
import { addLifeEvent, listLifeEvents, listTags, saveObservation, tagIdsOf } from '../src/domain/notes';
import { SEED_EVENT_CATEGORIES, SEED_TAGS } from '../src/domain/seed';
import { deleteSession, editSession, finishSleep, listSessions, startSettling, startSleep } from '../src/domain/sleep';
import { HOUR, makeHarness, MIN, type Harness } from './harness';

/** Dispositivo con datos variados: sesiones, intento enlazado, notas con etiquetas, evento y papelera. */
async function populated() {
  const h = await makeHarness('2027-01-15T20:40');
  const baby = (await createBaby(h.ctx, { alias: 'Lía', birthDate: '2026-07-01' })).id;
  await startSettling(h.ctx, baby);
  h.advance(25 * MIN);
  const s1 = await startSleep(h.ctx, baby);
  h.advance(2 * HOUR);
  await finishSleep(h.ctx, s1.id);
  h.advance(HOUR);
  const s2 = await startSleep(h.ctx, baby);
  h.advance(30 * MIN);
  await finishSleep(h.ctx, s2.id);
  h.advance(HOUR);
  const s3 = await startSleep(h.ctx, baby);
  h.advance(10 * MIN);
  await finishSleep(h.ctx, s3.id);
  await deleteSession(h.ctx, s3.id);

  const tags = await listTags(h.ctx);
  const inArms = tags.find((t) => t.tag_slug === 'onset.in_arms')!;
  await saveObservation(h.ctx, { target: { sessionId: s1.id }, moment: 'onset', text: 'Costó un rato', tagIds: [inArms.id] });
  const trip = (await h.ctx.db.event_category.toArray()).find((c) => c.slug === 'trip')!;
  await addLifeEvent(h.ctx, { babyId: baby, categoryId: trip.id, startDate: '2027-02-01', description: 'Viaje' });
  return { h, baby, s1, s2, s3 };
}

const exportOf = async (h: Harness) => (await buildBackupJson(h.ctx)).content;

describe('restaurar una copia en un dispositivo nuevo', () => {
  it('recupera bebés, sesiones (con la papelera), notas, etiquetas y diario sin duplicar los datos de sistema', async () => {
    const { h: a, s1 } = await populated();
    const json = await exportOf(a);

    const b = await makeHarness('2027-03-01T10:00'); // dispositivo nuevo: otra familia y otros ids
    expect(b.ctx.familyId).not.toBe(a.ctx.familyId);
    const plan = await planImport(b.ctx, json);
    expect(plan.ok, plan.errors.join('\n')).toBe(true);
    expect(plan.counts).toEqual({ sessions: 3, babies: ['Lía'] });
    expect(plan.mergedDuplicates).toBe(SEED_TAGS.length + SEED_EVENT_CATEGORIES.length);

    const r = await applyImport(b.ctx, plan);
    expect(r.overwritten).toBe(0);

    const baby = (await b.ctx.db.baby.toArray())[0]!;
    expect(baby.family_id).toBe(b.ctx.familyId); // identidad del dispositivo actual
    const sessions = await listSessions(b.ctx, baby.id, { includeDeleted: true });
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s) => s.deleted_at !== null)).toHaveLength(1);
    expect(sessions.find((s) => s.id === s1.id)?.sleep_start_utc).toBe(s1.sleep_start_utc);
    expect(sessions.find((s) => s.id === s1.id)?.settling_attempt_id).not.toBeNull();

    // Etiquetas: sigue habiendo un solo juego, y la nota apunta a la etiqueta LOCAL del mismo slug
    expect(await b.ctx.db.tag.count()).toBe(SEED_TAGS.length);
    const obs = (await b.ctx.db.observation.toArray())[0]!;
    const localInArms = (await listTags(b.ctx)).find((t) => t.tag_slug === 'onset.in_arms')!;
    expect(await tagIdsOf(b.ctx, obs.id)).toEqual([localInArms.id]);
    expect(obs.note_text).toBe('Costó un rato');

    // Diario: la categoría también es la local
    const ev = (await listLifeEvents(b.ctx, baby.id))[0]!;
    const localTrip = (await b.ctx.db.event_category.toArray()).find((c) => c.slug === 'trip')!;
    expect(ev.category_id).toBe(localTrip.id);
    expect(await b.ctx.db.event_category.count()).toBe(SEED_EVENT_CATEGORIES.length);
  });

  it('el ciclo exportar → importar → exportar no cambia el contenido de las sesiones', async () => {
    const { h: a } = await populated();
    const b = await makeHarness('2027-03-01T10:00');
    await applyImport(b.ctx, await planImport(b.ctx, await exportOf(a)));
    const key = (rows: Array<Record<string, unknown>>) =>
      rows.map((r): Record<string, unknown> => ({ ...r, family_id: 'X', created_by: 'X', updated_by: 'X' })).sort((x, y) => String(x['id']).localeCompare(String(y['id'])));
    expect(key(await b.ctx.db.sleep_session.toArray() as never)).toEqual(key(await a.ctx.db.sleep_session.toArray() as never));
  });

  it('es idempotente: importar dos veces la misma copia no añade nada', async () => {
    const { h: a } = await populated();
    const json = await exportOf(a);
    const b = await makeHarness('2027-03-01T10:00');
    await applyImport(b.ctx, await planImport(b.ctx, json));
    const before = await b.ctx.db.sleep_session.count();
    const again = await planImport(b.ctx, json);
    expect(again.ok).toBe(true);
    expect(Object.values(again.toAdd).flat()).toHaveLength(0);
    expect(again.newerInBackup).toHaveLength(0);
    expect(again.unchanged).toBeGreaterThan(0);
    expect((await applyImport(b.ctx, again)).added).toBe(0);
    expect(await b.ctx.db.sleep_session.count()).toBe(before);
  });

  it('importar sobre el MISMO dispositivo no duplica nada', async () => {
    const { h } = await populated();
    const plan = await planImport(h.ctx, await exportOf(h));
    expect(plan.ok).toBe(true);
    expect(Object.values(plan.toAdd).flat()).toHaveLength(0);
  });
});

describe('conflictos: nunca se sobrescribe sin confirmación', () => {
  it('lo más reciente en la copia solo se aplica con confirmación; lo local más reciente se conserva', async () => {
    const { h: a, s1, s2 } = await populated();
    // Dispositivo B restaura la copia y después AMBOS editan sesiones distintas
    const b = await makeHarness('2027-03-01T10:00');
    await applyImport(b.ctx, await planImport(b.ctx, await exportOf(a)));

    await editSession(a.ctx, s1.id, { type: 'night' }); // A: cambio en s1 (rev sube) → irá en la copia nueva
    const newerBackup = await exportOf(a);
    await editSession(b.ctx, s2.id, { type: 'night' }); // B: cambio local en s2
    await editSession(b.ctx, s2.id, { awakeningsCompleteness: 'partial' }); // B más reciente que la copia en s2

    const plan = await planImport(b.ctx, newerBackup);
    expect(plan.ok).toBe(true);
    expect(plan.newerInBackup.map((c) => c.id)).toEqual([s1.id]);
    expect(plan.newerLocal).toBeGreaterThanOrEqual(1); // s2 local es más nuevo

    // Sin confirmación no se toca nada
    const noOverwrite = await applyImport(b.ctx, plan);
    expect(noOverwrite.overwritten).toBe(0);
    const s1Local = (await b.ctx.db.sleep_session.get(s1.id))!;
    expect(s1Local.type_source).toBe('auto'); // la edición de A (→ manual) NO se ha aplicado
    expect(s1Local.rev).toBeLessThan(plan.newerInBackup[0]!.backupRev);

    // Con confirmación, se aplica solo lo más reciente de la copia
    const yes = await applyImport(b.ctx, plan, { overwriteNewer: true });
    expect(yes.overwritten).toBe(1);
    expect((await b.ctx.db.sleep_session.get(s1.id))?.type_source).toBe('manual');
    expect((await b.ctx.db.sleep_session.get(s2.id))?.awakenings_completeness).toBe('partial'); // intacto
  });

  it('misma versión pero contenido distinto: se avisa y se conserva lo local', async () => {
    const { h: a, s1 } = await populated();
    const b = await makeHarness('2027-03-01T10:00');
    await applyImport(b.ctx, await planImport(b.ctx, await exportOf(a)));
    await editSession(a.ctx, s1.id, { type: 'night' });
    await editSession(b.ctx, s1.id, { awakeningsCompleteness: 'partial' }); // misma rev nueva, distinto contenido
    const plan = await planImport(b.ctx, await exportOf(a));
    expect(plan.sameRevDiffers.map((c) => c.id)).toEqual([s1.id]);
    await applyImport(b.ctx, plan, { overwriteNewer: true });
    expect((await b.ctx.db.sleep_session.get(s1.id))?.awakenings_completeness).toBe('partial');
  });
});

describe('archivos inválidos: no se escribe nada', () => {
  const tweak = async (fn: (doc: { tables: Record<string, Array<Record<string, unknown>>> } & Record<string, unknown>) => void) => {
    const { h } = await populated();
    const doc = JSON.parse(await exportOf(h));
    fn(doc);
    const target = await makeHarness('2027-03-01T10:00');
    const plan = await planImport(target.ctx, JSON.stringify(doc));
    return { plan, target };
  };

  it('JSON roto', async () => {
    const h = await makeHarness();
    const plan = await planImport(h.ctx, '{no es json');
    expect(plan.ok).toBe(false);
    expect(plan.errors[0]).toMatch(/JSON/);
  });

  it('otro formato o una versión futura', async () => {
    const h = await makeHarness();
    expect((await planImport(h.ctx, JSON.stringify({ hola: 1 }))).errors[0]).toMatch(/BabySleep/);
    const future = await planImport(h.ctx, JSON.stringify({ export_format: 'babysleep-export', export_version: 99, tables: {} }));
    expect(future.ok).toBe(false);
    expect(future.errors[0]).toMatch(/versión/i);
  });

  it('una fila inválida (fin anterior al inicio) invalida todo el archivo', async () => {
    const { plan, target } = await tweak((d) => {
      d.tables['sleep_session']![0]!['sleep_end_utc'] = '2000-01-01T00:00:00.000Z';
    });
    expect(plan.ok).toBe(false);
    expect(plan.errors.some((e) => e.startsWith('sleep_session[0]'))).toBe(true);
    await expect(applyImport(target.ctx, plan)).rejects.toThrow();
    expect(await target.ctx.db.sleep_session.count()).toBe(0);
  });

  it('una referencia rota (sesión de un bebé inexistente)', async () => {
    const { plan } = await tweak((d) => {
      d.tables['baby'] = [];
    });
    expect(plan.ok).toBe(false);
    expect(plan.errors.some((e) => e.includes('referencia rota'))).toBe(true);
  });
});
