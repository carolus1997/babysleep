import type { SupabaseClient } from '@supabase/supabase-js';
import { isSyncConfigured, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SCHEMA, SUPABASE_URL } from './config';
import { SYNC_TABLES, type SyncTable } from './tables';
import type { OpResult, PullPage, ServerIdentity, Transport } from './types';

/** Cliente apuntando al esquema `app`. Sin tipos generados de la base de datos: las filas se validan con el contrato. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppClient = SupabaseClient<any, any, any>;

let cached: Promise<AppClient> | null = null;

/**
 * Cliente de Supabase, cargado bajo demanda: mientras la sincronización no esté activada, la librería ni
 * siquiera se descarga. La sesión se guarda en el almacenamiento del navegador y se renueva sola.
 */
export function getSupabaseClient(): Promise<AppClient> {
  if (!isSyncConfigured()) return Promise.reject(new Error('La sincronización no está configurada'));
  cached ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      db: { schema: SUPABASE_SCHEMA },
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    }) as unknown as AppClient,
  );
  return cached;
}

/** ¿Hay una sesión guardada en este navegador? Comprobación local y barata: evita cargar la librería si no hace falta. */
export function hasStoredSession(): boolean {
  try {
    return Object.keys(localStorage).some((k) => k.startsWith('sb-') && k.endsWith('-auth-token'));
  } catch {
    return false;
  }
}

/** Olvida la sesión guardada en este navegador (no avisa al servidor). */
export function clearStoredSession(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('sb-') && k.endsWith('-auth-token')) localStorage.removeItem(k);
  } catch {
    /* sin almacenamiento accesible: no hay sesión que olvidar */
  }
}

/** El usuario inició sesión pero aún no está vinculado a un cuidador de la familia. */
export class NotLinkedError extends Error {
  constructor() {
    super('Esta cuenta aún no está vinculada a un cuidador de la familia');
    this.name = 'NotLinkedError';
  }
}

type Row = Record<string, unknown>;

/** Mensaje que ve la persona cuando el servidor dice `not_allowed`: su acceso a la familia se retiró (o es solo lectura). */
export const ACCESS_REVOKED_MESSAGE = 'Tu acceso a la familia ya no permite registrar. Pide a quien administra que te vuelva a invitar.';

function check<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error !== null) {
    if (res.error.message.includes('not_allowed')) throw new Error(ACCESS_REVOKED_MESSAGE);
    throw new Error(`${what}: ${res.error.message}`);
  }
  return res.data as T;
}

/**
 * `Transport` real sobre Supabase: las operaciones van por la función `app.apply_changes` y las lecturas por
 * `change_seq`. Las políticas de seguridad (RLS) hacen que cada usuario solo vea las filas de su familia.
 */
export function supabaseTransport(client: AppClient): Transport {
  return {
    async fetchIdentity(): Promise<ServerIdentity> {
      const { data: auth, error } = await client.auth.getUser();
      if (error !== null || auth.user === null) throw new Error('No hay una sesión iniciada');
      const caregivers = check(await client.from('caregiver').select('*'), 'No se pudieron leer los cuidadores') as Row[];
      const me = caregivers.find((c) => c['auth_user_id'] === auth.user.id);
      if (me === undefined) throw new NotLinkedError();
      const families = check(await client.from('family').select('*'), 'No se pudo leer la familia') as Row[];
      const family = families[0];
      if (family === undefined) throw new NotLinkedError();
      return { family, caregivers, me: me['id'] as string };
    },

    async applyChanges({ deviceId, clientTime, ops }) {
      const data = check(
        await client.rpc('apply_changes', { p_device_id: deviceId, p_client_time: clientTime, p_ops: ops }),
        'No se pudieron enviar los cambios',
      ) as { results: OpResult[]; change_seq: number };
      return { results: data.results, change_seq: Number(data.change_seq) };
    },

    async pullChanges(since, limit): Promise<PullPage> {
      // Se pide a cada tabla sus `limit` filas más antiguas posteriores a `since`; se mezclan por `change_seq`
      // (único por familia) y se corta en `limit`. Lo que quede fuera tiene un `change_seq` mayor y vendrá
      // en la página siguiente, así que nunca se salta nada.
      const perTable = await Promise.all(
        SYNC_TABLES.map(async (table) => {
          const rows = check(
            await client.from(table).select('*').gt('change_seq', since).order('change_seq', { ascending: true }).limit(limit),
            `No se pudo leer ${table}`,
          ) as Row[];
          return rows.map((row) => ({ table, row, seq: Number(row['change_seq']) }));
        }),
      );
      const all = perTable.flat().sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, limit);
      const rows: PullPage['rows'] = {};
      for (const p of page) (rows[p.table as SyncTable] ??= []).push(p.row);
      return {
        rows,
        change_seq: page.reduce((m, p) => Math.max(m, p.seq), since),
        // Una tabla que devuelve exactamente `limit` filas puede tener más sin leer, aunque en total no
        // lleguemos a `limit`: sin esta segunda condición esas filas se quedarían sin recibir.
        more: all.length > limit || perTable.some((rows) => rows.length >= limit),
      };
    },
  };
}
