import { uuidv7 } from '@babysleep/core';
import { isSyncTable, MANAGED_COLUMNS, SYNC_SCHEMAS, SYNC_TABLES, type SyncTable } from '../src/sync/tables';
import type { OpResult, PullPage, ServerIdentity, Transport, WireOp } from '../src/sync/types';

/**
 * Servidor simulado: replica las reglas de `app.apply_changes` (migraciones 0003 y 0005) para probar dos
 * móviles sin conexión. Las reglas están verificadas contra PostgreSQL real en tests/db/sync.test.sql; este
 * simulador debe seguirlas al pie de la letra (si una cambia, cambian las dos).
 *
 * Imita también cómo devuelve PostgREST los datos: `timestamptz` como `…+00:00`.
 */

type Row = Record<string, unknown> & { id: string; rev: number; deleted_at: string | null; change_seq: number };

export interface SimConflict {
  id: string;
  table: string;
  row_id: string;
  field: string | null;
  kind: string;
  status: 'open' | 'auto';
  current: unknown;
  alternate: unknown;
}

const REFS: Record<string, SyncTable> = {
  baby_id: 'baby',
  session_id: 'sleep_session',
  settling_attempt_id: 'settling_attempt',
  period_id: 'aggregate_period',
  observation_id: 'observation',
  tag_id: 'tag',
  category_id: 'event_category',
  merged_into: 'sleep_session',
};

const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const toWire = (row: Row): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? v.replace(/\.000Z$/, '+00:00').replace(/Z$/, '+00:00') : v]),
  );

export class SimServer {
  readonly familyId = uuidv7();
  readonly caregiverIds: string[];
  endToleranceS = 120;
  seq = 0;
  conflicts: SimConflict[] = [];
  /** Pistas para las pruebas. */
  stats = { applyCalls: 0, opsSeen: 0, replays: 0 };
  /** Historial legible de operaciones recibidas (para depurar divergencias). */
  log: string[] = [];

  private tables = new Map<SyncTable, Map<string, Row>>(SYNC_TABLES.map((t) => [t, new Map()]));
  private revisions = new Map<string, Map<number, Row>>();
  private applied = new Map<string, OpResult>();

  constructor(private readonly nowMs: () => number, caregiverCount = 2) {
    this.caregiverIds = Array.from({ length: caregiverCount }, () => uuidv7());
  }

  private ts = () => new Date(this.nowMs()).toISOString();
  rows(table: SyncTable): Row[] {
    return [...(this.tables.get(table)?.values() ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  }
  get(table: SyncTable, id: string): Row | undefined {
    return this.tables.get(table)?.get(id);
  }

  transportFor(caregiverId: string): SimTransport {
    return new SimTransport(this, caregiverId);
  }

  identityFor(caregiverId: string): ServerIdentity {
    const at = this.ts();
    return {
      me: caregiverId,
      family: { id: this.familyId, name: 'Familia', home_tz: 'Europe/Madrid', settings: { end_conflict_tolerance_s: this.endToleranceS }, rev: 1, created_at: at, updated_at: at, deleted_at: null },
      caregivers: this.caregiverIds.map((id, i) => ({
        id, family_id: this.familyId, display_name: `Cuidador ${i + 1}`, email_normalized: `cuidador${i + 1}@example.test`,
        auth_user_id: uuidv7(), role: i === 0 ? 'admin' : 'caregiver', status: 'active', rev: 1, created_at: at, updated_at: at, deleted_at: null,
      })),
    };
  }

  // -------------------------------------------------------------- apply_changes

  applyChanges(caregiverId: string, deviceId: string, ops: WireOp[]): { results: OpResult[]; change_seq: number } {
    this.stats.applyCalls++;
    const results = ops.map((op) => {
      this.stats.opsSeen++;
      const prior = this.applied.get(op.op_id);
      if (prior !== undefined) {
        this.stats.replays++;
        return { ...prior, replayed: true };
      }
      let res: OpResult;
      try {
        res = this.applyCore(caregiverId, deviceId, op);
      } catch (e) {
        res = { op_id: op.op_id, status: 'rejected', reason: e instanceof Error ? e.message.split('\n')[0] ?? 'error' : String(e) };
      }
      res = { ...res, op_id: op.op_id };
      this.log.push(
        `${op.table}:${op.row_id.slice(-6)} cg${this.caregiverIds.indexOf(caregiverId)} base=${op.base_rev} ` +
          `${op.delete ? 'DELETE ' : ''}${op.restore ? 'RESTORE ' : ''}${JSON.stringify(op.fields)} -> ${res.status}${res.rev ? ` rev${res.rev}` : ''}${res.reason ? ` (${res.reason})` : ''}`,
      );
      this.applied.set(op.op_id, res);
      return res;
    });
    return { results, change_seq: this.seq };
  }

  private applyCore(cg: string, device: string, op: WireOp): OpResult {
    if (!isSyncTable(op.table)) throw new Error('unknown_table');
    const table = op.table;
    const schema = SYNC_SCHEMAS[table];
    const fields = op.fields ?? {};
    const store = this.tables.get(table) as Map<string, Row>;
    for (const k of Object.keys(fields)) if (MANAGED_COLUMNS.has(k)) throw new Error(`unknown_column: ${k}`);
    for (const [k, target] of Object.entries(REFS)) {
      const v = fields[k];
      if (v !== undefined && v !== null && !this.tables.get(target)?.has(v as string)) throw new Error(`invalid_reference: ${k}`);
    }
    if (op.delete === true && op.restore === true) throw new Error('delete_and_restore');

    const cur = store.get(op.row_id);
    const at = this.ts();

    // ---- alta
    if (cur === undefined) {
      if (op.delete === true || op.restore === true || op.base_rev !== null) throw new Error('row_not_found');
      const row = schema.parse({
        ...fields, id: op.row_id, family_id: this.familyId, rev: 1, change_seq: this.seq + 1, created_at: at, updated_at: at,
        created_by: cg, updated_by: cg, origin_device_id: device, deleted_at: null,
      }) as unknown as Row;
      this.seq++;
      this.commit(table, row);
      return { op_id: op.op_id, status: 'applied', rev: 1, change_seq: this.seq };
    }

    const rev = cur.rev;
    const deleted = cur.deleted_at !== null;
    if (op.base_rev === null) return { op_id: op.op_id, status: 'noop', rev };
    if (op.base_rev > rev) throw new Error('base_rev_ahead');

    // ---- fusión campo a campo (lo que escribiría la base de datos se valida con el contrato)
    const candidate = schema.parse({ ...cur, ...fields }) as unknown as Record<string, unknown>;
    const old = op.base_rev < rev ? this.revisions.get(`${table}:${op.row_id}`)?.get(op.base_rev) : undefined;
    const apply: string[] = [];
    const conflicts: string[] = [];
    let open = false;
    let flag = false;
    const conflict = (field: string | null, kind: string, status: 'open' | 'auto', current: unknown, alternate: unknown) => {
      const id = uuidv7();
      this.conflicts.push({ id, table, row_id: op.row_id, field, kind, status, current, alternate });
      conflicts.push(id);
    };

    for (const k of Object.keys(fields)) {
      const inc = candidate[k];
      if (eq(cur[k], inc)) continue;
      if (op.base_rev === rev || (old !== undefined && eq(cur[k], old[k]))) {
        apply.push(k);
      } else if (table === 'baby') {
        apply.push(k);
      } else if (table === 'sleep_session' && k === 'sleep_end_utc' && cur[k] != null && inc != null) {
        const diff = Math.abs(Date.parse(cur[k] as string) - Date.parse(inc as string)) / 1000;
        if (diff <= this.endToleranceS) conflict(k, 'end_time_within_tolerance', 'auto', cur[k], inc);
        else {
          conflict(k, 'end_time', 'open', cur[k], inc);
          open = true;
          flag = true;
        }
      } else {
        conflict(k, 'field', 'open', cur[k], inc);
        open = true;
      }
    }

    // ---- restaurar / borrar
    let restore = false;
    let doDelete = false;
    if (op.restore === true) restore = deleted;
    else if (deleted && op.base_rev < rev && op.delete !== true && apply.length + conflicts.length > 0) {
      restore = true;
      open = true;
      conflict(null, 'edit_after_delete', 'open', cur, fields);
    }
    if (op.delete === true && !deleted) {
      if (op.base_rev < rev) {
        conflict(null, 'delete_vs_edit', 'open', cur, null);
        open = true;
      } else doDelete = true;
    }

    if (apply.length === 0 && !restore && !flag && !doDelete) {
      return { op_id: op.op_id, status: open ? 'conflict' : 'noop', rev, conflicts };
    }

    const next = schema.parse({
      ...cur,
      ...Object.fromEntries(apply.map((k) => [k, candidate[k]])),
      ...(flag ? { conflict_open: true } : {}),
      ...(restore ? { deleted_at: null } : {}),
      ...(doDelete ? { deleted_at: at } : {}),
      rev: rev + 1, change_seq: this.seq + 1, updated_at: at, updated_by: cg, origin_device_id: device,
    }) as unknown as Row;
    this.seq++;
    this.commit(table, next);
    return { op_id: op.op_id, status: conflicts.length === 0 ? 'applied' : 'merged', rev: rev + 1, change_seq: this.seq, conflicts };
  }

  private commit(table: SyncTable, row: Row): void {
    (this.tables.get(table) as Map<string, Row>).set(row.id, row);
    const key = `${table}:${row.id}`;
    const history = this.revisions.get(key) ?? new Map<number, Row>();
    history.set(row.rev, structuredClone(row));
    this.revisions.set(key, history);
  }

  // ----------------------------------------------------------------------- pull

  pull(since: number, limit: number): PullPage {
    const all: Array<{ table: SyncTable; row: Row }> = [];
    for (const table of SYNC_TABLES) for (const row of this.tables.get(table)?.values() ?? []) if (row.change_seq > since) all.push({ table, row });
    all.sort((a, b) => a.row.change_seq - b.row.change_seq);
    const page = all.slice(0, limit);
    const rows: PullPage['rows'] = {};
    for (const { table, row } of page) (rows[table] ??= []).push(toWire(row));
    return { rows, change_seq: page.reduce((m, p) => Math.max(m, p.row.change_seq), since), more: all.length > limit };
  }
}

/** Transporte de un móvil: permite simular una red que falla o respuestas que se pierden. */
export class SimTransport implements Transport {
  /** Aplica el lote en el servidor pero la respuesta nunca llega (el caso difícil: el cliente no sabe si se aplicó). */
  dropNextResponse = false;
  /** La siguiente llamada falla antes de llegar al servidor. */
  failNext: 'apply' | 'pull' | 'any' | null = null;
  offline = false;

  constructor(private readonly server: SimServer, private readonly caregiverId: string) {}

  private gate(kind: 'apply' | 'pull') {
    if (this.offline) throw new Error('sin conexión');
    if (this.failNext === kind || this.failNext === 'any') {
      this.failNext = null;
      throw new Error('red caída');
    }
  }

  fetchIdentity(): Promise<ServerIdentity> {
    if (this.offline) return Promise.reject(new Error('sin conexión'));
    return Promise.resolve(this.server.identityFor(this.caregiverId));
  }

  applyChanges(a: { deviceId: string; clientTime: string; ops: WireOp[] }) {
    try {
      this.gate('apply');
    } catch (e) {
      return Promise.reject(e);
    }
    // El JSON viaja por la red: se copia para que el cliente y el servidor no compartan objetos.
    const res = this.server.applyChanges(this.caregiverId, a.deviceId, structuredClone(a.ops));
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      return Promise.reject(new Error('respuesta perdida'));
    }
    return Promise.resolve(structuredClone(res));
  }

  pullChanges(since: number, limit: number): Promise<PullPage> {
    try {
      this.gate('pull');
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve(structuredClone(this.server.pull(since, limit)));
  }
}
