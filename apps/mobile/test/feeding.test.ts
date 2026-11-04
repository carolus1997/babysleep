import { describe, expect, it } from 'vitest';
import { parseInstant } from '@babysleep/core';
import { createBaby } from '../src/domain/bootstrap';
import { buildBackupJson, buildFeedingsCsv, FEEDING_CSV_COLUMNS } from '../src/domain/export';
import { planImport, applyImport } from '../src/domain/import';
import type { DomainError } from '../src/domain/context';
import {
  addManualFeeding, cancelFeeding, deleteFeeding, editFeeding, finishFeeding, getOpenFeeding, lastFeeding, listFeedings,
  nudgeFeedingStart, restoreFeeding, startFeeding, summarizeFeedings,
} from '../src/domain/feeding';
import { findObservation, listTags, saveObservation, tagIdsOf } from '../src/domain/notes';
import { SEED_FEEDING_TAGS } from '../src/domain/seed';
import { HOUR, makeHarness, MIN } from './harness';

const code = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as DomainError).code);
const babyOf = async (h: Awaited<ReturnType<typeof makeHarness>>) => (await createBaby(h.ctx, { alias: 'Bebé', birthDate: '2026-07-01' })).id;

describe('cronómetro de tomas', () => {
  it('inicia y termina una toma de pecho con su pecho y su duración', async () => {
    const h = await makeHarness('2027-01-15T10:00');
    const baby = await babyOf(h);
    const f = await startFeeding(h.ctx, baby, 'breast', { side: 'left' });
    expect(f).toMatchObject({ feed_type: 'breast', end_utc: null, breast_side: 'left', source: 'timer', start_quality: 'exact' });
    expect((await getOpenFeeding(h.ctx, baby))?.id).toBe(f.id);

    h.advance(18 * MIN);
    const done = await finishFeeding(h.ctx, f.id, { side: 'both' });
    expect(done).toMatchObject({ breast_side: 'both', end_quality: 'exact' });
    expect(parseInstant(done.end_utc as string) - parseInstant(done.start_utc)).toBe(18 * MIN);
    expect(await getOpenFeeding(h.ctx, baby)).toBeUndefined();
  });

  it('un biberón se cierra con los ml', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const f = await startFeeding(h.ctx, baby, 'bottle');
    h.advance(10 * MIN);
    expect((await finishFeeding(h.ctx, f.id, { amountMl: 120 })).amount_ml).toBe(120);
  });

  it('no hay dos tomas abiertas del mismo bebé, y la de un bebé no aparece en otro', async () => {
    const h = await makeHarness();
    const a = await babyOf(h);
    h.advance(1);
    const b = (await createBaby(h.ctx, { alias: 'Otro', birthDate: '2026-07-01' })).id;
    const first = await startFeeding(h.ctx, a, 'breast');
    expect((await startFeeding(h.ctx, a, 'bottle')).id).toBe(first.id); // reutiliza la abierta
    expect(await getOpenFeeding(h.ctx, b)).toBeUndefined();
    expect(await listFeedings(h.ctx, b)).toHaveLength(0);
  });

  it('terminar dos veces no altera la toma; el fin debe ser posterior al inicio', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const f = await startFeeding(h.ctx, baby, 'breast');
    expect(await code(finishFeeding(h.ctx, f.id))).toBe('invalid_range'); // mismo instante
    h.advance(5 * MIN);
    const done = await finishFeeding(h.ctx, f.id);
    h.advance(MIN);
    expect((await finishFeeding(h.ctx, f.id)).end_utc).toBe(done.end_utc);
  });

  it('los ml solo en un biberón y el pecho solo en una toma de pecho', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    expect(await code(startFeeding(h.ctx, baby, 'bottle', { side: 'left' }))).toBe('invalid');
    const f = await startFeeding(h.ctx, baby, 'breast');
    h.advance(MIN);
    expect(await code(finishFeeding(h.ctx, f.id, { amountMl: 90 }))).toBe('invalid');
    expect((await getOpenFeeding(h.ctx, baby))?.id).toBe(f.id); // sigue abierta: lo inválido no cierra nada
    const b = await startFeeding(h.ctx, (await createBaby(h.ctx, { alias: 'X', birthDate: '2026-07-01' })).id, 'bottle');
    h.advance(MIN);
    for (const ml of [0, 501, 90.5]) expect(await code(finishFeeding(h.ctx, b.id, { amountMl: ml }))).toBe('invalid');
  });

  it('cancelar una toma en curso la manda a la papelera; solo las abiertas', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const f = await startFeeding(h.ctx, baby, 'solids');
    await cancelFeeding(h.ctx, f.id);
    expect(await getOpenFeeding(h.ctx, baby)).toBeUndefined();
    expect(await listFeedings(h.ctx, baby)).toHaveLength(0);
    expect(await listFeedings(h.ctx, baby, { includeDeleted: true })).toHaveLength(1);
    const g = await startFeeding(h.ctx, baby, 'breast');
    h.advance(MIN);
    await finishFeeding(h.ctx, g.id);
    expect(await code(cancelFeeding(h.ctx, g.id))).toBe('invalid');
  });
});

describe('registro manual de tomas', () => {
  it('los minutos son opcionales: sin ellos la toma queda sin fin (duración desconocida), no «en curso» ni 0', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const f = await addManualFeeding(h.ctx, { babyId: baby, type: 'breast', startLocal: '2027-01-15T07:30' });
    expect(f).toMatchObject({ source: 'manual', end_utc: null, end_tz: null, end_quality: null });
    expect(await getOpenFeeding(h.ctx, baby)).toBeUndefined(); // no es una toma en curso
    expect(await code(finishFeeding(h.ctx, f.id))).toBeNull(); // terminar no la toca
    expect((await h.ctx.db.feeding.get(f.id))?.end_utc).toBeNull();
    expect(await code(cancelFeeding(h.ctx, f.id))).toBe('invalid');
    // cuenta como toma, pero no suma tiempo al pecho
    const day = summarizeFeedings(await listFeedings(h.ctx, baby), '2027-01-15', h.ctx.zone);
    expect(day).toMatchObject({ count: 1, breastMs: 0 });
    // un cronómetro real sigue en curso
    const t = await startFeeding(h.ctx, baby, 'bottle');
    expect((await getOpenFeeding(h.ctx, baby))?.id).toBe(t.id);
  });

  it('guarda la hora local y la duración como aproximadas', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const f = await addManualFeeding(h.ctx, { babyId: baby, type: 'bottle', startLocal: '2027-01-15T07:30', durationMin: 15, amountMl: 100 });
    expect(f).toMatchObject({ source: 'manual', start_quality: 'approx', end_quality: 'approx', amount_ml: 100 });
    expect(f.start_utc).toBe('2027-01-15T06:30:00.000Z'); // Madrid en invierno: UTC+1
    expect(parseInstant(f.end_utc as string) - parseInstant(f.start_utc)).toBe(15 * MIN);
  });

  it('rechaza duraciones imposibles y datos que no corresponden al tipo', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const base = { babyId: baby, type: 'breast' as const, startLocal: '2027-01-15T07:30' };
    for (const d of [0, -5, 241, 10.5]) expect(await code(addManualFeeding(h.ctx, { ...base, durationMin: d }))).toBe('invalid_range');
    expect(await code(addManualFeeding(h.ctx, { ...base, durationMin: 10, amountMl: 50 }))).toBe('invalid');
    expect(await listFeedings(h.ctx, baby)).toHaveLength(0);
  });

  it('el cambio de hora no se corrige en silencio', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    expect(await code(addManualFeeding(h.ctx, { babyId: baby, type: 'breast', startLocal: '2027-03-28T02:30', durationMin: 10 }))).toBe('nonexistent_time');
    expect(await code(addManualFeeding(h.ctx, { babyId: baby, type: 'breast', startLocal: '2027-10-31T02:30', durationMin: 10 }))).toBe('ambiguous_time');
  });
});

describe('edición, papelera y notas de una toma', () => {
  it('cambiar el tipo quita lo que ya no aplica y mantiene la coherencia', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const f = await addManualFeeding(h.ctx, { babyId: baby, type: 'bottle', startLocal: '2027-01-15T07:30', durationMin: 10, amountMl: 90 });
    const asBreast = await editFeeding(h.ctx, f.id, { type: 'breast', side: 'right' });
    expect(asBreast).toMatchObject({ feed_type: 'breast', breast_side: 'right', amount_ml: null });
    const back = await editFeeding(h.ctx, f.id, { type: 'bottle' });
    expect(back).toMatchObject({ feed_type: 'bottle', breast_side: null, amount_ml: null });
    expect(await code(editFeeding(h.ctx, f.id, { amountMl: 700 }))).toBe('invalid');
    expect(await code(editFeeding(h.ctx, f.id, { type: 'breast', amountMl: 60 }))).toBe('invalid');
  });

  it('«−10 min» corrige el inicio y marca aproximado; el fin no puede quedar antes del inicio', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const f = await addManualFeeding(h.ctx, { babyId: baby, type: 'breast', startLocal: '2027-01-15T07:30', durationMin: 15 });
    const n = await nudgeFeedingStart(h.ctx, f.id, -10);
    expect(parseInstant(n.start_utc)).toBe(parseInstant(f.start_utc) - 10 * MIN);
    expect(await code(editFeeding(h.ctx, f.id, { endMs: parseInstant(f.start_utc) - 3_600_000 }))).toBe('invalid_range');
    expect((await h.ctx.db.feeding.get(f.id))?.start_utc).toBe(n.start_utc); // lo inválido no cambió nada
  });

  it('eliminar es lógico y reversible', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const f = await addManualFeeding(h.ctx, { babyId: baby, type: 'breast', startLocal: '2027-01-15T07:30', durationMin: 10 });
    await deleteFeeding(h.ctx, f.id);
    expect(await listFeedings(h.ctx, baby)).toHaveLength(0);
    await restoreFeeding(h.ctx, f.id);
    expect(await listFeedings(h.ctx, baby)).toHaveLength(1);
  });

  it('una toma admite notas y etiquetas propias, que se pueden cambiar', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const f = await addManualFeeding(h.ctx, { babyId: baby, type: 'bottle', startLocal: '2027-01-15T07:30', durationMin: 10 });
    const tags = (await listTags(h.ctx)).filter((t) => t.category === 'feeding');
    expect(tags.map((t) => t.tag_slug).sort()).toEqual(SEED_FEEDING_TAGS.map((t) => t.slug).sort());
    const little = tags.find((t) => t.tag_slug === 'feeding.took_little')!;
    const obs = await saveObservation(h.ctx, { target: { feedingId: f.id }, moment: 'feeding', text: 'Se distrajo', tagIds: [little.id] });
    expect(obs).toMatchObject({ feeding_id: f.id, session_id: null, settling_attempt_id: null });
    expect(await tagIdsOf(h.ctx, obs!.id)).toEqual([little.id]);
    expect((await findObservation(h.ctx, { feedingId: f.id }, 'feeding'))?.note_text).toBe('Se distrajo');
    await saveObservation(h.ctx, { target: { feedingId: f.id }, moment: 'feeding', text: '', tagIds: [] });
    expect(await tagIdsOf(h.ctx, obs!.id)).toEqual([]);
  });
});

describe('resumen del día', () => {
  it('cuenta las tomas del día local, suma ml solo de los biberones con cantidad y el tiempo al pecho', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const mk = (startLocal: string, type: 'breast' | 'bottle' | 'solids', durationMin: number, amountMl?: number) =>
      addManualFeeding(h.ctx, { babyId: baby, type, startLocal, durationMin, ...(amountMl === undefined ? {} : { amountMl }) });
    await mk('2027-01-15T01:00', 'breast', 20);
    await mk('2027-01-15T08:00', 'bottle', 10, 100);
    await mk('2027-01-15T12:00', 'bottle', 10); // sin cantidad: no suma ni se inventa
    await mk('2027-01-15T22:00', 'solids', 15);
    await mk('2027-01-14T23:30', 'breast', 30); // del día anterior (por la hora local)
    const all = await listFeedings(h.ctx, baby);
    const d = summarizeFeedings(all, '2027-01-15', 'Europe/Madrid');
    expect(d).toEqual({ count: 4, ml: 100, bottles: 2, bottlesWithAmount: 1, breastMs: 20 * MIN });
  });

  it('la última toma y cuánto hace, tomando el fin (o el inicio si sigue en curso)', async () => {
    const h = await makeHarness('2027-01-15T10:00');
    const baby = await babyOf(h);
    expect(lastFeeding([], h.nowMs())).toBeNull();
    const f = await startFeeding(h.ctx, baby, 'breast');
    h.advance(20 * MIN);
    expect(lastFeeding(await listFeedings(h.ctx, baby), h.nowMs())?.sinceMs).toBe(20 * MIN); // en curso: desde el inicio
    await finishFeeding(h.ctx, f.id);
    h.advance(HOUR);
    expect(lastFeeding(await listFeedings(h.ctx, baby), h.nowMs())?.sinceMs).toBe(HOUR); // cerrada: desde el fin
  });
});

describe('exportar e importar tomas', () => {
  it('el CSV deja vacío lo que no se sabe y no inventa ceros', async () => {
    const h = await makeHarness('2027-01-15T10:00');
    const baby = await babyOf(h);
    await addManualFeeding(h.ctx, { babyId: baby, type: 'bottle', startLocal: '2027-01-15T07:30', durationMin: 10 }); // sin ml
    await addManualFeeding(h.ctx, { babyId: baby, type: 'bottle', startLocal: '2027-01-15T09:00', durationMin: 10, amountMl: 120 });
    await startFeeding(h.ctx, baby, 'breast'); // en curso: sin fin
    const { content, filename } = await buildFeedingsCsv(h.ctx);
    expect(filename).toMatch(/^babysleep-tomas-.*\.csv$/);
    expect(content.charCodeAt(0)).toBe(0xfeff); // BOM para Excel
    const [head, ...rows] = content.trim().split('\r\n');
    expect(head!.split(',')).toEqual([...FEEDING_CSV_COLUMNS]);
    const col = (r: string, name: (typeof FEEDING_CSV_COLUMNS)[number]) => r.split(',')[FEEDING_CSV_COLUMNS.indexOf(name)];
    const byMl = Object.fromEntries(rows.map((r) => [col(r, 'start_local'), r]));
    expect(col(byMl['2027-01-15 07:30:00'] ?? '', 'amount_ml')).toBe(''); // desconocido: vacío, no 0
    expect(col(byMl['2027-01-15 09:00:00'] ?? '', 'amount_ml')).toBe('120');
    const open = rows.find((r) => col(r, 'end_utc') === '')!;
    expect(col(open, 'duration_s')).toBe('');
  });

  it('la copia completa incluye las tomas y sus notas, y se restaura en otro dispositivo sin duplicar', async () => {
    const a = await makeHarness('2027-01-15T10:00');
    const baby = await babyOf(a);
    const f = await addManualFeeding(a.ctx, { babyId: baby, type: 'breast', startLocal: '2027-01-15T07:30', durationMin: 12, side: 'left' });
    const tag = (await listTags(a.ctx)).find((t) => t.tag_slug === 'feeding.good')!;
    await saveObservation(a.ctx, { target: { feedingId: f.id }, moment: 'feeding', text: 'Muy bien', tagIds: [tag.id] });
    const json = (await buildBackupJson(a.ctx)).content;
    expect(JSON.parse(json).tables.feeding).toHaveLength(1);

    const b = await makeHarness('2027-03-01T10:00');
    const plan = await planImport(b.ctx, json);
    expect(plan.ok, plan.errors.join('\n')).toBe(true);
    await applyImport(b.ctx, plan);
    expect(await b.ctx.db.feeding.count()).toBe(1);
    expect((await b.ctx.db.feeding.get(f.id))?.breast_side).toBe('left');
    const obs = (await b.ctx.db.observation.toArray())[0]!;
    expect(obs.feeding_id).toBe(f.id);
    const localTag = (await listTags(b.ctx)).find((t) => t.tag_slug === 'feeding.good')!;
    expect(await tagIdsOf(b.ctx, obs.id)).toEqual([localTag.id]); // la etiqueta del dispositivo, no un duplicado
    // importar otra vez no añade nada
    const again = await planImport(b.ctx, json);
    expect(Object.values(again.toAdd).flat()).toHaveLength(0);
  });
});
