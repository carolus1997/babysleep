import { GROWTH_LIMITS, GrowthMeasure } from '@babysleep/contract';
import type { BabyT, GrowthMeasureT } from '@babysleep/contract';
import { growthPoints, localDate, type GrowthPoint } from '@babysleep/core';
import type { Ctx } from './context';
import { DomainError } from './context';
import { insertRow, newRow, restoreRow, softDelete, updateRow } from './write';

const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

export async function listGrowth(ctx: Ctx, babyId: string): Promise<GrowthMeasureT[]> {
  const rows = await ctx.db.growth_measure.where('baby_id').equals(babyId).toArray();
  return rows.filter((g) => g.deleted_at === null).sort((a, b) => a.measured_on.localeCompare(b.measured_on) || a.created_at.localeCompare(b.created_at));
}

export interface GrowthInput {
  babyId: string;
  measuredOn: string;
  /** Gramos. `null`/ausente = no se midió (nunca 0). */
  weightG?: number | null;
  /** Milímetros. */
  lengthMm?: number | null;
  /** Milímetros. */
  headMm?: number | null;
  place?: string | null;
  notes?: string | null;
}

function checkDate(ctx: Ctx, baby: Pick<BabyT, 'birth_date'>, on: string): void {
  if (!isDate(on)) throw new DomainError('invalid', 'La fecha de la medida no es válida');
  if (on < baby.birth_date) throw new DomainError('invalid', 'La medida no puede ser anterior al nacimiento');
  if (on > localDate(ctx.now(), ctx.zone)) throw new DomainError('invalid', 'La fecha de la medida no puede ser futura');
}

function checkValue(label: string, v: number | null | undefined, lim: { min: number; max: number }, unit: string): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < lim.min || v > lim.max) throw new DomainError('invalid', `${label}: valor fuera de lo posible (${lim.min}–${lim.max} ${unit})`);
  return v;
}

const checks = (i: Pick<GrowthInput, 'weightG' | 'lengthMm' | 'headMm'>) => ({
  weight_g: checkValue('Peso', i.weightG, GROWTH_LIMITS.weight_g, 'g'),
  length_mm: checkValue('Talla', i.lengthMm, GROWTH_LIMITS.length_mm, 'mm'),
  head_mm: checkValue('Perímetro cefálico', i.headMm, GROWTH_LIMITS.head_mm, 'mm'),
});

export async function addGrowth(ctx: Ctx, input: GrowthInput): Promise<GrowthMeasureT> {
  const baby = await ctx.db.baby.get(input.babyId);
  if (baby === undefined || baby.deleted_at !== null) throw new DomainError('not_found', 'El perfil no existe');
  checkDate(ctx, baby, input.measuredOn);
  const m = checks(input);
  if (m.weight_g === null && m.length_mm === null && m.head_mm === null) throw new DomainError('invalid', 'Anota al menos una medida');
  return insertRow(
    ctx.db.growth_measure,
    GrowthMeasure,
    GrowthMeasure.parse({ ...newRow(ctx), baby_id: input.babyId, measured_on: input.measuredOn, ...m, place: clean(input.place), notes: clean(input.notes) }),
  );
}

export type GrowthPatch = Partial<Omit<GrowthInput, 'babyId'>>;

/** Edita una visita. Solo se escribe (y viaja) lo que cambia de verdad: ver `renameBaby`. */
export async function editGrowth(ctx: Ctx, id: string, patch: GrowthPatch): Promise<GrowthMeasureT> {
  const cur = await ctx.db.growth_measure.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'La medida no existe');
  const changes: Record<string, unknown> = {};
  if (patch.measuredOn !== undefined) {
    const baby = await ctx.db.baby.get(cur.baby_id);
    if (baby === undefined) throw new DomainError('not_found', 'El perfil no existe');
    checkDate(ctx, baby, patch.measuredOn);
    changes['measured_on'] = patch.measuredOn;
  }
  const next = { ...cur } as Record<string, unknown>;
  if (patch.weightG !== undefined) changes['weight_g'] = checkValue('Peso', patch.weightG, GROWTH_LIMITS.weight_g, 'g');
  if (patch.lengthMm !== undefined) changes['length_mm'] = checkValue('Talla', patch.lengthMm, GROWTH_LIMITS.length_mm, 'mm');
  if (patch.headMm !== undefined) changes['head_mm'] = checkValue('Perímetro cefálico', patch.headMm, GROWTH_LIMITS.head_mm, 'mm');
  if (patch.place !== undefined) changes['place'] = clean(patch.place);
  if (patch.notes !== undefined) changes['notes'] = clean(patch.notes);
  for (const k of Object.keys(changes)) if ((next[k] ?? null) === (changes[k] ?? null)) delete changes[k];
  if (Object.keys(changes).length === 0) return cur;
  const after = { ...next, ...changes };
  if (after['weight_g'] == null && after['length_mm'] == null && after['head_mm'] == null) throw new DomainError('invalid', 'Anota al menos una medida');
  return updateRow(ctx, ctx.db.growth_measure, GrowthMeasure, id, changes);
}

export const deleteGrowth = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.growth_measure, GrowthMeasure, id);
export const restoreGrowth = (ctx: Ctx, id: string) => restoreRow(ctx, ctx.db.growth_measure, GrowthMeasure, id);

/** Puntos con z y percentil de la niña (edad corregida si es prematura). */
export function pointsFor(baby: Pick<BabyT, 'birth_date' | 'gestational_weeks'>, rows: readonly GrowthMeasureT[]): GrowthPoint[] {
  return growthPoints(
    baby,
    rows.map((r) => ({ measuredOn: r.measured_on, weightG: r.weight_g, lengthMm: r.length_mm, headMm: r.head_mm })),
  );
}
