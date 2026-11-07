import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listAppointments } from '../src/domain/appointments';
import { listVaccinations, planFor } from '../src/domain/vaccines';
import { normalizeServerRow, pullOnly } from '../src/sync/engine';
import { SYNC_SCHEMAS } from '../src/sync/tables';
import type { PullPage, Transport } from '../src/sync/types';
import { makeHarness } from './harness';

/**
 * `postgres-rows.json` lo genera `python tools/dump-server-rows.py .` con filas REALES de PostgreSQL (tras aplicar las
 * migraciones y varias operaciones con `apply_changes`). Aquí se comprueba que el cliente entiende exactamente lo que
 * la base de datos devuelve: formato de las fechas, listas de enteros, textos con saltos de línea, nulos.
 * Si cambia el esquema, se vuelve a generar el archivo.
 */
type Fixture = { baby: Array<Record<string, unknown>>; vaccination: Array<Record<string, unknown>>; appointment: Array<Record<string, unknown>> };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/postgres-rows.json', import.meta.url), 'utf-8')) as Fixture;

describe('filas reales de PostgreSQL de salud', () => {
  it('el formato crudo de la base de datos NO es el del contrato (por eso se normaliza)', () => {
    expect(fixture.appointment[0]?.['start_utc']).toMatch(/\+00:00$/);
    expect(typeof fixture.appointment[0]?.['change_seq']).toBe('number');
  });

  it.each([
    ['baby', () => fixture.baby],
    ['vaccination', () => fixture.vaccination],
    ['appointment', () => fixture.appointment],
  ] as const)('cada fila de %s se normaliza y cumple el contrato', (table, rows) => {
    expect(rows().length).toBeGreaterThan(0);
    for (const raw of rows()) {
      const parsed = SYNC_SCHEMAS[table].safeParse(normalizeServerRow(raw));
      expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
    }
  });

  it('conserva los valores: fechas civiles sin tocar, instantes en UTC con Z, listas y textos', () => {
    const baby = SYNC_SCHEMAS.baby.parse(normalizeServerRow(fixture.baby[0] as Record<string, unknown>));
    expect(baby).toMatchObject({
      pediatrician: 'Dra. Prueba',
      health_center_phone: '910000000',
      health_notes: 'linea 1\nlinea 2',
      cipa: 'TEST0000000000',
      birth_date: '2026-07-01',
      awakening_threshold_min: null,
    });
    const vac = fixture.vaccination.map((r) => SYNC_SCHEMAS.vaccination.parse(normalizeServerRow(r)));
    expect(vac.find((v) => v.dose_key === 'DTPa@2m')).toMatchObject({ status: 'given', given_on: '2027-01-05', lot: 'LOTE-1' });
    expect(vac.find((v) => v.dose_key === 'RV@2m')).toMatchObject({ status: 'not_applicable', given_on: null });
    expect(vac.find((v) => v.dose_key === null)).toMatchObject({ vaccine: 'Gripe 2026-27', given_on: '2027-01-20' });
    const appt = fixture.appointment.map((r) => SYNC_SCHEMAS.appointment.parse(normalizeServerRow(r)));
    expect(appt.find((a) => a.title === 'Revision de los 4 meses')).toMatchObject({
      start_utc: '2027-04-01T08:00:00.000Z',
      duration_min: 20,
      remind_before_min: [1440, 60],
      status: 'scheduled',
    });
    expect(appt.find((a) => a.title === 'Sin avisos')?.remind_before_min).toEqual([]);
  });

  it('un móvil nuevo que recibe estas filas por el motor de sincronización las guarda y la app las entiende', async () => {
    const h = await makeHarness('2027-02-01T12:00');
    const page: PullPage = {
      rows: { baby: fixture.baby, vaccination: fixture.vaccination, appointment: fixture.appointment },
      change_seq: 7,
      more: false,
    };
    const transport: Transport = {
      fetchIdentity: () => Promise.reject(new Error('no se usa')),
      applyChanges: () => Promise.reject(new Error('no se usa')),
      pullChanges: () => Promise.resolve(page),
    };
    const report = await pullOnly(h.ctx, transport);
    expect(report.invalidRows).toBe(0);
    expect(report.pulled).toBe(fixture.baby.length + fixture.vaccination.length + fixture.appointment.length);

    const babyId = fixture.baby[0]?.['id'] as string;
    const baby = (await h.ctx.db.baby.get(babyId))!;
    expect(baby.cipa).toBe('TEST0000000000');
    const vacs = await listVaccinations(h.ctx, babyId);
    expect(vacs).toHaveLength(3);
    const plan = planFor(h.ctx, baby, vacs);
    expect(plan.find((m) => m.milestone.id === '2m')?.doses.find((d) => d.key === 'DTPa@2m')?.status).toBe('given');
    expect(plan.find((m) => m.milestone.id === '2m')?.doses.find((d) => d.key === 'RV@2m')?.status).toBe('not_applicable');
    expect((await listAppointments(h.ctx, babyId)).map((a) => a.title)).toEqual(['Revision de los 4 meses', 'Sin avisos']);
  });
});
