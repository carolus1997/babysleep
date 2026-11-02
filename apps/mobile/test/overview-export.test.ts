import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { backupReminderDue, buildBackupJson, buildSessionsCsv, EXPORT_FORMAT, SESSION_CSV_COLUMNS } from '../src/domain/export';
import { buildOverview } from '../src/domain/overview';
import { addManualSession, deleteSession, finishSleep, listSessions, startSettling, startSleep } from '../src/domain/sleep';
import { HOUR, makeHarness, MIN } from './harness';

const manualNap = (h: Awaited<ReturnType<typeof makeHarness>>, babyId: string, day: string, from: string, to: string) =>
  addManualSession(h.ctx, { babyId, startLocal: `${day}T${from}`, endLocal: `${day}T${to}`, type: 'nap' });

describe('resumen de estadísticas', () => {
  it('promedia solo los días completos con datos y no rellena huecos con ceros', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    // 17: 60+30 min · 18: 90 min · 19: 45 min · 16, 15… sin datos
    await manualNap(h, baby, '2027-01-17', '10:00', '11:00');
    await manualNap(h, baby, '2027-01-17', '14:00', '14:30');
    await manualNap(h, baby, '2027-01-18', '11:00', '12:30');
    await manualNap(h, baby, '2027-01-19', '10:00', '10:45');

    const sessions = await listSessions(h.ctx, baby);
    const o = buildOverview({ sessions, attempts: [], zone: h.ctx.zone, nowMs: h.nowMs(), days: 7 });

    expect(o.series).toHaveLength(7);
    expect(o.series[6]?.date).toBe('2027-01-19'); // el último día completo es ayer
    expect(o.daysWithData).toBe(3);
    expect(o.meanDailyTotalMs).toBe(75 * MIN); // (90 + 90 + 45) / 3
    expect(o.meanNapsPerDay).toBeCloseTo(4 / 3, 9);
    expect(o.medianNapMs).toBe(52.5 * MIN); // mediana de 60, 30, 90, 45
    expect(o.medianNightMs).toBeNull();
    expect(o.latency.n).toBe(0);
    expect(o.latency.medianMs).toBeNull();
    expect(o.quality.sessionsInRange).toBe(4);
    expect(o.quality.approxTimes).toBe(4); // todas manuales
    expect(o.quality.awakeningsUnknown).toBe(4);
  });

  it('hoy aparece aparte y una sesión abierta se cuenta hasta ahora', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    await startSleep(h.ctx, baby);
    h.advance(30 * MIN);
    const o = buildOverview({ sessions: await listSessions(h.ctx, baby), attempts: [], zone: h.ctx.zone, nowMs: h.nowMs(), days: 7 });
    expect(o.today.totalMs).toBe(30 * MIN);
    expect(o.daysWithData).toBe(0); // hoy no entra en los promedios
    expect(o.meanDailyTotalMs).toBeNull();
    expect(o.quality.openSessions).toBe(1);
  });

  it('resume la latencia solo con las sesiones que tienen intento', async () => {
    const h = await makeHarness('2027-01-19T10:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    await startSettling(h.ctx, baby);
    h.advance(20 * MIN);
    const s1 = await startSleep(h.ctx, baby);
    h.advance(40 * MIN);
    await finishSleep(h.ctx, s1.id);
    h.advance(2 * HOUR);
    const s2 = await startSleep(h.ctx, baby); // sin intento
    h.advance(30 * MIN);
    await finishSleep(h.ctx, s2.id);

    h.at('2027-01-20T12:00');
    const attempts = await h.ctx.db.settling_attempt.toArray();
    const o = buildOverview({ sessions: await listSessions(h.ctx, baby), attempts, zone: h.ctx.zone, nowMs: h.nowMs(), days: 7 });
    expect(o.latency.n).toBe(1);
    expect(o.latency.medianMs).toBe(20 * MIN);
    expect(o.latency.excluded.unknown).toBe(1);
  });

  it('señala solapes pendientes de revisión sin duplicar el total del día', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    await manualNap(h, baby, '2027-01-19', '10:00', '11:00');
    await manualNap(h, baby, '2027-01-19', '10:02', '11:01');
    const o = buildOverview({ sessions: await listSessions(h.ctx, baby), attempts: [], zone: h.ctx.zone, nowMs: h.nowMs(), days: 3 });
    expect(o.series[2]?.totalMs).toBe(61 * MIN);
    expect(o.quality.overlapsPending).toBe(1);
  });
});

describe('exportación', () => {
  it('la copia JSON incluye todas las tablas y las filas de la papelera', async () => {
    const h = await makeHarness();
    const baby = (await createBaby(h.ctx, { alias: 'Lía', birthDate: '2026-07-01' })).id;
    const s = await startSleep(h.ctx, baby);
    h.advance(10 * MIN);
    await finishSleep(h.ctx, s.id);
    await deleteSession(h.ctx, s.id);

    const f = await buildBackupJson(h.ctx);
    const j = JSON.parse(f.content);
    expect(j.export_format).toBe(EXPORT_FORMAT);
    expect(j.tables.baby).toHaveLength(1);
    expect(j.tables.sleep_session).toHaveLength(1);
    expect(j.tables.sleep_session[0].deleted_at).not.toBeNull();
    expect(j.tables.tag.length).toBeGreaterThan(10);
    expect(Object.keys(j.tables)).toContain('settling_attempt');
    expect(f.filename).toMatch(/^babysleep-copia-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('el CSV deja la latencia vacía si es desconocida y la escribe si se midió', async () => {
    const h = await makeHarness('2027-01-15T20:40');
    const baby = (await createBaby(h.ctx, { alias: 'Lía, la peque', birthDate: '2026-07-01' })).id;
    await startSettling(h.ctx, baby);
    h.advance(25 * MIN);
    const s1 = await startSleep(h.ctx, baby);
    h.advance(HOUR);
    await finishSleep(h.ctx, s1.id);
    h.advance(HOUR);
    const s2 = await startSleep(h.ctx, baby);
    h.advance(30 * MIN);
    await finishSleep(h.ctx, s2.id);

    const csv = await buildSessionsCsv(h.ctx);
    expect(csv.content.startsWith('﻿')).toBe(true);
    const [header, row1, row2] = csv.content.replace('﻿', '').trim().split('\r\n');
    expect(header).toBe(SESSION_CSV_COLUMNS.join(','));
    const col = (row: string | undefined, name: (typeof SESSION_CSV_COLUMNS)[number]) => {
      const cells = (row as string).match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, ''));
      return cells[SESSION_CSV_COLUMNS.indexOf(name)];
    };
    expect(col(row1, 'baby')).toBe('"Lía, la peque"'); // escapado por la coma
    expect(col(row1, 'settling_latency_s')).toBe(String(25 * 60));
    expect(col(row1, 'settling_latency_status')).toBe('ok');
    expect(col(row2, 'settling_latency_s')).toBe(''); // desconocida, NO 0
    expect(col(row2, 'settling_latency_status')).toBe('unknown');
    expect(col(row1, 'start_local')).toBe('2027-01-15 21:05:00');
    expect(col(row1, 'recorded_duration_s')).toBe(String(3600));
  });

  it('el recordatorio de copia: sin datos no; el primer día no molesta; a los 4 días sí; tras exportar no; a los 8 días sí', async () => {
    const h = await makeHarness();
    expect(await backupReminderDue(h.ctx)).toBe(false);
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    await startSleep(h.ctx, baby);
    expect(await backupReminderDue(h.ctx)).toBe(false);
    h.advance(4 * 24 * HOUR);
    expect(await backupReminderDue(h.ctx)).toBe(true);
    await buildBackupJson(h.ctx);
    expect(await backupReminderDue(h.ctx)).toBe(false);
    h.advance(8 * 24 * HOUR);
    expect(await backupReminderDue(h.ctx)).toBe(true);
  });
});
