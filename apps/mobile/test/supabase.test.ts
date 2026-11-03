import { mustResolveLocal } from '@babysleep/core';
import { describe, expect, it } from 'vitest';
import { BabySleepDb } from '../src/db/schema';
import { createBaby, ensureBootstrap, listBabies } from '../src/domain/bootstrap';
import type { Ctx } from '../src/domain/context';
import { editSession, finishSleep, listSessions, startSleep } from '../src/domain/sleep';
import { AuthError, claimMembership, disableCaregiver, inviteCaregiver, isLinked, listFamily, requestCode, verifyCode } from '../src/sync/auth';
import { syncOnce } from '../src/sync/engine';
import { connectDevice } from '../src/sync/identity';
import { NotLinkedError, supabaseTransport } from '../src/sync/supabase';
import { SYNC_TABLES } from '../src/sync/tables';
import { fakeSupabase, type FakeClient } from './fake-supabase';
import { HOUR, MADRID } from './harness';
import { SimServer } from './sim-server';

let n = 0;
const OTHER = '00000000-0000-4000-8000-0000000000ee';
interface Phone {
  ctx: Ctx;
  fake: FakeClient;
}

function setup() {
  let t = mustResolveLocal('2027-01-15T13:00', MADRID);
  const now = () => t;
  const server = new SimServer(now);
  const phone = async (i: number): Promise<Phone> => {
    const db = new BabySleepDb(`sb-${++n}-${Math.random().toString(36).slice(2)}`);
    return { ctx: await ensureBootstrap(db, now), fake: fakeSupabase(server, server.caregiverIds[i] as string) };
  };
  return { server, phone, tick: (ms: number) => (t += ms) };
}

describe('transporte de Supabase', () => {
  it('conecta un móvil con datos, sincroniza con el servidor y otro móvil lo recibe (cliente real + motor)', async () => {
    const { server, phone, tick } = setup();
    const a = await phone(0);
    const b = await phone(1);

    const baby = await createBaby(a.ctx, { alias: 'Lía', birthDate: '2026-07-01', sex: 'female' });
    const s = await startSleep(a.ctx, baby.id);
    tick(HOUR);
    await finishSleep(a.ctx, s.id);

    const first = await connectDevice(a.ctx, supabaseTransport(a.fake.client));
    expect(first.report).toMatchObject({ ok: true, rejected: 0, invalidRows: 0 });
    a.ctx = first.ctx;
    expect(server.rows('sleep_session')).toHaveLength(1);
    expect(a.fake.calls.rpc.every((c) => c.name === 'apply_changes')).toBe(true);
    expect(a.fake.calls.rpc[0]?.args).toMatchObject({ p_device_id: first.ctx.deviceId });

    const second = await connectDevice(b.ctx, supabaseTransport(b.fake.client));
    expect(second.report.ok).toBe(true);
    b.ctx = second.ctx;
    expect((await listBabies(b.ctx)).map((x) => x.alias)).toEqual(['Lía']);
    expect(await listSessions(b.ctx, baby.id)).toHaveLength(1);

    // un cambio posterior viaja de A a B
    await editSession(a.ctx, s.id, { type: 'night' });
    await syncOnce(a.ctx, supabaseTransport(a.fake.client));
    await syncOnce(b.ctx, supabaseTransport(b.fake.client));
    expect((await b.ctx.db.sleep_session.get(s.id))?.sleep_type).toBe('night');
  });

  it('la recepción pagina sin saltarse ni repetir filas, aunque las tablas se entrelacen', async () => {
    const { server, phone, tick } = setup();
    const a = await phone(0);
    const baby = await createBaby(a.ctx, { alias: 'Lía', birthDate: '2026-07-01' });
    for (let i = 0; i < 8; i++) {
      const s = await startSleep(a.ctx, baby.id);
      tick(5 * 60_000);
      await finishSleep(a.ctx, s.id);
      tick(60_000);
    }
    a.ctx = (await connectDevice(a.ctx, supabaseTransport(a.fake.client))).ctx;

    const transport = supabaseTransport(a.fake.client);
    const seen: string[] = [];
    let since = 0;
    for (let guard = 0; guard < 100; guard++) {
      const page = await transport.pullChanges(since, 4); // páginas pequeñas a propósito
      for (const rows of Object.values(page.rows)) for (const r of rows ?? []) seen.push(`${String(r['id'])}@${String(r['change_seq'])}`);
      since = page.change_seq;
      if (!page.more) break;
    }
    const expected = SYNC_TABLES.flatMap((t) => server.rows(t).map((r) => `${r.id}@${r.change_seq}`));
    expect(expected.length).toBeGreaterThan(20);
    expect([...seen].sort()).toEqual([...expected].sort());
    expect(new Set(seen).size).toBe(seen.length); // ninguna repetida
  });

  it('un error del servidor al enviar no pierde nada: la cola se conserva y se reintenta', async () => {
    const { server, phone } = setup();
    const a = await phone(0);
    await createBaby(a.ctx, { alias: 'Lía', birthDate: '2026-07-01' });
    a.ctx = (await connectDevice(a.ctx, supabaseTransport(a.fake.client))).ctx;
    const baby = (await listBabies(a.ctx))[0]!;
    await startSleep(a.ctx, baby.id);

    a.fake.opts.failApply = 'JWT expired';
    const bad = await syncOnce(a.ctx, supabaseTransport(a.fake.client));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/JWT expired/);
    expect(await a.ctx.db.outbox.count()).toBeGreaterThan(0);

    delete a.fake.opts.failApply;
    expect((await syncOnce(a.ctx, supabaseTransport(a.fake.client))).ok).toBe(true);
    expect(await a.ctx.db.outbox.count()).toBe(0);
    expect(server.rows('sleep_session')).toHaveLength(1);
  });

  it('un usuario sin cuidador vinculado se rechaza con un error claro', async () => {
    const { server, phone } = setup();
    const a = await phone(0);
    const stranger = fakeSupabase(server, server.caregiverIds[0] as string, { userId: OTHER });
    // el usuario «otro-usuario» no coincide con ningún cuidador...
    const noMatch = fakeSupabase(server, 'no-existe', { userId: OTHER });
    await expect(supabaseTransport(noMatch.client).fetchIdentity()).rejects.toBeInstanceOf(NotLinkedError);
    expect(await isLinked(noMatch.client, OTHER)).toBe(false);
    // ...y el vinculado sí se reconoce
    expect(await isLinked(a.fake.client, a.fake.userId as string)).toBe(true);
    expect(stranger.userId).toBe(OTHER);
  });
});

describe('gestión de la familia', () => {
  const rpcClient = (result: { data?: unknown; error?: { message: string } | null }) => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
      },
    } as never;
    return { client, calls };
  };

  it('invitar devuelve el código y envía el nombre y el correo recortados', async () => {
    const { client, calls } = rpcClient({ data: 'c'.repeat(64) });
    const code = await inviteCaregiver(client, '  Claudia ', ' claudia@example.test ', 'caregiver');
    expect(code).toHaveLength(64);
    expect(calls[0]).toEqual({ name: 'invite_caregiver', args: { p_display_name: 'Claudia', p_email: 'claudia@example.test', p_role: 'caregiver' } });
  });

  it.each([
    ['not_admin', /administra/i],
    ['invalid_email', /correo/i],
    ['already_member', /ya forma parte/i],
    ['cannot_disable_self', /ti mismo/i],
  ])('traduce el error «%s» del servidor a un mensaje comprensible', async (raw, msg) => {
    const { client } = rpcClient({ error: { message: raw } });
    const err = await inviteCaregiver(client, 'A', 'a@example.test', 'viewer').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).message).toMatch(msg);
    expect((err as AuthError).code).toBe(raw);
    const err2 = await disableCaregiver(client, 'x').catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(AuthError);
  });

  it('retirar el acceso llama a la función con el id del cuidador', async () => {
    const { client, calls } = rpcClient({});
    await disableCaregiver(client, 'abc');
    expect(calls[0]).toEqual({ name: 'disable_caregiver', args: { p_caregiver_id: 'abc' } });
  });

  it('listar la familia devuelve los miembros en orden y excluye los eliminados', async () => {
    const { server, phone } = setup();
    const a = await phone(0);
    const list = await listFamily(a.fake.client);
    expect(list.map((m) => m.display_name)).toEqual(server.identityFor(server.caregiverIds[0] as string).caregivers.map((c) => c['display_name']));
    expect(list[0]).toMatchObject({ role: 'admin', status: 'active' });
  });
});

describe('acceso por código', () => {
  it('pide el código sin permitir crear cuentas y normaliza el correo', async () => {
    const { phone } = setup();
    const a = await phone(0);
    await requestCode(a.fake.client, '  Carlos@Example.TEST ');
    expect(a.fake.calls.otp[0]).toEqual({ email: 'carlos@example.test', options: { shouldCreateUser: false } });
  });

  it('el código se envía sin espacios y como tipo «email»', async () => {
    const { phone } = setup();
    const a = await phone(0);
    await verifyCode(a.fake.client, 'Carlos@example.test', '123 456');
    expect(a.fake.calls.verify[0]).toEqual({ email: 'carlos@example.test', token: '123456', type: 'email' });
  });

  it.each([
    ['invalid', /incorrecto/i],
    ['locked', /intentos/i],
    ['expired', /caducado/i],
    ['no_window', /ventana/i],
    ['already_linked', /ya está vinculada/i],
  ])('el alta traduce el resultado «%s» a un mensaje comprensible', async (status, msg) => {
    const client = { rpc: () => Promise.resolve({ data: { status }, error: null }) } as never;
    const err = await claimMembership(client, 'abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).message).toMatch(msg);
    expect((err as AuthError).code).toBe(status);
  });

  it('un alta correcta no lanza nada', async () => {
    const client = { rpc: () => Promise.resolve({ data: { status: 'ok' }, error: null }) } as never;
    await expect(claimMembership(client, ' codigo ')).resolves.toBeUndefined();
  });
});
