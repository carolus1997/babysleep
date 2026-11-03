import { uuidv7 } from '@babysleep/core';
import type { AppClient } from '../src/sync/supabase';
import { SYNC_TABLES } from '../src/sync/tables';
import { SimServer, toWire } from './sim-server';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };

/** Imita el constructor de consultas de supabase-js (solo lo que usa la app) sobre filas en memoria. */
class Query implements PromiseLike<Result> {
  constructor(private rows: Row[], private readonly fail: string | null = null) {}
  select(_cols?: string) {
    return this;
  }
  gt(col: string, v: number) {
    this.rows = this.rows.filter((r) => Number(r[col]) > v);
    return this;
  }
  is(col: string, v: unknown) {
    this.rows = this.rows.filter((r) => (r[col] ?? null) === v);
    return this;
  }
  eq(col: string, v: unknown) {
    this.rows = this.rows.filter((r) => r[col] === v);
    return this;
  }
  order(col: string, o: { ascending: boolean }) {
    const num = (x: unknown) => (typeof x === 'number' ? x : Number.NaN);
    this.rows = Number.isNaN(num(this.rows[0]?.[col])) ? this.rows : [...this.rows].sort((a, b) => (num(a[col]) - num(b[col])) * (o.ascending ? 1 : -1));
    return this;
  }
  limit(n: number) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  then<A, B>(ok?: ((v: Result) => A | PromiseLike<A>) | null, no?: ((e: unknown) => B | PromiseLike<B>) | null) {
    const res: Result = this.fail === null ? { data: this.rows, error: null } : { data: null, error: { message: this.fail } };
    return Promise.resolve(res).then(ok, no);
  }
}

export interface FakeOptions {
  userId?: string | null;
  /** Mensaje de error para las llamadas a `rpc('apply_changes')` mientras esté definido. */
  failApply?: string;
}

export interface FakeClient {
  client: AppClient;
  calls: { rpc: Array<{ name: string; args: Record<string, unknown> }>; otp: unknown[]; verify: unknown[] };
  opts: FakeOptions;
  userId: string | null;
}

/**
 * Cliente de Supabase de pruebas respaldado por el servidor simulado: `rpc('apply_changes')` lo ejecuta y las
 * lecturas (`from(tabla)`) devuelven sus filas en el formato de PostgREST. Así se prueban a la vez el transporte
 * real y el motor de sincronización.
 */
export function fakeSupabase(server: SimServer, caregiverId: string, opts: FakeOptions = {}): FakeClient {
  const calls: FakeClient['calls'] = { rpc: [], otp: [], verify: [] };
  const userId = opts.userId === undefined ? uuidv7() : opts.userId;
  const identity = server.identityFor(caregiverId);
  // el simulador no conoce auth.users: se enlaza el usuario de prueba al cuidador
  const caregivers = identity.caregivers.map((c) => ({ ...c, auth_user_id: c['id'] === caregiverId ? userId : c['auth_user_id'] }));

  const client = {
    auth: {
      getUser: () => Promise.resolve({ data: { user: userId === null ? null : { id: userId } }, error: null }),
      getSession: () => Promise.resolve({ data: { session: userId === null ? null : { user: { id: userId, email: 'a@example.test' } } } }),
      signInWithOtp: (a: unknown) => {
        calls.otp.push(a);
        return Promise.resolve({ error: null });
      },
      verifyOtp: (a: unknown) => {
        calls.verify.push(a);
        return Promise.resolve({ error: null });
      },
      signOut: () => Promise.resolve({ error: null }),
    },
    from: (table: string) => {
      if (table === 'caregiver') return new Query(caregivers);
      if (table === 'family') return new Query([identity.family]);
      if ((SYNC_TABLES as readonly string[]).includes(table)) {
        return new Query(server.rows(table as (typeof SYNC_TABLES)[number]).map((r) => toWire(r)));
      }
      return new Query([], `relation ${table} does not exist`);
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.rpc.push({ name, args });
      if (name === 'apply_changes') {
        if (opts.failApply !== undefined) return Promise.resolve({ data: null, error: { message: opts.failApply } });
        const out = server.applyChanges(caregiverId, args['p_device_id'] as string, structuredClone(args['p_ops']) as never);
        return Promise.resolve({ data: structuredClone(out), error: null });
      }
      return Promise.resolve({ data: null, error: { message: `función ${name} desconocida` } });
    },
  } as unknown as AppClient;
  return { client, calls, opts, userId };
}
