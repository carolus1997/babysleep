import type { SyncTable } from './tables';

/** Operación tal y como la recibe `app.apply_changes` (migraciones 0003 y 0005). */
export interface WireOp {
  op_id: string;
  table: SyncTable;
  row_id: string;
  /** `rev` del servidor sobre la que se editó; `null` = alta. */
  base_rev: number | null;
  fields: Record<string, unknown>;
  delete?: boolean;
  restore?: boolean;
}

export interface OpResult {
  op_id: string;
  status: 'applied' | 'merged' | 'noop' | 'conflict' | 'rejected';
  rev?: number;
  change_seq?: number;
  conflicts?: string[];
  reason?: string;
  replayed?: boolean;
}

export interface PullPage {
  rows: Partial<Record<SyncTable, Array<Record<string, unknown>>>>;
  /** Mayor `change_seq` de esta página (o el pedido si no hay nada nuevo). */
  change_seq: number;
  more: boolean;
}

export interface ServerIdentity {
  family: Record<string, unknown>;
  caregivers: Array<Record<string, unknown>>;
  /** `id` del cuidador que corresponde al usuario autenticado. */
  me: string;
}

/**
 * Lo único que el motor necesita del servidor. La implementación real (Supabase: RPC `apply_changes` y
 * lecturas por `change_seq`) vendrá después; las pruebas usan un servidor simulado con las mismas reglas.
 */
export interface Transport {
  fetchIdentity(): Promise<ServerIdentity>;
  applyChanges(args: { deviceId: string; clientTime: string; ops: WireOp[] }): Promise<{ results: OpResult[]; change_seq: number }>;
  pullChanges(sinceSeq: number, limit: number): Promise<PullPage>;
}

export interface SyncReport {
  ok: boolean;
  error?: string;
  /** Operaciones aceptadas por el servidor en esta pasada. */
  pushed: number;
  /** Operaciones rechazadas (se conservan en la cola con su motivo; nunca se pierden datos locales). */
  rejected: number;
  /** Ids de conflictos que el servidor ha registrado por operaciones de este dispositivo. */
  conflicts: string[];
  /** Filas recibidas del servidor. */
  pulled: number;
  /** Filas del servidor que no pasaron la validación local (se omiten y se cuentan). */
  invalidRows: number;
}
