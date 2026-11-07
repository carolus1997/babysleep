import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { awakeStatus } from '../src/domain/awake';
import { addManualSession, finishSleep, listSessions, startSleep } from '../src/domain/sleep';
import { HOUR, makeHarness, MIN } from './harness';

type H = Awaited<ReturnType<typeof makeHarness>>;
const status = async (h: H, babyId: string) => awakeStatus({ sessions: await listSessions(h.ctx, babyId), zone: h.ctx.zone, nowMs: h.nowMs() });

describe('tiempo despierta', () => {
  it('sin descansos no hay nada que contar', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    expect(await status(h, baby.id)).toEqual({ state: 'none' });
  });

  it('despierta = ahora − fin del último descanso, sea siesta o noche', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    await addManualSession(h.ctx, { babyId: baby.id, startLocal: '2027-01-19T21:00', endLocal: '2027-01-20T07:00', type: 'night' });
    const a = await status(h, baby.id);
    expect(a).toMatchObject({ state: 'awake', after: 'night', elapsedMs: 5 * HOUR, stale: false });

    await addManualSession(h.ctx, { babyId: baby.id, startLocal: '2027-01-20T10:00', endLocal: '2027-01-20T10:40', type: 'nap' });
    const b = await status(h, baby.id);
    expect(b).toMatchObject({ state: 'awake', after: 'nap', elapsedMs: 80 * MIN });
  });

  it('con un descanso en curso está durmiendo, no despierta', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    await addManualSession(h.ctx, { babyId: baby.id, startLocal: '2027-01-20T09:00', endLocal: '2027-01-20T10:00', type: 'nap' });
    const open = await startSleep(h.ctx, baby.id);
    expect(await status(h, baby.id)).toMatchObject({ state: 'sleeping', type: open.sleep_type });
    h.advance(10 * MIN);
    await finishSleep(h.ctx, open.id);
    expect((await status(h, baby.id)).state).toBe('awake');
  });

  it('muchas horas sin registros se marca como dato dudoso', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    await addManualSession(h.ctx, { babyId: baby.id, startLocal: '2027-01-19T08:00', endLocal: '2027-01-19T09:00', type: 'nap' });
    expect(await status(h, baby.id)).toMatchObject({ state: 'awake', stale: true });
  });

  it('con pocos datos no da ventana habitual (se abstiene)', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    await addManualSession(h.ctx, { babyId: baby.id, startLocal: '2027-01-20T09:00', endLocal: '2027-01-20T10:00', type: 'nap' });
    expect(await status(h, baby.id)).toMatchObject({ state: 'awake', usual: null });
  });
});
