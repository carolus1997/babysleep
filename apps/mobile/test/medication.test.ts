import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { DomainError } from '../src/domain/context';
import { buildBackupJson } from '../src/domain/export';
import { applyImport, planImport } from '../src/domain/import';
import { mergeBabies } from '../src/domain/merge';
import {
  addDose,
  addMedication,
  deleteDose,
  deleteMedication,
  editDose,
  editMedication,
  listDoses,
  listMedications,
  previewDose,
  restoreDose,
  restoreMedication,
  resumeMedication,
  stopMedication,
} from '../src/domain/medication';
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
  const h = await makeHarness('2027-01-20T08:00');
  const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
  return { h, baby };
};

describe('tratamientos', () => {
  it('guarda lo que escribe la familia tal cual; sin intervalo es «a demanda» (null, nunca 0); los textos se recortan', async () => {
    const { h, baby } = await setup();
    const m = await addMedication(h.ctx, { babyId: baby.id, name: '  Medicamento de prueba ', doseText: ' 2,5 ml ', intervalMin: 360, dailyMax: 4, notes: '   ' });
    expect(m).toMatchObject({ name: 'Medicamento de prueba', dose_text: '2,5 ml', interval_min: 360, daily_max: 4, remind: true, end_utc: null, notes: null });
    expect(m.start_utc).toBe(new Date(h.nowMs()).toISOString());
    const d = await addMedication(h.ctx, { babyId: baby.id, name: 'A demanda', doseText: '1 ml' });
    expect(d).toMatchObject({ interval_min: null, daily_max: null });
  });

  it('valida: nombre y dosis obligatorios, intervalo y máximo posibles, fin posterior al inicio', async () => {
    const { h, baby } = await setup();
    const add = (o: object) => code(addMedication(h.ctx, { babyId: baby.id, name: 'X', doseText: '1 ml', ...o }));
    expect(await add({ name: '  ' })).toBe('invalid');
    expect(await add({ doseText: '' })).toBe('invalid');
    expect(await add({ intervalMin: 10 })).toBe('invalid');
    expect(await add({ intervalMin: 90.5 })).toBe('invalid');
    expect(await add({ intervalMin: 0 })).toBe('invalid'); // 0 no es «a demanda»
    expect(await add({ dailyMax: 0 })).toBe('invalid');
    expect(await add({ startLocal: '2027-01-20T09:00', endLocal: '2027-01-20T08:00' })).toBe('invalid_range');
    expect(await add({ intervalMin: 480, dailyMax: 3 })).toBeNull();
    expect(await listMedications(h.ctx, baby.id)).toHaveLength(1);
  });

  it('edita solo lo que cambia; terminar y reabrir; borrar y restaurar', async () => {
    const { h, baby } = await setup();
    const m = await addMedication(h.ctx, { babyId: baby.id, name: 'X', doseText: '1 ml', intervalMin: 360 });
    h.ctx.db.syncEnabled = true;
    const rev = (await h.ctx.db.medication.get(m.id))!.rev;
    await editMedication(h.ctx, m.id, { name: 'X', intervalMin: 360, notes: '' }); // nada cambia
    expect((await h.ctx.db.medication.get(m.id))!.rev).toBe(rev);
    expect(await h.ctx.db.outbox.count()).toBe(0);

    await editMedication(h.ctx, m.id, { doseText: '2 ml', intervalMin: 360 });
    expect((await h.ctx.db.outbox.toArray()).flatMap((e) => Object.keys(e.fields))).toEqual(['dose_text']);

    expect(await code(editMedication(h.ctx, m.id, { endLocal: '2027-01-19T08:00' }))).toBe('invalid_range');
    h.advance(2 * HOUR);
    await stopMedication(h.ctx, m.id);
    expect((await h.ctx.db.medication.get(m.id))!.end_utc).toBe(new Date(h.nowMs()).toISOString());
    await resumeMedication(h.ctx, m.id);
    expect((await h.ctx.db.medication.get(m.id))!.end_utc).toBeNull();

    await deleteMedication(h.ctx, m.id);
    expect(await listMedications(h.ctx, baby.id)).toEqual([]);
    await restoreMedication(h.ctx, m.id);
    expect(await listMedications(h.ctx, baby.id)).toHaveLength(1);
  });
});

describe('dosis', () => {
  it('registra la hora y la zona; lo habitual no repite el texto; no admite horas futuras', async () => {
    const { h, baby } = await setup();
    const m = await addMedication(h.ctx, { babyId: baby.id, name: 'X', doseText: '2,5 ml', intervalMin: 360 });
    const d = await addDose(h.ctx, { medicationId: m.id });
    expect(d).toMatchObject({ baby_id: baby.id, medication_id: m.id, dose_text: null, notes: null, given_tz: 'Europe/Madrid', created_by: h.ctx.caregiverId });
    expect(d.given_utc).toBe(new Date(h.nowMs()).toISOString());
    expect(await code(addDose(h.ctx, { medicationId: m.id, atMs: h.nowMs() + 30 * MIN, confirmed: true }))).toBe('invalid');
    expect(await code(addDose(h.ctx, { medicationId: 'no-existe' }))).toBe('not_found');
  });

  it('antes de una segunda dosis se avisa y hay que confirmar; con confirmación se registra', async () => {
    const { h, baby } = await setup();
    const m = await addMedication(h.ctx, { babyId: baby.id, name: 'X', doseText: '2,5 ml', intervalMin: 360 });
    await addDose(h.ctx, { medicationId: m.id });
    h.advance(2 * HOUR);
    expect(await previewDose(h.ctx, m.id)).toEqual([{ kind: 'recent', minutesAgo: 120, intervalMin: 360 }]);
    expect(await code(addDose(h.ctx, { medicationId: m.id }))).toBe('needs_confirmation');
    expect(await listDoses(h.ctx, baby.id)).toHaveLength(1);
    await addDose(h.ctx, { medicationId: m.id, confirmed: true });
    expect(await listDoses(h.ctx, baby.id)).toHaveLength(2);
    h.advance(6 * HOUR);
    expect(await previewDose(h.ctx, m.id)).toEqual([]);
    expect(await code(addDose(h.ctx, { medicationId: m.id }))).toBeNull();
  });

  it('el máximo diario escrito se avisa, nunca se propone', async () => {
    const { h, baby } = await setup();
    const m = await addMedication(h.ctx, { babyId: baby.id, name: 'X', doseText: '1 ml', intervalMin: 60, dailyMax: 2 });
    await addDose(h.ctx, { medicationId: m.id });
    h.advance(70 * MIN);
    await addDose(h.ctx, { medicationId: m.id });
    h.advance(70 * MIN);
    expect(await previewDose(h.ctx, m.id)).toEqual([{ kind: 'daily_max', count: 2, max: 2 }]);
  });

  it('edita solo lo que cambia, borra y restaura; sus dosis desaparecen y vuelven con el tratamiento', async () => {
    const { h, baby } = await setup();
    const m = await addMedication(h.ctx, { babyId: baby.id, name: 'X', doseText: '2,5 ml' });
    const d = await addDose(h.ctx, { medicationId: m.id, doseText: '2 ml', notes: 'dormida' });
    h.ctx.db.syncEnabled = true;
    await editDose(h.ctx, d.id, { doseText: '2 ml', notes: 'dormida' });
    expect(await h.ctx.db.outbox.count()).toBe(0);
    await editDose(h.ctx, d.id, { notes: '' });
    expect((await h.ctx.db.outbox.toArray()).flatMap((e) => Object.keys(e.fields))).toEqual(['notes']);

    await deleteDose(h.ctx, d.id);
    expect(await listDoses(h.ctx, baby.id)).toEqual([]);
    await restoreDose(h.ctx, d.id);
    expect(await listDoses(h.ctx, baby.id)).toHaveLength(1);

    await deleteMedication(h.ctx, m.id);
    expect(await listDoses(h.ctx, baby.id)).toEqual([]);
    await restoreMedication(h.ctx, m.id);
    expect(await listDoses(h.ctx, baby.id)).toHaveLength(1);
  });

  it('al fusionar dos perfiles pasan los tratamientos y sus dosis al que se conserva', async () => {
    const { h, baby } = await setup();
    const other = await createBaby(h.ctx, { alias: 'Duplicado', birthDate: '2026-09-01' });
    const m = await addMedication(h.ctx, { babyId: other.id, name: 'X', doseText: '1 ml' });
    await addDose(h.ctx, { medicationId: m.id });
    await mergeBabies(h.ctx, other.id, baby.id);
    expect(await listMedications(h.ctx, baby.id)).toHaveLength(1);
    expect(await listDoses(h.ctx, baby.id)).toHaveLength(1);
    expect(await listMedications(h.ctx, other.id)).toEqual([]);
  });

  it('entran en la copia JSON y se restauran en un dispositivo nuevo, con la dosis enlazada a su tratamiento', async () => {
    const { h, baby } = await setup();
    const m = await addMedication(h.ctx, { babyId: baby.id, name: 'Medicamento de prueba', doseText: '2,5 ml', intervalMin: 360 });
    await addDose(h.ctx, { medicationId: m.id });
    const backup = await buildBackupJson(h.ctx);
    const doc = JSON.parse(backup.content);
    expect(doc.tables.medication).toHaveLength(1);
    expect(doc.tables.medication_dose).toHaveLength(1);

    const b = await makeHarness('2027-03-01T10:00');
    const plan = await planImport(b.ctx, backup.content);
    expect(plan.ok, plan.errors.join(' | ')).toBe(true);
    expect(plan.toAdd.medication).toHaveLength(1);
    expect(plan.toAdd.medication_dose).toHaveLength(1);
    await applyImport(b.ctx, plan);
    const nb = (await b.ctx.db.baby.toArray())[0]!;
    expect(await listMedications(b.ctx, nb.id)).toMatchObject([{ name: 'Medicamento de prueba', interval_min: 360 }]);
    expect(await listDoses(b.ctx, nb.id)).toHaveLength(1);
  });

  it('una copia con una dosis que apunta a un tratamiento que no existe se rechaza entera', async () => {
    const { h, baby } = await setup();
    const m = await addMedication(h.ctx, { babyId: baby.id, name: 'X', doseText: '1 ml' });
    await addDose(h.ctx, { medicationId: m.id });
    const doc = JSON.parse((await buildBackupJson(h.ctx)).content);
    doc.tables.medication = [];
    const b = await makeHarness('2027-03-01T10:00');
    const plan = await planImport(b.ctx, JSON.stringify(doc));
    expect(plan.ok).toBe(false);
  });
});

describe('texto de los conflictos de medicación', () => {
  it('se muestran el intervalo en horas y el aviso en palabras', () => {
    expect(describeValue('interval_min', 360, 'Europe/Madrid')).toBe('6 h');
    expect(describeValue('interval_min', 90, 'Europe/Madrid')).toBe('90 min');
    expect(describeValue('remind', true, 'Europe/Madrid')).toBe('con aviso');
    expect(describeValue('remind', false, 'Europe/Madrid')).toBe('sin aviso');
    expect(describeValue('interval_min', null, 'Europe/Madrid')).toBe('vacío');
  });
});
