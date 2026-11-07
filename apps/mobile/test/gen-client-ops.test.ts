import { mkdirSync, writeFileSync } from 'node:fs';
import { mustResolveLocal } from '@babysleep/core';
import { describe, expect, it } from 'vitest';
import { BabySleepDb } from '../src/db/schema';
import { addGrowth, deleteGrowth, editGrowth, restoreGrowth } from '../src/domain/growth';
import { addEntry, deleteEntry, deleteEpisode, editEntry, editEpisode, endEpisode, restoreEntry, restoreEpisode, startEpisode } from '../src/domain/illness';
import { addDose, addMedication, deleteDose, editDose, editMedication, restoreDose, stopMedication } from '../src/domain/medication';
import { addAppointment, deleteAppointment, editAppointment, restoreAppointment, setAppointmentStatus } from '../src/domain/appointments';
import { createBaby, ensureBootstrap, renameBaby } from '../src/domain/bootstrap';
import { addExtraVaccine, deleteVaccination, editVaccination, markNotApplicable, recordDoses, restoreVaccination } from '../src/domain/vaccines';
import { syncOnce } from '../src/sync/engine';
import { connectDevice } from '../src/sync/identity';
import type { Transport, WireOp } from '../src/sync/types';
import { SimServer } from './sim-server';

/**
 * Captura las operaciones REALES que el motor de sincronización envía al servidor para los datos de salud. Con
 * `UPDATE_FIXTURES=1` las guarda en `fixtures/client-ops.json`; `python tools/replay-client-ops.py .` las reproduce
 * contra PostgreSQL de verdad (con las migraciones aplicadas) y comprueba que el servidor acepta TODAS. Así se prueba
 * el camino móvil → servidor con el formato exacto que genera la app, sin ninguna simulación en medio.
 */
describe('operaciones de salud que envía el móvil', () => {
  it('las operaciones reales se envían, se aplican en el servidor simulado y (opcionalmente) se guardan para reproducirlas en PostgreSQL', async () => {
    let t = mustResolveLocal('2027-02-01T10:00', 'Europe/Madrid');
    const now = () => t;
    const server = new SimServer(now);
    const base = server.transportFor(server.caregiverIds[0] as string);
    const batches: WireOp[][] = [];
    const transport: Transport = {
      fetchIdentity: () => base.fetchIdentity(),
      pullChanges: (since, limit) => base.pullChanges(since, limit),
      applyChanges: async (req) => {
        batches.push(JSON.parse(JSON.stringify(req.ops)) as WireOp[]);
        const res = await base.applyChanges(req);
        for (const r of res.results) expect(['applied', 'merged', 'noop'], `${r.status} ${r.reason ?? ''}`).toContain(r.status);
        return res;
      },
    };

    const db = new BabySleepDb(`ops-${Math.random().toString(36).slice(2)}`);
    let ctx = await ensureBootstrap(db, now);
    const baby = await createBaby(ctx, { alias: 'Bebe de prueba', birthDate: '2026-09-01' });
    ctx = (await connectDevice(ctx, transport)).ctx;
    const step = async () => {
      t += 60_000;
      const r = await syncOnce(ctx, transport);
      expect(r.ok, r.error).toBe(true);
      expect(r.rejected).toBe(0);
    };

    // ficha de salud (edición de un perfil que ya existe en el servidor) y una segunda edición
    await renameBaby(ctx, baby.id, { pediatrician: 'Dra. Prueba', health_center_name: 'Centro de prueba', health_center_phone: '910000000', allergies: 'ninguna conocida', cipa: 'TEST0000000000' });
    await step();
    await renameBaby(ctx, baby.id, { health_notes: 'linea 1\nlinea 2', cipa: '' });
    await step();

    // vacunas: una visita entera, una «no procede», una fuera de calendario, una edición, un borrado y su restauración
    const made = await recordDoses(ctx, { babyId: baby.id, doseKeys: ['VHB@2m', 'DTPa@2m', 'VPI@2m'], givenOn: '2026-11-02', center: 'Centro de prueba', lot: 'LOTE-1' });
    await markNotApplicable(ctx, baby.id, 'RV@2m', 'lo indico el pediatra');
    await addExtraVaccine(ctx, { babyId: baby.id, vaccine: 'Gripe 2026-27', givenOn: '2027-01-20' });
    await step();
    await editVaccination(ctx, made[0]!.id, { givenOn: '2026-11-03', lot: 'LOTE-2', notes: 'sin reaccion' });
    await step();
    await deleteVaccination(ctx, made[1]!.id);
    await step();
    await restoreVaccination(ctx, made[1]!.id);
    await step();

    // citas: con avisos (lista de enteros), editar los avisos, marcar hecha, borrar y restaurar
    const a = await addAppointment(ctx, { babyId: baby.id, kind: 'pediatrician', title: 'Revision de los 4 meses', startLocal: '2027-03-01T09:30', durationMin: 20, place: 'Centro de prueba', remindBeforeMin: [1440, 60] });
    const b = await addAppointment(ctx, { babyId: baby.id, kind: 'other', title: 'Sin avisos', startLocal: '2027-03-02T09:30', remindBeforeMin: [] });
    await step();
    await editAppointment(ctx, a.id, { remindBeforeMin: [10080, 120, 0], title: 'Revision 4 meses', notes: 'llevar el documento' });
    await step();
    await setAppointmentStatus(ctx, a.id, 'done');
    await deleteAppointment(ctx, b.id);
    await step();
    await restoreAppointment(ctx, b.id);
    await step();

    // crecimiento: medidas opcionales (null = no medido), editar, borrar y restaurar
    const g1 = await addGrowth(ctx, { babyId: baby.id, measuredOn: '2027-01-05', weightG: 5600, headMm: 405, place: 'Centro de prueba', notes: 'en ayunas' });
    const g2 = await addGrowth(ctx, { babyId: baby.id, measuredOn: '2027-01-12', lengthMm: 625 });
    await step();
    await editGrowth(ctx, g1.id, { weightG: 5650, notes: '' });
    await step();
    await deleteGrowth(ctx, g2.id);
    await step();
    await restoreGrowth(ctx, g2.id);
    await step();

    // medicación: tratamiento con intervalo y a demanda (null), dosis (con y sin texto propio), editar, terminar, borrar y restaurar
    const m1 = await addMedication(ctx, { babyId: baby.id, name: 'Medicamento de prueba', doseText: '2,5 ml', intervalMin: 360, dailyMax: 4, notes: 'con las comidas' });
    const m2 = await addMedication(ctx, { babyId: baby.id, name: 'A demanda', doseText: '1 comprimido', remind: false });
    await step();
    const d1 = await addDose(ctx, { medicationId: m1.id });
    const d2 = await addDose(ctx, { medicationId: m1.id, doseText: '2 ml', notes: 'se durmio', confirmed: true });
    await step();
    await editMedication(ctx, m1.id, { doseText: '3 ml', intervalMin: 480 });
    await editDose(ctx, d1.id, { notes: 'sin problemas' });
    await step();
    await stopMedication(ctx, m2.id);
    await deleteDose(ctx, d2.id);
    await step();
    await restoreDose(ctx, d2.id);
    await step();

    // enfermedad: episodio en curso, una anotación de cada tipo, editar, terminar, borrar y restaurar
    const ep = await startEpisode(ctx, { babyId: baby.id, title: 'Resfriado de prueba', notes: 'empezo con mocos' });
    await step();
    const i1 = await addEntry(ctx, { episodeId: ep.id, kind: 'temperature', tempDc: 384, site: 'axillary' });
    await addEntry(ctx, { episodeId: ep.id, kind: 'symptom', symptom: 'cough', note: 'seca' });
    await addEntry(ctx, { episodeId: ep.id, kind: 'intake', intake: 'less' });
    await addEntry(ctx, { episodeId: ep.id, kind: 'diaper', diaper: 'both' });
    const i5 = await addEntry(ctx, { episodeId: ep.id, kind: 'note', note: 'Durmio inquieta' });
    await step();
    await editEntry(ctx, i1.id, { tempDc: 391, site: null });
    await editEpisode(ctx, ep.id, { title: 'Resfriado' });
    await step();
    await deleteEntry(ctx, i5.id);
    await endEpisode(ctx, ep.id);
    await step();
    await restoreEntry(ctx, i5.id);
    await step();
    const ep2 = await startEpisode(ctx, { babyId: baby.id, title: 'Otro' });
    await step();
    await deleteEpisode(ctx, ep2.id);
    await step();
    await restoreEpisode(ctx, ep2.id);
    await step();

    // el servidor simulado ha recibido exactamente lo que hay en el móvil
    expect(server.rows('vaccination')).toHaveLength(5);
    expect(server.rows('appointment')).toHaveLength(2);
    expect(server.rows('growth_measure')).toHaveLength(2);
    expect(server.rows('medication')).toHaveLength(2);
    expect(server.rows('medication_dose')).toHaveLength(2);
    expect(server.rows('illness_episode')).toHaveLength(2);
    expect(server.rows('illness_entry')).toHaveLength(5);
    expect(server.get('illness_entry', i1.id)).toMatchObject({ kind: 'temperature', temp_dc: 391, temp_site: null, symptom: null });
    expect(server.get('illness_episode', ep.id)).toMatchObject({ title: 'Resfriado' });
    expect(server.get('illness_episode', ep.id)?.['end_utc']).not.toBeNull();
    expect(server.get('medication', m1.id)).toMatchObject({ dose_text: '3 ml', interval_min: 480, daily_max: 4 });
    expect(server.get('medication', m2.id)).toMatchObject({ interval_min: null, remind: false });
    expect(server.get('medication', m2.id)?.['end_utc']).not.toBeNull();
    expect(server.get('medication_dose', d1.id)).toMatchObject({ dose_text: null, notes: 'sin problemas' });
    expect(server.get('growth_measure', g1.id)).toMatchObject({ weight_g: 5650, length_mm: null, head_mm: 405, notes: null });
    expect(server.get('appointment', a.id)).toMatchObject({ remind_before_min: [10080, 120, 0], status: 'done' });
    expect(server.get('baby', baby.id)).toMatchObject({ cipa: null, health_notes: 'linea 1\nlinea 2', pediatrician: 'Dra. Prueba' });

    const flat = batches.flat();
    expect(flat.some((o) => o.table === 'appointment' && Array.isArray(o.fields['remind_before_min']))).toBe(true);
    expect(flat.some((o) => o.table === 'vaccination' && o.delete === true)).toBe(true);
    expect(flat.some((o) => o.table === 'growth_measure' && o.fields['weight_g'] === 5650)).toBe(true);
    expect(flat.some((o) => o.table === 'medication' && o.fields['interval_min'] === 480)).toBe(true);
    expect(flat.some((o) => o.table === 'medication_dose' && o.delete === true)).toBe(true);
    expect(flat.some((o) => o.table === 'illness_entry' && o.fields['temp_dc'] === 391)).toBe(true);
    expect(flat.some((o) => o.table === 'illness_episode' && o.delete === true)).toBe(true);
    expect(flat.some((o) => o.table === 'baby' && o.base_rev !== null && 'pediatrician' in o.fields)).toBe(true);

    if (process.env['UPDATE_FIXTURES']) {
      const dir = new URL('./fixtures/', import.meta.url);
      mkdirSync(dir, { recursive: true });
      writeFileSync(new URL('client-ops.json', dir), JSON.stringify(batches, null, 1) + '\n');
    }
  });
});
