import { IllnessEntry, IllnessEpisode, ILLNESS_LIMITS } from '@babysleep/contract';
import type { DiaperKindT, IllnessEntryKindT, IllnessEntryT, IllnessEpisodeT, IntakeT, SymptomT, TempSiteT } from '@babysleep/contract';
import { MS_PER_MIN, parseInstant, sortEntries, toIso } from '@babysleep/core';
import type { Ctx } from './context';
import { DomainError } from './context';
import { localToMs } from './sleep';
import { insertRow, newRow, restoreRow, softDelete, updateRow } from './write';

/** Margen para relojes que van un poco adelantados: una anotación no puede ser «del futuro» más allá de esto. */
const FUTURE_SLACK_MS = 5 * MS_PER_MIN;

export const TEMP_SITES: readonly TempSiteT[] = ['axillary', 'rectal', 'ear', 'forehead', 'oral', 'other'];
export const SYMPTOMS: readonly SymptomT[] = ['cough', 'runny_nose', 'congestion', 'sneezing', 'vomiting', 'diarrhea', 'rash', 'fussy', 'drowsy', 'pain', 'other'];
export const INTAKES: readonly IntakeT[] = ['usual', 'less', 'much_less', 'almost_none'];
export const DIAPERS: readonly DiaperKindT[] = ['wet', 'dirty', 'both'];

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

function checkTitle(v: string | null | undefined): string | null {
  const t = clean(v);
  if (t !== null && t.length > 120) throw new DomainError('invalid', 'El título admite 120 caracteres como máximo');
  return t;
}

function checkNote(v: string | null | undefined): string | null {
  const t = clean(v);
  if (t !== null && t.length > 300) throw new DomainError('invalid', 'La nota admite 300 caracteres como máximo');
  return t;
}

/** Décimas de grado: la persona escribe «38,4» y aquí llega 384. */
export function checkTempDc(v: number): number {
  const { min, max } = ILLNESS_LIMITS.temp_dc;
  if (!Number.isInteger(v) || v < min || v > max) throw new DomainError('invalid', `La temperatura debe estar entre ${min / 10} y ${max / 10} °C`);
  return v;
}

// ------------------------------------------------------------------ episodios

export async function listEpisodes(ctx: Ctx, babyId: string): Promise<IllnessEpisodeT[]> {
  const rows = await ctx.db.illness_episode.where('baby_id').equals(babyId).toArray();
  return rows.filter((e) => e.deleted_at === null).sort((a, b) => b.start_utc.localeCompare(a.start_utc));
}

export interface EpisodeInput {
  babyId: string;
  title?: string | null;
  /** Hora local de pared (`YYYY-MM-DDTHH:mm`); ausente = ahora. */
  startLocal?: string;
  startChoice?: 0 | 1;
  notes?: string | null;
}

export async function startEpisode(ctx: Ctx, input: EpisodeInput): Promise<IllnessEpisodeT> {
  const baby = await ctx.db.baby.get(input.babyId);
  if (baby === undefined || baby.deleted_at !== null) throw new DomainError('not_found', 'El perfil no existe');
  const open = (await listEpisodes(ctx, input.babyId)).find((e) => e.end_utc === null);
  if (open !== undefined) throw new DomainError('already_open', 'Ya hay un episodio en curso: termínalo antes de empezar otro');
  const startMs = input.startLocal === undefined ? ctx.now() : localToMs(input.startLocal, ctx.zone, input.startChoice);
  if (startMs > ctx.now() + FUTURE_SLACK_MS) throw new DomainError('invalid', 'El episodio no puede empezar en el futuro');
  return insertRow(
    ctx.db.illness_episode,
    IllnessEpisode,
    IllnessEpisode.parse({
      ...newRow(ctx),
      baby_id: input.babyId,
      title: checkTitle(input.title),
      start_utc: toIso(startMs),
      start_tz: ctx.zone,
      end_utc: null,
      notes: clean(input.notes),
    }),
  );
}

export interface EpisodePatch {
  title?: string | null;
  startLocal?: string;
  startChoice?: 0 | 1;
  /** `null` o `''` = en curso. */
  endLocal?: string | null;
  endChoice?: 0 | 1;
  notes?: string | null;
}

/** Edita un episodio. Solo se escribe (y viaja) lo que cambia de verdad: ver `renameBaby`. */
export async function editEpisode(ctx: Ctx, id: string, patch: EpisodePatch): Promise<IllnessEpisodeT> {
  const cur = await ctx.db.illness_episode.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'El episodio no existe');
  const changes: Record<string, unknown> = {};
  if (patch.title !== undefined) changes['title'] = checkTitle(patch.title);
  if (patch.startLocal !== undefined) {
    changes['start_utc'] = toIso(localToMs(patch.startLocal, ctx.zone, patch.startChoice));
    changes['start_tz'] = ctx.zone;
  }
  if (patch.endLocal !== undefined) changes['end_utc'] = patch.endLocal === null || patch.endLocal === '' ? null : toIso(localToMs(patch.endLocal, ctx.zone, patch.endChoice));
  if (patch.notes !== undefined) changes['notes'] = clean(patch.notes);
  const next = cur as unknown as Record<string, unknown>;
  for (const k of Object.keys(changes)) if ((next[k] ?? null) === (changes[k] ?? null)) delete changes[k];
  if (Object.keys(changes).length === 0) return cur;
  const start = (changes['start_utc'] as string | undefined) ?? cur.start_utc;
  const end = 'end_utc' in changes ? (changes['end_utc'] as string | null) : cur.end_utc;
  if (end !== null && parseInstant(end) <= parseInstant(start)) throw new DomainError('invalid_range', 'El fin del episodio debe ser posterior al inicio');
  return updateRow(ctx, ctx.db.illness_episode, IllnessEpisode, id, changes);
}

/** Termina el episodio ahora (o un minuto después de su inicio, si aún no había empezado). */
export async function endEpisode(ctx: Ctx, id: string): Promise<IllnessEpisodeT> {
  const cur = await ctx.db.illness_episode.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'El episodio no existe');
  const end = Math.max(ctx.now(), parseInstant(cur.start_utc) + MS_PER_MIN);
  return updateRow(ctx, ctx.db.illness_episode, IllnessEpisode, id, { end_utc: toIso(end) });
}

/** Reabre un episodio terminado. Falla si hay otro en curso. */
export async function reopenEpisode(ctx: Ctx, id: string): Promise<IllnessEpisodeT> {
  const cur = await ctx.db.illness_episode.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'El episodio no existe');
  const open = (await listEpisodes(ctx, cur.baby_id)).find((e) => e.end_utc === null && e.id !== id);
  if (open !== undefined) throw new DomainError('already_open', 'Ya hay otro episodio en curso');
  return updateRow(ctx, ctx.db.illness_episode, IllnessEpisode, id, { end_utc: null });
}

/** Eliminar un episodio oculta también sus anotaciones (no se tocan: al restaurarlo vuelven tal cual estaban). */
export const deleteEpisode = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.illness_episode, IllnessEpisode, id);
export const restoreEpisode = (ctx: Ctx, id: string) => restoreRow(ctx, ctx.db.illness_episode, IllnessEpisode, id);

// ---------------------------------------------------------------- anotaciones

/** Anotaciones vivas de un bebé (de episodios que siguen existiendo), de la más antigua a la más reciente. */
export async function listEntries(ctx: Ctx, babyId: string): Promise<IllnessEntryT[]> {
  const live = new Set((await listEpisodes(ctx, babyId)).map((e) => e.id));
  const rows = await ctx.db.illness_entry.where('baby_id').equals(babyId).toArray();
  return sortEntries(rows.filter((e) => e.deleted_at === null && live.has(e.episode_id)));
}

export type EntryData =
  | { kind: 'temperature'; tempDc: number; site?: TempSiteT | null }
  | { kind: 'symptom'; symptom: SymptomT }
  | { kind: 'intake'; intake: IntakeT }
  | { kind: 'diaper'; diaper: DiaperKindT }
  | { kind: 'note'; note: string };

export type EntryInput = EntryData & {
  episodeId: string;
  /** Hora de la anotación (ms); ausente = ahora. */
  atMs?: number;
  /** Texto libre opcional en cualquier tipo (en `note` es el contenido y es obligatorio). */
  note?: string | null;
};

function fieldsFor(d: EntryData): { kind: IllnessEntryKindT; temp_dc: number | null; temp_site: TempSiteT | null; symptom: SymptomT | null; intake: IntakeT | null; diaper: DiaperKindT | null } {
  const base = { temp_dc: null, temp_site: null, symptom: null, intake: null, diaper: null };
  switch (d.kind) {
    case 'temperature':
      return { ...base, kind: 'temperature', temp_dc: checkTempDc(d.tempDc), temp_site: d.site ?? null };
    case 'symptom':
      if (!SYMPTOMS.includes(d.symptom)) throw new DomainError('invalid', 'Síntoma desconocido');
      return { ...base, kind: 'symptom', symptom: d.symptom };
    case 'intake':
      if (!INTAKES.includes(d.intake)) throw new DomainError('invalid', 'Valor desconocido');
      return { ...base, kind: 'intake', intake: d.intake };
    case 'diaper':
      if (!DIAPERS.includes(d.diaper)) throw new DomainError('invalid', 'Valor desconocido');
      return { ...base, kind: 'diaper', diaper: d.diaper };
    case 'note':
      return { ...base, kind: 'note' };
  }
}

export async function addEntry(ctx: Ctx, input: EntryInput): Promise<IllnessEntryT> {
  const ep = await ctx.db.illness_episode.get(input.episodeId);
  if (ep === undefined || ep.deleted_at !== null) throw new DomainError('not_found', 'El episodio no existe');
  const atMs = input.atMs ?? ctx.now();
  if (atMs > ctx.now() + FUTURE_SLACK_MS) throw new DomainError('invalid', 'La hora de la anotación no puede ser futura');
  const note = checkNote(input.note);
  if (input.kind === 'note' && note === null) throw new DomainError('invalid', 'Escribe la nota');
  return insertRow(
    ctx.db.illness_entry,
    IllnessEntry,
    IllnessEntry.parse({ ...newRow(ctx), baby_id: ep.baby_id, episode_id: ep.id, ...fieldsFor(input), at_utc: toIso(atMs), at_tz: ctx.zone, note }),
  );
}

export interface EntryPatch {
  atMs?: number;
  tempDc?: number;
  site?: TempSiteT | null;
  symptom?: SymptomT;
  intake?: IntakeT;
  diaper?: DiaperKindT;
  note?: string | null;
}

/** Edita una anotación. El tipo no cambia nunca; solo se escribe (y viaja) lo que cambia de verdad. */
export async function editEntry(ctx: Ctx, id: string, patch: EntryPatch): Promise<IllnessEntryT> {
  const cur = await ctx.db.illness_entry.get(id);
  if (cur === undefined || cur.deleted_at !== null) throw new DomainError('not_found', 'La anotación no existe');
  const changes: Record<string, unknown> = {};
  if (patch.atMs !== undefined) {
    if (patch.atMs > ctx.now() + FUTURE_SLACK_MS) throw new DomainError('invalid', 'La hora de la anotación no puede ser futura');
    changes['at_utc'] = toIso(patch.atMs);
    changes['at_tz'] = ctx.zone;
  }
  const wrongKind = (field: string) => new DomainError('invalid', `Una anotación de tipo «${cur.kind}» no tiene ${field}`);
  if (patch.tempDc !== undefined) {
    if (cur.kind !== 'temperature') throw wrongKind('temperatura');
    changes['temp_dc'] = checkTempDc(patch.tempDc);
  }
  if (patch.site !== undefined) {
    if (cur.kind !== 'temperature') throw wrongKind('lugar de medida');
    changes['temp_site'] = patch.site;
  }
  if (patch.symptom !== undefined) {
    if (cur.kind !== 'symptom') throw wrongKind('síntoma');
    if (!SYMPTOMS.includes(patch.symptom)) throw new DomainError('invalid', 'Síntoma desconocido');
    changes['symptom'] = patch.symptom;
  }
  if (patch.intake !== undefined) {
    if (cur.kind !== 'intake') throw wrongKind('ingesta');
    if (!INTAKES.includes(patch.intake)) throw new DomainError('invalid', 'Valor desconocido');
    changes['intake'] = patch.intake;
  }
  if (patch.diaper !== undefined) {
    if (cur.kind !== 'diaper') throw wrongKind('pañal');
    if (!DIAPERS.includes(patch.diaper)) throw new DomainError('invalid', 'Valor desconocido');
    changes['diaper'] = patch.diaper;
  }
  if (patch.note !== undefined) {
    const note = checkNote(patch.note);
    if (cur.kind === 'note' && note === null) throw new DomainError('invalid', 'Una nota no puede quedarse vacía');
    changes['note'] = note;
  }
  const next = cur as unknown as Record<string, unknown>;
  for (const k of Object.keys(changes)) if ((next[k] ?? null) === (changes[k] ?? null)) delete changes[k];
  if (Object.keys(changes).length === 0) return cur;
  return updateRow(ctx, ctx.db.illness_entry, IllnessEntry, id, changes);
}

export const deleteEntry = (ctx: Ctx, id: string) => softDelete(ctx, ctx.db.illness_entry, IllnessEntry, id);
export const restoreEntry = (ctx: Ctx, id: string) => restoreRow(ctx, ctx.db.illness_entry, IllnessEntry, id);
