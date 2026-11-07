import {
  AggregateItem,
  AggregatePeriod,
  Awakening,
  Baby,
  EventCategory,
  Feeding,
  LifeEvent,
  Observation,
  ObservationTag,
  SettlingAttempt,
  SleepSession,
  Tag,
  Vaccination,
  WakeEpisode,
} from '@babysleep/contract';

/**
 * Tablas que viajan por `apply_changes`, en orden de dependencia (los padres primero). Es la misma
 * lista blanca que usa el servidor. `family`, `caregiver` y `device` NO se sincronizan por operaciones.
 */
export const SYNC_TABLES = [
  'tag',
  'event_category',
  'baby',
  'feeding',
  'settling_attempt',
  'sleep_session',
  'awakening',
  'vaccination',
  'wake_episode',
  'observation',
  'observation_tag',
  'life_event',
  'aggregate_period',
  'aggregate_item',
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

export const isSyncTable = (name: string): name is SyncTable => (SYNC_TABLES as readonly string[]).includes(name);

export const SYNC_SCHEMAS = {
  tag: Tag,
  event_category: EventCategory,
  baby: Baby,
  feeding: Feeding,
  settling_attempt: SettlingAttempt,
  sleep_session: SleepSession,
  awakening: Awakening,
  vaccination: Vaccination,
  wake_episode: WakeEpisode,
  observation: Observation,
  observation_tag: ObservationTag,
  life_event: LifeEvent,
  aggregate_period: AggregatePeriod,
  aggregate_item: AggregateItem,
} as const;

/** Columnas que gestiona el servidor: el cliente nunca las envía en `fields`. */
export const MANAGED_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'family_id',
  'rev',
  'change_seq',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'origin_device_id',
  'deleted_at',
  'conflict_open',
]);

/** Solo las columnas de negocio de una fila (lo que sí viaja en `fields`). */
export function businessFields(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !MANAGED_COLUMNS.has(k)));
}
