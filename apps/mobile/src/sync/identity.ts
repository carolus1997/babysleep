import { Caregiver, Family } from '@babysleep/contract';
import { uuidv7 } from '@babysleep/core';
import { loadCtx } from '../domain/bootstrap';
import type { Ctx } from '../domain/context';
import { normalizeServerRow, pullOnly, syncOnce } from './engine';
import { SYNC_TABLES } from './tables';
import type { ServerIdentity, SyncReport, Transport } from './types';

const synced = (row: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  change_seq: null,
  created_by: null,
  updated_by: null,
  origin_device_id: null,
  ...normalizeServerRow(row),
  ...extra,
});

/**
 * Hasta conectar, cada dispositivo tiene su propia familia y su cuidador provisional. Al conectar adopta los
 * del servidor: reescribe `family_id` y la autoría de TODAS sus filas locales (sin perder ni duplicar nada) y
 * sustituye la familia y los cuidadores locales por los reales. Devuelve el contexto nuevo; la app debe
 * recargarlo.
 */
export async function adoptServerIdentity(ctx: Ctx, ident: ServerIdentity): Promise<Ctx> {
  const { db } = ctx;
  const family = Family.parse(synced(ident.family, { family_id: ident.family['id'] }));
  const caregivers = ident.caregivers.map((c) => Caregiver.parse(synced(c)));
  if (!caregivers.some((c) => c.id === ident.me)) throw new Error('El servidor no incluye a tu cuidador');
  const oldCaregiver = ctx.caregiverId;

  await db.transaction('rw', db.tables, async () => {
    for (const name of SYNC_TABLES) {
      const rows = (await db.table(name).toArray()) as Array<Record<string, unknown>>;
      await db.table(name).bulkPut(
        rows.map((r) => ({
          ...r,
          family_id: family.id,
          created_by: r['created_by'] === oldCaregiver ? ident.me : r['created_by'],
          updated_by: r['updated_by'] === oldCaregiver ? ident.me : r['updated_by'],
        })),
      );
    }
    await db.family.clear();
    await db.caregiver.clear();
    await db.family.put(family);
    await db.caregiver.bulkPut(caregivers);
    await db.meta.bulkPut([
      { key: 'family_id', value: family.id },
      { key: 'caregiver_id', value: ident.me },
    ]);
  });
  return loadCtx(db, ctx.now);
}

/**
 * Tras la primera recepción: las etiquetas y categorías de sistema que este dispositivo creó por su cuenta
 * se sustituyen por las del servidor con el mismo `slug` (si no, aparecerían duplicadas). Las referencias
 * locales se reapuntan y la copia local sobrante se elimina; nunca existió en el servidor.
 */
export async function reconcileSeeds(ctx: Ctx): Promise<number> {
  const { db } = ctx;
  let merged = 0;
  await db.transaction('rw', db.tables, async () => {
    const known = new Set((await db.sync_row.toArray()).map((r) => r.key));
    const drop = async (table: 'tag' | 'event_category', id: string) => {
      await db.table(table).delete(id);
      await db.outbox.where('[table+row_id]').equals([table, id]).delete();
    };

    const tags = await db.tag.toArray();
    const serverTag = new Map(tags.filter((t) => known.has(`tag:${t.id}`) && t.kind === 'system' && t.deleted_at === null).map((t) => [t.tag_slug, t.id]));
    for (const t of tags.filter((x) => x.kind === 'system' && x.deleted_at === null && !known.has(`tag:${x.id}`))) {
      const target = serverTag.get(t.tag_slug);
      if (target === undefined) continue;
      for (const rel of (await db.observation_tag.toArray()).filter((r) => r.tag_id === t.id)) {
        const twin = (await db.observation_tag.toArray()).find((r) => r.observation_id === rel.observation_id && r.tag_id === target);
        if (twin === undefined) {
          await db.observation_tag.put({ ...rel, tag_id: target });
        } else {
          await db.observation_tag.delete(rel.id);
          await db.outbox.where('[table+row_id]').equals(['observation_tag', rel.id]).delete();
        }
      }
      await drop('tag', t.id);
      merged++;
    }

    const cats = await db.event_category.toArray();
    const serverCat = new Map(cats.filter((c) => known.has(`event_category:${c.id}`) && c.kind === 'system' && c.deleted_at === null).map((c) => [c.slug, c.id]));
    for (const c of cats.filter((x) => x.kind === 'system' && x.deleted_at === null && !known.has(`event_category:${x.id}`))) {
      const target = serverCat.get(c.slug);
      if (target === undefined) continue;
      for (const ev of (await db.life_event.toArray()).filter((e) => e.category_id === c.id)) await db.life_event.put({ ...ev, category_id: target });
      await drop('event_category', c.id);
      merged++;
    }
  });
  return merged;
}

/** Encola un alta por cada fila local que el servidor aún no conoce, con los padres antes que los hijos. */
export async function backfillOutbox(ctx: Ctx): Promise<number> {
  const { db } = ctx;
  let queued = 0;
  await db.transaction('rw', db.tables, async () => {
    const known = new Set((await db.sync_row.toArray()).map((r) => r.key));
    const queuedRows = new Set((await db.outbox.toArray()).map((e) => `${e.table}:${e.row_id}`));
    for (const table of SYNC_TABLES) {
      const rows = ((await db.table(table).toArray()) as Array<{ id: string; created_at: string }>).sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const r of rows) {
        const k = `${table}:${r.id}`;
        if (known.has(k) || queuedRows.has(k)) continue;
        await db.outbox.add({
          table, row_id: r.id, op_id: uuidv7(), op_id_delete: uuidv7(),
          is_insert: true, fields: {}, delete: false, restore: false, attempts: 0, error: null,
        });
        queued++;
      }
    }
  });
  return queued;
}

/**
 * Conecta este dispositivo a la familia del servidor, en este orden (importa):
 *  1. adopta la identidad del servidor,
 *  2. activa la cola y TRAE lo que ya hay (sin enviar nada todavía),
 *  3. reconcilia las etiquetas de sistema duplicadas,
 *  4. encola todo lo local que el servidor no conoce,
 *  5. sincroniza.
 */
export async function connectDevice(ctx: Ctx, transport: Transport): Promise<{ ctx: Ctx; report: SyncReport }> {
  const adopted = await adoptServerIdentity(ctx, await transport.fetchIdentity());
  await adopted.db.meta.put({ key: 'sync_enabled', value: true });
  adopted.db.syncEnabled = true;

  const first = await pullOnly(adopted, transport);
  await reconcileSeeds(adopted);
  await backfillOutbox(adopted);
  const report = await syncOnce(adopted, transport);
  report.pulled += first.pulled;
  report.invalidRows += first.invalidRows;
  return { ctx: adopted, report };
}
