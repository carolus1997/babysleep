/**
 * Conexión con Supabase. Ambos valores son PÚBLICOS por diseño: la web publicada los lleva dentro de todos
 * modos, y no dan acceso a nada sin una sesión válida de un usuario dado de alta (registro cerrado) y sin
 * pasar las políticas de seguridad por filas (migración 0002). Los secretos —contraseña de la base de datos,
 * clave `service_role`, clave SMTP— NUNCA van aquí.
 */
export const SUPABASE_URL = 'https://tvdqmbkmzmclgzfbgdqv.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_1M4HbSt1AMN4nF7Af45oyg_By-HTLSa';

/** Esquema donde viven las tablas y las funciones (ver database/migrations). */
export const SUPABASE_SCHEMA = 'app';

export const isSyncConfigured = (): boolean => SUPABASE_URL.startsWith('https://') && SUPABASE_PUBLISHABLE_KEY.length > 20;

/**
 * Clave PÚBLICA para los avisos (web push, VAPID). Es pública por diseño (el navegador la necesita para suscribirse);
 * la clave PRIVADA vive solo en los secretos de Supabase. Vacía = los avisos no están configurados.
 */
export const VAPID_PUBLIC_KEY = '';
