import Dexie from 'dexie';
import type { BabySleepDb } from '../db/schema';
import { clearStoredSession } from './supabase';

/**
 * Lo que se perdería al borrar este móvil: los cambios que aún no están en el servidor (sin conexión, rechazados
 * o a medio enviar). Con cero, borrar es seguro: la familia lo conserva todo en el servidor.
 */
export async function wipeBlockers(db: BabySleepDb): Promise<{ pending: number }> {
  return { pending: await db.outbox.count() };
}

/**
 * Borra TODO lo guardado en este móvil: la base de datos local entera (bebés, registros, cola, foto del bebé) y la
 * sesión guardada. No toca el servidor. Es irreversible; quien llama debe haber sincronizado y confirmado antes.
 */
export async function wipeLocalDevice(db: BabySleepDb): Promise<void> {
  const name = db.name;
  db.close();
  await Dexie.delete(name);
  clearStoredSession();
}
