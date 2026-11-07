import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { applyFeedIntent, parseFeedIntent } from '../src/domain/feedIntent';
import { getOpenFeeding, listFeedings, startFeeding } from '../src/domain/feeding';
import {
  getReminderSettings, pushSupport, registerPush, setReminderSettings, unregisterPush, urlBase64ToUint8Array, type PushEnv,
} from '../src/sync/push';
import { parseMedIntent } from '../src/domain/medIntent';
import { buildMedicationPayload, buildPayload, isGone, sinceText } from '../../../supabase/functions/feed-reminders/payload';
import { makeHarness } from './harness';

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  hasServiceWorker: true, hasPushManager: true, hasNotification: true, standalone: true, ios: true, hasKey: true, ...over,
});

const rpcClient = (error: { message: string } | null = null) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: null, error });
    },
    from: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error }) }) }),
  } as never;
  return { client, calls };
};

describe('compatibilidad con los avisos', () => {
  it('en iPhone solo con la app instalada; sin clave, sin navegador compatible o instalada: motivo claro', () => {
    expect(pushSupport(env())).toEqual({ ok: true });
    expect(pushSupport(env({ standalone: false }))).toEqual({ ok: false, reason: 'not_installed' });
    expect(pushSupport(env({ standalone: false, ios: false }))).toEqual({ ok: true });
    expect(pushSupport(env({ hasPushManager: false }))).toEqual({ ok: false, reason: 'unsupported' });
    expect(pushSupport(env({ hasKey: false }))).toEqual({ ok: false, reason: 'no_key' });
  });

  it('convierte la clave VAPID de base64url a bytes', () => {
    expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([251, 255]); // alfabeto base64url y relleno ausente
  });
});

describe('llamadas al servidor', () => {
  it('registra y da de baja el móvil con los nombres de parámetros de la migración 0009', async () => {
    const { client, calls } = rpcClient();
    await registerPush(client, { endpoint: 'https://push.example.test/x', p256dh: 'k', auth: 'a' });
    await unregisterPush(client, 'https://push.example.test/x');
    await setReminderSettings(client, { enabled: true, interval_min: 150 });
    expect(calls).toEqual([
      { name: 'register_push', args: { p_endpoint: 'https://push.example.test/x', p_p256dh: 'k', p_auth: 'a' } },
      { name: 'unregister_push', args: { p_endpoint: 'https://push.example.test/x' } },
      { name: 'set_feed_reminder', args: { p_enabled: true, p_interval_min: 150 } },
    ]);
  });

  it('traduce los errores y, sin ajustes guardados, los avisos están apagados con 3 h por defecto', async () => {
    const denied = rpcClient({ message: 'not_allowed' });
    await expect(setReminderSettings(denied.client, { enabled: true, interval_min: 180 })).rejects.toThrow(/solo permite ver/);
    const none = rpcClient();
    expect(await getReminderSettings(none.client)).toEqual({ enabled: false, interval_min: 180 });
  });
});

describe('carga del aviso (servidor)', () => {
  const r = {
    subscription_id: 's', endpoint: 'https://push.example.test/x', p256dh: 'k', auth: 'a',
    baby_id: 'b1', baby_alias: 'Lía', feeding_id: 'f1', interval_min: 180, last_start_utc: '2027-01-15T08:00:00.000Z',
  };
  it('dice cuánto hace de la última toma, con el nombre del bebé y una etiqueta por bebé', () => {
    const p = buildPayload(r, Date.parse('2027-01-15T11:10:00.000Z'));
    expect(p).toMatchObject({ title: 'Toca toma · Lía', body: 'La última empezó hace 3 h 10 min.', tag: 'feed-b1', url: './?feed=ask' });
    expect(sinceText(45)).toBe('45 min');
    expect(sinceText(120)).toBe('2 h');
  });
  it('404 y 410 significan que el móvil ya no existe', () => {
    expect([404, 410, 500, undefined].map(isGone)).toEqual([true, true, false, false]);
  });
});

describe('al tocar el aviso', () => {
  it('lee solo valores conocidos de la dirección', () => {
    expect(parseFeedIntent('?feed=breast')).toBe('breast');
    expect(parseFeedIntent('?feed=bottle')).toBe('bottle');
    expect(parseFeedIntent('?feed=ask')).toBe('ask');
    expect(parseFeedIntent('?feed=solids')).toBeNull();
    expect(parseFeedIntent('?x=1')).toBeNull();
  });

  it('«Pecho» o «Biberón» empiezan la toma; «ask» no hace nada; nunca hay dos tomas en curso', async () => {
    const h = await makeHarness();
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    expect((await applyFeedIntent(h.ctx, baby, 'ask')).kind).toBe('ask');
    expect(await listFeedings(h.ctx, baby)).toHaveLength(0);

    const a = await applyFeedIntent(h.ctx, baby, 'bottle');
    expect(a.kind).toBe('started');
    expect((await getOpenFeeding(h.ctx, baby))?.feed_type).toBe('bottle');

    // tocar otra vez (o la otra persona ya la empezó): no se crea otra
    const b = await applyFeedIntent(h.ctx, baby, 'breast');
    expect(b.kind).toBe('already_running');
    expect(await listFeedings(h.ctx, baby)).toHaveLength(1);
  });

  it('respeta una toma en curso empezada antes', async () => {
    const h = await makeHarness();
    const baby = (await createBaby(h.ctx, { alias: 'B', birthDate: '2026-07-01' })).id;
    const f = await startFeeding(h.ctx, baby, 'breast');
    const r = await applyFeedIntent(h.ctx, baby, 'bottle');
    expect(r).toMatchObject({ kind: 'already_running', feeding: { id: f.id } });
  });
});

describe('aviso de medicación', () => {
  const r = {
    subscription_id: 's', endpoint: 'https://push.example.test/x', p256dh: 'k', auth: 'a',
    medication_id: '0190a7c2-0000-7000-8000-000000000001', baby_id: 'b1', baby_alias: 'Lía', name: 'Medicamento de prueba',
    dose_text: '2,5 ml', interval_min: 360, due_utc: '2027-01-20T14:00:00.000Z',
  };
  it('repite lo que escribió la familia (nombre, dosis, intervalo), con una etiqueta por tratamiento y el botón «Ya la di»', () => {
    expect(buildMedicationPayload(r)).toEqual({
      title: 'Toca Medicamento de prueba · Lía',
      body: '2,5 ml. Pauta: cada 6 h.',
      tag: 'med-0190a7c2-0000-7000-8000-000000000001',
      url: './?med=0190a7c2-0000-7000-8000-000000000001',
      babyId: 'b1',
      kind: 'medication',
      medicationId: '0190a7c2-0000-7000-8000-000000000001',
    });
    expect(buildMedicationPayload({ ...r, interval_min: 90 }).body).toBe('2,5 ml. Pauta: cada 1 h 30 min.');
  });

  it('la dirección del aviso solo admite un identificador de tratamiento; «given» solo con 1', () => {
    const id = '0190a7c2-0000-7000-8000-000000000001';
    expect(parseMedIntent(`?med=${id}`)).toEqual({ medicationId: id, given: false });
    expect(parseMedIntent(`?med=${id}&given=1`)).toEqual({ medicationId: id, given: true });
    expect(parseMedIntent(`?med=${id}&given=yes`)).toEqual({ medicationId: id, given: false });
    expect(parseMedIntent('?med=../../etc')).toBeNull();
    expect(parseMedIntent('?med=')).toBeNull();
    expect(parseMedIntent('?feed=ask')).toBeNull();
  });
});
