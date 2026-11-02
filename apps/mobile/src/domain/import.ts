import {
  AggregateItem,
  AggregatePeriod,
  Baby,
  EventCategory,
  LifeEvent,
  Observation,
  ObservationTag,
  SettlingAttempt,
  SleepSession,
  Tag,
  WakeEpisode,
} from '@babysleep/contract';
import { toIso } from '@babysleep/core';
import type { Ctx } from './context';
import { EXPORT_FORMAT, EXPORT_VERSION } from './export';

type AnyRow = { id: string; family_id: string; rev: number; created_by: string | null; updated_by: string | null } & Record<string, unknown>;
type Schema = { safeParse(input: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };

/**
 * Tablas importables, en orden de inserción. No se importan `family`, `caregiver` ni
 * `device`: la identidad es la del dispositivo que restaura.
 */
const IMPORT_TABLES = [
  ['tag', Tag],
  ['event_category', EventCategory],
  ['baby', Baby],
  ['settling_attempt', SettlingAttempt],
  ['sleep_session', SleepSession],
  ['wake_episode', WakeEpisode],
  ['observation', Observation],
  ['observation_tag', ObservationTag],
  ['life_event', LifeEvent],
  ['aggregate_period', AggregatePeriod],
  ['aggregate_item', AggregateItem],
] as const satisfies ReadonlyArray<readonly [string, Schema]>;

export type ImportTable = (typeof IMPORT_TABLES)[number][0];

export interface ImportConflict {
  table: ImportTable;
  id: string;
  localRev: number;
  backupRev: number;
}

export interface ImportPlan {
  ok: boolean;
  /** Motivos por los que no se puede importar. Con errores no se escribe nada. */
  errors: string[];
  exportedAt: string | null;
  /** Filas nuevas a añadir. */
  toAdd: Partial<Record<ImportTable, AnyRow[]>>;
  /** Filas que existen con otra versión más reciente en la copia (requieren confirmación). */
  newerInBackup: Array<ImportConflict & { row: AnyRow }>;
  /** Mismo id y versión pero contenido distinto: se conserva lo local. */
  sameRevDiffers: ImportConflict[];
  /** Existen con versión más reciente en este dispositivo: se conserva lo local. */
  newerLocal: number;
  unchanged: number;
  /** Etiquetas, categorías o relaciones que ya existían (por slug) y no se duplican. */
  mergedDuplicates: number;
  counts: { sessions: number; babies: string[] };
}

const empty = (errors: string[]): ImportPlan => ({
  ok: false,
  errors,
  exportedAt: null,
  toAdd: {},
  newerInBackup: [],
  sameRevDiffers: [],
  newerLocal: 0,
  unchanged: 0,
  mergedDuplicates: 0,
  counts: { sessions: 0, babies: [] },
});

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

/**
 * Analiza una copia JSON SIN escribir nada. Valida el formato y cada fila contra el
 * contrato, remapea la identidad al dispositivo actual, enlaza etiquetas y categorías de
 * sistema por `slug` (para no duplicarlas) y comprueba las referencias entre filas.
 */
export async function planImport(ctx: Ctx, text: string): Promise<ImportPlan> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty(['El archivo no es un JSON válido.']);
  }
  const doc = raw as { export_format?: unknown; export_version?: unknown; contract_version?: unknown; exported_at?: unknown; tables?: unknown };
  if (doc?.export_format !== EXPORT_FORMAT) return empty(['No es una copia de BabySleep (formato desconocido).']);
  if (doc.export_version !== EXPORT_VERSION) {
    return empty([`Versión de copia no soportada: ${String(doc.export_version)}. Esta app entiende la versión ${EXPORT_VERSION}.`]);
  }
  if (typeof doc.tables !== 'object' || doc.tables === null) return empty(['La copia no contiene tablas.']);
  const tables = doc.tables as Record<string, unknown>;

  const errors: string[] = [];
  const parsed = new Map<ImportTable, AnyRow[]>();
  for (const [name, schema] of IMPORT_TABLES) {
    const rows = tables[name] ?? [];
    if (!Array.isArray(rows)) {
      errors.push(`«${name}» debería ser una lista.`);
      continue;
    }
    const ok: AnyRow[] = [];
    rows.forEach((r, i) => {
      const res = schema.safeParse(r);
      if (res.success) ok.push(res.data as AnyRow);
      else if (errors.length < 20) errors.push(`${name}[${i}]: ${res.error.issues[0]?.path.join('.') ?? ''} ${res.error.issues[0]?.message ?? 'inválido'}`);
    });
    parsed.set(name, ok);
  }
  if (errors.length > 0) return { ...empty(errors), exportedAt: typeof doc.exported_at === 'string' ? doc.exported_at : null };

  const { db } = ctx;
  const [localCaregivers, localTags, localCats] = await Promise.all([db.caregiver.toArray(), db.tag.toArray(), db.event_category.toArray()]);
  const caregiverIds = new Set(localCaregivers.map((c) => c.id));

  // Etiquetas y categorías: se enlazan por slug con las locales (sistema y personalizadas).
  const tagMap = new Map<string, string>();
  const catMap = new Map<string, string>();
  const localTagBySlug = new Map(localTags.filter((t) => t.deleted_at === null).map((t) => [t.tag_slug, t.id]));
  const localCatBySlug = new Map(localCats.filter((c) => c.deleted_at === null).map((c) => [c.slug, c.id]));
  let mergedDuplicates = 0;

  const remap = (row: AnyRow): AnyRow => ({
    ...row,
    family_id: ctx.familyId,
    created_by: row.created_by !== null && caregiverIds.has(row.created_by) ? row.created_by : ctx.caregiverId,
    updated_by: row.updated_by !== null && caregiverIds.has(row.updated_by) ? row.updated_by : ctx.caregiverId,
  });

  const prepared = new Map<ImportTable, AnyRow[]>();
  for (const [name] of IMPORT_TABLES) {
    const out: AnyRow[] = [];
    for (const original of parsed.get(name) ?? []) {
      let row = remap(original);
      if (name === 'tag') {
        const slug = row['tag_slug'] as string;
        const local = localTagBySlug.get(slug);
        if (local !== undefined && row['deleted_at'] === null) {
          tagMap.set(row.id, local);
          mergedDuplicates++;
          continue;
        }
        tagMap.set(row.id, row.id);
      } else if (name === 'event_category') {
        const slug = row['slug'] as string;
        const local = localCatBySlug.get(slug);
        if (local !== undefined && row['deleted_at'] === null) {
          catMap.set(row.id, local);
          mergedDuplicates++;
          continue;
        }
        catMap.set(row.id, row.id);
      } else if (name === 'observation_tag') {
        row = { ...row, tag_id: tagMap.get(row['tag_id'] as string) ?? (row['tag_id'] as string) };
      } else if (name === 'life_event') {
        row = { ...row, category_id: catMap.get(row['category_id'] as string) ?? (row['category_id'] as string) };
      }
      out.push(row);
    }
    prepared.set(name, out);
  }

  // Referencias: cada fila debe apuntar a algo que exista en la copia o aquí.
  const ids = async (table: string) => new Set<string>((await db.table(table).toArray()).map((r: { id: string }) => r.id));
  const known = {
    baby: await ids('baby'),
    sleep_session: await ids('sleep_session'),
    settling_attempt: await ids('settling_attempt'),
    observation: await ids('observation'),
    tag: await ids('tag'),
    event_category: await ids('event_category'),
    aggregate_period: await ids('aggregate_period'),
  };
  for (const [name] of IMPORT_TABLES) for (const r of prepared.get(name) ?? []) if (name in known) (known as Record<string, Set<string>>)[name]?.add(r.id);

  const need = (table: ImportTable, field: string, target: keyof typeof known, nullable = false) => {
    for (const r of prepared.get(table) ?? []) {
      const v = r[field] as string | null;
      if (v === null && nullable) continue;
      if (v === null || !known[target].has(v)) {
        if (errors.length < 20) errors.push(`${table} ${r.id.slice(0, 8)}…: referencia rota en «${field}».`);
      }
    }
  };
  need('settling_attempt', 'baby_id', 'baby');
  need('sleep_session', 'baby_id', 'baby');
  need('sleep_session', 'settling_attempt_id', 'settling_attempt', true);
  need('wake_episode', 'session_id', 'sleep_session');
  need('observation', 'session_id', 'sleep_session', true);
  need('observation', 'settling_attempt_id', 'settling_attempt', true);
  need('observation_tag', 'observation_id', 'observation');
  need('observation_tag', 'tag_id', 'tag');
  need('life_event', 'baby_id', 'baby', true);
  need('life_event', 'category_id', 'event_category');
  need('aggregate_period', 'baby_id', 'baby');
  need('aggregate_item', 'period_id', 'aggregate_period');
  if (errors.length > 0) return { ...empty(errors), exportedAt: typeof doc.exported_at === 'string' ? doc.exported_at : null };

  // Clasificación frente a lo que ya hay en el dispositivo.
  const plan: ImportPlan = { ...empty([]), ok: true, exportedAt: typeof doc.exported_at === 'string' ? doc.exported_at : null, mergedDuplicates };
  const seenTagPairs = new Set((await db.observation_tag.toArray()).filter((r) => r.deleted_at === null).map((r) => `${r.observation_id}|${r.tag_id}`));
  for (const [name] of IMPORT_TABLES) {
    const local = new Map<string, AnyRow>((await db.table(name).toArray() as AnyRow[]).map((r) => [r.id, r]));
    for (const row of prepared.get(name) ?? []) {
      if (name === 'observation_tag' && row['deleted_at'] === null) {
        const key = `${row['observation_id']}|${row['tag_id']}`;
        if (!local.has(row.id) && seenTagPairs.has(key)) {
          plan.mergedDuplicates++;
          continue;
        }
        seenTagPairs.add(key);
      }
      const cur = local.get(row.id);
      if (cur === undefined) {
        (plan.toAdd[name] ??= []).push(row);
      } else if (stable(cur) === stable(row)) {
        plan.unchanged++;
      } else if (row.rev > cur.rev) {
        plan.newerInBackup.push({ table: name, id: row.id, localRev: cur.rev, backupRev: row.rev, row });
      } else if (row.rev < cur.rev) {
        plan.newerLocal++;
      } else {
        plan.sameRevDiffers.push({ table: name, id: row.id, localRev: cur.rev, backupRev: row.rev });
      }
    }
  }
  plan.counts = {
    sessions: (plan.toAdd.sleep_session ?? []).length,
    babies: (plan.toAdd.baby ?? []).map((b) => String(b['alias'])),
  };
  return plan;
}

export interface ImportResult {
  added: number;
  overwritten: number;
}

/**
 * Aplica un plan ya analizado, de forma atómica. Por defecto solo AÑADE lo que falta. Las filas
 * con versión más reciente en la copia solo se aplican con `overwriteNewer` (confirmación expresa).
 */
export async function applyImport(ctx: Ctx, plan: ImportPlan, opts: { overwriteNewer?: boolean } = {}): Promise<ImportResult> {
  if (!plan.ok) throw new Error('El plan de importación tiene errores; no se importa nada.');
  let added = 0;
  let overwritten = 0;
  await ctx.db.transaction('rw', ctx.db.tables, async () => {
    for (const [name] of IMPORT_TABLES) {
      const rows = plan.toAdd[name] ?? [];
      if (rows.length > 0) {
        await ctx.db.table(name).bulkAdd(rows);
        added += rows.length;
      }
    }
    if (opts.overwriteNewer === true) {
      for (const c of plan.newerInBackup) {
        await ctx.db.table(c.table).put(c.row);
        overwritten++;
      }
    }
    await ctx.db.meta.put({ key: 'last_import_at', value: toIso(ctx.now()) });
  });
  return { added, overwritten };
}
