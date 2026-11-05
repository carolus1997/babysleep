import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { buildRhythm } from '../src/domain/rhythm';
import { addManualSession, listSessions } from '../src/domain/sleep';
import { makeHarness, MIN } from './harness';

type H = Awaited<ReturnType<typeof makeHarness>>;
const add = (h: H, babyId: string, from: string, to: string, type: 'nap' | 'night') =>
  addManualSession(h.ctx, { babyId, startLocal: from, endLocal: to, type });

/** Un día de sueño completo: ventanas de 120, 150 y 180 min. */
async function day(h: H, baby: string, d: string, next: string) {
  await add(h, baby, `${d}T09:00`, `${d}T10:00`, 'nap');
  await add(h, baby, `${d}T12:30`, `${d}T14:00`, 'nap');
  await add(h, baby, `${d}T16:30`, `${d}T17:00`, 'nap');
  await add(h, baby, `${d}T20:00`, `${next}T07:00`, 'night');
}

describe('ritmo y ventanas de vigilia en el móvil', () => {
  it('separa el periodo actual del anterior y asigna cada ventana al periodo en que termina', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    await add(h, baby, '2027-01-08T20:00', '2027-01-09T07:00', 'night');
    for (const [d, n] of [['2027-01-09', '2027-01-10'], ['2027-01-10', '2027-01-11'], ['2027-01-11', '2027-01-12'], ['2027-01-12', '2027-01-13']] as const) await day(h, baby, d, n);
    for (const [d, n] of [['2027-01-14', '2027-01-15'], ['2027-01-15', '2027-01-16'], ['2027-01-16', '2027-01-17']] as const) await day(h, baby, d, n);

    const v = buildRhythm({ sessions: await listSessions(h.ctx, baby), zone: h.ctx.zone, nowMs: h.nowMs(), days: 7 });
    // Periodo actual: 13 ene 12:00 → 20 ene 12:00, con tres días completos (14, 15 y 16). El día 13 no tiene
    // datos, así que la ventana «tras la noche» del 14 abarcaría 26 h: es un hueco sin registrar y no se cuenta.
    expect(v.current.windows.first.n).toBe(2);
    expect(v.current.windows.tooLong).toBe(1);
    expect(v.current.windows.first.meanMs).toBe(120 * MIN);
    expect(v.current.windows.between.n).toBe(6);
    expect(v.current.windows.bedtime.n).toBe(3);
    // Periodo anterior: 7–13 ene.
    expect(v.previous.windows.first.n).toBe(4);
    expect(v.previous.windows.bedtime.meanMs).toBe(180 * MIN);
    expect(v.openSessions).toBe(0);
  });

  it('sin datos no inventa nada', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    const v = buildRhythm({ sessions: await listSessions(h.ctx, baby), zone: h.ctx.zone, nowMs: h.nowMs(), days: 14 });
    expect(v.current.windows.first).toMatchObject({ n: 0, meanMs: null });
    expect(v.current.rhythm.bedtime).toMatchObject({ n: 0, meanMinute: null });
  });
});
