import { describe, expect, it } from 'vitest';
import { mustResolveLocal, parseInstant, recordedDurationMs, settlingLatency } from '@babysleep/core';
import { createBaby, ensureBootstrap, getActiveBabyId, listBabies, renameBaby } from '../src/domain/bootstrap';
import { DomainError } from '../src/domain/context';
import { buildBackupJson } from '../src/domain/export';
import { getBabyPhoto, removeBabyPhoto, setBabyPhoto } from '../src/domain/photo';
import { SEED_EVENT_CATEGORIES, SEED_TAGS } from '../src/domain/seed';
import {
  addManualSession,
  cancelSettling,
  cancelSleep,
  deleteSession,
  editSession,
  finishSleep,
  getOpenAttempt,
  getOpenSession,
  listSessions,
  markPutDown,
  nudgeTime,
  reopenSettling,
  restoreSession,
  startSettling,
  startSleep,
  undoCancelSleep,
} from '../src/domain/sleep';
import { addLifeEvent, listLifeEvents, listTags, saveObservation, tagIdsOf } from '../src/domain/notes';
import { HOUR, MADRID, makeHarness, MIN } from './harness';

const babyOf = async (h: Awaited<ReturnType<typeof makeHarness>>) => (await createBaby(h.ctx, { alias: 'Bebé', birthDate: '2026-07-01' })).id;
const code = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as DomainError).code);

describe('arranque local', () => {
  it('es idempotente y siembra etiquetas y categorías de sistema', async () => {
    const h = await makeHarness();
    const again = await ensureBootstrap(h.ctx.db, () => h.nowMs());
    expect(again.familyId).toBe(h.ctx.familyId);
    expect(await h.ctx.db.family.count()).toBe(1);
    expect(await h.ctx.db.caregiver.count()).toBe(1);
    expect(await h.ctx.db.tag.count()).toBe(SEED_TAGS.length);
    expect(await h.ctx.db.event_category.count()).toBe(SEED_EVENT_CATEGORIES.length);
    expect(h.ctx.zone).toBe(MADRID);
  });

  it('crea bebés, marca el activo y rechaza alias vacíos', async () => {
    const h = await makeHarness();
    expect(await code(createBaby(h.ctx, { alias: '  ', birthDate: '2026-07-01' }))).toBe('invalid');
    const a = await createBaby(h.ctx, { alias: 'Ana', birthDate: '2026-07-01' });
    expect(await getActiveBabyId(h.ctx)).toBe(a.id);
    h.advance(1); // el reloj es de prueba: dos altas en el mismo ms no se ordenan
    const b = await createBaby(h.ctx, { alias: 'Bruno', birthDate: '2028-01-01' });
    expect(await getActiveBabyId(h.ctx)).toBe(b.id);
    expect((await listBabies(h.ctx)).map((x) => x.alias)).toEqual(['Ana', 'Bruno']);
    expect(a.color).not.toBe(b.color);
  });
});

describe('cronómetro: iniciar y finalizar sueño', () => {
  it('registra instantes y calcula la duración; una siesta de mediodía se sugiere como siesta', async () => {
    const h = await makeHarness('2027-01-15T13:00');
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    expect(s.sleep_type).toBe('nap');
    expect(s.type_source).toBe('auto');
    expect(s.sleep_end_utc).toBeNull();
    h.advance(45 * MIN);
    const done = await finishSleep(h.ctx, s.id);
    expect(recordedDurationMs(done)).toBe(45 * MIN);
    expect(done.end_tz).toBe(MADRID);
  });

  it('no crea una segunda sesión abierta del mismo bebé', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const a = await startSleep(h.ctx, baby);
    h.advance(MIN);
    const b = await startSleep(h.ctx, baby);
    expect(b.id).toBe(a.id);
    expect(await h.ctx.db.sleep_session.count()).toBe(1);
  });

  it('el cronómetro sobrevive a cerrar la app: la hora se guarda, no un contador', async () => {
    const h = await makeHarness('2027-01-15T21:00');
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    expect(s.sleep_type).toBe('night');
    h.advance(9 * HOUR); // «cerrada» toda la noche
    const open = await getOpenSession(h.ctx, baby);
    expect(open?.id).toBe(s.id);
    expect(recordedDurationMs(await finishSleep(h.ctx, s.id))).toBe(9 * HOUR);
  });

  it('finalizar dos veces no altera el registro', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    h.advance(10 * MIN);
    const first = await finishSleep(h.ctx, s.id);
    h.advance(10 * MIN);
    const second = await finishSleep(h.ctx, s.id);
    expect(second.sleep_end_utc).toBe(first.sleep_end_utc);
    expect(second.rev).toBe(first.rev);
  });

  it('la sesión de un bebé no aparece en otro', async () => {
    const h = await makeHarness();
    const a = await babyOf(h);
    const b = (await createBaby(h.ctx, { alias: 'Otro', birthDate: '2027-01-01' })).id;
    await startSleep(h.ctx, a);
    expect(await getOpenSession(h.ctx, b)).toBeUndefined();
    expect(await listSessions(h.ctx, b)).toHaveLength(0);
  });
});

describe('conciliación opcional', () => {
  it('el intento se enlaza al iniciar el sueño y da la latencia correcta', async () => {
    const h = await makeHarness('2027-01-15T20:40');
    const baby = await babyOf(h);
    const attempt = await startSettling(h.ctx, baby);
    h.advance(15 * MIN);
    await markPutDown(h.ctx, attempt.id);
    h.advance(10 * MIN); // 21:05: comprobamos que duerme
    const s = await startSleep(h.ctx, baby);
    expect(s.settling_attempt_id).toBe(attempt.id);
    const linked = await h.ctx.db.settling_attempt.get(attempt.id);
    expect(linked?.status).toBe('linked');
    expect(settlingLatency(linked, s)).toMatchObject({ status: 'ok', ms: 25 * MIN });
  });

  it('colocarlo en la cuna DESPUÉS de que se duerma no altera la latencia', async () => {
    const h = await makeHarness('2027-01-15T20:40');
    const baby = await babyOf(h);
    const attempt = await startSettling(h.ctx, baby);
    h.advance(25 * MIN);
    const s = await startSleep(h.ctx, baby); // se durmió en brazos
    h.advance(5 * MIN);
    const withPutDown = await markPutDown(h.ctx, attempt.id); // se acuesta ya dormido
    expect(parseInstant(withPutDown.put_down_utc as string)).toBeGreaterThan(parseInstant(s.sleep_start_utc));
    expect(settlingLatency(withPutDown, s)).toMatchObject({ status: 'ok', ms: 25 * MIN });
  });

  it('sin intento la latencia es desconocida, no cero', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    expect(s.settling_attempt_id).toBeNull();
    expect(settlingLatency(null, s)).toEqual({ status: 'unknown', reason: 'no_attempt' });
  });

  it('un intento caducado (>6 h) se abandona y no se enlaza', async () => {
    const h = await makeHarness('2027-01-15T08:00');
    const baby = await babyOf(h);
    const attempt = await startSettling(h.ctx, baby);
    h.advance(7 * HOUR);
    const s = await startSleep(h.ctx, baby);
    expect(s.settling_attempt_id).toBeNull();
    expect((await h.ctx.db.settling_attempt.get(attempt.id))?.status).toBe('abandoned');
  });

  it('pulsar «empezar a dormirlo» dos veces reutiliza el intento abierto; se puede cancelar sin borrar', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const a = await startSettling(h.ctx, baby);
    expect((await startSettling(h.ctx, baby)).id).toBe(a.id);
    await cancelSettling(h.ctx, a.id);
    expect(await getOpenAttempt(h.ctx, baby)).toBeUndefined();
    expect(await h.ctx.db.settling_attempt.count()).toBe(1); // conservado
  });
});

describe('perfil ampliado del bebé', () => {
  it('guarda los datos opcionales; lo que no se indica queda en null, nunca en 0', async () => {
    const h = await makeHarness();
    const bare = await createBaby(h.ctx, { alias: 'Sin datos', birthDate: '2026-07-01' });
    expect([bare.sex, bare.gestational_weeks, bare.birth_weight_g, bare.birth_length_cm, bare.notes]).toEqual([null, null, null, null, null]);

    h.advance(1);
    const full = await createBaby(h.ctx, {
      alias: 'Completo', birthDate: '2026-07-01', sex: 'female', gestational_weeks: 36,
      birth_weight_g: 2850, birth_length_cm: 48.5, notes: '  nació de madrugada  ',
    });
    expect(full).toMatchObject({ sex: 'female', gestational_weeks: 36, birth_weight_g: 2850, birth_length_cm: 48.5, notes: 'nació de madrugada' });
  });

  it('se edita y se pueden borrar los datos opcionales volviendo a null', async () => {
    const h = await makeHarness();
    const b = await createBaby(h.ctx, { alias: 'Ana', birthDate: '2026-07-01', birth_weight_g: 3000 });
    const edited = await renameBaby(h.ctx, b.id, { sex: 'male', birth_weight_g: null, notes: '   ' });
    expect(edited).toMatchObject({ sex: 'male', birth_weight_g: null, notes: null, alias: 'Ana', rev: 2 });
  });

  it('valida rangos con mensajes claros y no guarda nada si falla', async () => {
    const h = await makeHarness();
    expect(await code(createBaby(h.ctx, { alias: 'X', birthDate: '2026-07-01', gestational_weeks: 10 }))).toBe('invalid');
    expect(await code(createBaby(h.ctx, { alias: 'X', birthDate: '2026-07-01', birth_weight_g: Number.NaN }))).toBe('invalid');
    expect(await code(createBaby(h.ctx, { alias: 'X', birthDate: '2026-07-01', birth_weight_g: 3000.5 }))).toBe('invalid');
    expect(await code(createBaby(h.ctx, { alias: 'X', birthDate: '2026-07-01', birth_length_cm: 5 }))).toBe('invalid');
    expect(await h.ctx.db.baby.count()).toBe(0);
    const b = await createBaby(h.ctx, { alias: 'Ok', birthDate: '2026-07-01' });
    expect(await code(renameBaby(h.ctx, b.id, { alias: '  ' }))).toBe('invalid');
    expect((await h.ctx.db.baby.get(b.id))?.alias).toBe('Ok');
  });

  it('un perfil guardado antes de existir estos campos se sigue pudiendo editar', async () => {
    const h = await makeHarness();
    const b = await createBaby(h.ctx, { alias: 'Antiguo', birthDate: '2026-07-01' });
    const legacy: Record<string, unknown> = { ...b };
    for (const k of ['sex', 'gestational_weeks', 'birth_weight_g', 'birth_length_cm', 'notes']) delete legacy[k];
    await h.ctx.db.baby.put(legacy as unknown as typeof b);
    const edited = await renameBaby(h.ctx, b.id, { birth_weight_g: 3100 });
    expect(edited).toMatchObject({ birth_weight_g: 3100, sex: null, notes: null });
  });
});

describe('foto del bebé: solo local', () => {
  const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });

  it('se guarda, se recupera, se reemplaza y se quita', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    expect(await getBabyPhoto(h.ctx, baby)).toBeUndefined();
    await setBabyPhoto(h.ctx, baby, jpeg());
    expect((await getBabyPhoto(h.ctx, baby))?.type).toBe('image/jpeg');
    await setBabyPhoto(h.ctx, baby, new Blob([new Uint8Array([1])], { type: 'image/png' }));
    expect(await h.ctx.db.baby_photo.count()).toBe(1);
    expect((await getBabyPhoto(h.ctx, baby))?.type).toBe('image/png');
    await removeBabyPhoto(h.ctx, baby);
    expect(await getBabyPhoto(h.ctx, baby)).toBeUndefined();
  });

  it('rechaza lo que no es imagen o un bebé inexistente', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    expect(await code(setBabyPhoto(h.ctx, baby, new Blob(['hola'], { type: 'text/plain' })))).toBe('invalid');
    expect(await code(setBabyPhoto(h.ctx, '00000000-0000-4000-8000-000000000000', jpeg()))).toBe('not_found');
    expect(await h.ctx.db.baby_photo.count()).toBe(0);
  });

  it('la foto no entra en las copias ni en el CSV (privacidad y tamaño)', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    await setBabyPhoto(h.ctx, baby, jpeg());
    const json = (await buildBackupJson(h.ctx)).content;
    expect(json).not.toContain('baby_photo');
    expect(json).not.toContain('image/jpeg');
    expect(Object.keys(JSON.parse(json).tables)).not.toContain('baby_photo');
  });
});

describe('«no quiere dormir»: cancelar sin perder el rastro', () => {
  it('cancelar un sueño en curso lo manda a la papelera, deja el intento como abandonado y se puede deshacer', async () => {
    const h = await makeHarness('2027-01-15T14:00');
    const baby = await babyOf(h);
    const attempt = await startSettling(h.ctx, baby);
    h.advance(20 * MIN);
    const s = await startSleep(h.ctx, baby);
    expect((await h.ctx.db.settling_attempt.get(attempt.id))?.status).toBe('linked');
    h.advance(2 * MIN);

    await cancelSleep(h.ctx, s.id);
    expect(await getOpenSession(h.ctx, baby)).toBeUndefined();
    expect(await listSessions(h.ctx, baby)).toHaveLength(0);
    expect(await listSessions(h.ctx, baby, { includeDeleted: true })).toHaveLength(1); // conservada
    expect((await h.ctx.db.settling_attempt.get(attempt.id))?.status).toBe('abandoned');
    expect(await getOpenAttempt(h.ctx, baby)).toBeUndefined();

    await undoCancelSleep(h.ctx, s.id);
    expect((await getOpenSession(h.ctx, baby))?.id).toBe(s.id);
    expect((await h.ctx.db.settling_attempt.get(attempt.id))?.status).toBe('linked');
  });

  it('solo se cancela un sueño en curso, y no se deshace si ya hay otro abierto', async () => {
    const h = await makeHarness('2027-01-15T14:00');
    const baby = await babyOf(h);
    const done = await startSleep(h.ctx, baby);
    h.advance(30 * MIN);
    await finishSleep(h.ctx, done.id);
    expect(await code(cancelSleep(h.ctx, done.id))).toBe('invalid');

    h.advance(HOUR);
    const s = await startSleep(h.ctx, baby);
    await cancelSleep(h.ctx, s.id);
    h.advance(MIN);
    await startSleep(h.ctx, baby); // se inicia otro sueño
    expect(await code(undoCancelSleep(h.ctx, s.id))).toBe('invalid');
  });

  it('cancelar un intento se puede deshacer, salvo que ya haya otro abierto', async () => {
    const h = await makeHarness('2027-01-15T14:00');
    const baby = await babyOf(h);
    const a = await startSettling(h.ctx, baby);
    await cancelSettling(h.ctx, a.id);
    await reopenSettling(h.ctx, a.id);
    expect((await getOpenAttempt(h.ctx, baby))?.id).toBe(a.id);

    await cancelSettling(h.ctx, a.id);
    const b = await startSettling(h.ctx, baby);
    expect(b.id).not.toBe(a.id);
    expect(await code(reopenSettling(h.ctx, a.id))).toBe('invalid');
  });
});

describe('etiquetas de sistema nuevas en instalaciones existentes', () => {
  it('«En porteo» existe en la categoría «al dormirse»', async () => {
    const h = await makeHarness();
    const tag = (await listTags(h.ctx)).find((t) => t.tag_slug === 'onset.babywearing');
    expect(tag?.category).toBe('onset');
    expect(tag?.label_i18n['es']).toBe('En porteo');
  });

  it('se añaden al arrancar si faltan, sin duplicar ni tocar las existentes', async () => {
    const h = await makeHarness();
    const old = (await h.ctx.db.tag.toArray()).find((t) => t.tag_slug === 'onset.babywearing')!;
    await h.ctx.db.tag.delete(old.id); // instalación anterior a la etiqueta
    const before = (await h.ctx.db.tag.toArray()).find((t) => t.tag_slug === 'onset.in_arms')!;

    await ensureBootstrap(h.ctx.db, () => h.nowMs());
    await ensureBootstrap(h.ctx.db, () => h.nowMs());
    const tags = await h.ctx.db.tag.toArray();
    expect(tags.filter((t) => t.tag_slug === 'onset.babywearing' && t.deleted_at === null)).toHaveLength(1);
    expect(tags).toHaveLength(SEED_TAGS.length);
    expect(tags.find((t) => t.id === before.id)?.rev).toBe(before.rev); // no se reescribe lo existente
  });
});

describe('registro manual', () => {
  it('guarda horas locales y las marca como aproximadas', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await addManualSession(h.ctx, { babyId: baby, startLocal: '2027-01-14T21:30', endLocal: '2027-01-15T06:30', type: 'night' });
    expect(recordedDurationMs(s)).toBe(9 * HOUR);
    expect(s.source).toBe('manual');
    expect(s.start_quality).toBe('approx');
    expect(s.type_source).toBe('manual');
  });

  it('el salto de primavera cuenta 9 h reales, no 10', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await addManualSession(h.ctx, { babyId: baby, startLocal: '2027-03-27T21:00', endLocal: '2027-03-28T07:00', type: 'night' });
    expect(recordedDurationMs(s)).toBe(9 * HOUR);
  });

  it('hora ambigua: exige elegir; hora inexistente: se rechaza', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const base = { babyId: baby, endLocal: '2026-10-25T07:00', type: 'night' as const };
    expect(await code(addManualSession(h.ctx, { ...base, startLocal: '2026-10-25T02:30' }))).toBe('ambiguous_time');
    const first = await addManualSession(h.ctx, { ...base, startLocal: '2026-10-25T02:30', startChoice: 0 });
    const second = await addManualSession(h.ctx, { ...base, startLocal: '2026-10-25T02:30', startChoice: 1 });
    expect(parseInstant(second.sleep_start_utc) - parseInstant(first.sleep_start_utc)).toBe(HOUR);
    expect(await code(addManualSession(h.ctx, { babyId: baby, startLocal: '2027-03-28T02:30', endLocal: '2027-03-28T07:00', type: 'night' }))).toBe('nonexistent_time');
  });

  it('rechaza un fin anterior al inicio', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    expect(await code(addManualSession(h.ctx, { babyId: baby, startLocal: '2027-01-15T10:00', endLocal: '2027-01-15T09:00', type: 'nap' }))).toBe('invalid_range');
  });
});

describe('edición, correcciones y papelera', () => {
  it('«−10 min» corrige el inicio, marca aproximado y sube la revisión', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    h.advance(40 * MIN);
    const done = await finishSleep(h.ctx, s.id);
    const edited = await nudgeTime(h.ctx, done.id, 'start', -10);
    expect(recordedDurationMs(edited)).toBe(50 * MIN);
    expect(edited.start_quality).toBe('approx');
    expect(edited.rev).toBe(done.rev + 1);
  });

  it('rechaza dejar el fin antes del inicio y conserva el registro intacto', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    h.advance(20 * MIN);
    const done = await finishSleep(h.ctx, s.id);
    expect(await code(nudgeTime(h.ctx, done.id, 'end', -30))).toBe('invalid_range');
    expect((await h.ctx.db.sleep_session.get(done.id))?.sleep_end_utc).toBe(done.sleep_end_utc);
  });

  it('cambiar el tipo lo marca como manual', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    const e = await editSession(h.ctx, s.id, { type: 'night' });
    expect(e.sleep_type).toBe('night');
    expect(e.type_source).toBe('manual');
  });

  it('eliminar es lógico y reversible; los datos se conservan', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    h.advance(10 * MIN);
    await finishSleep(h.ctx, s.id);
    await deleteSession(h.ctx, s.id);
    expect(await listSessions(h.ctx, baby)).toHaveLength(0);
    expect(await listSessions(h.ctx, baby, { includeDeleted: true })).toHaveLength(1);
    await restoreSession(h.ctx, s.id);
    expect(await listSessions(h.ctx, baby)).toHaveLength(1);
  });
});

describe('notas, etiquetas y diario', () => {
  it('una observación por momento, con etiquetas que se pueden quitar y volver a poner', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    const tags = await listTags(h.ctx);
    const t = (slug: string) => tags.find((x) => x.tag_slug === slug)?.id as string;

    const o1 = await saveObservation(h.ctx, { target: { sessionId: s.id }, moment: 'onset', text: ' Costó un rato ', tagIds: [t('onset.hard_to_fall_asleep'), t('onset.in_arms')] });
    expect(o1?.note_text).toBe('Costó un rato');
    expect((await tagIdsOf(h.ctx, o1!.id)).sort()).toEqual([t('onset.hard_to_fall_asleep'), t('onset.in_arms')].sort());

    const o2 = await saveObservation(h.ctx, { target: { sessionId: s.id }, moment: 'onset', text: '', tagIds: [t('onset.in_arms')] });
    expect(o2?.id).toBe(o1?.id); // misma observación (upsert)
    expect(await tagIdsOf(h.ctx, o1!.id)).toEqual([t('onset.in_arms')]);
    expect(await h.ctx.db.observation_tag.count()).toBe(2); // el quitado se conserva como tombstone

    await saveObservation(h.ctx, { target: { sessionId: s.id }, moment: 'onset', text: '', tagIds: [t('onset.in_arms'), t('onset.hard_to_fall_asleep')] });
    expect(await tagIdsOf(h.ctx, o1!.id)).toHaveLength(2);
    expect(await h.ctx.db.observation_tag.count()).toBe(2); // restaurado, sin duplicar
  });

  it('guardar vacío no crea nada; las notas no son obligatorias', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    expect(await saveObservation(h.ctx, { target: { sessionId: s.id }, moment: 'wake', text: '  ', tagIds: [] })).toBeNull();
    expect(await h.ctx.db.observation.count()).toBe(0);
  });

  it('las notas de conciliación se vinculan al intento', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const a = await startSettling(h.ctx, baby);
    const crying = (await listTags(h.ctx)).find((x) => x.tag_slug === 'settling.crying')!;
    const o = await saveObservation(h.ctx, { target: { attemptId: a.id }, moment: 'settling', text: '', tagIds: [crying.id] });
    expect(o?.settling_attempt_id).toBe(a.id);
    expect(o?.session_id).toBeNull();
  });

  it('diario: valida fechas y muestra los eventos de toda la familia', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const cat = (await h.ctx.db.event_category.toArray()).find((c) => c.slug === 'trip')!;
    expect(await code(addLifeEvent(h.ctx, { babyId: baby, categoryId: cat.id, startDate: '2027-02-10', endDate: '2027-02-01' }))).toBe('invalid_range');
    await addLifeEvent(h.ctx, { babyId: null, categoryId: cat.id, startDate: '2027-02-01', endDate: '2027-02-08', description: 'Viaje' });
    await addLifeEvent(h.ctx, { babyId: baby, categoryId: cat.id, startDate: '2027-03-01' });
    expect((await listLifeEvents(h.ctx, baby)).map((e) => e.start_date)).toEqual(['2027-03-01', '2027-02-01']);
  });
});

describe('integridad de lo guardado', () => {
  it('toda escritura incrementa rev y conserva autoría y dispositivo', async () => {
    const h = await makeHarness();
    const baby = await babyOf(h);
    const s = await startSleep(h.ctx, baby);
    h.advance(MIN);
    const done = await finishSleep(h.ctx, s.id);
    expect(s.rev).toBe(1);
    expect(done.rev).toBe(2);
    expect(done.created_by).toBe(h.ctx.caregiverId);
    expect(done.updated_by).toBe(h.ctx.caregiverId);
    expect(done.origin_device_id).toBe(h.ctx.deviceId);
    expect(done.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(mustResolveLocal('2027-01-15T13:00', MADRID)).toBeGreaterThan(0);
  });
});
