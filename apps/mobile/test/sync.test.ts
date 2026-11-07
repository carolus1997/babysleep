import { formatLocal, mustResolveLocal, parseInstant } from '@babysleep/core';
import { SleepSession } from '@babysleep/contract';
import { describe, expect, it } from 'vitest';
import { BabySleepDb } from '../src/db/schema';
import { createBaby, deleteBaby, ensureBootstrap, listBabies, renameBaby, restoreBaby } from '../src/domain/bootstrap';
import { mergeBabies } from '../src/domain/merge';
import type { Ctx } from '../src/domain/context';
import { addAppointment, deleteAppointment, editAppointment, listAppointments, restoreAppointment, setAppointmentStatus } from '../src/domain/appointments';
import { addGrowth, deleteGrowth, editGrowth, listGrowth, restoreGrowth } from '../src/domain/growth';
import { addExtraVaccine, deleteVaccination, editVaccination, listVaccinations, markNotApplicable, planFor, recordDoses, restoreVaccination } from '../src/domain/vaccines';
import { addManualAwakening, deleteAwakening, editAwakening, finishAwakening, getOpenAwakening, startAwakening } from '../src/domain/awakening';
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

describe('volver a entrar con la cuenta en un móvil limpio', () => {
  it('el almacenamiento se borró (o es un móvil nuevo): al entrar con la misma cuenta se recupera todo, sin crear ni duplicar nada', async () => {
    const { clock, server, A, B, baby, session } = await connectedPair();
    // lo que hay antes: tomas, notas y perfil completos
    const f = await startFeed(A.ctx, baby, 'breast', { side: 'left' });
    clock.tick(10 * MIN);
    await finishFeed(A.ctx, f.id);
    const inArms = (await listTags(A.ctx)).find((t) => t.tag_slug === 'onset.in_arms')!;
    await saveObservation(A.ctx, { target: { sessionId: session }, moment: 'onset', text: 'Costó un rato', tagIds: [inArms.id] });
    await settle(A, B);
    const before = {
      babies: await A.ctx.db.baby.count(), sessions: await A.ctx.db.sleep_session.count(), feedings: await A.ctx.db.feeding.count(),
      tags: await A.ctx.db.tag.count(), observations: await A.ctx.db.observation.count(),
    };

    // el mismo progenitor en un móvil recién estrenado: sin ningún bebé, todo local desde cero
    const fresh = await makePhone(server, clock, 'A-limpio', 0);
    expect(await listBabies(fresh.ctx)).toHaveLength(0); // aquí la app mostraría la bienvenida
    const report = await fresh.connect();
    expect(report).toMatchObject({ ok: true, rejected: 0, invalidRows: 0 });

    expect(await listBabies(fresh.ctx)).toHaveLength(1); // ya no hay bienvenida: el bebé viene del servidor
    expect(before).toEqual({
      babies: await fresh.ctx.db.baby.count(), sessions: await fresh.ctx.db.sleep_session.count(), feedings: await fresh.ctx.db.feeding.count(),
      tags: await fresh.ctx.db.tag.count(), observations: await fresh.ctx.db.observation.count(),
    });
    expect(server.rows('baby')).toHaveLength(1); // el servidor no recibió ningún bebé «nuevo»
    expect(await pendingCount(fresh.ctx.db)).toBe(0); // y nada local quedó sin enviar
    await expectConverged(server, A, B, fresh);
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

describe('salud entre dos móviles', () => {
  const doseStates = async (p: Phone, baby: string) => {
    const b = (await p.ctx.db.baby.get(baby))!;
    return planFor(p.ctx, b, await listVaccinations(p.ctx, baby)).flatMap((m) => m.doses.map((d) => `${d.key}:${d.status}:${d.record?.given_on ?? '-'}`));
  };

  it('la ficha de salud de uno aparece en el otro; el CIPA también', async () => {
    const { server, A, B, baby } = await connectedPair();
    await renameBaby(A.ctx, baby, { pediatrician: 'Dra. Prueba', health_center_name: 'Centro de prueba', health_center_phone: '910000000', allergies: 'ninguna conocida', health_notes: 'linea 1\nlinea 2', cipa: 'TEST0000000000' });
    await settle(A, B);
    for (const p of [A, B]) {
      expect(await p.ctx.db.baby.get(baby)).toMatchObject({ pediatrician: 'Dra. Prueba', health_center_name: 'Centro de prueba', health_center_phone: '910000000', allergies: 'ninguna conocida', health_notes: 'linea 1\nlinea 2', cipa: 'TEST0000000000' });
    }
    expect(server.get('baby', baby)).toMatchObject({ cipa: 'TEST0000000000' });
    await expectConverged(server, A, B);
  });

  it('campos distintos de la ficha editados a la vez sin conexión se fusionan; el mismo campo: gana el último, sin conflicto ni rechazo', async () => {
    const { clock, server, A, B, baby } = await connectedPair();
    await renameBaby(A.ctx, baby, { pediatrician: 'Dra. A', health_center_name: 'Centro de A' });
    clock.tick(MIN);
    await renameBaby(B.ctx, baby, { nurse: 'Enfermera B', health_center_name: 'Centro de B' });
    await A.sync();
    await B.sync();
    await settle(A, B);
    for (const p of [A, B]) {
      expect(await p.ctx.db.baby.get(baby)).toMatchObject({ pediatrician: 'Dra. A', nurse: 'Enfermera B', health_center_name: 'Centro de B' });
    }
    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    expect(server.conflicts.filter((c) => c.status === 'open')).toEqual([]);
    await expectConverged(server, A, B);
  });

  it('los dos móviles abren la ficha a la vez y guardan el formulario ENTERO: lo que cada uno cambió se conserva, no se pisan los campos que no tocaron', async () => {
    const { server, A, B, baby } = await connectedPair();
    await renameBaby(A.ctx, baby, { pediatrician: 'Dra. Inicial', nurse: 'Enfermera inicial' });
    await settle(A, B);
    const open = async (p: Phone) => {
      const b = (await p.ctx.db.baby.get(baby))!;
      return { pediatrician: b.pediatrician, nurse: b.nurse, health_center_name: b.health_center_name, allergies: b.allergies, cipa: b.cipa };
    };
    const formA = await open(A);
    const formB = await open(B); // los dos parten de lo mismo
    await renameBaby(A.ctx, baby, { ...formA, pediatrician: 'Dra. Nueva' });
    await renameBaby(B.ctx, baby, { ...formB, nurse: 'Enfermera nueva', health_center_name: 'Centro nuevo' });
    await A.sync();
    await B.sync();
    await settle(A, B);
    for (const p of [A, B]) expect(await p.ctx.db.baby.get(baby)).toMatchObject({ pediatrician: 'Dra. Nueva', nurse: 'Enfermera nueva', health_center_name: 'Centro nuevo' });
    await expectConverged(server, A, B);
  });

  it('una visita de vacunas registrada en un móvil llega al otro con las mismas fechas y estados; editar, borrar y restaurar se propagan', async () => {
    const { server, A, B, baby } = await connectedPair();
    const made = await recordDoses(A.ctx, { babyId: baby, doseKeys: ['VHB@2m', 'DTPa@2m', 'VPI@2m', 'Hib@2m'], givenOn: '2027-01-05', center: 'Centro de prueba', lot: 'LOTE-1' });
    await markNotApplicable(A.ctx, baby, 'RV@2m');
    await addExtraVaccine(A.ctx, { babyId: baby, vaccine: 'Gripe 2026-27', givenOn: '2027-01-10' });
    await settle(A, B);
    expect(await listVaccinations(B.ctx, baby)).toHaveLength(6);
    expect(await doseStates(B, baby)).toEqual(await doseStates(A, baby));

    await editVaccination(B.ctx, made[0]!.id, { givenOn: '2027-01-06', lot: 'LOTE-2' });
    await deleteVaccination(A.ctx, made[1]!.id);
    await settle(A, B);
    expect((await B.ctx.db.vaccination.get(made[0]!.id))).toMatchObject({ given_on: '2027-01-06', lot: 'LOTE-2' });
    expect(await listVaccinations(B.ctx, baby)).toHaveLength(5);
    expect(await doseStates(B, baby)).toEqual(await doseStates(A, baby));

    await restoreVaccination(B.ctx, made[1]!.id);
    await settle(A, B);
    expect(await listVaccinations(A.ctx, baby)).toHaveLength(6);
    expect(await doseStates(A, baby)).toEqual(await doseStates(B, baby));
    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    await expectConverged(server, A, B);
  });

  it('dos cuidadores anotan la misma dosis sin conexión: nada se rechaza, converge y el plan es el mismo en los dos', async () => {
    const { server, A, B, baby } = await connectedPair();
    await recordDoses(A.ctx, { babyId: baby, doseKeys: ['DTPa@2m'], givenOn: '2027-01-08' });
    await recordDoses(B.ctx, { babyId: baby, doseKeys: ['DTPa@2m', 'VPI@2m'], givenOn: '2027-01-05' });
    await markNotApplicable(A.ctx, baby, 'VPI@2m'); // uno la da por puesta, el otro por «no procede»
    await A.sync();
    await B.sync();
    await settle(A, B);
    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    expect((await listVaccinations(A.ctx, baby)).filter((v) => v.dose_key === 'DTPa@2m')).toHaveLength(2);
    const a = await doseStates(A, baby);
    expect(a).toEqual(await doseStates(B, baby));
    expect(a).toContain('DTPa@2m:given:2027-01-05'); // gana la primera vez que consta
    expect(a).toContain('VPI@2m:given:2027-01-05'); // «puesta» gana a «no procede»
    await expectConverged(server, A, B);
  });

  it('las citas viajan con sus avisos (lista); estado y título editados a la vez se fusionan', async () => {
    const { server, A, B, baby } = await connectedPair();
    const a = await addAppointment(A.ctx, { babyId: baby, kind: 'pediatrician', title: 'Revision', startLocal: '2027-03-01T09:30', durationMin: 20, place: 'Centro de prueba', remindBeforeMin: [1440, 60] });
    await settle(A, B);
    expect(await listAppointments(B.ctx, baby)).toMatchObject([{ id: a.id, title: 'Revision', remind_before_min: [1440, 60], duration_min: 20, start_utc: a.start_utc }]);

    await setAppointmentStatus(B.ctx, a.id, 'done');
    await editAppointment(A.ctx, a.id, { title: 'Revision de los 4 meses', place: 'Otro centro' });
    await A.sync();
    await B.sync();
    await settle(A, B);
    for (const p of [A, B]) expect(await p.ctx.db.appointment.get(a.id)).toMatchObject({ status: 'done', title: 'Revision de los 4 meses', place: 'Otro centro' });
    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    await expectConverged(server, A, B);
  });

  it('los avisos de una cita editados a la vez: converge, sin rechazos, y queda el cambio alternativo para decidir', async () => {
    const { server, A, B, baby } = await connectedPair();
    const a = await addAppointment(A.ctx, { babyId: baby, kind: 'test', title: 'Analisis', startLocal: '2027-03-01T09:30', remindBeforeMin: [1440, 60] });
    await settle(A, B);
    await editAppointment(A.ctx, a.id, { remindBeforeMin: [120] });
    await editAppointment(B.ctx, a.id, { remindBeforeMin: [10080, 30] });
    await A.sync();
    await B.sync();
    await settle(A, B);
    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    expect(server.get('appointment', a.id)?.['remind_before_min']).toEqual([120]); // el primero en llegar
    expect(server.conflicts.some((c) => c.field === 'remind_before_min' && c.status === 'open')).toBe(true);
    await expectConverged(server, A, B);
  });

  it('borrar una cita en un móvil mientras el otro la edita (en cualquier orden de envío): se conserva y queda marcada; borrar y restaurar se propagan', async () => {
    const { server, A, B, baby } = await connectedPair();
    const a = await addAppointment(A.ctx, { babyId: baby, kind: 'other', title: 'Cita', startLocal: '2027-03-01T09:30' });
    const b = await addAppointment(A.ctx, { babyId: baby, kind: 'other', title: 'Otra cita', startLocal: '2027-03-02T09:30' });
    await settle(A, B);

    // el borrado llega primero y la edición después / la edición llega primero y el borrado después
    await deleteAppointment(A.ctx, a.id);
    await editAppointment(B.ctx, a.id, { place: 'Lugar nuevo' });
    await editAppointment(A.ctx, b.id, { place: 'Lugar de A' });
    await deleteAppointment(B.ctx, b.id);
    await A.sync();
    await B.sync();
    await settle(A, B);
    expect(server.conflicts.filter((c) => c.status === 'open').map((c) => c.row_id).sort()).toEqual([a.id, b.id].sort());
    expect(server.conflicts.map((c) => c.kind).sort()).toEqual(['delete_vs_edit', 'edit_after_delete']);
    // nada se pierde en silencio: las dos citas siguen vivas en los dos móviles
    for (const p of [A, B]) expect((await listAppointments(p.ctx, baby)).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());

    await deleteAppointment(B.ctx, a.id);
    await settle(A, B);
    expect((await listAppointments(A.ctx, baby)).map((x) => x.id)).toEqual([b.id]);
    await restoreAppointment(A.ctx, a.id);
    await settle(A, B);
    expect(await listAppointments(B.ctx, baby)).toHaveLength(2);
    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    await expectConverged(server, A, B);
  });

  it('un móvil nuevo que entra después recibe todo lo de salud: ficha, vacunas y citas', async () => {
    const { clock, server, A, B, baby } = await connectedPair();
    await renameBaby(A.ctx, baby, { pediatrician: 'Dra. Prueba', cipa: 'TEST0000000000' });
    await recordDoses(A.ctx, { babyId: baby, doseKeys: ['VHB@2m', 'DTPa@2m'], givenOn: '2027-01-05' });
    await addAppointment(B.ctx, { babyId: baby, kind: 'nurse', title: 'Enfermeria', startLocal: '2027-03-01T09:30', remindBeforeMin: [60] });
    await settle(A, B);

    clock.tick(HOUR);
    const C = await makePhone(server, clock, 'C', 0);
    expect((await C.connect()).ok).toBe(true);
    await settle(A, B, C);
    expect(await C.ctx.db.baby.get(baby)).toMatchObject({ pediatrician: 'Dra. Prueba', cipa: 'TEST0000000000' });
    expect(await listVaccinations(C.ctx, baby)).toHaveLength(2);
    expect((await listAppointments(C.ctx, baby)).map((x) => x.title)).toEqual(['Enfermeria']);
    expect(await doseStates(C, baby)).toEqual(await doseStates(A, baby));
    await expectConverged(server, A, B, C);
  });

  it('lo anotado de salud ANTES de conectar el móvil se sube tal cual y el otro lo recibe', async () => {
    const { server, A, B } = await pair({
      seedA: async (A) => {
        const baby = await createBaby(A.ctx, { alias: 'Lía', birthDate: '2026-07-01' });
        await renameBaby(A.ctx, baby.id, { pediatrician: 'Dra. Prueba', cipa: 'TEST0000000000' });
        await recordDoses(A.ctx, { babyId: baby.id, doseKeys: ['VHB@2m'], givenOn: '2026-11-02' });
        await addAppointment(A.ctx, { babyId: baby.id, kind: 'other', title: 'Cita previa', startLocal: '2027-03-01T09:30' });
      },
    });
    expect((await A.connect()).ok).toBe(true);
    expect((await B.connect()).ok).toBe(true);
    await settle(A, B);
    expect(server.rows('vaccination')).toHaveLength(1);
    expect(server.rows('appointment')).toHaveLength(1);
    const baby = (await listBabies(B.ctx))[0]!;
    expect(baby).toMatchObject({ pediatrician: 'Dra. Prueba', cipa: 'TEST0000000000' });
    expect(await listVaccinations(B.ctx, baby.id)).toHaveLength(1);
    expect(await listAppointments(B.ctx, baby.id)).toHaveLength(1);
    await expectConverged(server, A, B);
  });

  it('un perfil anterior a la ficha de salud (sin esos campos) sigue sincronizando y recibe la ficha del otro móvil', async () => {
    const { server, A, B, baby } = await connectedPair();
    // El móvil B guardó su perfil antes de existir los campos de salud: en su almacenamiento no están.
    const legacy: Record<string, unknown> = { ...(await B.ctx.db.baby.get(baby)) };
    for (const k of ['pediatrician', 'nurse', 'health_center_name', 'health_center_address', 'health_center_phone', 'birth_hospital', 'allergies', 'health_notes', 'cipa']) delete legacy[k];
    await B.ctx.db.baby.put(legacy as never);
    await renameBaby(A.ctx, baby, { pediatrician: 'Dra. Prueba', cipa: 'TEST0000000000' });
    await settle(A, B);
    expect(await B.ctx.db.baby.get(baby)).toMatchObject({ pediatrician: 'Dra. Prueba', cipa: 'TEST0000000000' });
    await renameBaby(B.ctx, baby, { nurse: 'Enfermera B' });
    await settle(A, B);
    expect(await A.ctx.db.baby.get(baby)).toMatchObject({ nurse: 'Enfermera B', pediatrician: 'Dra. Prueba' });
    await expectConverged(server, A, B);
  });
});

describe('crecimiento entre dos móviles', () => {
  const summary = async (p: Phone, baby: string) => (await listGrowth(p.ctx, baby)).map((g) => `${g.measured_on}|${g.weight_g}|${g.length_mm}|${g.head_mm}|${g.place}`);

  it('una medida anotada en un móvil llega al otro con las mismas cifras; lo no medido sigue siendo «no medido», nunca 0', async () => {
    const { server, A, B, baby } = await connectedPair();
    await addGrowth(A.ctx, { babyId: baby, measuredOn: '2027-01-05', weightG: 5600, headMm: 405, place: 'Centro de prueba', notes: 'en ayunas' });
    await addGrowth(A.ctx, { babyId: baby, measuredOn: '2027-01-12', lengthMm: 625 });
    await settle(A, B);
    expect(await summary(B, baby)).toEqual(['2027-01-05|5600|null|405|Centro de prueba', '2027-01-12|null|625|null|null']);
    expect(await summary(A, baby)).toEqual(await summary(B, baby));
    expect(server.rows('growth_measure')).toHaveLength(2);
    await expectConverged(server, A, B);
  });

  it('editar, borrar y restaurar se propagan; campos distintos editados a la vez se fusionan', async () => {
    const { server, A, B, baby } = await connectedPair();
    const g = await addGrowth(A.ctx, { babyId: baby, measuredOn: '2027-01-05', weightG: 5600, lengthMm: 600, headMm: 400 });
    await settle(A, B);
    await editGrowth(A.ctx, g.id, { weightG: 5650 });
    await editGrowth(B.ctx, g.id, { headMm: 410, place: 'Casa' });
    await A.sync();
    await B.sync();
    await settle(A, B);
    for (const p of [A, B]) expect((await listGrowth(p.ctx, baby))[0]).toMatchObject({ weight_g: 5650, length_mm: 600, head_mm: 410, place: 'Casa' });
    expect(server.conflicts.filter((c) => c.status === 'open')).toEqual([]);
    await deleteGrowth(B.ctx, g.id);
    await settle(A, B);
    expect(await listGrowth(A.ctx, baby)).toEqual([]);
    await restoreGrowth(A.ctx, g.id);
    await settle(A, B);
    expect(await listGrowth(B.ctx, baby)).toHaveLength(1);
    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    await expectConverged(server, A, B);
  });

  it('dos cuidadores cambian el mismo peso a la vez: nada se rechaza y queda el cambio alternativo para decidir', async () => {
    const { server, A, B, baby } = await connectedPair();
    const g = await addGrowth(A.ctx, { babyId: baby, measuredOn: '2027-01-05', weightG: 5600 });
    await settle(A, B);
    await editGrowth(A.ctx, g.id, { weightG: 5700 });
    await editGrowth(B.ctx, g.id, { weightG: 5800 });
    await A.sync();
    await B.sync();
    await settle(A, B);
    expect(await rejectedEntries(A.ctx.db)).toEqual([]);
    expect(await rejectedEntries(B.ctx.db)).toEqual([]);
    expect(server.conflicts.filter((c) => c.status === 'open' && c.field === 'weight_g')).toHaveLength(1);
    await expectConverged(server, A, B);
  });

  it('borrar una medida en un móvil mientras el otro la edita: se conserva y queda marcada', async () => {
    const { server, A, B, baby } = await connectedPair();
    const g = await addGrowth(A.ctx, { babyId: baby, measuredOn: '2027-01-05', weightG: 5600 });
    await settle(A, B);
    await deleteGrowth(A.ctx, g.id);
    await editGrowth(B.ctx, g.id, { notes: 'revisada' });
    await A.sync();
    await B.sync();
    await settle(A, B);
    expect(server.conflicts.filter((c) => c.status === 'open')).toHaveLength(1);
    for (const p of [A, B]) expect(await listGrowth(p.ctx, baby)).toHaveLength(1);
    await expectConverged(server, A, B);
  });

  it('un móvil nuevo que entra después recibe las medidas; las anotadas antes de conectar se suben tal cual', async () => {
    const { clock, server, A, B, baby } = await connectedPair();
    await addGrowth(A.ctx, { babyId: baby, measuredOn: '2027-01-05', weightG: 5600 });
    await settle(A, B);
    clock.tick(HOUR);
    const C = await makePhone(server, clock, 'C', 0);
    expect((await C.connect()).ok).toBe(true);
    await settle(A, B, C);
    expect(await summary(C, baby)).toEqual(await summary(A, baby));
    await expectConverged(server, A, B, C);

    const pre = await pair({
      seedA: async (X) => {
        const b = await createBaby(X.ctx, { alias: 'Lía', birthDate: '2026-07-01' });
        await addGrowth(X.ctx, { babyId: b.id, measuredOn: '2026-11-02', weightG: 5000, headMm: 395 });
      },
    });
    expect((await pre.A.connect()).ok).toBe(true);
    expect((await pre.B.connect()).ok).toBe(true);
    await settle(pre.A, pre.B);
    expect(pre.server.rows('growth_measure')).toHaveLength(1);
    expect(await listGrowth(pre.B.ctx, (await listBabies(pre.B.ctx))[0]!.id)).toHaveLength(1);
  });

  it('al fusionar dos perfiles duplicados las medidas pasan al que se conserva, en los dos móviles', async () => {
    const { server, A, B, baby } = await connectedPair();
    const other = await createBaby(A.ctx, { alias: 'Duplicado', birthDate: '2026-07-01' });
    await addGrowth(A.ctx, { babyId: other.id, measuredOn: '2027-01-05', weightG: 5600 });
    await settle(A, B);
    await mergeBabies(A.ctx, other.id, baby);
    await settle(A, B);
    for (const p of [A, B]) {
      expect(await listGrowth(p.ctx, baby)).toHaveLength(1);
      expect(await listGrowth(p.ctx, other.id)).toEqual([]);
    }
    await expectConverged(server, A, B);
  });
});

describe('convergencia (prueba aleatoria)', () => {
  /** Cuánto de lo de salud acabó en el servidor a lo largo de todas las semillas: si fuera 0, la prueba no probaría nada. */
  const exercised = { seeds: 0, growth: 0, vaccinations: 0, appointments: 0, healthProfiles: 0, withReminders: 0 };
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
      const awakes = (await p.ctx.db.awakening.toArray()).filter((x) => x.baby_id === baby && x.deleted_at === null);
      const nights = live.filter((x) => x.sleep_type === 'night');
      const vacs = (await p.ctx.db.vaccination.toArray()).filter((x) => x.baby_id === baby);
      const appts = (await p.ctx.db.appointment.toArray()).filter((x) => x.baby_id === baby);
      const grows = (await p.ctx.db.growth_measure.toArray()).filter((x) => x.baby_id === baby);
      clock.tick((1 + Math.floor(rand() * 25)) * MIN);

      const action = pick(['start', 'finish', 'cancel', 'edit', 'delete', 'restore', 'manual', 'note', 'profile', 'feedStart', 'feedFinish', 'feedEdit', 'feedNote', 'feedDelete', 'awStart', 'awManual', 'awFinish', 'awEdit', 'awDelete', 'hProfile', 'vRecord', 'vEdit', 'vDelete', 'vRestore', 'aAdd', 'aEdit', 'aStatus', 'aDelete', 'aRestore', 'gAdd', 'gEdit', 'gDelete', 'gRestore', 'sync', 'sync', 'sync', 'fail']);
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
        else if (action === 'awStart' && open?.sleep_type === 'night') await startAwakening(p.ctx, open.id, pick(['feeding', 'diaper', null] as const));
        else if (action === 'awFinish' && awakes.length > 0) {
          const a = pick(awakes);
          await finishAwakening(p.ctx, a.id);
        } else if (action === 'awManual' && nights.length > 0) {
          const night = pick(nights);
          const at = parseInstant(night.sleep_start_utc) + 20 * MIN;
          await addManualAwakening(p.ctx, { sessionId: night.id, startLocal: formatLocal(at, 'Europe/Madrid').slice(0, 16).replace(' ', 'T'), durationMin: rand() < 0.5 ? null : 5 + Math.floor(rand() * 60) });
        } else if (action === 'awEdit' && awakes.length > 0) {
          const a = pick(awakes);
          if (rand() < 0.5) await editAwakening(p.ctx, a.id, { reason: pick(['crying', 'other', null] as const) });
          else await editAwakening(p.ctx, a.id, { endMs: parseInstant(a.start_utc) + (10 + Math.floor(rand() * 50)) * MIN });
        } else if (action === 'awDelete' && awakes.length > 0) await deleteAwakening(p.ctx, pick(awakes).id);
        else if (action === 'hProfile') {
          await renameBaby(p.ctx, baby, rand() < 0.5 ? { pediatrician: `Dra. ${step}`, cipa: rand() < 0.3 ? '' : `TEST${step}` } : { health_center_name: `Centro ${step}`, allergies: rand() < 0.3 ? '' : `alergia ${step}` });
        } else if (action === 'vRecord') {
          const keys = ['VHB@2m', 'DTPa@2m', 'VPI@2m', 'Hib@2m', 'VNC@2m', 'MenB@2m', 'RV@2m', 'VHB@4m', 'DTPa@4m'];
          await recordDoses(p.ctx, { babyId: baby, doseKeys: [pick(keys), pick(keys)], givenOn: `2027-01-${10 + Math.floor(rand() * 5)}` });
          if (rand() < 0.3) await addExtraVaccine(p.ctx, { babyId: baby, vaccine: `Campaña ${step}`, givenOn: '2027-01-12' });
        } else if (action === 'vEdit' && vacs.some((x) => x.deleted_at === null && x.status === 'given')) {
          await editVaccination(p.ctx, pick(vacs.filter((x) => x.deleted_at === null && x.status === 'given')).id, rand() < 0.5 ? { givenOn: `2027-01-${10 + Math.floor(rand() * 5)}` } : { lot: `L${step}` });
        } else if (action === 'vDelete' && vacs.some((x) => x.deleted_at === null)) await deleteVaccination(p.ctx, pick(vacs.filter((x) => x.deleted_at === null)).id);
        else if (action === 'vRestore' && vacs.some((x) => x.deleted_at !== null)) await restoreVaccination(p.ctx, pick(vacs.filter((x) => x.deleted_at !== null)).id);
        else if (action === 'aAdd') {
          await addAppointment(p.ctx, { babyId: baby, kind: pick(['pediatrician', 'nurse', 'vaccination', 'other'] as const), title: `Cita ${step}`, startLocal: `2027-02-${10 + Math.floor(rand() * 10)}T09:30`, remindBeforeMin: rand() < 0.3 ? [] : [1440, 60] });
        } else if (action === 'aEdit' && appts.some((x) => x.deleted_at === null)) {
          const a = pick(appts.filter((x) => x.deleted_at === null));
          await editAppointment(p.ctx, a.id, rand() < 0.5 ? { remindBeforeMin: pick([[60], [1440, 120], [], [10080, 0]]) } : { title: `Cita ${step} editada`, place: `Lugar ${step}` });
        } else if (action === 'aStatus' && appts.some((x) => x.deleted_at === null)) await setAppointmentStatus(p.ctx, pick(appts.filter((x) => x.deleted_at === null)).id, pick(['scheduled', 'done', 'cancelled'] as const));
        else if (action === 'aDelete' && appts.some((x) => x.deleted_at === null)) await deleteAppointment(p.ctx, pick(appts.filter((x) => x.deleted_at === null)).id);
        else if (action === 'aRestore' && appts.some((x) => x.deleted_at !== null)) await restoreAppointment(p.ctx, pick(appts.filter((x) => x.deleted_at !== null)).id);
        else if (action === 'gAdd') {
          await addGrowth(p.ctx, { babyId: baby, measuredOn: `2027-01-${10 + Math.floor(rand() * 5)}`, weightG: rand() < 0.2 ? null : 4000 + Math.floor(rand() * 2000), lengthMm: rand() < 0.5 ? null : 560 + Math.floor(rand() * 80), headMm: rand() < 0.5 ? null : 380 + Math.floor(rand() * 40) });
        } else if (action === 'gEdit' && grows.some((x) => x.deleted_at === null)) {
          const g = pick(grows.filter((x) => x.deleted_at === null));
          await editGrowth(p.ctx, g.id, rand() < 0.5 ? { weightG: 4000 + Math.floor(rand() * 2000) } : { place: `Lugar ${step}`, notes: rand() < 0.3 ? '' : `nota ${step}` });
        } else if (action === 'gDelete' && grows.some((x) => x.deleted_at === null)) await deleteGrowth(p.ctx, pick(grows.filter((x) => x.deleted_at === null)).id);
        else if (action === 'gRestore' && grows.some((x) => x.deleted_at !== null)) await restoreGrowth(p.ctx, pick(grows.filter((x) => x.deleted_at !== null)).id);
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
    exercised.seeds++;
    exercised.vaccinations += server.rows('vaccination').length;
    exercised.appointments += server.rows('appointment').length;
    exercised.growth += server.rows('growth_measure').length;
    exercised.withReminders += server.rows('appointment').filter((a) => ((a['remind_before_min'] as number[] | undefined) ?? []).length > 0).length;
    exercised.healthProfiles += server.rows('baby').filter((b) => b['pediatrician'] != null || b['health_center_name'] != null || b['cipa'] != null).length;
    try {
      await expectConverged(server, A, B);
    } catch (e) {
      if (process.env['SYNC_TRACE']) console.log(trace.join('\n'));
      throw e;
    }
  });

  it('la prueba aleatoria sí ejercita la ficha, las vacunas y las citas (no converge «en vacío»)', () => {
    if (exercised.seeds === 0) return; // se filtró la ejecución y las semillas no corrieron
    expect(exercised.vaccinations).toBeGreaterThan(0);
    expect(exercised.appointments).toBeGreaterThan(0);
    expect(exercised.growth).toBeGreaterThan(0);
    expect(exercised.withReminders).toBeGreaterThan(0);
    expect(exercised.healthProfiles).toBeGreaterThan(0);
  });
});
