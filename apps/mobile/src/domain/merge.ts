import { AggregatePeriod, Appointment, Awakening, Baby, Feeding, LifeEvent, SettlingAttempt, SleepSession, Vaccination } from '@babysleep/contract';
import type { Table } from 'dexie';
import { getActiveBabyId, setActiveBabyId } from './bootstrap';
import type { Ctx } from './context';
import { DomainError } from './context';
import { softDelete, updateRow } from './write';

type Validator<T> = { parse(input: unknown): T };

async function moveAll<T extends { id: string; rev: number }>(ctx: Ctx, table: Table<T, string>, schema: Validator<T>, fromId: string, intoId: string): Promise<number> {
  const rows = await (table as unknown as Table<{ id: string; baby_id: string | null }, string>).where('baby_id').equals(fromId).toArray();
  for (const r of rows) await updateRow(ctx, table, schema, r.id, { baby_id: intoId } as unknown as Partial<T>);
  return rows.length;
}

/**
 * Fusiona dos perfiles del mismo bebé: pasa TODOS los registros de `fromId` a `intoId` (sesiones, despertares, tomas, vacunas,
 * intentos de conciliación, acontecimientos e históricos) y archiva el perfil de origen (papelera, reversible). Sirve
 * cuando dos móviles crearon cada uno su perfil. El perfil que se conserva no cambia; si no tiene foto y el
 * otro sí, se queda con esa. Con la sincronización activada, el cambio viaja a todos los móviles.
 */
export async function mergeBabies(ctx: Ctx, fromId: string, intoId: string): Promise<{ moved: number }> {
  if (fromId === intoId) throw new DomainError('invalid', 'Elige dos perfiles distintos');
  const [from, into] = await Promise.all([ctx.db.baby.get(fromId), ctx.db.baby.get(intoId)]);
  if (from === undefined || into === undefined || from.deleted_at !== null || into.deleted_at !== null) {
    throw new DomainError('not_found', 'Alguno de los perfiles no existe');
  }
  const { db } = ctx;
  return db.transaction('rw', db.tables, async () => {
    let moved = 0;
    moved += await moveAll(ctx, db.sleep_session, SleepSession, fromId, intoId);
    moved += await moveAll(ctx, db.settling_attempt, SettlingAttempt, fromId, intoId);
    moved += await moveAll(ctx, db.feeding, Feeding, fromId, intoId);
    moved += await moveAll(ctx, db.awakening, Awakening, fromId, intoId);
    moved += await moveAll(ctx, db.vaccination, Vaccination, fromId, intoId);
    moved += await moveAll(ctx, db.appointment, Appointment, fromId, intoId);
    moved += await moveAll(ctx, db.aggregate_period, AggregatePeriod, fromId, intoId);
    // Los acontecimientos de la familia entera (baby_id nulo) no se tocan
    for (const e of await db.life_event.where('baby_id').equals(fromId).toArray()) {
      await updateRow(ctx, db.life_event, LifeEvent, e.id, { baby_id: intoId });
      moved++;
    }
    const photo = await db.baby_photo.get(fromId);
    if (photo !== undefined && (await db.baby_photo.get(intoId)) === undefined) await db.baby_photo.put({ ...photo, baby_id: intoId });
    await db.baby_photo.delete(fromId);
    await softDelete(ctx, db.baby, Baby, fromId);
    if ((await getActiveBabyId(ctx)) === fromId || (await db.meta.get('active_baby_id'))?.value === fromId) await setActiveBabyId(ctx, intoId);
    return { moved };
  });
}
