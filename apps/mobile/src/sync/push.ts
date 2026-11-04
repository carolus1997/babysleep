import { VAPID_PUBLIC_KEY } from './config';
import type { AppClient } from './supabase';

/** Entorno del navegador que decide si se pueden recibir avisos. Se pasa aparte para poder probar cada caso. */
export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** La app está instalada en la pantalla de inicio (modo «standalone»). */
  standalone: boolean;
  ios: boolean;
  hasKey: boolean;
}

export type PushSupport = { ok: true } | { ok: false; reason: 'no_key' | 'unsupported' | 'not_installed' };

export function detectPushEnv(): PushEnv {
  const w = typeof window === 'undefined' ? undefined : window;
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { standalone?: boolean });
  return {
    hasServiceWorker: nav !== undefined && 'serviceWorker' in nav,
    hasPushManager: w !== undefined && 'PushManager' in w,
    hasNotification: w !== undefined && 'Notification' in w,
    standalone: (w?.matchMedia?.('(display-mode: standalone)').matches ?? false) || nav?.standalone === true,
    ios: nav !== undefined && /iphone|ipad|ipod/i.test(nav.userAgent),
    hasKey: VAPID_PUBLIC_KEY.length > 20,
  };
}

/** En iPhone los avisos solo funcionan con la app instalada en la pantalla de inicio. */
export function pushSupport(env: PushEnv = detectPushEnv()): PushSupport {
  if (!env.hasKey) return { ok: false, reason: 'no_key' };
  if (env.ios && !env.standalone) return { ok: false, reason: 'not_installed' };
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return { ok: false, reason: 'unsupported' };
  return { ok: true };
}

/** Clave pública VAPID (base64url) → bytes, como pide `pushManager.subscribe`. */
export function urlBase64ToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const INTERVAL_CHOICES_MIN = [120, 150, 180, 210, 240] as const;
export const DEFAULT_INTERVAL_MIN = 180;

export interface ReminderSettings {
  enabled: boolean;
  interval_min: number;
}

const friendly = (message: string): string => {
  if (message.includes('not_allowed')) return 'Tu acceso solo permite ver: pide a quien administra que te dé permisos de cuidador.';
  if (message.includes('invalid_interval')) return 'El intervalo debe estar entre 30 minutos y 12 horas.';
  if (message.includes('invalid_endpoint') || message.includes('invalid_keys')) return 'Este móvil no pudo registrarse para recibir avisos.';
  return message;
};

/** Ajustes de la familia (comunes a todos los móviles). Sin fila todavía = avisos desactivados. */
export async function getReminderSettings(client: AppClient): Promise<ReminderSettings> {
  const { data, error } = await client.from('feed_reminder').select('enabled, interval_min').maybeSingle();
  if (error !== null) throw new Error(friendly(error.message));
  const row = data as ReminderSettings | null;
  return row ?? { enabled: false, interval_min: DEFAULT_INTERVAL_MIN };
}

export async function setReminderSettings(client: AppClient, s: ReminderSettings): Promise<void> {
  const { error } = await client.rpc('set_feed_reminder', { p_enabled: s.enabled, p_interval_min: s.interval_min });
  if (error !== null) throw new Error(friendly(error.message));
}

export async function registerPush(client: AppClient, sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
  const { error } = await client.rpc('register_push', { p_endpoint: sub.endpoint, p_p256dh: sub.p256dh, p_auth: sub.auth });
  if (error !== null) throw new Error(friendly(error.message));
}

export async function unregisterPush(client: AppClient, endpoint: string): Promise<void> {
  const { error } = await client.rpc('unregister_push', { p_endpoint: endpoint });
  if (error !== null) throw new Error(friendly(error.message));
}

/** Claves de una suscripción del navegador, en base64url (el formato que guarda el servidor). */
export function subscriptionKeys(sub: PushSubscription): { endpoint: string; p256dh: string; auth: string } {
  const json = sub.toJSON();
  const p256dh = json.keys?.['p256dh'];
  const auth = json.keys?.['auth'];
  if (p256dh === undefined || auth === undefined) throw new Error('El navegador no entregó las claves del aviso');
  return { endpoint: sub.endpoint, p256dh, auth };
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Activa los avisos en ESTE móvil. Debe llamarse desde un toque (iOS exige un gesto para pedir el permiso). */
export async function enableThisDevice(client: AppClient): Promise<void> {
  const support = pushSupport();
  if (!support.ok) throw new Error('Este móvil no puede recibir avisos en este momento');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('No diste permiso para las notificaciones. Puedes activarlo en los ajustes del móvil.');
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }));
  await registerPush(client, subscriptionKeys(sub));
}

export async function disableThisDevice(client: AppClient): Promise<void> {
  const sub = await currentSubscription();
  if (sub === null) return;
  // Primero se avisa al servidor; si falla (sin red), el aviso sigue activo y la persona lo ve en vez de creerlo apagado.
  await unregisterPush(client, sub.endpoint);
  await sub.unsubscribe();
}

/** Aviso de prueba LOCAL: comprueba que el móvil muestra notificaciones (no pasa por el servidor). */
export async function showTestNotification(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('Toca toma · prueba', {
    body: 'Así se verá el aviso. Tócalo para abrir la app.',
    icon: 'icon-192.png',
    tag: 'feed-test',
    data: { url: './?feed=ask' },
  });
}
