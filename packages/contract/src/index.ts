import { z } from 'zod';

/**
 * Contrato de datos de BabySleep (v0.1.0).
 *
 * El formato de red/exportación usa snake_case para coincidir con las columnas
 * de PostgreSQL (database/migrations). Los instantes son siempre UTC ISO-8601
 * con sufijo `Z`; la zona IANA y el offset viajan aparte en cada evento.
 */
export const CONTRACT_VERSION = '0.7.0';

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
  /** Desde qué duración (min) un despertar nocturno se descuenta del sueño. `null` = el valor por defecto (30). Desde 0.4.0. */
  awakening_threshold_min: z.number().int().min(5).max(180).nullable().default(null),
  // ---- Ficha de salud (desde 0.5.0). Todo opcional; `null` = no consta. Viaja como el resto del perfil.
  pediatrician: z.string().max(120).nullable().default(null),
  nurse: z.string().max(120).nullable().default(null),
  health_center_name: z.string().max(160).nullable().default(null),
  health_center_address: z.string().max(240).nullable().default(null),
  health_center_phone: z.string().max(40).nullable().default(null),
  birth_hospital: z.string().max(160).nullable().default(null),
  allergies: z.string().max(500).nullable().default(null),
  health_notes: z.string().max(2000).nullable().default(null),
  /** Código de identificación personal autonómico (tarjeta sanitaria). Sensible: la app lo oculta y no lo comparte. */
  cipa: z.string().max(40).nullable().default(null),
});

// --------------------------------------------------------------------- vacunas

/**
 * Vacunas puestas (o marcadas «no procede»). Solo se guardan hechos: lo previsto se calcula del calendario y de la
 * fecha de nacimiento. `dose_key` identifica la dosis del calendario (p. ej. `DTPa@2m`); es `null` en una vacuna
 * fuera de calendario (campañas, viajes…), que lleva su nombre en `vaccine`. Desde 0.5.0.
 */
export const VaccinationStatus = z.enum(['given', 'not_applicable']);
export const Vaccination = SyncedRow.extend({
  baby_id: Uuid,
  dose_key: z.string().min(1).max(60).nullable().default(null),
  vaccine: z.string().min(1).max(120),
  status: VaccinationStatus,
  /** Fecha civil en que se puso. Obligatoria si `status = given`. */
  given_on: LocalDate.nullable().default(null),
  center: z.string().max(160).nullable().default(null),
  lot: z.string().max(60).nullable().default(null),
  notes: z.string().max(500).nullable().default(null),
}).refine((v) => v.status !== 'given' || v.given_on !== null, { message: 'Una vacuna puesta necesita su fecha' });

// ---------------------------------------------------------------------- citas

export const AppointmentKind = z.enum(['pediatrician', 'nurse', 'vaccination', 'specialist', 'test', 'other']);
export const AppointmentStatus = z.enum(['scheduled', 'done', 'cancelled']);
/** Máximo de avisos por cita y antelación máxima (4 semanas, el mismo tope que Google Calendar). Desde 0.6.0. */
export const APPOINTMENT_MAX_REMINDERS = 5;
export const APPOINTMENT_MAX_REMIND_MIN = 40320;

/**
 * Cita médica (o de vacunación). `remind_before_min` son los avisos por notificación, en minutos antes del inicio
 * (0 = a la hora). La hora se guarda en UTC con la zona en que se anotó, como los descansos.
 */
export const Appointment = SyncedRow.extend({
  baby_id: Uuid,
  kind: AppointmentKind,
  title: z.string().min(1).max(160),
  start_utc: InstantUtc,
  start_tz: IanaZone,
  duration_min: z.number().int().min(5).max(720).nullable().default(null),
  place: z.string().max(240).nullable().default(null),
  notes: z.string().max(1000).nullable().default(null),
  status: AppointmentStatus.default('scheduled'),
  remind_before_min: z.array(z.number().int().min(0).max(APPOINTMENT_MAX_REMIND_MIN)).max(APPOINTMENT_MAX_REMINDERS).default([]),
});

// ----------------------------------------------------------------- crecimiento

/** Límites de plausibilidad de cada medida (evitan teclear mal una cifra). Desde 0.7.0. */
export const GROWTH_LIMITS = {
  weight_g: { min: 500, max: 30000 },
  length_mm: { min: 300, max: 1300 },
  head_mm: { min: 250, max: 600 },
} as const;

/**
 * Una visita de medición: fecha y, como máximo, peso (g), longitud/talla (mm) y perímetro cefálico (mm). Cada medida es
 * opcional (`null` = no se midió, nunca 0), pero al menos una debe constar. Enteros: sin errores de coma flotante.
 */
export const GrowthMeasure = SyncedRow.extend({
  baby_id: Uuid,
  measured_on: LocalDate,
  weight_g: z.number().int().min(GROWTH_LIMITS.weight_g.min).max(GROWTH_LIMITS.weight_g.max).nullable().default(null),
  length_mm: z.number().int().min(GROWTH_LIMITS.length_mm.min).max(GROWTH_LIMITS.length_mm.max).nullable().default(null),
  head_mm: z.number().int().min(GROWTH_LIMITS.head_mm.min).max(GROWTH_LIMITS.head_mm.max).nullable().default(null),
  place: z.string().max(160).nullable().default(null),
  notes: z.string().max(500).nullable().default(null),
}).refine((g) => g.weight_g !== null || g.length_mm !== null || g.head_mm !== null, { message: 'Anota al menos una medida' });

// ---------------------------------------------------------------------- tomas

export const FeedType = z.enum(['breast', 'bottle', 'solids']);
export const BreastSide = z.enum(['left', 'right', 'both']);

/**
 * Una toma de comida. `end_*` es `null` mientras la toma sigue en curso (cronómetro). El pecho usado solo
 * existe en una toma de pecho y la cantidad en ml solo en un biberón. Todo dato opcional es `null` si no
 * se conoce (nunca 0).
 */
export const Feeding = SyncedRow.extend({
  baby_id: Uuid,
  feed_type: FeedType,
  start_utc: InstantUtc,
  start_tz: IanaZone,
  start_quality: TimeQuality.default('exact'),
  end_utc: InstantUtc.nullable(),
  end_tz: IanaZone.nullable(),
  end_quality: TimeQuality.nullable(),
  breast_side: BreastSide.nullable().default(null),
  amount_ml: z.number().int().min(1).max(500).nullable().default(null),
  source: z.enum(['timer', 'manual', 'import']),
})
  .refine((f) => f.end_utc === null || Date.parse(f.end_utc) > Date.parse(f.start_utc), {
    message: 'El fin de la toma debe ser posterior al inicio',
  })
  .refine((f) => (f.end_utc === null) === (f.end_tz === null), { message: 'end_utc y end_tz van juntos' })
  .refine((f) => f.breast_side === null || f.feed_type === 'breast', { message: 'El pecho solo se indica en una toma de pecho' })
  .refine((f) => f.amount_ml === null || f.feed_type === 'bottle', { message: 'Los ml solo se indican en un biberón' });


// ------------------------------------------------------------------ despertares

export const AwakeningReason = z.enum(['feeding', 'diaper', 'crying', 'other']);

/**
 * Despertar dentro de un sueño NOCTURNO (desde contrato 0.4.0). `end_*` es `null` si el niño sigue despierto
 * (cronómetro, `source = 'timer'`) o si no se sabe cuánto duró (`source = 'manual'`): un despertar sin duración
 * cuenta como despertar y NO descuenta tiempo (desconocido ≠ 0). Que la sesión sea nocturna lo comprueba la app.
 */
export const Awakening = SyncedRow.extend({
  baby_id: Uuid,
  session_id: Uuid,
  start_utc: InstantUtc,
  start_tz: IanaZone,
  start_quality: TimeQuality.default('exact'),
  end_utc: InstantUtc.nullable(),
  end_tz: IanaZone.nullable(),
  end_quality: TimeQuality.nullable(),
  reason: AwakeningReason.nullable().default(null),
  source: z.enum(['timer', 'manual', 'import']),
})
  .refine((a) => a.end_utc === null || Date.parse(a.end_utc) > Date.parse(a.start_utc), {
    message: 'El fin del despertar debe ser posterior al inicio',
  })
  .refine((a) => (a.end_utc === null) === (a.end_tz === null), { message: 'end_utc y end_tz van juntos' });

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

export const ObservationMoment = z.enum(['onset', 'during', 'wake', 'settling', 'feeding']);
export const Observation = SyncedRow.extend({
  session_id: Uuid.nullable(),
  settling_attempt_id: Uuid.nullable(),
  /** Toma a la que pertenece la nota (desde contrato 0.3.0). Las filas anteriores no lo tienen: es `null`. */
  feeding_id: Uuid.nullable().default(null),
  moment: ObservationMoment,
  occurred_utc: InstantUtc.nullable(),
  note_text: z.string().nullable(),
}).refine((o) => [o.session_id, o.settling_attempt_id, o.feeding_id].filter((x) => x !== null).length === 1, {
  message: 'Una observación se vincula a una sesión, a un intento o a una toma: exactamente a uno',
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
export type FeedingT = z.infer<typeof Feeding>;
export type AwakeningT = z.infer<typeof Awakening>;
export type VaccinationT = z.infer<typeof Vaccination>;
export type AppointmentT = z.infer<typeof Appointment>;
export type GrowthMeasureT = z.infer<typeof GrowthMeasure>;
export type AppointmentKindT = z.infer<typeof AppointmentKind>;
export type AppointmentStatusT = z.infer<typeof AppointmentStatus>;
export type VaccinationStatusT = z.infer<typeof VaccinationStatus>;
export type AwakeningReasonT = z.infer<typeof AwakeningReason>;
export type FeedTypeT = z.infer<typeof FeedType>;
export type BreastSideT = z.infer<typeof BreastSide>;
export type BabyT = z.infer<typeof Baby>;
export type FamilyT = z.infer<typeof Family>;
export type AggregateItemT = z.infer<typeof AggregateItem>;
export type TimeQualityT = z.infer<typeof TimeQuality>;
export type SleepTypeT = z.infer<typeof SleepType>;
export type AwakeningsCompletenessT = z.infer<typeof AwakeningsCompleteness>;
