import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { DomainError } from '../src/domain/context';
import { buildBackupJson } from '../src/domain/export';
import {
  addEntry,
  deleteEntry,
  deleteEpisode,
  editEntry,
  editEpisode,
  endEpisode,
  listEntries,
  listEpisodes,
  reopenEpisode,
  restoreEntry,
  restoreEpisode,
  startEpisode,
} from '../src/domain/illness';
import { applyImport, planImport } from '../src/domain/import';
import { mergeBabies } from '../src/domain/merge';
import { describeValue } from '../src/sync/conflicts';
import { HOUR, makeHarness, MIN } from './harness';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof DomainError ? e.code : 'other';
  }
};

const setup = async () => {
  const h = await makeHarness('2027-01-20T20:00');
  const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
  return { h, baby };
};

describe('episodios de enfermedad', () => {
  it('empieza en curso (sin fin); el título es libre y opcional; solo uno en curso a la vez', async () => {
    const { h, baby } = await setup();
    const e = await startEpisode(h.ctx, { babyId: baby.id, title: '  Resfriado de prueba ', notes: '   ' });
    expect(e).toMatchObject({ title: 'Resfriado de prueba', end_utc: null, notes: null, start_tz: 'Europe/Madrid' });
    expect(e.start_utc).toBe(new Date(h.nowMs()).toISOString());
    expect(await code(startEpisode(h.ctx, { babyId: baby.id }))).toBe('already_open');
    await endEpisode(h.ctx, e.id);
    expect(await code(startEpisode(h.ctx, { babyId: baby.id }))).toBeNull();
    expect((await listEpisodes(h.ctx, baby.id)).some((x) => x.title === null)).toBe(true); // el título es opcional
  });

  it('valida: no empieza en el futuro y el fin es posterior al inicio', async () => {
    const { h, baby } = await setup();
    expect(await code(startEpisode(h.ctx, { babyId: baby.id, startLocal: '2027-01-21T09:00' }))).toBe('invalid');
    const e = await startEpisode(h.ctx, { babyId: baby.id, startLocal: '2027-01-19T09:00' });
    expect(await code(editEpisode(h.ctx, e.id, { endLocal: '2027-01-19T08:00' }))).toBe('invalid_range');
    await editEpisode(h.ctx, e.id, { endLocal: '2027-01-20T09:00' });
    expect((await h.ctx.db.illness_episode.get(e.id))!.end_utc).not.toBeNull();
    await editEpisode(h.ctx, e.id, { endLocal: null });
    expect((await h.ctx.db.illness_episode.get(e.id))!.end_utc).toBeNull();
  });

  it('edita solo lo que cambia; terminar y reabrir (no si hay otro en curso); borrar y restaurar', async () => {
    const { h, baby } = await setup();
    const e = await startEpisode(h.ctx, { babyId: baby.id, title: 'X' });
    h.ctx.db.syncEnabled = true;
    const rev = (await h.ctx.db.illness_episode.get(e.id))!.rev;
    await editEpisode(h.ctx, e.id, { title: 'X', notes: '' });
    expect((await h.ctx.db.illness_episode.get(e.id))!.rev).toBe(rev);
    expect(await h.ctx.db.outbox.count()).toBe(0);
    await editEpisode(h.ctx, e.id, { title: 'Y' });
    expect((await h.ctx.db.outbox.toArray()).flatMap((x) => Object.keys(x.fields))).toEqual(['title']);

    h.advance(2 * HOUR);
    await endEpisode(h.ctx, e.id);
    const other = await startEpisode(h.ctx, { babyId: baby.id });
    expect(await code(reopenEpisode(h.ctx, e.id))).toBe('already_open');
    await endEpisode(h.ctx, other.id);
    await reopenEpisode(h.ctx, e.id);
    expect((await h.ctx.db.illness_episode.get(e.id))!.end_utc).toBeNull();

    await deleteEpisode(h.ctx, e.id);
    expect((await listEpisodes(h.ctx, baby.id)).map((x) => x.id)).toEqual([other.id]);
    await restoreEpisode(h.ctx, e.id);
    expect(await listEpisodes(h.ctx, baby.id)).toHaveLength(2);
  });
});

describe('anotaciones de un episodio', () => {
  it('cada tipo guarda un único dato; lo demás es null; la temperatura va en décimas de grado', async () => {
    const { h, baby } = await setup();
    const ep = await startEpisode(h.ctx, { babyId: baby.id });
    const t = await addEntry(h.ctx, { episodeId: ep.id, kind: 'temperature', tempDc: 384, site: 'axillary' });
    expect(t).toMatchObject({ kind: 'temperature', temp_dc: 384, temp_site: 'axillary', symptom: null, intake: null, diaper: null, note: null, baby_id: baby.id });
    expect(await addEntry(h.ctx, { episodeId: ep.id, kind: 'symptom', symptom: 'cough', note: 'seca' })).toMatchObject({ symptom: 'cough', temp_dc: null, note: 'seca' });
    expect(await addEntry(h.ctx, { episodeId: ep.id, kind: 'intake', intake: 'less' })).toMatchObject({ intake: 'less', temp_dc: null });
    expect(await addEntry(h.ctx, { episodeId: ep.id, kind: 'diaper', diaper: 'both' })).toMatchObject({ diaper: 'both' });
    expect(await addEntry(h.ctx, { episodeId: ep.id, kind: 'note', note: ' Durmió inquieta ' })).toMatchObject({ kind: 'note', note: 'Durmió inquieta' });
    expect(await listEntries(h.ctx, baby.id)).toHaveLength(5);
  });

  it('valida: temperatura posible, nota no vacía, hora no futura, episodio existente', async () => {
    const { h, baby } = await setup();
    const ep = await startEpisode(h.ctx, { babyId: baby.id });
    const add = (o: object) => code(addEntry(h.ctx, { episodeId: ep.id, kind: 'temperature', tempDc: 380, ...o } as never));
    expect(await add({ tempDc: 450 })).toBe('invalid'); // 45 °C
    expect(await add({ tempDc: 300 })).toBe('invalid');
    expect(await add({ tempDc: 38.4 })).toBe('invalid'); // no son décimas
    expect(await add({ atMs: h.nowMs() + 30 * MIN })).toBe('invalid');
    expect(await code(addEntry(h.ctx, { episodeId: ep.id, kind: 'note', note: '   ' }))).toBe('invalid');
    expect(await code(addEntry(h.ctx, { episodeId: 'no-existe', kind: 'note', note: 'x' }))).toBe('not_found');
    expect(await code(addEntry(h.ctx, { episodeId: ep.id, kind: 'symptom', symptom: 'inventado' as never }))).toBe('invalid');
    expect(await add({})).toBeNull();
    expect(await listEntries(h.ctx, baby.id)).toHaveLength(1);
  });

  it('edita solo lo que cambia; el tipo nunca cambia; una nota no puede quedarse vacía', async () => {
    const { h, baby } = await setup();
    const ep = await startEpisode(h.ctx, { babyId: baby.id });
    const t = await addEntry(h.ctx, { episodeId: ep.id, kind: 'temperature', tempDc: 384, site: 'axillary' });
    const n = await addEntry(h.ctx, { episodeId: ep.id, kind: 'note', note: 'x' });
    h.ctx.db.syncEnabled = true;
    await editEntry(h.ctx, t.id, { tempDc: 384, site: 'axillary', note: '' });
    expect(await h.ctx.db.outbox.count()).toBe(0);
    await editEntry(h.ctx, t.id, { tempDc: 391 });
    expect((await h.ctx.db.outbox.toArray()).flatMap((x) => Object.keys(x.fields))).toEqual(['temp_dc']);
    await editEntry(h.ctx, t.id, { site: null });
    expect((await h.ctx.db.illness_entry.get(t.id))!.temp_site).toBeNull();

    expect(await code(editEntry(h.ctx, t.id, { symptom: 'cough' }))).toBe('invalid'); // una temperatura no tiene síntoma
    expect(await code(editEntry(h.ctx, n.id, { tempDc: 380 }))).toBe('invalid');
    expect(await code(editEntry(h.ctx, n.id, { note: '  ' }))).toBe('invalid');
    expect(await code(editEntry(h.ctx, t.id, { tempDc: 500 }))).toBe('invalid');
    await editEntry(h.ctx, n.id, { note: 'y', atMs: h.nowMs() - HOUR });

    await deleteEntry(h.ctx, t.id);
    expect(await listEntries(h.ctx, baby.id)).toHaveLength(1);
    await restoreEntry(h.ctx, t.id);
    expect(await listEntries(h.ctx, baby.id)).toHaveLength(2);
  });

  it('salen ordenadas por hora; las de un episodio eliminado desaparecen y vuelven al restaurarlo', async () => {
    const { h, baby } = await setup();
    const ep = await startEpisode(h.ctx, { babyId: baby.id });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'note', note: 'segunda', atMs: h.nowMs() });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'note', note: 'primera', atMs: h.nowMs() - 2 * HOUR });
    expect((await listEntries(h.ctx, baby.id)).map((x) => x.note)).toEqual(['primera', 'segunda']);
    await deleteEpisode(h.ctx, ep.id);
    expect(await listEntries(h.ctx, baby.id)).toEqual([]);
    await restoreEpisode(h.ctx, ep.id);
    expect(await listEntries(h.ctx, baby.id)).toHaveLength(2);
  });

  it('al fusionar dos perfiles pasan los episodios y sus anotaciones al que se conserva', async () => {
    const { h, baby } = await setup();
    const other = await createBaby(h.ctx, { alias: 'Duplicado', birthDate: '2026-09-01' });
    const ep = await startEpisode(h.ctx, { babyId: other.id });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'temperature', tempDc: 380 });
    await mergeBabies(h.ctx, other.id, baby.id);
    expect(await listEpisodes(h.ctx, baby.id)).toHaveLength(1);
    expect(await listEntries(h.ctx, baby.id)).toHaveLength(1);
    expect(await listEpisodes(h.ctx, other.id)).toEqual([]);
  });

  it('entran en la copia JSON y se restauran en un dispositivo nuevo; una anotación huérfana rechaza la copia', async () => {
    const { h, baby } = await setup();
    const ep = await startEpisode(h.ctx, { babyId: baby.id, title: 'Resfriado de prueba' });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'temperature', tempDc: 384, site: 'rectal' });
    const backup = await buildBackupJson(h.ctx);
    const doc = JSON.parse(backup.content);
    expect(doc.tables.illness_episode).toHaveLength(1);
    expect(doc.tables.illness_entry).toHaveLength(1);

    const b = await makeHarness('2027-03-01T10:00');
    const plan = await planImport(b.ctx, backup.content);
    expect(plan.ok, plan.errors.join(' | ')).toBe(true);
    await applyImport(b.ctx, plan);
    const nb = (await b.ctx.db.baby.toArray())[0]!;
    expect(await listEpisodes(b.ctx, nb.id)).toMatchObject([{ title: 'Resfriado de prueba' }]);
    expect(await listEntries(b.ctx, nb.id)).toMatchObject([{ temp_dc: 384, temp_site: 'rectal' }]);

    doc.tables.illness_episode = [];
    expect((await planImport((await makeHarness('2027-03-01T10:00')).ctx, JSON.stringify(doc))).ok).toBe(false);
  });
});

describe('texto de los conflictos de enfermedad', () => {
  it('se muestran la temperatura en °C y las opciones en palabras', () => {
    expect(describeValue('temp_dc', 384, 'Europe/Madrid')).toBe('38,4 °C');
    expect(describeValue('temp_site', 'axillary', 'Europe/Madrid')).toBe('axila');
    expect(describeValue('symptom', 'runny_nose', 'Europe/Madrid')).toBe('mocos');
    expect(describeValue('intake', 'much_less', 'Europe/Madrid')).toBe('mucho menos');
    expect(describeValue('diaper', 'both', 'Europe/Madrid')).toBe('pis y caca');
    expect(describeValue('temp_dc', null, 'Europe/Madrid')).toBe('vacío');
  });
});
