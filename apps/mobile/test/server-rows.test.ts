import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listAppointments } from '../src/domain/appointments';
import { listGrowth } from '../src/domain/growth';
import { listEntries, listEpisodes } from '../src/domain/illness';
import { listDoses, listMedications } from '../src/domain/medication';
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
type Fixture = { baby: Array<Record<string, unknown>>; vaccination: Array<Record<string, unknown>>; appointment: Array<Record<string, unknown>>; growth_measure: Array<Record<string, unknown>>; medication: Array<Record<string, unknown>>; medication_dose: Array<Record<string, unknown>>; illness_episode: Array<Record<string, unknown>>; illness_entry: Array<Record<string, unknown>> };
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
    ['growth_measure', () => fixture.growth_measure],
    ['medication', () => fixture.medication],
    ['medication_dose', () => fixture.medication_dose],
    ['illness_episode', () => fixture.illness_episode],
    ['illness_entry', () => fixture.illness_entry],
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
    const growth = fixture.growth_measure.map((r) => SYNC_SCHEMAS.growth_measure.parse(normalizeServerRow(r)));
    expect(growth.find((g) => g.measured_on === '2027-01-05')).toMatchObject({ weight_g: 5600, length_mm: null, head_mm: 405, place: 'Centro de prueba', notes: 'en ayunas' });
    expect(growth.find((g) => g.measured_on === '2027-01-12')).toMatchObject({ weight_g: null, length_mm: 625, head_mm: null });
    const meds = fixture.medication.map((r) => SYNC_SCHEMAS.medication.parse(normalizeServerRow(r)));
    expect(meds.find((m) => m.name === 'Medicamento de prueba')).toMatchObject({ dose_text: '2,5 ml', interval_min: 360, daily_max: 4, remind: true, end_utc: null, start_utc: '2027-01-20T08:00:00.000Z', notes: 'con las comidas\nsin leche' });
    expect(meds.find((m) => m.name === 'A demanda')).toMatchObject({ interval_min: null, daily_max: null, remind: false });
    const doses = fixture.medication_dose.map((r) => SYNC_SCHEMAS.medication_dose.parse(normalizeServerRow(r)));
    expect(doses.find((d) => d.given_utc === '2027-01-20T08:05:00.000Z')).toMatchObject({ dose_text: null, notes: null });
    expect(doses.find((d) => d.given_utc === '2027-01-20T14:10:00.000Z')).toMatchObject({ dose_text: '2 ml', notes: 'se durmio' });
    const episodes = fixture.illness_episode.map((r) => SYNC_SCHEMAS.illness_episode.parse(normalizeServerRow(r)));
    expect(episodes.find((e) => e.title === 'Resfriado de prueba')).toMatchObject({ start_utc: '2027-01-20T18:00:00.000Z', end_utc: null, notes: 'empezo con mocos\ny tos' });
    expect(episodes.find((e) => e.title === null)).toMatchObject({ start_utc: '2027-02-01T08:00:00.000Z', end_utc: '2027-02-03T08:00:00.000Z' });
    const entries = fixture.illness_entry.map((r) => SYNC_SCHEMAS.illness_entry.parse(normalizeServerRow(r)));
    expect(entries.find((e) => e.kind === 'temperature')).toMatchObject({ temp_dc: 384, temp_site: 'axillary', symptom: null, intake: null, diaper: null, note: null });
    expect(entries.find((e) => e.kind === 'symptom')).toMatchObject({ symptom: 'cough', note: 'seca', temp_dc: null });
    expect(entries.find((e) => e.kind === 'intake')).toMatchObject({ intake: 'less' });
    expect(entries.find((e) => e.kind === 'diaper')).toMatchObject({ diaper: 'both' });
    expect(entries.find((e) => e.kind === 'note')).toMatchObject({ note: 'Durmio inquieta', temp_dc: null });
  });

  it('un móvil nuevo que recibe estas filas por el motor de sincronización las guarda y la app las entiende', async () => {
    const h = await makeHarness('2027-02-01T12:00');
    const page: PullPage = {
      rows: { baby: fixture.baby, vaccination: fixture.vaccination, appointment: fixture.appointment, growth_measure: fixture.growth_measure, medication: fixture.medication, medication_dose: fixture.medication_dose, illness_episode: fixture.illness_episode, illness_entry: fixture.illness_entry },
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
    expect(report.pulled).toBe(fixture.baby.length + fixture.vaccination.length + fixture.appointment.length + fixture.growth_measure.length + fixture.medication.length + fixture.medication_dose.length + fixture.illness_episode.length + fixture.illness_entry.length);

    const babyId = fixture.baby[0]?.['id'] as string;
    const baby = (await h.ctx.db.baby.get(babyId))!;
    expect(baby.cipa).toBe('TEST0000000000');
    const vacs = await listVaccinations(h.ctx, babyId);
    expect(vacs).toHaveLength(3);
    const plan = planFor(h.ctx, baby, vacs);
    expect(plan.find((m) => m.milestone.id === '2m')?.doses.find((d) => d.key === 'DTPa@2m')?.status).toBe('given');
    expect(plan.find((m) => m.milestone.id === '2m')?.doses.find((d) => d.key === 'RV@2m')?.status).toBe('not_applicable');
    expect((await listAppointments(h.ctx, babyId)).map((a) => a.title)).toEqual(['Revision de los 4 meses', 'Sin avisos']);
    expect((await listGrowth(h.ctx, babyId)).map((g) => `${g.measured_on}:${g.weight_g}:${g.length_mm}:${g.head_mm}`)).toEqual(['2027-01-05:5600:null:405', '2027-01-12:null:625:null']);
    expect((await listMedications(h.ctx, babyId)).map((m) => `${m.name}:${m.interval_min}:${m.remind}`).sort()).toEqual(['A demanda:null:false', 'Medicamento de prueba:360:true']);
    expect((await listDoses(h.ctx, babyId)).map((d) => `${d.given_utc}:${d.dose_text}`)).toEqual(['2027-01-20T08:05:00.000Z:null', '2027-01-20T14:10:00.000Z:2 ml']);
    expect((await listEpisodes(h.ctx, babyId)).map((e) => e.title).sort()).toEqual(['Resfriado de prueba', null]);
    expect((await listEntries(h.ctx, babyId)).map((e) => e.kind)).toEqual(['temperature', 'symptom', 'intake', 'diaper', 'note']);
  });
});
