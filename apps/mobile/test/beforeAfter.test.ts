import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { listFeedings } from '../src/domain/feeding';
import { addDays, buildBeforeAfter, clockDelta } from '../src/domain/beforeAfter';
import { addManualSession, listSessions } from '../src/domain/sleep';
import { HOUR, makeHarness } from './harness';

type H = Awaited<ReturnType<typeof makeHarness>>;
const nap = (h: H, b: string, d: string, to: string) => addManualSession(h.ctx, { babyId: b, startLocal: `${d}T10:00`, endLocal: `${d}T${to}`, type: 'nap' });
const run = async (h: H, baby: string, eventDate: string, days: number) =>
  buildBeforeAfter({
    sessions: await listSessions(h.ctx, baby),
    feedings: await listFeedings(h.ctx, baby),
    awakenings: [],
    attempts: [],
    awakeningThresholdMs: 30 * 60_000,
    zone: h.ctx.zone,
    nowMs: h.nowMs(),
    eventDate,
    days,
  });

describe('antes y después de un hito', () => {
  it('compara los días de cada lado, deja fuera el día del hito y da la variación previa como referencia', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' })).id;
    for (const d of ['04', '05', '06', '07', '08', '09']) await nap(h, baby, `2027-01-${d}`, '11:00'); // 1 h
    await nap(h, baby, '2027-01-10', '14:00'); // día del hito: 4 h, no debe contar en ningún lado
    for (const d of ['11', '12', '13']) await nap(h, baby, `2027-01-${d}`, '12:00'); // 2 h

    const r = await run(h, baby, '2027-01-10', 3);
    expect(r.after).not.toBeNull();
    expect(r.before).toMatchObject({ from: '2027-01-07', to: '2027-01-09', daysWithData: 3 });
    expect(r.after).toMatchObject({ from: '2027-01-11', to: '2027-01-13', daysWithData: 3 });
    const total = r.comparisons.find((c) => c.key === 'total')!;
    expect(total).toMatchObject({ before: HOUR, after: 2 * HOUR, delta: HOUR, baselineDelta: 0 });
    // Sin tomas ni latencia no se inventa ninguna diferencia.
    expect(r.comparisons.find((c) => c.key === 'feeds')).toMatchObject({ delta: null, before: null, after: null });
    expect(r.comparisons.find((c) => c.key === 'latency')?.delta).toBeNull();
  });

  it('si aún no han pasado los días, no compara y dice cuántos faltan', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' })).id;
    const r = await run(h, baby, '2027-01-19', 3);
    expect(r.after).toBeNull();
    expect(r.daysMissing).toBe(3);
    expect(r.comparisons.every((c) => c.delta === null)).toBe(true);
  });

  it('con menos de 3 días con datos en un lado no hay diferencia', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' })).id;
    for (const d of ['07', '08', '09']) await nap(h, baby, `2027-01-${d}`, '11:00');
    for (const d of ['11', '12']) await nap(h, baby, `2027-01-${d}`, '12:00'); // solo 2 días después
    const r = await run(h, baby, '2027-01-10', 3);
    expect(r.comparisons.find((c) => c.key === 'total')?.delta).toBeNull();
  });
});

describe('ayudas', () => {
  it('suma días y diferencia horas del reloj por el camino corto', () => {
    expect(addDays('2027-01-31', 1)).toBe('2027-02-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(clockDelta(23 * 60 + 50, 10)).toBe(20);
    expect(clockDelta(10, 23 * 60 + 50)).toBe(-20);
    expect(clockDelta(20 * 60, 21 * 60)).toBe(60);
  });
});
