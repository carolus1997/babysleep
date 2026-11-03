import { mustResolveLocal } from '@babysleep/core';
import { SleepSession } from '@babysleep/contract';
import { describe, expect, it } from 'vitest';
import { BabySleepDb } from '../src/db/schema';
import { createBaby, deleteBaby, ensureBootstrap, listBabies, renameBaby, restoreBaby } from '../src/domain/bootstrap';
import { mergeBabies } from '../src/domain/merge';
import type { Ctx } from '../src/domain/context';
import { deleteFeeding, editFeeding, finishFeeding as finishFeed, getOpenFeeding, listFeedings, nudgeFeedingStart, restoreFeeding, startFeeding as startFeed } from '../src/domain/feeding';
import { listTags, saveObservation } from '../src/domain/notes';
import { SEED_EVENT_CATEGORIES, SEED_TAGS } from '../src/domain/seed';
import {
  addManualSession, cancelSleep, deleteSession, editSession, finishSleep, getOpenSession, listSessions,
  restoreSession, startSleep, undoCancelSleep,
} from '../src/domain/sleep';
import { insertRow, newRow } from '../src/domain/write';
import { syncOnce } from '../src/sync/engine';
import { connectDevice } from '../src/sync/identity';
import { pendingCount, rejectedEntries, retryRejected } from '../src/sync/outbox';
import { SYNC_TABLES, type SyncTable } from '../src/sync/tables';
import type { SyncReport } from '../src/sync/types';
import { SimServer, SimTransport } from './sim-server';
import { HOUR, MADRID, MIN } from './harness';

// ------------------------------------------------------------------ utilidades

class Clock {
  t = mustResolveLocal('2027-01-15T13:00', MADRID);
  now = () => this.t;
  tick(ms: number) {
    this.t += ms;
  }
}

let counter = 0;
interface Phone {
  name: string;
  ctx: Ctx;
  transport: SimTransport;
  connect(): Promise<SyncReport>;
  sync(): Promise<SyncReport>;
}

async function makePhone(server: SimServer, clock: Clock, name: string, caregiverIndex: number): Promise<Phone> {
  const db = new BabySleepDb(`sim-${name}-${++counter}-${Math.random().toString(36).slice(2)}`);
  const transport = server.transportFor(server.caregiverIds[caregiverIndex] as string);
  const phone: Phone = {
    name,
    ctx: await ensureBootstrap(db, clock.now),
    transport,
    async connect() {
      const r = await connectDevice(phone.ctx, transport);
      phone.ctx = r.ctx;
      return r.report;
    },
    sync: () => syncOnce(phone.ctx, transport),
  };
  return phone;
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
const localRows = async (p: Phone, t: SyncTable) => ((await p.ctx.db.table(t).toArray()) as Array<{ id: string }>).sort(byId);

/**
 * Metadatos de contabilidad local: si una edición del móvil resulta ser un no-op para el servidor (p. ej. restaurar
 * lo que ya está vivo), el servidor no escribe y su versión no vuelve; el móvil conserva su `rev`/`updated_*` propios.
 * El CONTENIDO es siempre idéntico; solo se tolera esto.
 */
const BOOKKEEPING = new Set(['rev', 'updated_at', 'updated_by', 'origin_device_id']);

/** `deleted_at`: importa que esté borrada o no, no la hora (cada móvil anota la suya si el servidor ya la tenía borrada). */
const sameValue = (key: string, a: unknown, b: unknown) =>
  key === 'deleted_at' ? (a === null) === (b === null) : JSON.stringify(a) === JSON.stringify(b);

/** Diferencias campo a campo entre lo que tiene un móvil y lo que tiene el servidor (vacío = idénticos). */
function diff(local: Array<{ id: string }>, remote: Array<{ id: string }>): string[] {
  const out: string[] = [];
  const l = new Map(local.map((r) => [r.id, r as Record<string, unknown>]));
  const r = new Map(remote.map((x) => [x.id, x as Record<string, unknown>]));
  for (const id of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(id);
    const b = r.get(id);
    if (a === undefined) out.push(`${id.slice(-6)}: falta en el móvil`);
    else if (b === undefined) out.push(`${id.slice(-6)}: solo en el móvil`);
    else for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!BOOKKEEPING.has(k) && !sameValue(k, a[k], b[k])) out.push(`${id.slice(-6)}.${k}: móvil=${JSON.stringify(a[k])} servidor=${JSON.stringify(b[k])}`);
  }
  return out;
}

/** Los dos móviles y el servidor tienen EXACTAMENTE las mismas filas. */
async function expectConverged(server: SimServer, ...phones: Phone[]) {
  for (const p of phones) {
    for (const t of SYNC_TABLES) {
      const d = diff(await localRows(p, t), server.rows(t));
      if (d.length > 0) {
        const ids = new Set(d.map((x) => x.split(/[.:]/)[0]));
        d.push(...server.log.filter((l) => [...ids].some((id) => l.includes(`:${id} `))).map((l) => `  · ${l}`));
      }
      expect(d, `${p.name}.${t}`).toEqual([]);
    }
    expect(await pendingCount(p.ctx.db), `${p.name}: cola vacía`).toBe(0);
  }
}

/** Sincroniza todos hasta que nada cambie. */
async function settle(...phones: Phone[]) {
  for (let i = 0; i < 6; i++) for (const p of phones) await p.sync();
}

async function pair(opts: { seedA?: (a: Phone, clock: Clock) => Promise<void> } = {}) {
  const clock = new Clock();
  const server = new SimServer(clock.now);
  const A = await makePhone(server, clock, 'A', 0);
  const B = await makePhone(server, clock, 'B', 1);
  await opts.seedA?.(A, clock);
  return { clock, server, A, B };
}

/** A tiene un bebé y una siesta cerrada; los dos móviles conectados y al día. */
async function connectedPair() {
  const w = await pair({
    seedA: async (A, clock) => {
      await createBaby(A.ctx, { alias: 'Lía', birthDate: '2026-07-01' });
      const s = await startSleep(A.ctx, (await listBabies(A.ctx))[0]?.id as string);
      clock.tick(HOUR);
      await finishSleep(A.ctx, s.id);
    },
  });
  expect((await w.A.connect()).ok).toBe(true);
  expect((await w.B.connect()).ok).toBe(true);
  await settle(w.A, w.B);
  const baby = (await listBabies(w.A.ctx))[0]?.id as string;
  const session = (await listSessions(w.A.ctx, baby))[0]?.id as string;
  return { ...w, baby, session };
}

// ------------------------------------------------------------------ escenarios

describe('la cola solo trabaja cuando la sincronización está activada', () => {
  it('sin conectar, la app escribe como siempre y no acumula nada', async () => {
    const { A, clock } = await pair();
    const baby = await createBaby(A.ctx, { alias: 'Lía', birthDate: '2026-07-01' });
    const s = await startSleep(A.ctx, baby.id);
    clock.tick(30 * MIN);
    await finishSleep(A.ctx, s.id);
    expect(A.ctx.db.syncEnabled).toBe(false);
    expect(await pendingCount(A.ctx.db)).toBe(0);
  });

  it('con ella activada, varias ediciones sin enviar se fusionan en un solo registro', async () => {
    const { A, session } = await connectedPair();
    await editSession(A.ctx, session, { type: 'night' });
    await editSession(A.ctx, session, { awakeningsCompleteness: 'partial' });
    await editSession(A.ctx, session, { type: 'nap' });
    const q = await A.ctx.db.outbox.toArray();
    expect(q).toHaveLength(1);
    expect(q[0]?.fields).toMatchObject({ sleep_type: 'nap', awakenings_completeness: 'partial' });
  });

  it('borrar y restaurar sin enviar deja el estado final (viva), no «nada»: el servidor puede tenerla borrada', async () => {
    const { server, A, B, session } = await connectedPair();
    await deleteSession(A.ctx, session);
    await settle(A, B); // el servidor la tiene borrada
    await restoreSession(B.ctx, session);
    await deleteSession(B.ctx, session);
    await restoreSession(B.ctx, session); // B acaba con la fila viva
    const q = await B.ctx.db.outbox.toArray();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ restore: true, delete: false });
    await settle(A, B);
    expect(server.get('sleep_session', session)?.deleted_at).toBeNull();
    await expectConverged(server, A, B);
  });

  it('restaurar algo que nunca se borró no cambia nada en el servidor', async () => {
    const { server, A, B, session } = await connectedPair();
    const rev = server.get('sleep_session', session)?.rev;
    await deleteSession(A.ctx, session);
    await restoreSession(A.ctx, session);
    await settle(A, B);
    expect(server.get('sleep_session', session)?.rev).toBe(rev);
    await expectConverged(server, A, B);
  });
});

describe('conectar un dispositivo', () => {
  it('el móvil con datos previos los sube tal cual, adopta la familia del servidor y no pierde ni duplica nada', async () => {
    const { server, A } = await pair({
      seedA: async (A, clock) => {
        const baby = await createBaby(A.ctx, { alias: 'Lía', birthDate: '2026-07-01', sex: 'female', birth_weight_g: 3100 });
        const s1 = await startSleep(A.ctx, baby.id);
        clock.tick(2 * HOUR);
        await finishSleep(A.ctx, s1.id);
        clock.tick(HOUR);
        const s2 = await startSleep(A.ctx, baby.id);
        clock.tick(30 * MIN);
        await finishSleep(A.ctx, s2.id);
        await deleteSession(A.ctx, s2.id); // una sesión en la papelera también viaja
        const inArms = (await listTags(A.ctx)).find((t) => t.tag_slug === 'onset.in_arms')!;
        await saveObservation(A.ctx, { target: { sessionId: s1.id }, moment: 'onset', text: 'Costó un rato', tagIds: [inArms.id] });
      },
    });
    const localFamily = A.ctx.familyId;
    const localSessionIds = (await A.ctx.db.sleep_session.toArray()).map((s) => s.id).sort();
    expect(await pendingCount(A.ctx.db)).toBe(0);

    const report = await A.connect();
    expect(report).toMatchObject({ ok: true, rejected: 0, invalidRows: 0 });
    expect(A.ctx.familyId).toBe(server.familyId);
    expect(A.ctx.familyId).not.toBe(localFamily);
    expect(A.ctx.db.syncEnabled).toBe(true);

    expect(server.rows('baby')).toHaveLength(1);
    expect(server.rows('sleep_session').map((s) => s.id).sort()).toEqual(localSessionIds); // mismos ids
    expect(server.rows('sleep_session').filter((s) => s.deleted_at !== null)).toHaveLength(1);
    expect(server.rows('observation')).toHaveLength(1);
    expect(server.rows('tag')).toHaveLength(SEED_TAGS.length);
    expect(server.rows('event_category')).toHaveLength(SEED_EVENT_CATEGORIES.length);
    expect(server.rows('baby')[0]).toMatchObject({ alias: 'Lía', sex: 'female', birth_weight_g: 3100 });
    await expectConverged(server, A);
    // La autoría pasó al cuidador real
    expect(new Set(server.rows('sleep_session').map((s) => s.created_by))).toEqual(new Set([server.caregiverIds[0]]));
  });

  it('un móvil nuevo recibe todo y las etiquetas de sistema no se duplican', async () => {
    const { server, A, B } = await pair({
      seedA: async (A) => {
        const baby = await createBaby(A.ctx, { alias: 'Lía', birthDate: '2026-07-01' });
        const s = await startSleep(A.ctx, baby.id);
        const inArms = (await listTags(A.ctx)).find((t) => t.tag_slug === 'onset.in_arms')!;
        await saveObservation(A.ctx, { target: { sessionId: s.id }, moment: 'onset', tagIds: [inArms.id], text: 'x' });
      },
    });
    await A.connect();
    const localTagIdsOfB = (await B.ctx.db.tag.toArray()).map((t) => t.id);
    const report = await B.connect();
    expect(report.ok).toBe(true);
    expect(await B.ctx.db.tag.count()).toBe(SEED_TAGS.length); // sin duplicados
    expect(await B.ctx.db.event_category.count()).toBe(SEED_EVENT_CATEGORIES.length);
    expect((await B.ctx.db.tag.toArray()).some((t) => localTagIdsOfB.includes(t.id))).toBe(false); // sustituidas por las del servidor
    expect(await listBabies(B.ctx)).toHaveLength(1);
    expect((await getOpenSession(B.ctx, (await listBabies(B.ctx))[0]?.id as string))?.id).toBeDefined();
    // la etiqueta de la nota apunta a la etiqueta del servidor en ambos móviles
    const rel = (await B.ctx.db.observation_tag.toArray())[0];
    expect(server.get('tag', rel?.tag_id as string)).toBeDefined();
    await expectConverged(server, A, B);
  });
});

describe('dos móviles', () => {
  it('lo que registra uno aparece en el otro', async () => {
    const { server, A, B, baby } = await connectedPair();
    const s = await startSleep(B.ctx, baby);
    await B.ctx.db.sleep_session.get(s.id);
    await settle(A, B);
    expect((await getOpenSession(A.ctx, baby))?.id).toBe(s.id);
    await expectConverged(server, A, B);
  });

  it('campos distintos editados a la vez sin conexión se fusionan en los dos', async () => {
    const { server, A, B, session } = await connectedPair();
    await editSession(A.ctx, session, { type: 'night' });
    await editSession(B.ctx, session, { awakeningsCompleteness: 'partial' });
    await settle(A, B);
    for (const p of [A, B]) {
      const s = await p.ctx.db.sleep_session.get(session);
      expect(s).toMatchObject({ sleep_type: 'night', awakenings_completeness: 'partial' });
    }
    expect(server.conflicts).toHaveLength(0);
    await expectConverged(server, A, B);
  });

  it('el mismo fin con ≤ 2 min de diferencia: gana el primero y queda traza automática', async () => {
    const { clock, server, A, B, baby } = await connectedPair();
    const s = await startSleep(A.ctx, baby);
    await settle(A, B);
    clock.tick(40 * MIN);
    await finishSleep(A.ctx, s.id);
    const endA = (await A.ctx.db.sleep_session.get(s.id))?.sleep_end_utc;
    clock.tick(MIN);
    await finishSleep(B.ctx, s.id); // 1 min después, sin haber visto lo de A
    await A.sync();
    await B.sync();
    await settle(A, B);
    expect(server.get('sleep_session', s.id)?.['sleep_end_utc']).toBe(endA);
    expect(server.conflicts.map((c) => [c.kind, c.status])).toEqual([['end_time_within_tolerance', 'auto']]);
    expect(server.get('sleep_session', s.id)?.['conflict_open']).toBe(false);
    await expectConverged(server, A, B);
  });

  it('el mismo fin con > 2 min de diferencia: gana el primero y la sesión queda en conflicto abierto', async () => {
    const { clock, server, A, B, baby } = await connectedPair();
    const s = await startSleep(A.ctx, baby);
    await settle(A, B);
    clock.tick(40 * MIN);
    await finishSleep(A.ctx, s.id);
    const endA = (await A.ctx.db.sleep_session.get(s.id))?.sleep_end_utc;
    clock.tick(10 * MIN);
    await finishSleep(B.ctx, s.id);
    await A.sync();
    await B.sync();
    await settle(A, B);
    const row = server.get('sleep_session', s.id);
    expect(row?.['sleep_end_utc']).toBe(endA);
    expect(row?.['conflict_open']).toBe(true);
    expect(server.conflicts.filter((c) => c.status === 'open').map((c) => c.kind)).toEqual(['end_time']);
    expect(server.conflicts[0]?.alternate).not.toBe(endA); // el valor desplazado se conserva
    for (const p of [A, B]) expect((await p.ctx.db.sleep_session.get(s.id))?.conflict_open).toBe(true);
    await expectConverged(server, A, B);
  });

  it('borrar en uno y editar en el otro: la fila se conserva y queda marcada', async () => {
    const { server, A, B, session } = await connectedPair();
    await deleteSession(A.ctx, session);
    await editSession(B.ctx, session, { type: 'night' });
    await A.sync();
    await B.sync();
    await settle(A, B);
    const row = server.get('sleep_session', session);
    expect(row?.deleted_at).toBeNull();
    expect(row?.['sleep_type']).toBe('night');
    expect(server.conflicts.map((c) => c.kind)).toContain('edit_after_delete');
    await expectConverged(server, A, B);
  });

  it('cancelar un sueño en curso se propaga y deshacerlo lo recupera, en los dos móviles', async () => {
    const { server, A, B, baby } = await connectedPair();
    const s = await startSleep(A.ctx, baby);
    await settle(A, B);
    await cancelSleep(A.ctx, s.id);
    await settle(A, B);
    expect(server.get('sleep_session', s.id)?.deleted_at).not.toBeNull();
    expect(await getOpenSession(B.ctx, baby)).toBeUndefined();

    await undoCancelSleep(A.ctx, s.id);
    await settle(A, B);
    expect(server.get('sleep_session', s.id)?.deleted_at).toBeNull();
    expect((await getOpenSession(B.ctx, baby))?.id).toBe(s.id);
    await expectConverged(server, A, B);
  });

  it('el perfil del bebé: último por campo', async () => {
    const { server, A, B, baby } = await connectedPair();
    await renameBaby(A.ctx, baby, { alias: 'Lía A' });
    await renameBaby(B.ctx, baby, { alias: 'Lía B', birth_weight_g: 3000 });
    await A.sync();
    await B.sync();
    await settle(A, B);
    expect(server.get('baby', baby)).toMatchObject({ alias: 'Lía B', birth_weight_g: 3000 });
    await expectConverged(server, A, B);
  });
});

describe('red que falla', () => {
  it('sin conexión se sigue registrando y al volver todo se envía una sola vez', async () => {
    const { server, A, B, baby } = await connectedPair();
    A.transport.offline = true;
    const s = await startSleep(A.ctx, baby);
    const r = await A.sync();
    expect(r.ok).toBe(false);
    expect(await A.ctx.db.sleep_session.get(s.id)).toBeDefined(); // nada se pierde
    expect(await pendingCount(A.ctx.db)).toBeGreaterThan(0);

    A.transport.offline = false;
    await settle(A, B);
    expect(server.rows('sleep_session').filter((x) => x.id === s.id)).toHaveLength(1);
    await expectConverged(server, A, B);
  });

  it('respuesta perdida: el servidor aplicó pero el móvil no lo sabe; reenviar no duplica ni sube la versión dos veces', async () => {
    const { server, A, B, session } = await connectedPair();
    const before = server.get('sleep_session', session)?.rev as number;
    await editSession(A.ctx, session, { type: 'night' });
    A.transport.dropNextResponse = true;
    expect((await A.sync()).ok).toBe(false);
    expect(server.get('sleep_session', session)?.rev).toBe(before + 1); // se aplicó
    expect(await pendingCount(A.ctx.db)).toBe(1); // pero el móvil lo sigue teniendo pendiente

    await settle(A, B);
    expect(server.get('sleep_session', session)?.rev).toBe(before + 1); // no se aplicó otra vez
    expect(server.stats.replays).toBeGreaterThan(0);
    await expectConverged(server, A, B);
  });

  it('respuesta perdida y luego otra edición del MISMO campo: gana la última, sin chocar consigo mismo', async () => {
    const { server, A, B, session } = await connectedPair();
    await editSession(A.ctx, session, { type: 'night' });
    A.transport.dropNextResponse = true;
    await A.sync();
    await editSession(A.ctx, session, { type: 'nap' }); // detrás de la que ya salió, no fusionada con ella
    expect(await pendingCount(A.ctx.db)).toBe(2);
    await settle(A, B);
    expect(server.get('sleep_session', session)?.['sleep_type']).toBe('nap');
    expect(server.conflicts).toHaveLength(0);
    expect((await B.ctx.db.sleep_session.get(session))?.sleep_type).toBe('nap');
    await expectConverged(server, A, B);
  });

  it('un fallo de red a mitad de la recepción no pierde nada', async () => {
    const { server, A, B, baby } = await connectedPair();
    await startSleep(A.ctx, baby);
    await A.sync();
    B.transport.failNext = 'pull';
    expect((await B.sync()).ok).toBe(false);
    await settle(A, B);
    await expectConverged(server, A, B);
  });
});

describe('operaciones rechazadas', () => {
  it('se conservan en la cola con su motivo, no se pierde el dato local y el resto sigue', async () => {
    const { server, A, baby } = await connectedPair();
    // Un registro local que el servidor no puede aceptar: apunta a un bebé que no existe
    const ghost = await insertRow(A.ctx.db.sleep_session, SleepSession, SleepSession.parse({
      ...newRow(A.ctx), baby_id: '00000000-0000-4000-8000-0000000000aa',
      sleep_start_utc: '2027-01-15T10:00:00.000Z', sleep_end_utc: '2027-01-15T11:00:00.000Z', start_tz: MADRID, end_tz: MADRID,
      start_quality: 'approx', end_quality: 'approx', sleep_type: 'nap', type_source: 'manual', settling_attempt_id: null,
      merged_into: null, source: 'manual',
    }));
    const ok = await addManualSession(A.ctx, { babyId: baby, startLocal: '2027-01-15T15:00', endLocal: '2027-01-15T16:00', type: 'nap' });

    const report = await A.sync();
    expect(report.rejected).toBe(1);
    expect(report.pushed).toBeGreaterThanOrEqual(1);
    expect(server.get('sleep_session', ghost.id)).toBeUndefined();
    expect(server.get('sleep_session', ok.id)).toBeDefined(); // la buena sí llegó
    expect(await A.ctx.db.sleep_session.get(ghost.id)).toBeDefined(); // y la mala sigue en el móvil
    const rejected = await rejectedEntries(A.ctx.db);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.error).toMatch(/invalid_reference/);

    // No bloquea el resto ni se reintenta en bucle
    expect((await A.sync()).rejected).toBe(0);
    expect(await retryRejected(A.ctx.db)).toBe(1);
  });
});

describe('tomas entre dos móviles', () => {
  it('una toma iniciada en un móvil se ve en curso en el otro, que puede terminarla; las notas viajan con ella', async () => {
    const { clock, server, A, B, baby } = await connectedPair();
    const f = await startFeed(A.ctx, baby, 'bottle');
    await settle(A, B);
    expect((await getOpenFeeding(B.ctx, baby))?.id).toBe(f.id); // en curso en el otro móvil

    clock.tick(12 * MIN);
    await finishFeed(B.ctx, f.id, { amountMl: 110 });
    const little = (await listTags(B.ctx)).find((t) => t.tag_slug === 'feeding.took_little')!;
    await saveObservation(B.ctx, { target: { feedingId: f.id }, moment: 'feeding', text: 'Se distrajo', tagIds: [little.id] });
    await settle(A, B);

    for (const p of [A, B]) {
      expect(await getOpenFeeding(p.ctx, baby)).toBeUndefined();
      expect((await p.ctx.db.feeding.get(f.id))?.amount_ml).toBe(110);
      expect((await p.ctx.db.observation.where('feeding_id').equals(f.id).toArray())[0]?.note_text).toBe('Se distrajo');
    }
    expect(server.rows('feeding')).toHaveLength(1);
    await expectConverged(server, A, B);
  });

  it('editar, borrar y recuperar una toma se propaga; el tipo y sus datos viajan juntos', async () => {
    const { clock, server, A, B, baby } = await connectedPair();
    const f = await startFeed(A.ctx, baby, 'breast', { side: 'left' });
    clock.tick(10 * MIN);
    await finishFeed(A.ctx, f.id);
    await settle(A, B);

    await editFeeding(B.ctx, f.id, { type: 'bottle', amountMl: 90 });       // pecho → biberón: quita el pecho
    await settle(A, B);
    expect(await A.ctx.db.feeding.get(f.id)).toMatchObject({ feed_type: 'bottle', breast_side: null, amount_ml: 90 });

    await deleteFeeding(A.ctx, f.id);
    await settle(A, B);
    expect(await listFeedings(B.ctx, baby)).toHaveLength(0);
    expect(server.get('feeding', f.id)?.deleted_at).not.toBeNull();
    await restoreFeeding(B.ctx, f.id);
    await settle(A, B);
    expect(await listFeedings(A.ctx, baby)).toHaveLength(1);
    await expectConverged(server, A, B);
  });

  it('dos móviles terminan la misma toma a la vez: converge sin perder ninguna', async () => {
    const { clock, server, A, B, baby } = await connectedPair();
    const f = await startFeed(A.ctx, baby, 'breast');
    await settle(A, B);
    clock.tick(15 * MIN);
    await finishFeed(A.ctx, f.id, { side: 'left' });
    clock.tick(MIN);
    await finishFeed(B.ctx, f.id, { side: 'right' });
    await A.sync();
    await B.sync();
    await settle(A, B);
    expect(server.rows('feeding')).toHaveLength(1);
    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    await expectConverged(server, A, B);
  });
});

describe('campos acoplados entre dos móviles', () => {
  it('uno cambia pecho→biberón mientras el otro anota los ml: nadie queda atascado y la toma es coherente', async () => {
    const { clock, server, A, B, baby } = await connectedPair();
    const f = await startFeed(A.ctx, baby, 'bottle');
    await settle(A, B);
    clock.tick(10 * MIN);
    await editFeeding(A.ctx, f.id, { type: 'breast', side: 'left' });
    await finishFeed(B.ctx, f.id, { amountMl: 90 });
    await A.sync();
    await B.sync();
    await settle(A, B);

    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    const row = server.get('feeding', f.id);
    expect(row).toMatchObject({ feed_type: 'breast', breast_side: 'left', amount_ml: null });
    expect(row?.['end_utc']).not.toBeNull(); // el cierre sí se aplicó
    expect(server.conflicts.some((c) => c.field === 'amount_ml' && c.status === 'open' && c.alternate === 90)).toBe(true);
    await expectConverged(server, A, B);
  });
});

describe('eliminar perfiles entre dos móviles', () => {
  it('eliminar un perfil en un móvil lo quita del otro, y recuperarlo lo devuelve (con sus sesiones)', async () => {
    const { clock, server, A, B } = await pair();
    const keep = await createBaby(A.ctx, { alias: 'Ginebra', birthDate: '2026-07-01' });
    clock.tick(1);
    const dup = await createBaby(A.ctx, { alias: 'Duplicado raro', birthDate: '2026-07-01' });
    const s = await startSleep(A.ctx, dup.id);
    clock.tick(HOUR);
    await finishSleep(A.ctx, s.id);
    await A.connect();
    await B.connect();
    await settle(A, B);
    expect((await listBabies(B.ctx)).map((b) => b.id).sort()).toEqual([keep.id, dup.id].sort());

    await deleteBaby(B.ctx, dup.id);
    await settle(A, B);
    for (const p of [A, B]) expect((await listBabies(p.ctx)).map((b) => b.id)).toEqual([keep.id]);
    expect(server.get('baby', dup.id)?.deleted_at).not.toBeNull(); // en el servidor se conserva
    expect(server.rows('sleep_session')).toHaveLength(1); // y también sus sesiones

    await restoreBaby(A.ctx, dup.id);
    await settle(A, B);
    for (const p of [A, B]) {
      expect((await listBabies(p.ctx)).map((b) => b.id).sort()).toEqual([keep.id, dup.id].sort());
      expect(await listSessions(p.ctx, dup.id)).toHaveLength(1);
    }
    await expectConverged(server, A, B);
  });
});

describe('perfiles duplicados del mismo bebé', () => {
  it('cada móvil creó el suyo: tras conectar los dos aparecen, se fusionan desde uno y los dos móviles convergen', async () => {
    const { clock, server, A, B } = await pair();
    const babyA = await createBaby(A.ctx, { alias: 'Ginebra', birthDate: '2026-07-01' });
    const sA = await startSleep(A.ctx, babyA.id);
    clock.tick(HOUR);
    await finishSleep(A.ctx, sA.id);

    const babyB = await createBaby(B.ctx, { alias: 'Ginebra', birthDate: '2026-07-01' });
    clock.tick(HOUR);
    const sB = await startSleep(B.ctx, babyB.id);
    clock.tick(30 * MIN);
    await finishSleep(B.ctx, sB.id);

    expect((await A.connect()).ok).toBe(true);
    expect((await B.connect()).ok).toBe(true);
    await settle(A, B);
    // al conectar, cada móvil ve los dos perfiles y los dos conjuntos de registros
    for (const p of [A, B]) expect((await listBabies(p.ctx)).map((b) => b.id).sort()).toEqual([babyA.id, babyB.id].sort());

    await mergeBabies(A.ctx, babyB.id, babyA.id);
    await settle(A, B);

    for (const p of [A, B]) {
      expect((await listBabies(p.ctx)).map((b) => b.id)).toEqual([babyA.id]);
      expect(await listSessions(p.ctx, babyA.id)).toHaveLength(2);
      expect(await listSessions(p.ctx, babyB.id)).toHaveLength(0);
    }
    expect(server.get('baby', babyB.id)?.deleted_at).not.toBeNull(); // archivado, no borrado
    await expectConverged(server, A, B);
  });
});

describe('convergencia (prueba aleatoria)', () => {
  const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // SYNC_SEEDS=200 npx vitest run apps/mobile/test/sync.test.ts  → búsqueda más amplia de casos raros
  it.each(Array.from({ length: Number(process.env['SYNC_SEEDS'] ?? 12) }, (_, i) => i + 1))('dos móviles con acciones y fallos al azar acaban idénticos al servidor (semilla %i)', async (seed) => {
    const rand = rng(seed);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const { clock, server, A, B, baby } = await connectedPair();
    const phones = [A, B];
    const trace: string[] = [];
    const tags = (await listTags(A.ctx)).filter((t) => t.category === 'onset');

    for (let step = 0; step < 45; step++) {
      const p = pick(phones);
      const live = (await p.ctx.db.sleep_session.toArray()).filter((s) => s.deleted_at === null && s.baby_id === baby);
      const closed = live.filter((s) => s.sleep_end_utc !== null);
      const trashed = (await p.ctx.db.sleep_session.toArray()).filter((s) => s.deleted_at !== null);
      const open = await getOpenSession(p.ctx, baby);
      const openFeed = await getOpenFeeding(p.ctx, baby);
      const feeds = (await p.ctx.db.feeding.toArray()).filter((x) => x.baby_id === baby && x.deleted_at === null);
      clock.tick((1 + Math.floor(rand() * 25)) * MIN);

      const action = pick(['start', 'finish', 'cancel', 'edit', 'delete', 'restore', 'manual', 'note', 'profile', 'feedStart', 'feedFinish', 'feedEdit', 'feedNote', 'feedDelete', 'sync', 'sync', 'sync', 'fail']);
      trace.push(`${step} ${p.name} ${action} open=${open?.id.slice(-6) ?? '-'} live=[${live.map((x) => x.id.slice(-6))}] trash=[${trashed.map((x) => x.id.slice(-6))}]`);
      try {
        if (action === 'start' && !open) await startSleep(p.ctx, baby);
        else if (action === 'finish' && open) await finishSleep(p.ctx, open.id);
        else if (action === 'cancel' && open) await cancelSleep(p.ctx, open.id);
        else if (action === 'edit' && live.length > 0) {
          const s = pick(live);
          await editSession(p.ctx, s.id, rand() < 0.5 ? { type: pick(['nap', 'night'] as const) } : { awakeningsCompleteness: pick(['unknown', 'partial', 'complete'] as const) });
        } else if (action === 'delete' && closed.length > 0) await deleteSession(p.ctx, pick(closed).id);
        else if (action === 'restore' && trashed.length > 0) await restoreSession(p.ctx, pick(trashed).id);
        else if (action === 'manual') {
          const day = 10 + Math.floor(rand() * 5);
          await addManualSession(p.ctx, { babyId: baby, startLocal: `2027-01-${day}T0${Math.floor(rand() * 5)}:00`, endLocal: `2027-01-${day}T0${5 + Math.floor(rand() * 4)}:30`, type: 'night' });
        } else if (action === 'note' && live.length > 0) {
          await saveObservation(p.ctx, { target: { sessionId: pick(live).id }, moment: 'onset', text: `nota ${step}`, tagIds: [pick(tags).id] });
        } else if (action === 'profile') await renameBaby(p.ctx, baby, { alias: `Lía ${step}`, birth_weight_g: 2500 + step });
        else if (action === 'feedStart' && !openFeed) await startFeed(p.ctx, baby, pick(['breast', 'bottle', 'solids'] as const));
        else if (action === 'feedFinish' && openFeed) {
          await finishFeed(p.ctx, openFeed.id, openFeed.feed_type === 'bottle' ? { amountMl: 30 + Math.floor(rand() * 120) } : openFeed.feed_type === 'breast' ? { side: pick(['left', 'right', 'both'] as const) } : {});
        } else if (action === 'feedEdit' && feeds.length > 0) {
          const f = pick(feeds);
          if (rand() < 0.5) await editFeeding(p.ctx, f.id, { type: pick(['breast', 'bottle', 'solids'] as const) });
          else await nudgeFeedingStart(p.ctx, f.id, -5);
        } else if (action === 'feedNote' && feeds.length > 0) {
          const ft = (await listTags(p.ctx)).filter((t) => t.category === 'feeding');
          await saveObservation(p.ctx, { target: { feedingId: pick(feeds).id }, moment: 'feeding', text: `toma ${step}`, tagIds: [pick(ft).id] });
        } else if (action === 'feedDelete' && feeds.length > 0) await deleteFeeding(p.ctx, pick(feeds).id);
        else if (action === 'sync') await p.sync();
        else if (action === 'fail') {
          p.transport[rand() < 0.5 ? 'dropNextResponse' : 'offline'] = true;
          await p.sync();
          p.transport.offline = false;
          p.transport.dropNextResponse = false;
        }
      } catch (e) {
        // Acciones inválidas en el estado actual del móvil (p. ej. cancelar un sueño ya cerrado): no son el objeto de la prueba
        if (!(e instanceof Error && /invalid|not_found|Ya hay/i.test(e.message + (e as { code?: string }).code))) throw e;
      }
    }

    await settle(A, B);
    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    try {
      await expectConverged(server, A, B);
    } catch (e) {
      if (process.env['SYNC_TRACE']) console.log(trace.join('\n'));
      throw e;
    }
  });
});
