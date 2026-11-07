import { describe, expect, it } from 'vitest';
import { createBaby, renameBaby } from '../src/domain/bootstrap';
import { DomainError } from '../src/domain/context';
import { buildBackupJson } from '../src/domain/export';
import { applyImport, planImport } from '../src/domain/import';
import { mergeBabies } from '../src/domain/merge';
import {
  addExtraVaccine,
  deleteVaccination,
  editVaccination,
  listVaccinations,
  markNotApplicable,
  planFor,
  recordDoses,
  restoreVaccination,
} from '../src/domain/vaccines';
import { makeHarness } from './harness';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof DomainError ? e.code : 'other';
  }
};

describe('ficha de salud', () => {
  it('guarda los textos recortados, vacío = no consta, y respeta los límites', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    await renameBaby(h.ctx, baby.id, { pediatrician: '  Dra. Prueba ', health_center_name: 'Centro de prueba', allergies: '   ', cipa: 'TEST0001' });
    const b = await h.ctx.db.baby.get(baby.id);
    expect(b).toMatchObject({ pediatrician: 'Dra. Prueba', health_center_name: 'Centro de prueba', allergies: null, cipa: 'TEST0001' });
    expect(await code(renameBaby(h.ctx, baby.id, { nurse: 'x'.repeat(121) }))).toBe('invalid');
    await renameBaby(h.ctx, baby.id, { cipa: '' });
    expect((await h.ctx.db.baby.get(baby.id))?.cipa).toBeNull();
  });
});

describe('guardar la ficha manda solo lo que cambió', () => {
  it('los campos que no se tocaron no se envían (no pisan lo que otro móvil cambió) y sin cambios no se escribe nada', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    await renameBaby(h.ctx, baby.id, { pediatrician: 'Dra. A', nurse: 'Enfermera A' });
    h.ctx.db.syncEnabled = true;
    const before = (await h.ctx.db.baby.get(baby.id))!;

    // El formulario manda TODOS los campos; solo `nurse` es nuevo.
    await renameBaby(h.ctx, baby.id, { alias: 'B', birth_date: '2026-09-01', pediatrician: 'Dra. A', nurse: 'Enfermera B', allergies: '', cipa: '' });
    const sent = (await h.ctx.db.outbox.toArray()).flatMap((e) => Object.keys(e.fields));
    expect(sent).toEqual(['nurse']);

    // Sin ningún cambio real: ni se escribe ni sube la versión.
    const rev = (await h.ctx.db.baby.get(baby.id))!.rev;
    await renameBaby(h.ctx, baby.id, { pediatrician: 'Dra. A', nurse: 'Enfermera B', allergies: null });
    expect((await h.ctx.db.baby.get(baby.id))!.rev).toBe(rev);
    expect(before.pediatrician).toBe('Dra. A');
  });
});

describe('perfiles anteriores a la ficha de salud', () => {
  it('un perfil guardado antes de 0.5.0 (sin esos campos) se edita y se lee sin problema', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    const legacy: Record<string, unknown> = { ...baby };
    for (const k of ['pediatrician', 'nurse', 'health_center_name', 'health_center_address', 'health_center_phone', 'birth_hospital', 'allergies', 'health_notes', 'cipa']) delete legacy[k];
    await h.ctx.db.baby.put(legacy as never);
    expect((await h.ctx.db.baby.get(baby.id))?.cipa).toBeUndefined();
    await renameBaby(h.ctx, baby.id, { cipa: 'TEST0001' });
    expect(await h.ctx.db.baby.get(baby.id)).toMatchObject({ cipa: 'TEST0001', pediatrician: null });
  });
});

describe('vacunas', () => {
  const setup = async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    return { h, baby };
  };

  it('registra varias dosis de una visita con la misma fecha y no duplica las que ya constan', async () => {
    const { h, baby } = await setup();
    const a = await recordDoses(h.ctx, { babyId: baby.id, doseKeys: ['DTPa@2m', 'VPI@2m', 'Hib@2m'], givenOn: '2026-11-03', center: ' Centro de prueba ' });
    expect(a.map((v) => v.dose_key)).toEqual(['DTPa@2m', 'VPI@2m', 'Hib@2m']);
    expect(a[0]).toMatchObject({ status: 'given', given_on: '2026-11-03', center: 'Centro de prueba', vaccine: expect.stringContaining('DTPa') });
    const b = await recordDoses(h.ctx, { babyId: baby.id, doseKeys: ['DTPa@2m', 'VHB@2m'], givenOn: '2026-11-04' });
    expect(b.map((v) => v.dose_key)).toEqual(['VHB@2m']);
    expect((await listVaccinations(h.ctx, baby.id)).length).toBe(4);
  });

  it('valida: fecha real, no futura, no anterior al nacimiento, dosis conocida y al menos una', async () => {
    const { h, baby } = await setup();
    const rec = (givenOn: string, doseKeys = ['DTPa@2m']) => code(recordDoses(h.ctx, { babyId: baby.id, doseKeys, givenOn }));
    expect(await rec('2027-02-30')).toBe('invalid');
    expect(await rec('2027-01-21')).toBe('invalid'); // mañana
    expect(await rec('2026-08-31')).toBe('invalid'); // antes de nacer
    expect(await rec('2026-11-03', ['XXX@2m'])).toBe('invalid');
    expect(await rec('2026-11-03', [])).toBe('invalid');
    expect(await rec('2026-11-03')).toBeNull();
  });

  it('«no procede» y vacunas fuera de calendario', async () => {
    const { h, baby } = await setup();
    const na = await markNotApplicable(h.ctx, baby.id, 'RV@2m', 'lo indicó el pediatra');
    expect(na).toMatchObject({ status: 'not_applicable', given_on: null });
    expect(await code(markNotApplicable(h.ctx, baby.id, 'RV@2m'))).toBe('invalid'); // ya tiene registro
    const extra = await addExtraVaccine(h.ctx, { babyId: baby.id, vaccine: 'Gripe 2026-27', givenOn: '2027-01-10' });
    expect(extra).toMatchObject({ dose_key: null, vaccine: 'Gripe 2026-27' });
    expect(await code(addExtraVaccine(h.ctx, { babyId: baby.id, vaccine: '  ', givenOn: '2027-01-10' }))).toBe('invalid');
  });

  it('edita, elimina y restaura; el plan refleja el estado', async () => {
    const { h, baby } = await setup();
    const [v] = await recordDoses(h.ctx, { babyId: baby.id, doseKeys: ['DTPa@2m'], givenOn: '2026-11-03' });
    await editVaccination(h.ctx, v!.id, { givenOn: '2026-11-05', lot: 'LOTE1', notes: '' });
    expect((await listVaccinations(h.ctx, baby.id))[0]).toMatchObject({ given_on: '2026-11-05', lot: 'LOTE1', notes: null });

    const stateOf = async () => {
      const b = (await h.ctx.db.baby.get(baby.id))!;
      const plan = planFor(h.ctx, b, await listVaccinations(h.ctx, baby.id));
      return plan.find((m) => m.milestone.id === '2m')!.doses.find((d) => d.key === 'DTPa@2m')!.status;
    };
    expect(await stateOf()).toBe('given');
    await deleteVaccination(h.ctx, v!.id);
    expect(await stateOf()).toBe('unconfirmed'); // 2 meses cumplidos el 1 nov, hoy 20 ene: sin constancia
    await restoreVaccination(h.ctx, v!.id);
    expect(await stateOf()).toBe('given');
  });

  it('al fusionar dos perfiles las vacunas pasan al que se conserva', async () => {
    const { h, baby } = await setup();
    const other = await createBaby(h.ctx, { alias: 'Duplicado', birthDate: '2026-09-01' });
    await recordDoses(h.ctx, { babyId: other.id, doseKeys: ['DTPa@2m'], givenOn: '2026-11-03' });
    await mergeBabies(h.ctx, other.id, baby.id);
    expect((await listVaccinations(h.ctx, baby.id)).map((v) => v.dose_key)).toEqual(['DTPa@2m']);
    expect(await listVaccinations(h.ctx, other.id)).toEqual([]);
  });

  it('entran en la copia JSON y se restauran en un dispositivo nuevo, con la ficha de salud', async () => {
    const { h, baby } = await setup();
    await renameBaby(h.ctx, baby.id, { cipa: 'TEST0001', pediatrician: 'Dra. Prueba' });
    await recordDoses(h.ctx, { babyId: baby.id, doseKeys: ['DTPa@2m'], givenOn: '2026-11-03', lot: 'LOTE1' });
    const backup = await buildBackupJson(h.ctx);
    expect(JSON.parse(backup.content).tables.vaccination).toHaveLength(1);

    const b = await makeHarness('2027-03-01T10:00');
    const plan = await planImport(b.ctx, backup.content);
    expect(plan.ok, plan.errors.join(' | ')).toBe(true);
    expect(plan.toAdd.vaccination).toHaveLength(1);
    await applyImport(b.ctx, plan);
    const nb = (await b.ctx.db.baby.toArray())[0]!;
    expect(nb).toMatchObject({ cipa: 'TEST0001', pediatrician: 'Dra. Prueba' });
    expect(await listVaccinations(b.ctx, nb.id)).toMatchObject([{ dose_key: 'DTPa@2m', given_on: '2026-11-03', lot: 'LOTE1' }]);
  });
});
