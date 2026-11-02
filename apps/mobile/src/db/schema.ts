import Dexie, { type Table } from 'dexie';
import type {
  AggregateItemT,
  AggregatePeriodT,
  BabyT,
  CaregiverT,
  EventCategoryT,
  FamilyT,
  LifeEventT,
  ObservationT,
  ObservationTagT,
  SettlingAttemptT,
  SleepSessionT,
  TagT,
  WakeEpisodeT,
} from '@babysleep/contract';

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

export class BabySleepDb extends Dexie {
  baby_photo!: Table<BabyPhotoRow, string>;
  family!: Table<FamilyT, string>;
  caregiver!: Table<CaregiverT, string>;
  baby!: Table<BabyT, string>;
  sleep_session!: Table<SleepSessionT, string>;
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
  }
}

export const TABLES_FOR_EXPORT = [
  'family',
  'caregiver',
  'baby',
  'sleep_session',
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
