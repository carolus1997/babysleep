import { Medication, MedicationDose, MEDICATION_LIMITS } from '@babysleep/contract';
import type { MedicationDoseT, MedicationT } from '@babysleep/contract';
import { checkBeforeDose, MS_PER_MIN, parseInstant, toIso, type DoseWarning } from '@babysleep/core';
import type { Ctx } from './context';
import { DomainError } from './context';
import { localToMs } from './sleep';
import { insertRow, newRow, restoreRow, softDelete, updateRow } from './write';

/** Margen para relojes que van un poco adelantados: una dosis no puede ser «del futuro» más allá de esto. */
const FUTURE_SLACK_MS = 5 * MS_PER_MIN;

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

function checkName(v: string): string {
  const t = v.trim();
  if (t === '') throw new DomainError('invalid', 'Escribe el nombre del medicamento');
  if (t.length > 120) throw new DomainError('invalid', 'El nombre admite 120 caracteres como máximo');
  return t;
}

function checkDoseText(v: string): string {
  const t = v.trim();
  if (t === '') throw new DomainError('invalid', 'Escribe la dosis tal como la pautó el médico');
  if (t.length > 160) throw new DomainError('invalid', 'La dosis admite 160 caracteres como máximo');
  return t;
}

function checkInterval(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const { min, max } = MEDICATION_LIMITS.interval_min;
  if (!Number.isInteger(v) || v < min || v > max) throw new DomainError('invalid', `El intervalo debe estar entre ${min} minutos y ${max / 1440} días`);
  return v;
}

function checkDailyMax(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const { min, max } = MEDICATION_LIMITS.daily_max;
  if (!Number.isInteger(v) || v < min || v > max) throw new DomainError('invalid', `El máximo diario debe estar entre ${min} y ${max} dosis`);
  return v;
}

export async function listMedications(ctx: Ctx, babyId: string): Promise<MedicationT[]> {
  const rows = await ctx.db.medication.where('baby_id').equals(babyId).toArray();
  return rows.filter((m) => m.deleted_at === null).sort((a, b) => b.start_utc.localeCompare(a.start_utc));
}

/** Dosis vivas de un bebé (de tratamientos que siguen existiendo), de la más antigua a la más reciente. */
export async function listDoses(ctx: Ctx, babyId: string): Promise<MedicationDoseT[]> {
  const live = new Set((await listMedications(ctx, babyId)).map((m) => m.id));
  const rows = await ctx.db.medication_dose.where('baby_id').equals(babyId).toArray();
  return rows.filter((d) => d.deleted_at === null && live.has(d.medication_id)).sort((a, b) => a.given_utc.localeCompare(b.given_utc) || a.created_at.localeCompare(b.created_at));
}

export interface MedicationInput {
  babyId: string;
  name: string;
  /** Tal como lo escribió el médico («2,5 ml», «1 comprimido»…). */
  doseText: string;
  /** Minutos entre dosis; `null`/ausente = a demanda. */
  intervalMin?: number | null;
  /** Hora local de pared (`YYYY-MM-DDTHH:mm`); ausente = ahora. */
  startLocal?: string;
  startChoice?: 0 | 1;
  /** Fin previsto (hora local); ausente = sin fin previsto. */
  endLocal?: string | null;
  endChoice?: 0 | 1;
  dailyMax?: number | null;
  remind?: boolean;
  notes?: string | null;
}

export async function addMedication(ctx: Ctx, input: MedicationInput): Promise<MedicationT> {
  const baby = await ctx.db.baby.get(input.babyId);
  if (baby === undefined || baby.deleted_at !== null) throw new DomainError('not_found', 'El perfil no existe');
  const startMs = input.startLocal === undefined ? ctx.now() : localToMs(input.startLocal, ctx.zone, input.startChoice);
  const endMs = input.endLocal === undefined || input.endLocal === null || input.endLocal === '' ? null : localToMs(input.endLocal, ctx.zone, input.endChoice);
  if (endMs !== null && endMs <= startMs) throw new DomainError('invalid_range', 'El fin del tratamiento debe ser posterior al inicio');
  return insertRow(
    ctx.db.medication,
    Medication,
    Medication.parse({
      ...newRow(ctx),
      baby_id: input.babyId,
      name: checkName(input.name),
      dose_text: checkDoseText(input.doseText),
      interval_min: checkInterval(input.intervalMin),
      start_utc: toIso(startMs),
      start_tz: ctx.zone,
      end_utc: endMs === null ? null : toIso(endMs),
      daily_max: checkDailyMax(input.dailyMax),
      remind: input.remind ?? true,
      notes: clean(input.notes),
    }),
  );
}

export type MedicationPatch = Partial<Omit<MedicationInput, 'babyId'>>;

/** Edita un tratamiento. Solo se escribe (y viaja) lo que cambia de verdad: ver `renameBaby`. */
export async function editMedication(ctx: Ctx, id: string, patch: MedicationPatch): Promise<MedicationT> {
  const cur = await ctx.db.medication.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'El tratamiento no existe');
  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined) changes['name'] = checkName(patch.name);
  if (patch.doseText !== undefined) changes['dose_text'] = checkDoseText(patch.doseText);
  if (patch.intervalMin !== undefined) changes['interval_min'] = checkInterval(patch.intervalMin);
  if (patch.startLocal !== undefined) {
    changes['start_utc'] = toIso(localToMs(patch.startLocal, ctx.zone, patch.startChoice));
    changes['start_tz'] = ctx.zone;
  }
  if (patch.endLocal !== undefined) {
    changes['end_utc'] = patch.endLocal === null || patch.endLocal === '' ? null : toIso(localToMs(patch.endLocal, ctx.zone, patch.endChoice));
  }
  if (patch.dailyMax !== undefined) changes['daily_max'] = checkDailyMax(patch.dailyMax);
  if (patch.remind !== undefined) changes['remind'] = patch.remind;
  if (patch.notes !== undefined) changes['notes'] = clean(patch.notes);
  const next = cur as unknown as Record<string, unknown>;
  for (const k of Object.keys(changes)) if ((next[k] ?? null) === (changes[k] ?? null)) delete changes[k];
  if (Object.keys(changes).length === 0) return cur;
  const start = (changes['start_utc'] as string | undefined) ?? cur.start_utc;
  const end = 'end_utc' in changes ? (changes['end_utc'] as string | null) : cur.end_utc;
  if (end !== null && parseInstant(end) <= parseInstant(start)) throw new DomainError('invalid_range', 'El fin del tratamiento debe ser posterior al inicio');
  return updateRow(ctx, ctx.db.medication, Medication, id, changes);
}

/** Termina el tratamiento ahora (o un minuto después de su inicio, si aún no había empezado). */
export async function stopMedication(ctx: Ctx, id: string): Promise<MedicationT> {
  const cur = await ctx.db.medication.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'El tratamiento no existe');
  const end = Math.max(ctx.now(), parseInstant(cur.start_utc) + MS_PER_MIN);
  return updateRow(ctx, ctx.db.medication, Medication, id, { end_utc: toIso(end) });
}

/** Reabre un tratamiento terminado (sin fin previsto). */
export async function resumeMedication(ctx: Ctx, id: string): Promise<MedicationT> {
  const cur = await ctx.db.medication.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'El tratamiento no existe');
  return updateRow(ctx, ctx.db.medication, Medication, id, { end_utc: null });
}

/** Eliminar un tratamiento oculta también sus dosis (no se tocan: al restaurarlo vuelven tal cual estaban). */
export const deleteMedication = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.medication, Medication, id);
export const restoreMedication = (ctx: Ctx, id: string) => restoreRow(ctx, ctx.db.medication, Medication, id);

// ---------------------------------------------------------------------- dosis

/** Avisos (hechos, sin recomendar nada) que conviene enseñar ANTES de registrar una dosis a esa hora. */
export async function previewDose(ctx: Ctx, medicationId: string, atMs: number = ctx.now()): Promise<DoseWarning[]> {
  const med = await ctx.db.medication.get(medicationId);
  if (med === undefined || med.deleted_at !== null) throw new DomainError('not_found', 'El tratamiento no existe');
  const doses = (await ctx.db.medication_dose.where('medication_id').equals(medicationId).toArray()).filter((d) => d.deleted_at === null);
  return checkBeforeDose(med, doses, atMs);
}

export interface DoseInput {
  medicationId: string;
  /** Hora de la dosis (ms); ausente = ahora. */
  atMs?: number;
  /** Solo si lo dado no fue lo pautado. */
  doseText?: string | null;
  notes?: string | null;
  /** La persona ya vio los avisos de `previewDose` y registra de todos modos. */
  confirmed?: boolean;
}

export async function addDose(ctx: Ctx, input: DoseInput): Promise<MedicationDoseT> {
  const med = await ctx.db.medication.get(input.medicationId);
  if (med === undefined || med.deleted_at !== null) throw new DomainError('not_found', 'El tratamiento no existe');
  const atMs = input.atMs ?? ctx.now();
  if (atMs > ctx.now() + FUTURE_SLACK_MS) throw new DomainError('invalid', 'La hora de la dosis no puede ser futura');
  const given = clean(input.doseText);
  if (given !== null && given.length > 160) throw new DomainError('invalid', 'La dosis admite 160 caracteres como máximo');
  if (input.confirmed !== true && (await previewDose(ctx, med.id, atMs)).length > 0) {
    throw new DomainError('needs_confirmation', 'Ya hay una dosis anotada hace poco o se alcanzó el máximo del día: confirma para registrarla de todos modos');
  }
  return insertRow(
    ctx.db.medication_dose,
    MedicationDose,
    MedicationDose.parse({
      ...newRow(ctx),
      baby_id: med.baby_id,
      medication_id: med.id,
      given_utc: toIso(atMs),
      given_tz: ctx.zone,
      dose_text: given,
      notes: clean(input.notes),
    }),
  );
}

export interface DosePatch {
  atMs?: number;
  doseText?: string | null;
  notes?: string | null;
}

export async function editDose(ctx: Ctx, id: string, patch: DosePatch): Promise<MedicationDoseT> {
  const cur = await ctx.db.medication_dose.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'La dosis no existe');
  const changes: Record<string, unknown> = {};
  if (patch.atMs !== undefined) {
    if (patch.atMs > ctx.now() + FUTURE_SLACK_MS) throw new DomainError('invalid', 'La hora de la dosis no puede ser futura');
    changes['given_utc'] = toIso(patch.atMs);
    changes['given_tz'] = ctx.zone;
  }
  if (patch.doseText !== undefined) changes['dose_text'] = clean(patch.doseText);
  if (patch.notes !== undefined) changes['notes'] = clean(patch.notes);
  const next = cur as unknown as Record<string, unknown>;
  for (const k of Object.keys(changes)) if ((next[k] ?? null) === (changes[k] ?? null)) delete changes[k];
  if (Object.keys(changes).length === 0) return cur;
  return updateRow(ctx, ctx.db.medication_dose, MedicationDose, id, changes);
}

export const deleteDose = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.medication_dose, MedicationDose, id);
export const restoreDose = (ctx: Ctx, id: string) => restoreRow(ctx, ctx.db.medication_dose, MedicationDose, id);
