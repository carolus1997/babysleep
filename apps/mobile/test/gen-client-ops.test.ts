import { mkdirSync, writeFileSync } from 'node:fs';
import { mustResolveLocal } from '@babysleep/core';
import { describe, expect, it } from 'vitest';
import { BabySleepDb } from '../src/db/schema';
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

    // el servidor simulado ha recibido exactamente lo que hay en el móvil
    expect(server.rows('vaccination')).toHaveLength(5);
    expect(server.rows('appointment')).toHaveLength(2);
    expect(server.get('appointment', a.id)).toMatchObject({ remind_before_min: [10080, 120, 0], status: 'done' });
    expect(server.get('baby', baby.id)).toMatchObject({ cipa: null, health_notes: 'linea 1\nlinea 2', pediatrician: 'Dra. Prueba' });

    const flat = batches.flat();
    expect(flat.some((o) => o.table === 'appointment' && Array.isArray(o.fields['remind_before_min']))).toBe(true);
    expect(flat.some((o) => o.table === 'vaccination' && o.delete === true)).toBe(true);
    expect(flat.some((o) => o.table === 'baby' && o.base_rev !== null && 'pediatrician' in o.fields)).toBe(true);

    if (process.env['UPDATE_FIXTURES']) {
      const dir = new URL('./fixtures/', import.meta.url);
      mkdirSync(dir, { recursive: true });
      writeFileSync(new URL('client-ops.json', dir), JSON.stringify(batches, null, 1) + '\n');
    }
  });
});
