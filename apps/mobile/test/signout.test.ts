import { mustResolveLocal } from '@babysleep/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BabySleepDb } from '../src/db/schema';
import { createBaby, ensureBootstrap, listBabies } from '../src/domain/bootstrap';
import { finishSleep, listSessions, startSleep } from '../src/domain/sleep';
import { isAuthFailure, signOut } from '../src/sync/auth';
import { connectDevice } from '../src/sync/identity';
import { supabaseTransport } from '../src/sync/supabase';
import { wipeBlockers, wipeLocalDevice } from '../src/sync/wipe';
import { fakeSupabase } from './fake-supabase';
import { HOUR, MADRID } from './harness';
import { SimServer } from './sim-server';

/** localStorage de pruebas (Node no lo tiene): las claves guardadas se pueden recorrer, como en el navegador. */
const store = new Map<string, string>();
vi.stubGlobal(
  'localStorage',
  new Proxy({} as Record<string, unknown>, {
    get: (_t, p) =>
      p === 'getItem' ? (k: string) => store.get(k) ?? null
      : p === 'setItem' ? (k: string, v: string) => void store.set(k, String(v))
      : p === 'removeItem' ? (k: string) => void store.delete(k)
      : p === 'clear' ? () => store.clear()
      : undefined,
    ownKeys: () => [...store.keys()],
    getOwnPropertyDescriptor: (_t, p) => (store.has(p as string) ? { enumerable: true, configurable: true, value: store.get(p as string) } : undefined),
  }),
);

let n = 0;
const fresh = () => new BabySleepDb(`wipe-${++n}-${Math.random().toString(36).slice(2)}`);

describe('cerrar sesión', () => {
  const calls: unknown[] = [];
  const client = (result: { error: { message: string } | null }) =>
    ({ auth: { signOut: (a: unknown) => (calls.push(a), Promise.resolve(result)) } }) as never;
  afterEach(() => {
    calls.length = 0;
    localStorage.clear();
  });

  it('«solo este móvil» usa el ámbito local y «todos mis dispositivos» el global', async () => {
    await signOut(client({ error: null }));
    await signOut(client({ error: null }), 'global');
    expect(calls).toEqual([{ scope: 'local' }, { scope: 'global' }]);
  });

  it('sin conexión, cerrar la sesión de ESTE móvil funciona igualmente y olvida la sesión guardada', async () => {
    localStorage.setItem('sb-abc-auth-token', '{"access_token":"x"}');
    localStorage.setItem('bs-theme', 'dark');
    await expect(signOut(client({ error: { message: 'Failed to fetch' } }))).resolves.toBeUndefined();
    expect(localStorage.getItem('sb-abc-auth-token')).toBeNull();
    expect(localStorage.getItem('bs-theme')).toBe('dark'); // lo demás no se toca
  });

  it('sin conexión, cerrar en TODOS los dispositivos avisa en vez de aparentar que se hizo', async () => {
    localStorage.setItem('sb-abc-auth-token', '{}');
    await expect(signOut(client({ error: { message: 'Failed to fetch' } }), 'global')).rejects.toThrow(/Sin conexión/);
    expect(localStorage.getItem('sb-abc-auth-token')).not.toBeNull(); // la sesión sigue: no se dio por cerrada
  });
});

describe('borrar los datos de este móvil', () => {
  it('borra la base local entera y la sesión guardada, y una base nueva con el mismo nombre arranca vacía', async () => {
    const db = fresh();
    const ctx = await ensureBootstrap(db, () => Date.now());
    const baby = await createBaby(ctx, { alias: 'Lía', birthDate: '2026-07-01' });
    await startSleep(ctx, baby.id);
    localStorage.setItem('sb-abc-auth-token', '{}');
    expect(await db.sleep_session.count()).toBe(1);

    await wipeLocalDevice(db);
    expect(localStorage.getItem('sb-abc-auth-token')).toBeNull();
    const again = new BabySleepDb(db.name);
    expect(await again.baby.count()).toBe(0);
    expect(await again.sleep_session.count()).toBe(0);
    expect(await again.meta.count()).toBe(0); // ni siquiera queda la identidad local
  });

  it('antes de borrar se sabe cuántos cambios sin enviar se perderían', async () => {
    const server = new SimServer(() => Date.now());
    const db = fresh();
    const ctx = await ensureBootstrap(db, () => Date.now());
    const fake = fakeSupabase(server, server.caregiverIds[0] as string);
    const c = (await connectDevice(ctx, supabaseTransport(fake.client))).ctx;
    expect((await wipeBlockers(c.db)).pending).toBe(0); // conectado y al día: borrar es seguro
    await createBaby(c, { alias: 'Nuevo', birthDate: '2026-07-01' }); // algo sin enviar
    expect((await wipeBlockers(c.db)).pending).toBeGreaterThan(0);
  });

  it('el ciclo completo: borrar el móvil y volver a entrar con la cuenta lo recupera todo', async () => {
    let t = mustResolveLocal('2027-01-15T13:00', MADRID);
    const now = () => t;
    const server = new SimServer(now);
    const fake = fakeSupabase(server, server.caregiverIds[0] as string);
    const db = fresh();
    const name = db.name;
    let ctx = await ensureBootstrap(db, now);
    const baby = await createBaby(ctx, { alias: 'Lía', birthDate: '2026-07-01' });
    const s = await startSleep(ctx, baby.id);
    t += HOUR;
    await finishSleep(ctx, s.id);
    ctx = (await connectDevice(ctx, supabaseTransport(fake.client))).ctx;
    expect((await wipeBlockers(ctx.db)).pending).toBe(0);

    await wipeLocalDevice(ctx.db); // «vendo el móvil»
    const ctx2 = await ensureBootstrap(new BabySleepDb(name), now); // la app arranca limpia (bienvenida)
    expect(await listBabies(ctx2)).toHaveLength(0);

    const back = await connectDevice(ctx2, supabaseTransport(fake.client)); // «ya tengo cuenta»
    expect(back.report).toMatchObject({ ok: true, rejected: 0 });
    expect((await listBabies(back.ctx)).map((b) => b.alias)).toEqual(['Lía']);
    expect(await listSessions(back.ctx, baby.id)).toHaveLength(1);
    expect(server.rows('baby')).toHaveLength(1); // el servidor no recibió ningún bebé nuevo
  });
});

describe('distinguir una sesión inválida de un fallo de red', () => {
  it.each([
    'No se pudo leer baby: JWT cryptographic operation failed',
    'JWT expired',
    'Invalid Refresh Token: Refresh Token Not Found',
    'No hay una sesión iniciada',
    'Request failed with status 401',
  ])('«%s» significa que hay que volver a entrar', (m) => {
    expect(isAuthFailure(m)).toBe(true);
  });

  it.each([
    'Failed to fetch',
    'sin conexión',
    'red caída',
    'respuesta perdida',
    'No se pudieron enviar los cambios: canceling statement due to statement timeout',
    'No se pudo leer baby: permission denied for table baby',
  ])('«%s» es un fallo pasajero o de otra naturaleza: se reintenta, no se cierra la sesión', (m) => {
    expect(isAuthFailure(m)).toBe(false);
  });
});
