import { uuidv7 } from '@babysleep/core';
import type { Table } from 'dexie';
import type { BabySleepDb, OutboxRow } from '../db/schema';
import { isSyncTable, MANAGED_COLUMNS } from './tables';

// `any`: las tablas de Dexie son invariantes en su tipo de fila y aquí solo se usan `name`, `db` y el id.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTable = Table<any, string>;

/**
 * Cola de operaciones pendientes (outbox). Un registro por escritura local, con estas reglas:
 *
 *  - Si el último registro de la fila aún NO se ha intentado enviar, la escritura se fusiona con él
 *    (el último valor de cada campo gana). Si ya se intentó, se crea otro registro detrás: su `op_id` y su
 *    contenido quedan congelados, de modo que reenviarlo tras una respuesta perdida es idempotente y no
 *    «pisa» la edición siguiente.
 *  - El motor envía como mucho UN registro por fila y pasada, para que `base_rev` de cada uno sea el
 *    que dejó el anterior.
 *  - La cola solo se alimenta cuando la sincronización está activada (`db.syncEnabled`); si no, la
 *    escritura de la app es exactamente la de siempre.
 */
export async function recordLocalWrite(
  table: AnyTable,
  row: { id: string },
  patch: Record<string, unknown> | null,
): Promise<void> {
  const db = table.db as BabySleepDb;
  if (!db.syncEnabled || !isSyncTable(table.name)) return;

  const change = {
    insert: patch === null,
    fields: patch === null ? {} : Object.fromEntries(Object.entries(patch).filter(([k]) => !MANAGED_COLUMNS.has(k))),
    // `deleted_at` en el parche: con valor = borrar; null = restaurar
    delete: patch !== null && 'deleted_at' in patch && patch['deleted_at'] !== null,
    restore: patch !== null && 'deleted_at' in patch && patch['deleted_at'] === null,
  };
  const last = await db.outbox.where('[table+row_id]').equals([table.name, row.id]).last();
  const fresh = (): OutboxRow => ({
    table: table.name as OutboxRow['table'],
    row_id: row.id,
    op_id: uuidv7(),
    op_id_delete: uuidv7(),
    is_insert: change.insert,
    fields: change.fields,
    delete: change.delete,
    restore: change.restore,
    attempts: 0,
    error: null,
  });

  if (last === undefined || last.attempts > 0 || last.error !== null) {
    await db.outbox.add(fresh());
    return;
  }

  // Fusión con un registro que aún no ha salido del dispositivo. Borrar/restaurar guardan el ESTADO FINAL deseado
  // (no una resta de operaciones): «borrar y restaurar sin enviar» NO equivale a «no hacer nada», porque en el
  // servidor la fila puede estar ya borrada. El servidor trata «borrar lo borrado» y «restaurar lo vivo» como no-op.
  const merged: OutboxRow = { ...last, fields: { ...last.fields, ...change.fields }, op_id: uuidv7() };
  if (change.delete) {
    merged.delete = true;
    merged.restore = false;
  } else if (change.restore) {
    merged.restore = true;
    merged.delete = false;
  }
  await db.outbox.put(merged);
}

/** Registros pendientes de enviar (incluye los rechazados, que esperan una decisión). */
export const pendingCount = (db: BabySleepDb) => db.outbox.count();

export const rejectedEntries = (db: BabySleepDb) => db.outbox.filter((e) => e.error !== null).toArray();

/** Vuelve a intentar los registros rechazados (p. ej. tras actualizar la app o resolver una dependencia). */
export async function retryRejected(db: BabySleepDb): Promise<number> {
  const rejected = await rejectedEntries(db);
  await db.outbox.bulkPut(rejected.map((e) => ({ ...e, error: null, op_id: uuidv7(), op_id_delete: uuidv7(), attempts: 0 })));
  return rejected.length;
}
