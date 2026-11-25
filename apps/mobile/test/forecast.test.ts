import { describe, expect, it } from 'vitest';
import { mustResolveLocal } from '@babysleep/core';
import { createBaby } from '../src/domain/bootstrap';
import { addManualFeeding, listFeedings } from '../src/domain/feeding';
import { buildForecast } from '../src/domain/forecast';
import { addManualSession, listSessions } from '../src/domain/sleep';
import { HOUR, MADRID, makeHarness, MIN } from './harness';

type H = Awaited<ReturnType<typeof makeHarness>>;
const view = async (h: H, babyId: string) =>
  buildForecast({ sessions: await listSessions(h.ctx, babyId), feedings: await listFeedings(h.ctx, babyId), zone: h.ctx.zone, nowMs: h.nowMs() });

describe('previsión en el móvil', () => {
  it('sin registros no hay nada que prever', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    const v = await view(h, baby.id);
    expect(v.sleep).toEqual({ state: 'unknown', reason: 'no_sessions' });
    expect(v.feed).toEqual({ state: 'unknown', reason: 'no_feeds' });
  });

  it('con pocas ventanas se abstiene y lo dice; con un historial regular da un rango y una prueba hacia atrás', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    const day = (d: string) => addManualSession(h.ctx, { babyId: baby.id, startLocal: `${d}T09:00`, endLocal: `${d}T10:00`, type: 'nap' });
    const nap2 = (d: string) => addManualSession(h.ctx, { babyId: baby.id, startLocal: `${d}T12:30`, endLocal: `${d}T13:30`, type: 'nap' });

    await day('2027-01-20'); // una sola siesta: acaba a las 10:00, ahora son las 12:00
    const few = await view(h, baby.id);
    expect(few.sleep.state).toBe('awake');
    if (few.sleep.state === 'awake') expect(few.sleep.forecast).toMatchObject({ kind: 'abstain', reason: 'few_data' });

    // Seis días con ventana de 150 min entre la 1.ª y la 2.ª siesta.
    for (const d of ['2027-01-12', '2027-01-13', '2027-01-14', '2027-01-15', '2027-01-16', '2027-01-17']) {
      await day(d);
      await nap2(d);
    }
    const ok = await view(h, baby.id);
    expect(ok.sleep.state).toBe('awake');
    if (ok.sleep.state === 'awake') {
      expect(ok.sleep.position).toBe('between');
      expect(ok.sleep.forecast).toMatchObject({ kind: 'range', midMs: 150 * MIN });
      expect(ok.sleep.range).toEqual({ fromMs: ok.sleep.awakeSinceMs + 150 * MIN, midMs: ok.sleep.awakeSinceMs + 150 * MIN, toMs: ok.sleep.awakeSinceMs + 150 * MIN });
      expect(ok.sleep.backtest.predicted).toBeGreaterThanOrEqual(0);
    }
  });

  it('las ventanas de menos de 30 min (siesta partida) no entran en la muestra ni ensanchan el rango', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    const add = (s: string, e: string) => addManualSession(h.ctx, { babyId: baby.id, startLocal: s, endLocal: e, type: 'nap' });
    for (const d of ['2027-01-12', '2027-01-13', '2027-01-14', '2027-01-15', '2027-01-16', '2027-01-17']) {
      await add(`${d}T09:00`, `${d}T10:00`);
      await add(`${d}T12:30`, `${d}T13:30`); // ventana de 150 min
    }
    for (const d of ['2027-01-09', '2027-01-10', '2027-01-11']) {
      await add(`${d}T09:00`, `${d}T10:00`);
      await add(`${d}T10:10`, `${d}T11:00`); // ventana de 10 min: siesta partida
    }
    await add('2027-01-20T09:00', '2027-01-20T10:00');
    const v = await view(h, baby.id);
    expect(v.sleep.state).toBe('awake');
    if (v.sleep.state === 'awake') expect(v.sleep.forecast).toEqual({ kind: 'range', lowMs: 150 * MIN, midMs: 150 * MIN, highMs: 150 * MIN, n: 6 });
  });

  it('con hora habitual de acostarse, ella decide si viene otra siesta o la noche, y la noche se prevé por reloj', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    const add = (s: string, e: string, type: 'nap' | 'night') => addManualSession(h.ctx, { babyId: baby.id, startLocal: s, endLocal: e, type });
    for (let d = 12; d <= 18; d++) await add(`2027-01-${d}T21:00`, `2027-01-${d + 1}T07:00`, 'night');

    // Una siesta que acaba por la mañana: viene otra siesta, por muchas que lleve.
    await add('2027-01-20T09:00', '2027-01-20T10:00', 'nap');
    const morning = await view(h, baby.id);
    expect(morning.sleep).toMatchObject({ state: 'awake', position: 'between', basis: 'awake' });

    // Acaba a menos de 3 h de acostarse: viene la noche, hacia la hora de siempre.
    h.at('2027-01-20T19:00');
    await add('2027-01-20T18:00', '2027-01-20T18:40', 'nap');
    const evening = await view(h, baby.id);
    expect(evening.sleep).toMatchObject({ state: 'awake', position: 'bedtime', basis: 'clock' });
    if (evening.sleep.state === 'awake') expect(evening.sleep.range?.midMs).toBe(mustResolveLocal('2027-01-20T21:00', MADRID));
  });

  it('tomas: aprende de las de una hora parecida y una retomada al poco es la misma', async () => {
    const h = await makeHarness('2027-01-20T10:30');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    const feed = (at: string) => addManualFeeding(h.ctx, { babyId: baby.id, type: 'breast', startLocal: at, durationMin: 5, side: null, amountMl: null });
    for (let d = 13; d <= 19; d++) {
      await feed(`2027-01-${d}T10:00`);
      await feed(`2027-01-${d}T12:15`); // por la mañana, cada 2 h y cuarto
      await feed(`2027-01-${d}T17:00`);
      await feed(`2027-01-${d}T21:00`);
    }
    await feed('2027-01-20T10:00');
    await feed('2027-01-20T10:15'); // la misma toma retomada
    const v = await view(h, baby.id);
    expect(v.feed).toMatchObject({ state: 'waiting', basis: 'same_hour', lastStartMs: mustResolveLocal('2027-01-20T10:00', MADRID), forecast: { kind: 'range', midMs: 2 * HOUR + 15 * MIN } });
  });

  it('durmiendo no se prevé; con datos viejos tampoco', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    await addManualSession(h.ctx, { babyId: baby.id, startLocal: '2027-01-19T08:00', endLocal: '2027-01-19T09:00', type: 'nap' });
    expect((await view(h, baby.id)).sleep).toEqual({ state: 'unknown', reason: 'stale' });
    expect(HOUR).toBe(3_600_000);
  });
});
