import type { AppClient } from './supabase';

export interface ConflictRow {
  id: string;
  table_name: string;
  row_id: string;
  field_name: string | null;
  kind: string;
  current_value: unknown;
  alternate_value: unknown;
  status: string;
  detected_at: string;
}

export interface ConflictView {
  question: string;
  /** Texto del botón que conserva lo que hay ahora. */
  keep: string;
  /** Texto del botón que aplica el otro valor. */
  other: string;
}

const TYPE_LABEL: Record<string, string> = { nap: 'Siesta', night: 'Noche' };
const COMPLETENESS_LABEL: Record<string, string> = { unknown: 'No indicado', partial: 'Algunos', complete: 'Todos' };
const SOURCE_LABEL: Record<string, string> = { auto: 'Automático', manual: 'Manual' };

/** Nombres de campo comprensibles; los que no estén aquí se muestran tal cual. */
const FIELD_LABEL: Record<string, string> = {
  sleep_type: 'tipo (siesta o noche)',
  type_source: 'origen del tipo',
  sleep_start_utc: 'hora de dormirse',
  sleep_end_utc: 'hora de despertar',
  end_quality: 'precisión de la hora de despertar',
  awakenings_completeness: 'despertares registrados',
  alias: 'nombre',
  birth_date: 'fecha de nacimiento',
  note_text: 'comentario',
  description: 'descripción',
  // salud (0.5.0 y 0.6.0)
  pediatrician: 'pediatra',
  nurse: 'enfermera',
  health_center_name: 'centro de salud',
  health_center_address: 'dirección del centro',
  health_center_phone: 'teléfono del centro',
  birth_hospital: 'hospital de nacimiento',
  allergies: 'alergias',
  health_notes: 'notas de salud',
  cipa: 'CIPA',
  given_on: 'fecha en que se puso la vacuna',
  center: 'centro',
  lot: 'lote',
  notes: 'notas',
  title: 'título de la cita',
  start_utc: 'hora de la cita',
  place: 'lugar',
  duration_min: 'duración (min)',
  status: 'estado',
  kind: 'tipo',
  remind_before_min: 'avisos',
};

const STATUS_LABEL: Record<string, string> = { scheduled: 'Pendiente', done: 'Hecha', cancelled: 'Cancelada', given: 'Puesta', not_applicable: 'No procede' };

/** «1 día antes», «1 h antes», «a la hora»… para la lista de avisos de una cita. */
const reminderText = (min: number): string =>
  min === 0 ? 'a la hora' : min % 10080 === 0 ? `${min / 10080} sem antes` : min % 1440 === 0 ? `${min / 1440} d antes` : min % 60 === 0 ? `${min / 60} h antes` : `${min} min antes`;

/** El CIPA nunca se enseña entero en una pantalla de decisión: solo los 4 últimos caracteres. */
const maskSecret = (v: string): string => (v.length <= 4 ? '••••' : `${'•'.repeat(v.length - 4)}${v.slice(-4)}`);

const dateTime = (iso: string, zone: string) =>
  new Date(iso).toLocaleString('es-ES', { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Un valor tal y como lo entiende una persona (horas en la zona local, etiquetas en español). */
export function describeValue(field: string | null, value: unknown, zone: string): string {
  if (value === null || value === undefined || value === '') return 'vacío';
  if (typeof value === 'string' && field !== null) {
    if (field.endsWith('_utc') && !Number.isNaN(Date.parse(value))) return dateTime(value, zone);
    if (field === 'sleep_type') return TYPE_LABEL[value] ?? value;
    if (field === 'awakenings_completeness') return COMPLETENESS_LABEL[value] ?? value;
    if (field === 'type_source') return SOURCE_LABEL[value] ?? value;
    if (field === 'status') return STATUS_LABEL[value] ?? value;
    if (field === 'cipa') return maskSecret(value);
    if (field === 'given_on' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T12:00:00Z`).toLocaleDateString('es-ES', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  }
  if (field === 'remind_before_min' && Array.isArray(value)) return value.length === 0 ? 'ninguno' : (value as number[]).map(reminderText).join(', ');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function describeConflict(c: ConflictRow, zone: string): ConflictView {
  const field = c.field_name === null ? null : (FIELD_LABEL[c.field_name] ?? c.field_name);
  switch (c.kind) {
    case 'delete_vs_edit':
      return {
        question: 'Alguien eliminó este registro mientras otra persona lo editaba. Se ha conservado.',
        keep: 'Mantener el registro',
        other: 'Eliminarlo',
      };
    case 'edit_after_delete':
      return {
        question: 'Este registro estaba eliminado y alguien lo editó, así que se ha recuperado.',
        keep: 'Mantenerlo',
        other: 'Volver a eliminarlo',
      };
    case 'end_time':
      return {
        question: 'Cada móvil anotó una hora de despertar distinta para esta misma sesión.',
        keep: `Dejar ${describeValue(c.field_name, c.current_value, zone)}`,
        other: `Usar ${describeValue(c.field_name, c.alternate_value, zone)}`,
      };
    default:
      return {
        question: `Dos móviles cambiaron a la vez ${field === null ? 'este registro' : `la ${field}`}.`,
        keep: `Dejar ${describeValue(c.field_name, c.current_value, zone)}`,
        other: `Usar ${describeValue(c.field_name, c.alternate_value, zone)}`,
      };
  }
}

/** Conflictos que esperan decisión (los más recientes primero). */
export async function listOpenConflicts(client: AppClient): Promise<ConflictRow[]> {
  const { data, error } = await client.from('sync_conflict').select('*').eq('status', 'open').order('detected_at', { ascending: false });
  if (error !== null) throw new Error(error.message);
  return (data ?? []) as ConflictRow[];
}

const RESOLVE_ERRORS: Array<[string, string]> = [
  ['already_resolved', 'Ese conflicto ya estaba resuelto.'],
  ['conflict_not_found', 'Ese conflicto ya no existe.'],
  ['not_allowed', 'No tienes permiso para resolver conflictos.'],
];

/** Aplica la decisión: «current» conserva lo que hay; «other» aplica el valor alternativo. */
export async function resolveConflict(client: AppClient, id: string, use: 'current' | 'other'): Promise<void> {
  const { error } = await client.rpc('resolve_conflict', { p_conflict_id: id, p_use: use });
  if (error !== null) throw new Error(RESOLVE_ERRORS.find(([k]) => error.message.includes(k))?.[1] ?? error.message);
}
