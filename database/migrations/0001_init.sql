-- BabySleep · migración 0001 · esquema relacional base (contrato v0.1.0)
--
-- Alcance: tablas, restricciones e índices. Las políticas RLS, las funciones
-- (apply_changes, claim_membership, ...) y los triggers de sincronización van en
-- migraciones posteriores. Por seguridad, TODAS las tablas nacen con RLS activada
-- y SIN políticas: nadie accede por la API hasta que se definan y se prueben.
--
-- Convenciones: instantes en timestamptz (UTC); zona IANA y offset por evento;
-- ids uuid generados en el cliente (UUIDv7); borrado lógico con deleted_at.

create schema if not exists app;

-- ---------------------------------------------------------------- metadatos

create table app.app_meta (
  key   text primary key,
  value text not null
);
insert into app.app_meta (key, value) values
  ('schema_version', '0.1.0'),
  ('db_epoch', gen_random_uuid()::text);

-- ------------------------------------------------------------------ familia

create table app.family (
  id          uuid primary key,
  name        text not null check (length(name) > 0),
  home_tz     text not null default 'Europe/Madrid',
  settings    jsonb not null default jsonb_build_object(
                'end_conflict_tolerance_s', 120,
                'duplicate_start_tolerance_s', 300,
                'latency_review_threshold_s', 10800),
  rev         integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Cuidador = entidad de aplicación. Los datos referencian caregiver.id, NUNCA
-- auth.users: así una restauración no depende del esquema auth (ver spec §8.4).
create table app.caregiver (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  display_name     text not null check (length(display_name) > 0),
  email_normalized text not null check (email_normalized = lower(trim(email_normalized))),
  auth_user_id     uuid unique,            -- se vincula tras el primer acceso (claim controlado)
  role             text not null check (role in ('admin', 'caregiver', 'viewer')),
  status           text not null check (status in ('invited', 'active', 'disabled')),
  rev              integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (family_id, email_normalized)
);

create table app.device (
  id              uuid primary key,
  family_id       uuid not null references app.family (id),
  caregiver_id    uuid not null references app.caregiver (id),
  label           text,
  last_seen_at    timestamptz,
  clock_offset_ms bigint,
  created_at      timestamptz not null default now()
);

-- Contador monótono de cambios por familia (se incrementa bajo bloqueo de fila).
create table app.family_counter (
  family_id  uuid primary key references app.family (id),
  change_seq bigint not null default 0
);

-- ------------------------------------------------- columnas comunes de datos
-- (id, family_id, rev, change_seq, created/updated_at, created/updated_by,
--  origin_device_id, deleted_at) se repiten en cada tabla sincronizada.

create table app.baby (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  alias            text not null check (length(alias) > 0),
  birth_date       date not null,
  color            text,
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz
);

create table app.settling_attempt (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  baby_id          uuid not null references app.baby (id),
  started_utc      timestamptz,
  put_down_utc     timestamptz,
  started_quality  text check (started_quality in ('exact', 'approx')),
  put_down_quality text check (put_down_quality in ('exact', 'approx')),
  tz               text not null,
  status           text not null check (status in ('open', 'linked', 'abandoned')),
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz,
  check (started_utc is not null or put_down_utc is not null)
);

create table app.sleep_session (
  id                      uuid primary key,
  family_id               uuid not null references app.family (id),
  baby_id                 uuid not null references app.baby (id),
  sleep_start_utc         timestamptz not null,
  sleep_end_utc           timestamptz,            -- null = sesión abierta
  start_tz                text not null,
  end_tz                  text,
  start_quality           text not null default 'exact' check (start_quality in ('exact', 'approx')),
  end_quality             text check (end_quality in ('exact', 'approx')),
  sleep_type              text not null check (sleep_type in ('nap', 'night')),
  type_source             text not null check (type_source in ('auto', 'manual')),
  interval_semantics      text not null default 'observed_asleep_to_observed_awake'
                          check (interval_semantics = 'observed_asleep_to_observed_awake'),
  awakenings_completeness text not null default 'unknown'
                          check (awakenings_completeness in ('unknown', 'partial', 'complete')),
  settling_attempt_id     uuid unique references app.settling_attempt (id),
  merged_into             uuid references app.sleep_session (id),
  conflict_open           boolean not null default false,
  source                  text not null check (source in ('timer', 'manual', 'import', 'synthetic')),
  rev                     integer not null default 1,
  change_seq              bigint,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references app.caregiver (id),
  updated_by              uuid references app.caregiver (id),
  origin_device_id        uuid,
  deleted_at              timestamptz,
  check (sleep_end_utc is null or sleep_end_utc > sleep_start_utc),
  check ((sleep_end_utc is null) = (end_tz is null))
  -- NOTA: NO hay restricción de unicidad de sesión abierta ni de no solape.
  -- Dos dispositivos sin conexión pueden crear sesiones coincidentes; se aceptan y
  -- se marcan para revisión (spec §7). Bloquearlas perdería información.
);
create index sleep_session_baby_start_idx on app.sleep_session (baby_id, sleep_start_utc) where deleted_at is null;
create index sleep_session_open_idx on app.sleep_session (baby_id) where sleep_end_utc is null and deleted_at is null;

create table app.wake_episode (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  session_id       uuid not null references app.sleep_session (id),
  kind             text not null check (kind in ('timed', 'duration_only')),
  start_utc        timestamptz,
  end_utc          timestamptz,
  start_quality    text check (start_quality in ('exact', 'approx')),
  end_quality      text check (end_quality in ('exact', 'approx')),
  duration_s       integer check (duration_s > 0),
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz,
  check (end_utc is null or start_utc is null or end_utc > start_utc),
  check (kind <> 'duration_only' or duration_s is not null)
);

create table app.tag (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  tag_slug         text not null check (tag_slug ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  category         text not null,
  kind             text not null check (kind in ('system', 'custom')),
  label_i18n       jsonb not null,
  archived         boolean not null default false,
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz,
  unique (family_id, tag_slug)
);

create table app.observation (
  id                  uuid primary key,
  family_id           uuid not null references app.family (id),
  session_id          uuid references app.sleep_session (id),
  settling_attempt_id uuid references app.settling_attempt (id),
  moment              text not null check (moment in ('onset', 'during', 'wake', 'settling')),
  occurred_utc        timestamptz,
  note_text           text,
  rev                 integer not null default 1,
  change_seq          bigint,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references app.caregiver (id),
  updated_by          uuid references app.caregiver (id),
  origin_device_id    uuid,
  deleted_at          timestamptz,
  -- exactamente uno de los dos vínculos
  check ((session_id is null) <> (settling_attempt_id is null))
);

create table app.observation_tag (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  observation_id   uuid not null references app.observation (id),
  tag_id           uuid not null references app.tag (id),
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz,        -- tombstone de la relación
  unique (observation_id, tag_id)
);

create table app.event_category (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  slug             text not null,
  kind             text not null check (kind in ('system', 'custom')),
  label_i18n       jsonb not null,
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz,
  unique (family_id, slug)
);

create table app.life_event (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  baby_id          uuid references app.baby (id),   -- null = afecta a toda la familia
  category_id      uuid not null references app.event_category (id),
  start_date       date not null,                    -- fecha civil local
  end_date         date,
  description      text,
  notes            text,
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz,
  check (end_date is null or end_date >= start_date)
);

-- Históricos agregados: inmutables, sin fechas ni horas, separados de las sesiones.
create table app.aggregate_period (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  baby_id          uuid not null references app.baby (id),
  label            text not null check (length(label) > 0),
  source           text not null default 'historical_import' check (source = 'historical_import'),
  notes            text,
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz
);

create table app.aggregate_item (
  id                      uuid primary key,
  family_id               uuid not null references app.family (id),
  period_id               uuid not null references app.aggregate_period (id),
  kind                    text not null check (kind in ('nap', 'night')),
  ordinal                 integer not null check (ordinal >= 0),
  duration_s              integer not null check (duration_s > 0),
  interval_semantics      text not null default 'observed_asleep_to_observed_awake'
                          check (interval_semantics = 'observed_asleep_to_observed_awake'),
  awakenings_completeness text not null default 'unknown' check (awakenings_completeness = 'unknown'),
  rev                     integer not null default 1,
  change_seq              bigint,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references app.caregiver (id),
  updated_by              uuid references app.caregiver (id),
  origin_device_id        uuid,
  deleted_at              timestamptz,
  unique (period_id, ordinal)
);

-- ------------------------------------------------------- infraestructura sync

-- Historial append-only: cada versión de cada fila queda registrada.
create table app.revision (
  id           bigint generated always as identity primary key,
  family_id    uuid not null references app.family (id),
  table_name   text not null,
  row_id       uuid not null,
  rev          integer not null,
  change_seq   bigint not null,
  patch        jsonb,
  snapshot     jsonb not null,
  caregiver_id uuid references app.caregiver (id),
  device_id    uuid,
  recorded_at  timestamptz not null default now(),
  unique (table_name, row_id, rev)
);

create table app.sync_conflict (
  id              uuid primary key,
  family_id       uuid not null references app.family (id),
  table_name      text not null,
  row_id          uuid not null,
  field_name      text,
  kind            text not null,
  current_value   jsonb,
  alternate_value jsonb,
  status          text not null check (status in ('open', 'auto', 'resolved')),
  resolution      jsonb,
  detected_at     timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     uuid references app.caregiver (id)
);

-- Idempotencia: una operación del cliente se aplica una sola vez.
create table app.applied_op (
  op_id      uuid primary key,
  family_id  uuid not null references app.family (id),
  device_id  uuid,
  result     jsonb not null,
  applied_at timestamptz not null default now()
);

-- Estado de copias; lo escribe solo CI (spec §8). Cuatro estados distintos.
create table app.backup_status (
  id                            smallint primary key default 1 check (id = 1),
  last_backup_created_at        timestamptz,
  last_backup_stored_at         timestamptz,   -- cifrada y almacenada, hash verificado
  last_technical_restore_at     timestamptz,   -- restauración de prueba en CI (antes de cifrar)
  last_full_recovery_drill_at   timestamptz,   -- simulacro humano con clave real
  updated_at                    timestamptz not null default now()
);
insert into app.backup_status (id) values (1);

-- ----------------------------------------------------------------------- RLS
-- Denegar por defecto hasta que existan políticas probadas.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t);
  end loop;
end $$;
