import { z } from 'zod';

/**
 * Contrato de datos de BabySleep (v0.1.0).
 *
 * El formato de red/exportación usa snake_case para coincidir con las columnas
 * de PostgreSQL (database/migrations). Los instantes son siempre UTC ISO-8601
 * con sufijo `Z`; la zona IANA y el offset viajan aparte en cada evento.
 */
export const CONTRACT_VERSION = '0.2.0';

// ---------------------------------------------------------------- primitivos

export const Uuid = z.string().uuid();
/** Instante UTC, p. ej. `2027-03-28T00:50:00.000Z`. No se admiten offsets. */
export const InstantUtc = z.string().datetime();
/** Fecha civil local `YYYY-MM-DD` (sin zona). */
export const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Nombre IANA; su existencia real se valida en `@babysleep/core` (Luxon). */
export const IanaZone = z.string().min(1);

export const TimeQuality = z.enum(['exact', 'approx']);
export const SleepType = z.enum(['nap', 'night']);
export const TypeSource = z.enum(['auto', 'manual']);
export const RecordSource = z.enum(['timer', 'manual', 'import', 'synthetic']);

/** Qué representan inicio y fin de una sesión. Hoy es constante (decisión F1/F2). */
export const IntervalSemantics = z.literal('observed_asleep_to_observed_awake');

/**
 * Exhaustividad del registro de despertares. `unknown` es el valor por defecto
 * y nunca se establece automáticamente.
 */
export const AwakeningsCompleteness = z.enum(['unknown', 'partial', 'complete']);

// ------------------------------------------------------- columnas comunes sync

export const SyncedRow = z.object({
  id: Uuid,
  family_id: Uuid,
  rev: z.number().int().nonnegative(),
  change_seq: z.number().int().nonnegative().nullable(),
  created_at: InstantUtc,
  updated_at: InstantUtc,
  created_by: Uuid.nullable(),
  updated_by: Uuid.nullable(),
  origin_device_id: Uuid.nullable(),
  deleted_at: InstantUtc.nullable(),
});

// ------------------------------------------------------------------- entidades

export const Family = SyncedRow.extend({
  name: z.string().min(1),
  home_tz: IanaZone.default('Europe/Madrid'),
  settings: z
    .object({
      /** Tolerancia para considerar equivalentes dos finales de la misma sesión. */
      end_conflict_tolerance_s: z.number().int().nonnegative().default(120),
      /** Tolerancia para proponer fusión de inicios duplicados. */
      duplicate_start_tolerance_s: z.number().int().nonnegative().default(300),
      /** Latencia a partir de la cual se pide revisión (no se descarta). */
      latency_review_threshold_s: z.number().int().positive().default(10800),
    })
    // zod 4: `prefault` aplica el valor antes de validar, de modo que se rellenan los defaults internos.
    .prefault({}),
});

export const CaregiverRole = z.enum(['admin', 'caregiver', 'viewer']);
export const Caregiver = SyncedRow.extend({
  display_name: z.string().min(1),
  email_normalized: z.string().email(),
  auth_user_id: Uuid.nullable(),
  role: CaregiverRole,
  status: z.enum(['invited', 'active', 'disabled']),
});

export const BabySex = z.enum(['female', 'male']);

/**
 * Perfil del bebé. Todos los datos opcionales son `null` si no se conocen (nunca 0).
 * La foto NO forma parte del contrato: vive solo en el dispositivo y no se sincroniza.
 */
export const Baby = SyncedRow.extend({
  alias: z.string().min(1),
  birth_date: LocalDate,
  color: z.string().nullable(),
  sex: BabySex.nullable().default(null),
  /** Semanas completas de gestación al nacer; relevante para la edad corregida. */
  gestational_weeks: z.number().int().min(22).max(44).nullable().default(null),
  birth_weight_g: z.number().int().min(300).max(7000).nullable().default(null),
  birth_length_cm: z.number().min(20).max(70).nullable().default(null),
  notes: z.string().max(1000).nullable().default(null),
});

export const SleepSession = SyncedRow.extend({
  baby_id: Uuid,
  sleep_start_utc: InstantUtc,
  /** `null` mientras la sesión sigue abierta. */
  sleep_end_utc: InstantUtc.nullable(),
  start_tz: IanaZone,
  end_tz: IanaZone.nullable(),
  start_quality: TimeQuality.default('exact'),
  end_quality: TimeQuality.nullable(),
  sleep_type: SleepType,
  type_source: TypeSource,
  interval_semantics: IntervalSemantics.default('observed_asleep_to_observed_awake'),
  awakenings_completeness: AwakeningsCompleteness.default('unknown'),
  settling_attempt_id: Uuid.nullable(),
  merged_into: Uuid.nullable(),
  conflict_open: z.boolean().default(false),
  source: RecordSource,
}).refine(
  (s) => s.sleep_end_utc === null || Date.parse(s.sleep_end_utc) > Date.parse(s.sleep_start_utc),
  { message: 'sleep_end_utc debe ser posterior a sleep_start_utc', path: ['sleep_end_utc'] },
);

export const SettlingStatus = z.enum(['open', 'linked', 'abandoned']);
export const SettlingAttempt = SyncedRow.extend({
  baby_id: Uuid,
  /** Inicio del intento de dormir (opcional). */
  started_utc: InstantUtc.nullable(),
  /** Momento de colocar al bebé en la cuna (opcional). No interviene en la latencia. */
  put_down_utc: InstantUtc.nullable(),
  started_quality: TimeQuality.nullable(),
  put_down_quality: TimeQuality.nullable(),
  tz: IanaZone,
  status: SettlingStatus,
}).refine((a) => a.started_utc !== null || a.put_down_utc !== null, {
  message: 'Un intento necesita al menos started_utc o put_down_utc',
});

export const WakeEpisode = SyncedRow.extend({
  session_id: Uuid,
  kind: z.enum(['timed', 'duration_only']),
  start_utc: InstantUtc.nullable(),
  end_utc: InstantUtc.nullable(),
  start_quality: TimeQuality.nullable(),
  end_quality: TimeQuality.nullable(),
  duration_s: z.number().int().positive().nullable(),
});

export const ObservationMoment = z.enum(['onset', 'during', 'wake', 'settling']);
export const Observation = SyncedRow.extend({
  session_id: Uuid.nullable(),
  settling_attempt_id: Uuid.nullable(),
  moment: ObservationMoment,
  occurred_utc: InstantUtc.nullable(),
  note_text: z.string().nullable(),
}).refine((o) => (o.session_id === null) !== (o.settling_attempt_id === null), {
  message: 'Una observación se vincula a una sesión o a un intento, nunca a ambos ni a ninguno',
});

export const Tag = SyncedRow.extend({
  /** Identificador estable; no cambia aunque cambie la etiqueta visible. */
  tag_slug: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/),
  category: z.string().min(1),
  kind: z.enum(['system', 'custom']),
  label_i18n: z.record(z.string(), z.string()),
  archived: z.boolean().default(false),
});

export const ObservationTag = SyncedRow.extend({
  observation_id: Uuid,
  tag_id: Uuid,
});

export const EventCategory = SyncedRow.extend({
  slug: z.string().min(1),
  kind: z.enum(['system', 'custom']),
  label_i18n: z.record(z.string(), z.string()),
});

export const LifeEvent = SyncedRow.extend({
  baby_id: Uuid.nullable(), // null = afecta a toda la familia
  category_id: Uuid,
  start_date: LocalDate,
  end_date: LocalDate.nullable(),
  description: z.string().nullable(),
  notes: z.string().nullable(),
});

/**
 * Históricos agregados. Inmutables y separados de las sesiones con marcas
 * temporales: no tienen fecha ni hora, solo una etiqueta («Día 1»).
 */
export const AggregatePeriod = SyncedRow.extend({
  baby_id: Uuid,
  label: z.string().min(1),
  source: z.literal('historical_import'),
  notes: z.string().nullable(),
});

export const AggregateItem = SyncedRow.extend({
  period_id: Uuid,
  kind: SleepType,
  ordinal: z.number().int().nonnegative(),
  duration_s: z.number().int().positive(),
  interval_semantics: IntervalSemantics.default('observed_asleep_to_observed_awake'),
  awakenings_completeness: z.literal('unknown').default('unknown'),
});

// ---------------------------------------------------------------------- tipos

export type CaregiverT = z.infer<typeof Caregiver>;
export type TagT = z.infer<typeof Tag>;
export type ObservationTagT = z.infer<typeof ObservationTag>;
export type EventCategoryT = z.infer<typeof EventCategory>;
export type LifeEventT = z.infer<typeof LifeEvent>;
export type AggregatePeriodT = z.infer<typeof AggregatePeriod>;
export type ObservationMomentT = z.infer<typeof ObservationMoment>;
export type SleepSessionT = z.infer<typeof SleepSession>;
export type SettlingAttemptT = z.infer<typeof SettlingAttempt>;
export type WakeEpisodeT = z.infer<typeof WakeEpisode>;
export type ObservationT = z.infer<typeof Observation>;
export type BabyT = z.infer<typeof Baby>;
export type FamilyT = z.infer<typeof Family>;
export type AggregateItemT = z.infer<typeof AggregateItem>;
export type TimeQualityT = z.infer<typeof TimeQuality>;
export type SleepTypeT = z.infer<typeof SleepType>;
export type AwakeningsCompletenessT = z.infer<typeof AwakeningsCompleteness>;
