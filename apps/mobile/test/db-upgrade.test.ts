import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { BabySleepDb } from '../src/db/schema';
import { createBaby, ensureBootstrap } from '../src/domain/bootstrap';
import { getBabyPhoto, setBabyPhoto } from '../src/domain/photo';
import { startSleep } from '../src/domain/sleep';

describe('actualización de la base local (v1 → v2)', () => {
  it('conserva todos los datos existentes y añade la tabla de fotos', async () => {
    const name = `upgrade-${Math.random().toString(36).slice(2)}`;

    // Base tal y como la dejó la versión anterior de la app (solo esquema v1)
    const v1 = new Dexie(name);
    v1.version(1).stores({
      family: 'id', caregiver: 'id, family_id', baby: 'id, family_id',
      sleep_session: 'id, baby_id, sleep_start_utc, [baby_id+sleep_start_utc]',
      settling_attempt: 'id, baby_id, status', wake_episode: 'id, session_id',
      observation: 'id, session_id, settling_attempt_id', tag: 'id, tag_slug, category',
      observation_tag: 'id, observation_id', event_category: 'id, slug', life_event: 'id, baby_id, start_date',
      aggregate_period: 'id, baby_id', aggregate_item: 'id, period_id', meta: 'key',
    });
    await v1.open();
    expect(v1.tables.map((t) => t.name)).not.toContain('baby_photo');
    v1.close();

    // Con el esquema nuevo se arranca, se crean datos y se comprueba que sobreviven a una reapertura
    const db1 = new BabySleepDb(name);
    const ctx = await ensureBootstrap(db1);
    const baby = await createBaby(ctx, { alias: 'Lía', birthDate: '2026-07-01' });
    await startSleep(ctx, baby.id);
    db1.close();

    // Reapertura: nada se pierde y la tabla nueva funciona
    const db2 = new BabySleepDb(name);
    const again = await ensureBootstrap(db2);
    expect(again.familyId).toBe(ctx.familyId);
    expect(await db2.baby.count()).toBe(1);
    expect(await db2.sleep_session.count()).toBe(1);
    await setBabyPhoto(again, baby.id, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));
    expect((await getBabyPhoto(again, baby.id))?.type).toBe('image/jpeg');
    db2.close();
  });

  it('una base v1 con datos reales (creados antes de la v2) se abre sin perder nada', async () => {
    const name = `legacy-${Math.random().toString(36).slice(2)}`;
    // 1) Se crea con v1 puro y se guardan filas directamente
    const v1 = new Dexie(name);
    v1.version(1).stores({
      family: 'id', caregiver: 'id, family_id', baby: 'id, family_id',
      sleep_session: 'id, baby_id, sleep_start_utc, [baby_id+sleep_start_utc]',
      settling_attempt: 'id, baby_id, status', wake_episode: 'id, session_id',
      observation: 'id, session_id, settling_attempt_id', tag: 'id, tag_slug, category',
      observation_tag: 'id, observation_id', event_category: 'id, slug', life_event: 'id, baby_id, start_date',
      aggregate_period: 'id, baby_id', aggregate_item: 'id, period_id', meta: 'key',
    });
    await v1.table('meta').put({ key: 'marcador', value: 'datos previos' });
    await v1.table('baby').put({ id: 'b1', family_id: 'f1', alias: 'Previo' });
    v1.close();

    // 2) Se abre con la clase nueva (v2): los datos previos siguen ahí
    const db = new BabySleepDb(name);
    await db.open();
    expect((await db.meta.get('marcador'))?.value).toBe('datos previos');
    expect((await db.baby.get('b1'))?.alias).toBe('Previo');
    expect(await db.baby_photo.count()).toBe(0);
    db.close();
  });
});
