import { Vaccination } from '@babysleep/contract';
import type { BabyT, VaccinationT } from '@babysleep/contract';
import { localDate, MADRID_2026, nextMilestone, vaccinePlan, type PlannedMilestone, type VaccineDose } from '@babysleep/core';
import type { Ctx } from './context';
import { DomainError } from './context';
import { insertRow, newRow, restoreRow, softDelete, updateRow } from './write';

/** Dosis del calendario por clave, para poner nombre a un registro. */
const DOSE_BY_KEY = new Map<string, VaccineDose>(MADRID_2026.milestones.flatMap((m) => m.doses.map((d) => [d.key, d] as const)));
export const doseLabel = (key: string | null): string | undefined => (key === null ? undefined : DOSE_BY_KEY.get(key)?.label);

const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

export async function listVaccinations(ctx: Ctx, babyId: string): Promise<VaccinationT[]> {
  const rows = await ctx.db.vaccination.where('baby_id').equals(babyId).toArray();
  return rows.filter((v) => v.deleted_at === null).sort((a, b) => (a.given_on ?? '9999').localeCompare(b.given_on ?? '9999') || a.created_at.localeCompare(b.created_at));
}

function checkGivenOn(ctx: Ctx, baby: Pick<BabyT, 'birth_date'>, givenOn: string): void {
  if (!isDate(givenOn)) throw new DomainError('invalid', 'La fecha de la vacuna no es válida');
  if (givenOn < baby.birth_date) throw new DomainError('invalid', 'La vacuna no puede ser anterior al nacimiento');
  if (givenOn > localDate(ctx.now(), ctx.zone)) throw new DomainError('invalid', 'La fecha de la vacuna no puede ser futura');
}

export interface RecordDosesInput {
  babyId: string;
  /** Claves de las dosis del calendario que se marcan como puestas con la misma fecha (una visita). */
  doseKeys: readonly string[];
  givenOn: string;
  center?: string | null;
  lot?: string | null;
  notes?: string | null;
}

/**
 * Registra como puestas varias dosis del calendario con la misma fecha, que es lo normal en una visita. Una dosis que
 * ya consta (puesta o «no procede») se SALTA: no se duplica ni se pisa, y se devuelve cuántas se crearon.
 */
export async function recordDoses(ctx: Ctx, input: RecordDosesInput): Promise<VaccinationT[]> {
  const baby = await ctx.db.baby.get(input.babyId);
  if (baby === undefined || baby.deleted_at !== null) throw new DomainError('not_found', 'El perfil no existe');
  checkGivenOn(ctx, baby, input.givenOn);
  if (input.doseKeys.length === 0) throw new DomainError('invalid', 'Elige al menos una vacuna');
  const existing = new Set((await listVaccinations(ctx, input.babyId)).map((v) => v.dose_key).filter((k): k is string => k !== null));
  const made: VaccinationT[] = [];
  for (const key of input.doseKeys) {
    const dose = DOSE_BY_KEY.get(key);
    if (dose === undefined) throw new DomainError('invalid', `Dosis desconocida: ${key}`);
    if (existing.has(key)) continue;
    made.push(
      await insertRow(
        ctx.db.vaccination,
        Vaccination,
        Vaccination.parse({
          ...newRow(ctx),
          baby_id: input.babyId,
          dose_key: key,
          vaccine: dose.label,
          status: 'given',
          given_on: input.givenOn,
          center: clean(input.center),
          lot: clean(input.lot),
          notes: clean(input.notes),
        }),
      ),
    );
    existing.add(key);
  }
  return made;
}

/** Marca una dosis del calendario como «no procede» (p. ej. la pauta cambió o el pediatra la descartó). */
export async function markNotApplicable(ctx: Ctx, babyId: string, doseKey: string, notes?: string | null): Promise<VaccinationT> {
  const dose = DOSE_BY_KEY.get(doseKey);
  if (dose === undefined) throw new DomainError('invalid', `Dosis desconocida: ${doseKey}`);
  const existing = (await listVaccinations(ctx, babyId)).find((v) => v.dose_key === doseKey);
  if (existing !== undefined) throw new DomainError('invalid', 'Esa dosis ya tiene un registro');
  return insertRow(
    ctx.db.vaccination,
    Vaccination,
    Vaccination.parse({ ...newRow(ctx), baby_id: babyId, dose_key: doseKey, vaccine: dose.label, status: 'not_applicable', given_on: null, center: null, lot: null, notes: clean(notes) }),
  );
}

export interface ExtraVaccineInput {
  babyId: string;
  vaccine: string;
  givenOn: string;
  center?: string | null;
  lot?: string | null;
  notes?: string | null;
}

/** Una vacuna fuera del calendario sistemático (campaña, viaje, indicación del pediatra…). */
export async function addExtraVaccine(ctx: Ctx, input: ExtraVaccineInput): Promise<VaccinationT> {
  const baby = await ctx.db.baby.get(input.babyId);
  if (baby === undefined || baby.deleted_at !== null) throw new DomainError('not_found', 'El perfil no existe');
  const name = input.vaccine.trim();
  if (name === '') throw new DomainError('invalid', 'Escribe el nombre de la vacuna');
  if (name.length > 120) throw new DomainError('invalid', 'El nombre de la vacuna admite 120 caracteres como máximo');
  checkGivenOn(ctx, baby, input.givenOn);
  return insertRow(
    ctx.db.vaccination,
    Vaccination,
    Vaccination.parse({
      ...newRow(ctx),
      baby_id: input.babyId,
      dose_key: null,
      vaccine: name,
      status: 'given',
      given_on: input.givenOn,
      center: clean(input.center),
      lot: clean(input.lot),
      notes: clean(input.notes),
    }),
  );
}

export interface VaccinationPatch {
  givenOn?: string;
  center?: string | null;
  lot?: string | null;
  notes?: string | null;
}

export async function editVaccination(ctx: Ctx, id: string, patch: VaccinationPatch): Promise<VaccinationT> {
  const cur = await ctx.db.vaccination.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'La vacuna no existe');
  const changes: Record<string, unknown> = {};
  if (patch.givenOn !== undefined) {
    const baby = await ctx.db.baby.get(cur.baby_id);
    if (baby === undefined) throw new DomainError('not_found', 'El perfil no existe');
    if (cur.status !== 'given') throw new DomainError('invalid', 'Una dosis «no procede» no tiene fecha');
    checkGivenOn(ctx, baby, patch.givenOn);
    changes['given_on'] = patch.givenOn;
  }
  if (patch.center !== undefined) changes['center'] = clean(patch.center);
  if (patch.lot !== undefined) changes['lot'] = clean(patch.lot);
  if (patch.notes !== undefined) changes['notes'] = clean(patch.notes);
  return updateRow(ctx, ctx.db.vaccination, Vaccination, id, changes);
}

export const deleteVaccination = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.vaccination, Vaccination, id);
export const restoreVaccination = (ctx: Ctx, id: string) => restoreRow(ctx, ctx.db.vaccination, Vaccination, id);

/** Plan de vacunación del bebé a la fecha de hoy (hora local de la familia). */
export function planFor(ctx: Ctx, baby: Pick<BabyT, 'birth_date'>, records: readonly VaccinationT[]): Array<PlannedMilestone<VaccinationT>> {
  return vaccinePlan({ birthDate: baby.birth_date, records, today: localDate(ctx.now(), ctx.zone) });
}

export { nextMilestone };
