import type { AppClient } from './supabase';

/** Resultados de `app.claim_membership` (migración 0002), con el mensaje que ve la persona. */
export const CLAIM_MESSAGES: Record<string, string> = {
  invalid: 'Código incorrecto. Revísalo e inténtalo de nuevo.',
  locked: 'Demasiados intentos fallidos. Pide a quien administra la familia que abra una ventana nueva.',
  expired: 'El código ha caducado (dura 30 minutos). Pide uno nuevo.',
  no_window: 'No hay una ventana de alta abierta para este correo. Pide que la abran de nuevo.',
  already_linked: 'Esta cuenta ya está vinculada a otro cuidador.',
};

export class AuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Traduce los errores de Supabase Auth más habituales a mensajes comprensibles. */
function friendly(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('signups not allowed') || m.includes('not allowed for otp')) return 'Este correo no está dado de alta en la familia.';
  if (m.includes('rate limit') || m.includes('too many') || m.includes('seconds')) return 'Demasiados intentos seguidos. Espera un poco y vuelve a probar.';
  if (m.includes('expired') || m.includes('invalid')) return 'El código no es válido o ha caducado. Pide uno nuevo.';
  if (m.includes('fetch') || m.includes('network')) return 'Sin conexión con el servidor. Comprueba tu conexión.';
  return message;
}

/** Envía un código de 6 dígitos al correo. Nunca crea cuentas nuevas: el registro está cerrado. */
export async function requestCode(client: AppClient, email: string): Promise<void> {
  const { error } = await client.auth.signInWithOtp({ email: normalizeEmail(email), options: { shouldCreateUser: false } });
  if (error !== null) throw new AuthError(friendly(error.message), 'request');
}

export async function verifyCode(client: AppClient, email: string, token: string): Promise<void> {
  const { error } = await client.auth.verifyOtp({ email: normalizeEmail(email), token: token.replace(/\s+/g, ''), type: 'email' });
  if (error !== null) throw new AuthError(friendly(error.message), 'verify');
}

export async function currentSession(client: AppClient): Promise<{ userId: string; email: string } | null> {
  const { data } = await client.auth.getSession();
  const user = data.session?.user;
  return user === undefined ? null : { userId: user.id, email: user.email ?? '' };
}

/** ¿Este usuario ya está vinculado a un cuidador? (Si no lo está, las políticas de seguridad no le dejan ver nada.) */
export async function isLinked(client: AppClient, userId: string): Promise<boolean> {
  const { data, error } = await client.from('caregiver').select('id').eq('auth_user_id', userId).limit(1);
  if (error !== null) throw new Error(friendly(error.message));
  return (data?.length ?? 0) > 0;
}

/** Canjea el código de alta que abrió quien administra la familia. */
export async function claimMembership(client: AppClient, code: string): Promise<void> {
  const { data, error } = await client.rpc('claim_membership', { p_code: code.trim() });
  if (error !== null) throw new AuthError(friendly(error.message), 'claim');
  const status = (data as { status?: string } | null)?.status ?? 'unknown';
  if (status !== 'ok') throw new AuthError(CLAIM_MESSAGES[status] ?? 'No se pudo completar el alta.', status);
}

export async function signOut(client: AppClient): Promise<void> {
  await client.auth.signOut();
}

// ----------------------------------------------------------------- familia (solo administradores)

export interface FamilyMember {
  id: string;
  display_name: string;
  email_normalized: string;
  role: 'admin' | 'caregiver' | 'viewer';
  status: 'invited' | 'active' | 'disabled';
}

/** Mensajes de las excepciones de `invite_caregiver` / `disable_caregiver` (migración 0006). */
const FAMILY_ERRORS: Array<[string, string]> = [
  ['not_admin', 'Solo quien administra la familia puede hacer esto.'],
  ['invalid_name', 'Escribe un nombre.'],
  ['invalid_email', 'Ese correo no parece válido.'],
  ['invalid_role', 'Permisos no válidos.'],
  ['already_member', 'Esa persona ya forma parte de la familia.'],
  ['cannot_disable_self', 'No puedes quitarte el acceso a ti mismo.'],
  ['not_found', 'Esa persona no existe en tu familia.'],
];

function familyError(message: string): AuthError {
  const hit = FAMILY_ERRORS.find(([k]) => message.includes(k));
  return new AuthError(hit?.[1] ?? friendly(message), hit?.[0] ?? 'family');
}

export async function listFamily(client: AppClient): Promise<FamilyMember[]> {
  const { data, error } = await client
    .from('caregiver')
    .select('id, display_name, email_normalized, role, status')
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error !== null) throw new Error(friendly(error.message));
  return (data ?? []) as FamilyMember[];
}

/** Da de alta (o re-invita) a alguien y devuelve su código de alta: 30 minutos, un solo uso. */
export async function inviteCaregiver(client: AppClient, name: string, email: string, role: 'caregiver' | 'viewer'): Promise<string> {
  const { data, error } = await client.rpc('invite_caregiver', { p_display_name: name.trim(), p_email: email.trim(), p_role: role });
  if (error !== null) throw familyError(error.message);
  return String(data);
}

export async function disableCaregiver(client: AppClient, id: string): Promise<void> {
  const { error } = await client.rpc('disable_caregiver', { p_caregiver_id: id });
  if (error !== null) throw familyError(error.message);
}
