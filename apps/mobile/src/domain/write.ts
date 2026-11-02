import { toIso, uuidv7 } from '@babysleep/core';
import Dexie, { type Table } from 'dexie';
import type { BabySleepDb } from '../db/schema';
import { recordLocalWrite, type AnyTable } from '../sync/outbox';
import type { Ctx } from './context';
import { DomainError } from './context';

/** Campos comunes de toda fila sincronizable, para una fila nueva. */
export function newRow(ctx: Ctx) {
  const at = toIso(ctx.now());
  return {
    id: uuidv7(ctx.now()),
    family_id: ctx.familyId,
    rev: 1,
    change_seq: null,
    created_at: at,
    updated_at: at,
    created_by: ctx.caregiverId,
    updated_by: ctx.caregiverId,
    origin_device_id: ctx.deviceId,
    deleted_at: null,
  };
}

type Row = { id: string; rev: number };
type Validator<T> = { parse(input: unknown): T };

/**
 * Punto ÚNICO de escritura de filas de datos. Valida contra el contrato antes de
 * guardar. Cuando llegue la sincronización (Fase 2), aquí se añadirá el registro
 * en la cola de operaciones.
 */
export async function insertRow<T extends Row>(table: Table<T, string>, schema: Validator<T>, row: unknown): Promise<T> {
  const valid = schema.parse(row);
  await withOutbox(table, async () => {
    await table.add(valid);
    await recordLocalWrite(table, valid, null);
  });
  return valid;
}

/**
 * Con la sincronización activada, la fila y su operación pendiente se guardan en UNA transacción (si la app
 * se cierra a mitad, no queda una sin la otra). Con ella apagada, o ya dentro de otra transacción, no hace nada
 * especial: la escritura es la de siempre.
 */
async function withOutbox<T>(table: AnyTable, fn: () => Promise<T>): Promise<T> {
  const db = table.db as BabySleepDb;
  if (!db.syncEnabled || Boolean(Dexie.currentTransaction)) return fn();
  return db.transaction('rw', [table, db.outbox, db.sync_row], fn);
}

export async function updateRow<T extends Row>(
  ctx: Ctx,
  table: Table<T, string>,
  schema: Validator<T>,
  id: string,
  patch: Partial<T>,
): Promise<T> {
  const current = await table.get(id);
  if (current === undefined) throw new DomainError('not_found', `No existe ${id}`);
  const next = schema.parse({
    ...current,
    ...patch,
    rev: current.rev + 1,
    updated_at: toIso(ctx.now()),
    updated_by: ctx.caregiverId,
    origin_device_id: ctx.deviceId,
  });
  await withOutbox(table, async () => {
    await table.put(next);
    await recordLocalWrite(table, next, patch as Record<string, unknown>);
  });
  return next;
}

/** Borrado lógico: la fila se conserva (papelera) y puede restaurarse. */
export function softDelete<T extends Row & { deleted_at: string | null }>(
  ctx: Ctx,
  table: Table<T, string>,
  schema: Validator<T>,
  id: string,
): Promise<T> {
  return updateRow(ctx, table, schema, id, { deleted_at: toIso(ctx.now()) } as unknown as Partial<T>);
}

export function restoreRow<T extends Row & { deleted_at: string | null }>(
  ctx: Ctx,
  table: Table<T, string>,
  schema: Validator<T>,
  id: string,
): Promise<T> {
  return updateRow(ctx, table, schema, id, { deleted_at: null } as unknown as Partial<T>);
}
