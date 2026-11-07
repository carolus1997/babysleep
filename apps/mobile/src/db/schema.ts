import Dexie, { type Table } from 'dexie';
import type {
  AggregateItemT,
  AggregatePeriodT,
  AppointmentT,
  GrowthMeasureT,
  IllnessEntryT,
  IllnessEpisodeT,
  MedicationDoseT,
  MedicationT,
  AwakeningT,
  BabyT,
  CaregiverT,
  EventCategoryT,
  FamilyT,
  FeedingT,
  LifeEventT,
  ObservationT,
  ObservationTagT,
  SettlingAttemptT,
  SleepSessionT,
  TagT,
  VaccinationT,
  WakeEpisodeT,
} from '@babysleep/contract';

import type { SyncTable } from '../sync/tables';

export interface MetaRow {
  key: string;
  value: unknown;
}

/**
 * Base local (IndexedDB). Las tablas reflejan el contrato (`@babysleep/contract`)
 * y el esquema SQL. En la Fase 2 se añadirán la cola de operaciones (outbox) y el
 * estado de sincronización; toda escritura pasa ya por `domain/write.ts` para que
 * ese cambio sea local a una sola capa.
 */
/** Foto del bebé: local, fuera del contrato y de las copias (ver `domain/photo.ts`). */
export interface BabyPhotoRow {
  baby_id: string;
  blob: Blob;
  updated_at: string;
}

/** Operación local pendiente de enviar (ver `sync/outbox.ts`). */
export interface OutboxRow {
  seq?: number;
  table: SyncTable;
  row_id: string;
  op_id: string;
  /** Segundo id estable, para el borrado que acompaña a un alta enviada en el mismo lote. */
  op_id_delete: string;
  is_insert: boolean;
  fields: Record<string, unknown>;
  delete: boolean;
  restore: boolean;
  /** Veces que se ha intentado enviar; con > 0 el contenido queda congelado. */
  attempts: number;
  /** Motivo de rechazo del servidor; el registro se conserva hasta resolverlo. */
  error: string | null;
}

/** Última versión del servidor conocida para una fila (`table:id`): es el `base_rev` de la siguiente edición. */
export interface SyncRowRow {
  key: string;
  server_rev: number;
}

export class BabySleepDb extends Dexie {
  baby_photo!: Table<BabyPhotoRow, string>;
  outbox!: Table<OutboxRow, number>;
  sync_row!: Table<SyncRowRow, string>;
  /**
   * Sincronización activada. Se mantiene en memoria para que la ruta de escritura normal no haga
   * ninguna lectura extra: con `false` la app escribe exactamente igual que antes de la Fase 2.
   */
  syncEnabled = false;
  family!: Table<FamilyT, string>;
  caregiver!: Table<CaregiverT, string>;
  baby!: Table<BabyT, string>;
  feeding!: Table<FeedingT, string>;
  sleep_session!: Table<SleepSessionT, string>;
  awakening!: Table<AwakeningT, string>;
  vaccination!: Table<VaccinationT, string>;
  appointment!: Table<AppointmentT, string>;
  growth_measure!: Table<GrowthMeasureT, string>;
  medication!: Table<MedicationT, string>;
  medication_dose!: Table<MedicationDoseT, string>;
  illness_episode!: Table<IllnessEpisodeT, string>;
  illness_entry!: Table<IllnessEntryT, string>;
  settling_attempt!: Table<SettlingAttemptT, string>;
  wake_episode!: Table<WakeEpisodeT, string>;
  observation!: Table<ObservationT, string>;
  tag!: Table<TagT, string>;
  observation_tag!: Table<ObservationTagT, string>;
  event_category!: Table<EventCategoryT, string>;
  life_event!: Table<LifeEventT, string>;
  aggregate_period!: Table<AggregatePeriodT, string>;
  aggregate_item!: Table<AggregateItemT, string>;
  meta!: Table<MetaRow, string>;

  constructor(name = 'babysleep') {
    super(name);
    this.version(1).stores({
      family: 'id',
      caregiver: 'id, family_id',
      baby: 'id, family_id',
      sleep_session: 'id, baby_id, sleep_start_utc, [baby_id+sleep_start_utc]',
      settling_attempt: 'id, baby_id, status',
      wake_episode: 'id, session_id',
      observation: 'id, session_id, settling_attempt_id',
      tag: 'id, tag_slug, category',
      observation_tag: 'id, observation_id',
      event_category: 'id, slug',
      life_event: 'id, baby_id, start_date',
      aggregate_period: 'id, baby_id',
      aggregate_item: 'id, period_id',
      meta: 'key',
    });
    // v2: foto local del bebé. Solo añade una tabla; no migra ni toca datos existentes.
    this.version(2).stores({ baby_photo: 'baby_id' });
    // v3: cola de sincronización y última versión conocida del servidor. Solo añade tablas.
    this.version(3).stores({ outbox: '++seq, [table+row_id]', sync_row: 'key' });
    // v4: tomas de comida y su índice en las notas. Solo añade; no toca datos existentes.
    this.version(4).stores({ feeding: 'id, baby_id, start_utc', observation: 'id, session_id, settling_attempt_id, feeding_id' });
    // v5: despertares nocturnos. Solo añade una tabla; no toca datos existentes.
    this.version(5).stores({ awakening: 'id, baby_id, session_id, start_utc' });
    // v6: vacunas. Solo añade una tabla; la ficha de salud son columnas del perfil y no necesita migración.
    this.version(6).stores({ vaccination: 'id, baby_id, dose_key' });
    // v7: citas médicas. Solo añade una tabla.
    this.version(7).stores({ appointment: 'id, baby_id, start_utc' });
    // v8: medidas de crecimiento (peso, talla, perímetro cefálico). Solo añade una tabla.
    this.version(8).stores({ growth_measure: 'id, baby_id, measured_on' });
    // v9: medicación (tratamientos y dosis). Solo añade dos tablas.
    this.version(9).stores({ medication: 'id, baby_id, start_utc', medication_dose: 'id, baby_id, medication_id, given_utc' });
    // v10: episodios de enfermedad y sus anotaciones. Solo añade dos tablas.
    this.version(10).stores({ illness_episode: 'id, baby_id, start_utc', illness_entry: 'id, baby_id, episode_id, at_utc' });
  }
}

export const TABLES_FOR_EXPORT = [
  'family',
  'caregiver',
  'baby',
  'feeding',
  'sleep_session',
  'awakening',
  'vaccination',
  'appointment',
  'growth_measure',
  'medication',
  'medication_dose',
  'illness_episode',
  'illness_entry',
  'settling_attempt',
  'wake_episode',
  'observation',
  'tag',
  'observation_tag',
  'event_category',
  'life_event',
  'aggregate_period',
  'aggregate_item',
] as const;
