import { describe, expect, it } from 'vitest';
import { parseInstant } from '@babysleep/core';
import { createBaby, renameBaby } from '../src/domain/bootstrap';
import type { DomainError } from '../src/domain/context';
import {
  addManualAwakening, awakeningsOf, confirmAwakenings, deleteAwakening, editAwakening, finishAwakening, getOpenAwakening,
  listAwakenings, restoreAwakening, startAwakening, thresholdMs,
} from '../src/domain/awakening';
import { buildBackupJson } from '../src/domain/export';
import { applyImport, planImport } from '../src/domain/import';
import { buildOverview } from '../src/domain/overview';
import { addManualSession, finishSleep, listSessions, startSleep } from '../src/domain/sleep';
import { HOUR, makeHarness, MIN } from './harness';

const code = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as DomainError).code);

async function nightOf(h: Awaited<ReturnType<typeof makeHarness>>) {
  const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
  const night = await addManualSession(h.ctx, { babyId: baby, startLocal: '2027-01-14T21:00', endLocal: '2027-01-15T07:00', type: 'night' });
  return { baby, night };
}

describe('despertares: cronómetro', () => {
  it('«Se despertó» y «Se durmió de nuevo» miden el despertar y marcan la noche como parcialmente anotada', async () => {
    const h = await makeHarness('2027-01-14T21:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    const s = await startSleep(h.ctx, baby);
    expect(s.sleep_type).toBe('night');
    h.advance(4 * HOUR);
    const a = await startAwakening(h.ctx, s.id, 'feeding');
    expect(a).toMatchObject({ source: 'timer', end_utc: null, reason: 'feeding' });
    expect((await getOpenAwakening(h.ctx, s.id))?.id).toBe(a.id);
    expect((await h.ctx.db.sleep_session.get(s.id))?.awakenings_completeness).toBe('partial');
    expect((await startAwakening(h.ctx, s.id)).id).toBe(a.id); // nunca dos abiertos
    h.advance(35 * MIN);
    const done = await finishAwakening(h.ctx, a.id);
    expect(parseInstant(done.end_utc as string) - parseInstant(done.start_utc)).toBe(35 * MIN);
    expect(await getOpenAwakening(h.ctx, s.id)).toBeUndefined();
  });

  it('solo en noches y dentro del descanso', async () => {
    const h = await makeHarness('2027-01-15T10:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    const nap = await addManualSession(h.ctx, { babyId: baby, startLocal: '2027-01-15T09:00', endLocal: '2027-01-15T09:45', type: 'nap' });
    expect(await code(startAwakening(h.ctx, nap.id))).toBe('invalid'); // siesta: no
    expect(await code(addManualAwakening(h.ctx, { sessionId: nap.id, startLocal: '2027-01-15T09:10' }))).toBe('invalid');

    const { night } = await nightOf(h);
    expect(await code(startAwakening(h.ctx, night.id))).toBe('invalid_range'); // la noche ya acabó
    expect(await code(addManualAwakening(h.ctx, { sessionId: night.id, startLocal: '2027-01-14T20:00' }))).toBe('invalid_range'); // antes de dormirse
    expect(await code(addManualAwakening(h.ctx, { sessionId: night.id, startLocal: '2027-01-15T07:30' }))).toBe('invalid_range'); // después de despertar
  });
});

describe('despertares: registro manual y edición', () => {
  it('la duración es opcional: sin ella queda sin fin (desconocida), no «en curso»', async () => {
    const h = await makeHarness();
    const { night } = await nightOf(h);
    const a = await addManualAwakening(h.ctx, { sessionId: night.id, startLocal: '2027-01-15T02:00', reason: 'diaper' });
    expect(a).toMatchObject({ source: 'manual', end_utc: null, end_tz: null, end_quality: null, reason: 'diaper' });
    expect(await getOpenAwakening(h.ctx, night.id)).toBeUndefined();
    const b = await addManualAwakening(h.ctx, { sessionId: night.id, startLocal: '2027-01-15T04:00', durationMin: 40 });
    expect(parseInstant(b.end_utc as string) - parseInstant(b.start_utc)).toBe(40 * MIN);
    for (const d of [0, -1, 601, 2.5]) {
      expect(await code(addManualAwakening(h.ctx, { sessionId: night.id, startLocal: '2027-01-15T05:00', durationMin: d }))).toBe('invalid_range');
    }
    expect(awakeningsOf(await listAwakenings(h.ctx, night.baby_id), night.id)).toHaveLength(2);
  });

  it('editar: fin, motivo, dejarlo sin duración; eliminar con deshacer', async () => {
    const h = await makeHarness();
    const { night } = await nightOf(h);
    const a = await addManualAwakening(h.ctx, { sessionId: night.id, startLocal: '2027-01-15T02:00', durationMin: 20 });
    const e = await editAwakening(h.ctx, a.id, { endMs: parseInstant(a.start_utc) + 50 * MIN, reason: 'crying' });
    expect(parseInstant(e.end_utc as string) - parseInstant(e.start_utc)).toBe(50 * MIN);
    expect(e.reason).toBe('crying');
    expect(await code(editAwakening(h.ctx, a.id, { endMs: parseInstant(a.start_utc) - MIN }))).toBe('invalid_range');
    const u = await editAwakening(h.ctx, a.id, { endMs: null });
    expect(u).toMatchObject({ end_utc: null, end_tz: null, end_quality: null });

    await deleteAwakening(h.ctx, a.id);
    expect(await listAwakenings(h.ctx, night.baby_id)).toHaveLength(0);
    await restoreAwakening(h.ctx, a.id);
    expect(await listAwakenings(h.ctx, night.baby_id)).toHaveLength(1);
  });

  it('«estos son todos» marca la noche como completa (aunque no haya ninguno); quitarlo vuelve a lo que corresponda', async () => {
    const h = await makeHarness();
    const { night } = await nightOf(h);
    expect((await confirmAwakenings(h.ctx, night.id, true)).awakenings_completeness).toBe('complete');
    expect((await confirmAwakenings(h.ctx, night.id, false)).awakenings_completeness).toBe('unknown');
    await addManualAwakening(h.ctx, { sessionId: night.id, startLocal: '2027-01-15T02:00', durationMin: 20 });
    expect((await confirmAwakenings(h.ctx, night.id, false)).awakenings_completeness).toBe('partial');
  });
});

describe('umbral por bebé', () => {
  it('por defecto 30 min; se ajusta en el perfil entre 5 y 180', async () => {
    const h = await makeHarness();
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' });
    expect(thresholdMs(baby)).toBe(30 * MIN);
    const b = await renameBaby(h.ctx, baby.id, { awakening_threshold_min: 45 });
    expect(thresholdMs(b)).toBe(45 * MIN);
    expect(await code(renameBaby(h.ctx, baby.id, { awakening_threshold_min: 3 }))).toBe('invalid');
    expect(await code(renameBaby(h.ctx, baby.id, { awakening_threshold_min: 181 }))).toBe('invalid');
    expect(thresholdMs(await renameBaby(h.ctx, baby.id, { awakening_threshold_min: null }))).toBe(30 * MIN);
  });
});

describe('despertares en estadísticas', () => {
  it('descuenta los largos de la noche; promedia despertares solo en noches confirmadas', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    const n1 = await addManualSession(h.ctx, { babyId: baby, startLocal: '2027-01-17T21:00', endLocal: '2027-01-18T07:00', type: 'night' });
    const n2 = await addManualSession(h.ctx, { babyId: baby, startLocal: '2027-01-18T21:00', endLocal: '2027-01-19T07:00', type: 'night' });
    await addManualSession(h.ctx, { babyId: baby, startLocal: '2027-01-16T21:00', endLocal: '2027-01-17T07:00', type: 'night' }); // sin anotar
    await addManualAwakening(h.ctx, { sessionId: n1.id, startLocal: '2027-01-18T01:00', durationMin: 40 }); // largo
    await addManualAwakening(h.ctx, { sessionId: n1.id, startLocal: '2027-01-18T04:00', durationMin: 10 }); // corto
    await confirmAwakenings(h.ctx, n1.id, true);
    await confirmAwakenings(h.ctx, n2.id, true); // confirmada sin ningún despertar = 0 reales

    const sessions = await listSessions(h.ctx, baby);
    const awakenings = await listAwakenings(h.ctx, baby);
    const o = buildOverview({ sessions, awakenings, attempts: [], zone: h.ctx.zone, nowMs: h.nowMs(), days: 7 });
    const d17 = o.series.find((d) => d.date === '2027-01-17');
    expect(d17).toMatchObject({ awakeningCount: 2, longAwakeningCount: 1, nightMs: 10 * HOUR - 40 * MIN, nightBedMs: 10 * HOUR });
    expect(o.awakeningNights).toBe(2); // solo las confirmadas
    expect(o.meanAwakeningsPerNight).toBe(1); // (2 + 0) / 2: la noche sin anotar NO cuenta como 0
    expect(o.meanLongAwakeningsPerNight).toBe(0.5);
    expect(o.meanNightTotalMs).toBeCloseTo((3 * (10 * HOUR) - 40 * MIN) / 3, 0); // las 3 noches, con el descuento
  });
});

describe('copia y restauración', () => {
  it('los despertares viajan en la copia completa y se restauran sin duplicar', async () => {
    const a = await makeHarness();
    const { night } = await nightOf(a);
    await addManualAwakening(a.ctx, { sessionId: night.id, startLocal: '2027-01-15T02:00', durationMin: 35, reason: 'feeding' });
    const json = (await buildBackupJson(a.ctx)).content;

    const b = await makeHarness();
    const plan = await planImport(b.ctx, json);
    expect(plan.errors).toEqual([]);
    await applyImport(b.ctx, plan);
    expect(await b.ctx.db.awakening.count()).toBe(1);
    const again = await planImport(b.ctx, json);
    expect(Object.values(again.toAdd).flat()).toHaveLength(0);
  });
});
