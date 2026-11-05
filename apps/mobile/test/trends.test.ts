import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { listFeedings } from '../src/domain/feeding';
import { addManualSession, listSessions } from '../src/domain/sleep';
import { buildTrends } from '../src/domain/trends';
import { HOUR, makeHarness, MIN } from './harness';

type H = Awaited<ReturnType<typeof makeHarness>>;
const nap = (h: H, b: string, d: string, from: string, to: string) => addManualSession(h.ctx, { babyId: b, startLocal: `${d}T${from}`, endLocal: `${d}T${to}`, type: 'nap' });

describe('tendencias semanales', () => {
  it('una semana con pocos días no da medias; una con suficientes sí, y cada semana usa solo sus días', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    // Semana más reciente (13–19 ene): 4 días con 2 h de siesta. Semana anterior (6–12): solo 2 días.
    for (const d of ['2027-01-14', '2027-01-15', '2027-01-16', '2027-01-17']) await nap(h, baby.id, d, '10:00', '12:00');
    for (const d of ['2027-01-07', '2027-01-08']) await nap(h, baby.id, d, '10:00', '11:00');

    const rows = buildTrends({
      baby,
      sessions: await listSessions(h.ctx, baby.id),
      feedings: await listFeedings(h.ctx, baby.id),
      zone: h.ctx.zone,
      nowMs: h.nowMs(),
      weeks: 3,
    });
    expect(rows).toHaveLength(3);
    const [old, prev, last] = rows;
    expect(old!.daysWithData).toBe(0);
    expect(prev).toMatchObject({ daysWithData: 2, enough: false, meanTotalMs: null });
    expect(last).toMatchObject({ daysWithData: 4, enough: true });
    expect(last!.meanTotalMs).toBe(2 * HOUR);
    expect(last!.q1TotalMs).toBe(2 * HOUR);
    expect(last!.napsPerDay).toBe(1);
    expect(last!.endMs - prev!.endMs).toBe(7 * 24 * HOUR);
    expect(MIN).toBe(60_000);
  });

  it('la edad en semanas avanza una por semana y la corregida solo existe en prematuros', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const term = await createBaby(h.ctx, { alias: 'T', birthDate: '2026-10-07' });
    const pre = await createBaby(h.ctx, { alias: 'P', birthDate: '2026-10-07', gestational_weeks: 32 });
    const get = async (b: typeof term) =>
      buildTrends({ baby: b, sessions: [], feedings: [], zone: h.ctx.zone, nowMs: h.nowMs(), weeks: 2 });
    const a = await get(term);
    expect(a[1]!.ageWeeks - a[0]!.ageWeeks).toBe(1);
    expect(a[1]!.correctedWeeks).toBeNull();
    const b = await get(pre);
    expect(b[1]!.correctedWeeks).toBe(b[1]!.ageWeeks - 8); // 40 − 32 semanas
  });
});
