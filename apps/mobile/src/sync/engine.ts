import { toIso } from '@babysleep/core';
import type { Ctx } from '../domain/context';
import type { OutboxRow } from '../db/schema';
import { businessFields, SYNC_SCHEMAS, SYNC_TABLES, type SyncTable } from './tables';
import type { OpResult, SyncReport, Transport, WireOp } from './types';

const PUSH_BATCH = 100;
const PULL_PAGE = 500;
const MAX_ROUNDS = 50;

const rowKey = (table: string, id: string) => `${table}:${id}`;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;

/**
 * El servidor devuelve `timestamptz` como `2027-01-14T20:00:00+00:00` y el contrato exige `…Z` con milisegundos.
 * Se normaliza SOLO el primer nivel de la fila (las fechas civiles `YYYY-MM-DD` y los jsonb no se tocan).
 */
export function normalizeServerRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && TIMESTAMP.test(v)) {
      const fixed = /[+-]\d{2}$/.test(v) ? `${v}:00` : v; // «+00» → «+00:00»
      out[k] = toIso(Date.parse(fixed));
    } else if (k === 'change_seq' && typeof v === 'string') {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Una pasada de sincronización: primero envía lo pendiente, después trae lo nuevo. Nunca borra datos
 * locales por un error del servidor; cada operación rechazada queda en la cola con su motivo.
 */
export async function syncOnce(ctx: Ctx, transport: Transport): Promise<SyncReport> {
  const report: SyncReport = { ok: true, pushed: 0, rejected: 0, conflicts: [], pulled: 0, invalidRows: 0 };
  try {
    for (let i = 0; i < MAX_ROUNDS; i++) {
      if ((await pushRound(ctx, transport, report)) !== 'progress') break;
    }
    await pullAll(ctx, transport, report);
  } catch (e) {
    report.ok = false;
    report.error = e instanceof Error ? e.message : String(e);
  }
  return report;
}

/** Solo recibe (sin enviar): la primera pasada de un dispositivo que se conecta. */
export async function pullOnly(ctx: Ctx, transport: Transport): Promise<SyncReport> {
  const report: SyncReport = { ok: true, pushed: 0, rejected: 0, conflicts: [], pulled: 0, invalidRows: 0 };
  await pullAll(ctx, transport, report);
  return report;
}

// ---------------------------------------------------------------------- envío

async function pushRound(ctx: Ctx, transport: Transport, report: SyncReport): Promise<'idle' | 'progress' | 'stalled'> {
  const { db } = ctx;

  // Como mucho el primer registro de cada fila; si ese está rechazado, bloquea los siguientes de la fila.
  const seen = new Set<string>();
  const chosen: OutboxRow[] = [];
  for (const e of await db.outbox.orderBy('seq').toArray()) {
    const k = rowKey(e.table, e.row_id);
    if (seen.has(k)) continue;
    seen.add(k);
    if (e.error !== null) continue;
    chosen.push(e);
    if (chosen.length >= PUSH_BATCH) break;
  }
  if (chosen.length === 0) return 'idle';

  const ops: WireOp[] = [];
  const sent: Array<{ entry: OutboxRow; deleteOp: boolean }> = [];
  for (const e of chosen) {
    const known = await db.sync_row.get(rowKey(e.table, e.row_id));
    if (known === undefined) {
      // Alta: se envía la fila ENTERA tal y como está ahora (incluye lo editado desde que se encoló).
      const local = (await db.table(e.table).get(e.row_id)) as Record<string, unknown> | undefined;
      if (local === undefined) {
        if (e.seq !== undefined) await db.outbox.delete(e.seq);
        continue;
      }
      ops.push({ op_id: e.op_id, table: e.table, row_id: e.row_id, base_rev: null, fields: businessFields(local) });
      const trashed = local['deleted_at'] !== null && local['deleted_at'] !== undefined;
      // Una fila nueva tiene rev 1 en el servidor: el borrado puede ir en el mismo lote.
      if (trashed) ops.push({ op_id: e.op_id_delete, table: e.table, row_id: e.row_id, base_rev: 1, fields: {}, delete: true });
      sent.push({ entry: e, deleteOp: trashed });
    } else {
      if (Object.keys(e.fields).length === 0 && !e.delete && !e.restore) {
        if (e.seq !== undefined) await db.outbox.delete(e.seq);
        continue;
      }
      ops.push({
        op_id: e.op_id,
        table: e.table,
        row_id: e.row_id,
        base_rev: known.server_rev,
        fields: e.fields,
        ...(e.delete ? { delete: true } : {}),
        ...(e.restore ? { restore: true } : {}),
      });
      sent.push({ entry: e, deleteOp: false });
    }
  }
  if (ops.length === 0) return 'progress';

  // Se anota el intento ANTES de enviar: desde aquí el contenido del registro queda congelado, de modo que
  // reenviarlo tras una respuesta perdida es idempotente (mismo op_id) y las ediciones nuevas van detrás.
  await db.outbox.bulkPut(sent.map(({ entry }) => ({ ...entry, attempts: entry.attempts + 1 })));

  const response = await transport.applyChanges({ deviceId: ctx.deviceId, clientTime: toIso(ctx.now()), ops });
  const byId = new Map<string, OpResult>(response.results.map((r) => [r.op_id, r]));

  let resolved = 0;
  for (const { entry, deleteOp } of sent) {
    const main = byId.get(entry.op_id);
    const extra = deleteOp ? byId.get(entry.op_id_delete) : undefined;
    if (main === undefined || (deleteOp && extra === undefined)) continue; // sin respuesta: se reintentará

    const failed = main.status === 'rejected' ? main : extra?.status === 'rejected' ? extra : undefined;
    const rev = extra?.rev ?? main.rev;
    if (failed !== undefined) {
      if (main.status !== 'rejected' && main.rev !== undefined) {
        await db.sync_row.put({ key: rowKey(entry.table, entry.row_id), server_rev: main.rev });
      }
      if (entry.seq !== undefined) await db.outbox.update(entry.seq, { error: failed.reason ?? 'rechazada por el servidor' });
      report.rejected++;
      resolved++;
      continue;
    }
    if (rev !== undefined) await db.sync_row.put({ key: rowKey(entry.table, entry.row_id), server_rev: rev });
    if (entry.seq !== undefined) await db.outbox.delete(entry.seq);
    report.pushed++;
    report.conflicts.push(...(main.conflicts ?? []), ...(extra?.conflicts ?? []));
    resolved++;
  }
  return resolved > 0 ? 'progress' : 'stalled';
}

// ------------------------------------------------------------------ recepción

async function pullAll(ctx: Ctx, transport: Transport, report: SyncReport): Promise<void> {
  const { db } = ctx;
  let since = Number((await db.meta.get('sync_last_seq'))?.value ?? 0);
  for (let i = 0; i < MAX_ROUNDS * 10; i++) {
    const page = await transport.pullChanges(since, PULL_PAGE);
    await db.transaction('rw', db.tables, async () => {
      for (const table of SYNC_TABLES) {
        for (const raw of page.rows[table] ?? []) {
          if (await applyServerRow(ctx, table, raw)) report.pulled++;
          else report.invalidRows++;
        }
      }
      since = Math.max(since, page.change_seq);
      await db.meta.put({ key: 'sync_last_seq', value: since });
    });
    if (!page.more) break;
  }
}

/**
 * Guarda una fila del servidor. Si hay cambios locales pendientes sobre esa fila, se conserva su valor local
 * (la app sigue mostrando lo que acaba de hacer la persona); se enviarán en la siguiente pasada.
 */
async function applyServerRow(ctx: Ctx, table: SyncTable, raw: Record<string, unknown>): Promise<boolean> {
  const { db } = ctx;
  const parsed = SYNC_SCHEMAS[table].safeParse(normalizeServerRow(raw));
  if (!parsed.success) return false;
  const row = parsed.data as unknown as Record<string, unknown> & { id: string; rev: number };

  const pending = await db.outbox.where('[table+row_id]').equals([table, row.id]).toArray();
  if (pending.length > 0) {
    const local = (await db.table(table).get(row.id)) as Record<string, unknown> | undefined;
    if (local !== undefined) {
      for (const e of pending) {
        for (const k of Object.keys(e.fields)) row[k] = local[k];
        if (e.delete || e.restore) row['deleted_at'] = local['deleted_at'];
      }
    }
  }
  await db.table(table).put(row);
  await db.sync_row.put({ key: rowKey(table, row.id), server_rev: row.rev });
  return true;
}
