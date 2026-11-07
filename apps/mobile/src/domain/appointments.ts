import { Appointment, APPOINTMENT_MAX_REMIND_MIN, APPOINTMENT_MAX_REMINDERS } from '@babysleep/contract';
import type { AppointmentKindT, AppointmentStatusT, AppointmentT } from '@babysleep/contract';
import { MS_PER_MIN, parseInstant, toIso } from '@babysleep/core';
import type { Ctx } from './context';
import { DomainError } from './context';
import { localToMs } from './sleep';
import { insertRow, newRow, restoreRow, softDelete, updateRow } from './write';

export const APPOINTMENT_KINDS: readonly AppointmentKindT[] = ['pediatrician', 'nurse', 'vaccination', 'specialist', 'test', 'other'];
/** Antelaciones que ofrece la app, en minutos (la base de datos admite cualquiera entre 0 y 4 semanas). */
export const REMINDER_PRESETS: readonly number[] = [10080, 1440, 120, 60, 30, 0];
/** Avisos que se proponen al crear una cita. */
export const DEFAULT_REMINDERS: readonly number[] = [1440, 60];

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

/** Avisos válidos: enteros entre 0 y 4 semanas, sin repetidos, como mucho 5, de mayor a menor antelación. */
export function normalizeReminders(list: readonly number[]): number[] {
  const out = [...new Set(list)];
  for (const m of out) {
    if (!Number.isInteger(m) || m < 0 || m > APPOINTMENT_MAX_REMIND_MIN) throw new DomainError('invalid', 'Un aviso debe estar entre «a la hora» y 4 semanas antes');
  }
  if (out.length > APPOINTMENT_MAX_REMINDERS) throw new DomainError('invalid', `Solo se admiten ${APPOINTMENT_MAX_REMINDERS} avisos por cita`);
  return out.sort((a, b) => b - a);
}

export async function listAppointments(ctx: Ctx, babyId: string): Promise<AppointmentT[]> {
  const rows = await ctx.db.appointment.where('baby_id').equals(babyId).toArray();
  return rows.filter((a) => a.deleted_at === null).sort((a, b) => a.start_utc.localeCompare(b.start_utc));
}

export interface AppointmentInput {
  babyId: string;
  kind: AppointmentKindT;
  title: string;
  /** Hora local de pared (`YYYY-MM-DDTHH:mm`) en la zona de la familia. */
  startLocal: string;
  startChoice?: 0 | 1;
  durationMin?: number | null;
  place?: string | null;
  notes?: string | null;
  remindBeforeMin?: readonly number[];
}

function checkText(title: string): string {
  const t = title.trim();
  if (t === '') throw new DomainError('invalid', 'Escribe un título para la cita');
  if (t.length > 160) throw new DomainError('invalid', 'El título admite 160 caracteres como máximo');
  return t;
}

function checkDuration(d: number | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  if (!Number.isInteger(d) || d < 5 || d > 720) throw new DomainError('invalid', 'La duración debe estar entre 5 y 720 minutos');
  return d;
}

export async function addAppointment(ctx: Ctx, input: AppointmentInput): Promise<AppointmentT> {
  const baby = await ctx.db.baby.get(input.babyId);
  if (baby === undefined || baby.deleted_at !== null) throw new DomainError('not_found', 'El perfil no existe');
  const startMs = localToMs(input.startLocal, ctx.zone, input.startChoice);
  return insertRow(
    ctx.db.appointment,
    Appointment,
    Appointment.parse({
      ...newRow(ctx),
      baby_id: input.babyId,
      kind: input.kind,
      title: checkText(input.title),
      start_utc: toIso(startMs),
      start_tz: ctx.zone,
      duration_min: checkDuration(input.durationMin),
      place: clean(input.place),
      notes: clean(input.notes),
      status: 'scheduled',
      remind_before_min: normalizeReminders(input.remindBeforeMin ?? DEFAULT_REMINDERS),
    }),
  );
}

export interface AppointmentPatch {
  kind?: AppointmentKindT;
  title?: string;
  startLocal?: string;
  startChoice?: 0 | 1;
  durationMin?: number | null;
  place?: string | null;
  notes?: string | null;
  remindBeforeMin?: readonly number[];
}

export async function editAppointment(ctx: Ctx, id: string, patch: AppointmentPatch): Promise<AppointmentT> {
  const cur = await ctx.db.appointment.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'La cita no existe');
  const changes: Record<string, unknown> = {};
  if (patch.kind !== undefined) changes['kind'] = patch.kind;
  if (patch.title !== undefined) changes['title'] = checkText(patch.title);
  if (patch.startLocal !== undefined) {
    changes['start_utc'] = toIso(localToMs(patch.startLocal, ctx.zone, patch.startChoice));
    changes['start_tz'] = ctx.zone;
  }
  if (patch.durationMin !== undefined) changes['duration_min'] = checkDuration(patch.durationMin);
  if (patch.place !== undefined) changes['place'] = clean(patch.place);
  if (patch.notes !== undefined) changes['notes'] = clean(patch.notes);
  if (patch.remindBeforeMin !== undefined) changes['remind_before_min'] = normalizeReminders(patch.remindBeforeMin);
  return updateRow(ctx, ctx.db.appointment, Appointment, id, changes);
}

export async function setAppointmentStatus(ctx: Ctx, id: string, status: AppointmentStatusT): Promise<AppointmentT> {
  const cur = await ctx.db.appointment.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'La cita no existe');
  return updateRow(ctx, ctx.db.appointment, Appointment, id, { status });
}

export const deleteAppointment = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.appointment, Appointment, id);
export const restoreAppointment = (ctx: Ctx, id: string) => restoreRow(ctx, ctx.db.appointment, Appointment, id);

/** Citas pendientes que aún no han empezado (o empezaron hace menos de 1 h), las más próximas primero. */
export function upcoming(all: readonly AppointmentT[], nowMs: number): AppointmentT[] {
  return all.filter((a) => a.status === 'scheduled' && parseInstant(a.start_utc) + 60 * MS_PER_MIN > nowMs);
}

/** Todo lo demás: hechas, canceladas o ya pasadas, las más recientes primero. */
export function past(all: readonly AppointmentT[], nowMs: number): AppointmentT[] {
  const up = new Set(upcoming(all, nowMs).map((a) => a.id));
  return all.filter((a) => !up.has(a.id)).sort((a, b) => b.start_utc.localeCompare(a.start_utc));
}
