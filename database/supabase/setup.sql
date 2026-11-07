-- BabySleep · instalación completa para Supabase (GENERADO: no lo edites).
-- Fuente: database/migrations/*.sql. Regenerar con: node tools/build-supabase-setup.mjs
--
-- Pégalo ENTERO en Supabase → SQL Editor → Run. Se ejecuta una sola vez.
-- Después crea tu familia (ver docs/development/supabase-setup.md):
--   select app.bootstrap_family('Mi familia', 'Tu nombre', 'tu-correo@ejemplo.com');
--
-- Contiene: 0001_init.sql, 0002_security.sql, 0003_sync.sql, 0004_baby_profile.sql, 0005_sync_restore.sql, 0006_family_admin.sql, 0007_resolve_conflict.sql, 0008_feeding.sql, 0009_feed_reminders.sql, 0010_awakenings.sql, 0011_health_vaccines.sql, 0012_appointments.sql

-- ================================================================
-- 0001_init.sql
-- ================================================================

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

-- ================================================================
-- 0002_security.sql
-- ================================================================

-- BabySleep · migración 0002 · seguridad: privilegios, RLS y alta de cuidadores
--
-- Modelo:
--  * Los clientes (rol `authenticated`) SOLO LEEN, y solo las filas de su familia.
--  * Toda escritura pasará por RPC `security definer` (apply_changes, migración 0003);
--    no hay políticas ni privilegios de INSERT/UPDATE/DELETE para los clientes.
--  * Un usuario de auth solo queda vinculado a un cuidador mediante claim_membership():
--    ventana abierta por un admin, código de un solo uso, caduca, intentos limitados,
--    correo coincidente con el del JWT (OTP ya verificado) y auditoría de todo.
--  * El código se guarda solo como hash SHA-256; se muestra una vez al admin.
--
-- Requiere el esquema `auth` de Supabase (auth.uid(), auth.jwt()). En CI se simula con
-- tests/db/00_supabase_shim.sql.

-- ------------------------------------------------------------- privilegios base

revoke all on schema app from public;
grant usage on schema app to authenticated;
revoke all on all tables in schema app from public, anon, authenticated;

-- ------------------------------------------------------------- tablas nuevas

create table app.audit_log (
  id             bigint generated always as identity primary key,
  family_id      uuid references app.family (id),
  actor_auth_uid uuid,
  event          text not null,
  detail         jsonb not null default '{}'::jsonb,
  at             timestamptz not null default now()
);

create table app.membership_claim (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references app.family (id),
  caregiver_id uuid not null references app.caregiver (id),
  code_hash    bytea not null,                       -- SHA-256 del código; nunca el código
  opened_by    uuid references app.caregiver (id),
  expires_at   timestamptz not null,
  attempts     integer not null default 0,
  max_attempts integer not null default 5,
  closed_at    timestamptz,
  close_reason text check (close_reason in ('consumed', 'superseded', 'locked', 'expired')),
  created_at   timestamptz not null default now(),
  check ((closed_at is null) = (close_reason is null))
);
-- Una sola ventana abierta por cuidador.
create unique index membership_claim_one_open on app.membership_claim (caregiver_id) where closed_at is null;

alter table app.audit_log enable row level security;
alter table app.membership_claim enable row level security;

-- ------------------------------------------------------------------- ayudantes

-- Rol del usuario autenticado en la familia (null si no es miembro activo).
create function app.family_role(p_family_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select c.role
  from app.caregiver c
  where c.family_id = p_family_id
    and c.auth_user_id = auth.uid()
    and c.status = 'active'
    and c.deleted_at is null
$$;

create function app.is_any_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.caregiver c
    where c.auth_user_id = auth.uid() and c.role = 'admin' and c.status = 'active' and c.deleted_at is null
  )
$$;

-- --------------------------------------------------------------------- lectura

do $$
declare t text;
begin
  foreach t in array array[
    'baby', 'settling_attempt', 'sleep_session', 'wake_episode', 'tag', 'observation',
    'observation_tag', 'event_category', 'life_event', 'aggregate_period', 'aggregate_item',
    'caregiver', 'device', 'family_counter', 'revision', 'sync_conflict'
  ] loop
    execute format('grant select on app.%I to authenticated', t);
    execute format(
      'create policy member_read on app.%I for select to authenticated using (app.family_role(family_id) is not null)', t);
  end loop;
end $$;

grant select on app.family to authenticated;
create policy member_read on app.family for select to authenticated
  using (app.family_role(id) is not null);

grant select on app.audit_log to authenticated;
create policy admin_read on app.audit_log for select to authenticated
  using (app.family_role(family_id) = 'admin');

grant select on app.backup_status to authenticated;
create policy admin_read on app.backup_status for select to authenticated
  using (app.is_any_admin());

-- Sin acceso para clientes (sin privilegios ni políticas): app_meta, applied_op, membership_claim.

-- ------------------------------------------------------------ alta de cuidadores

-- Crea una ventana de alta de 30 min y devuelve el código en claro (única vez).
create function app._new_claim(p_caregiver_id uuid, p_opened_by uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_family uuid;
  v_code   text;
begin
  select family_id into v_family from app.caregiver where id = p_caregiver_id;

  update app.membership_claim
     set closed_at = now(), close_reason = 'superseded'
   where caregiver_id = p_caregiver_id and closed_at is null;

  v_code := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');  -- 64 hex (~240 bits)
  insert into app.membership_claim (family_id, caregiver_id, code_hash, opened_by, expires_at)
  values (v_family, p_caregiver_id, sha256(convert_to(v_code, 'utf8')), p_opened_by, now() + interval '30 minutes');

  insert into app.audit_log (family_id, actor_auth_uid, event, detail)
  values (v_family, auth.uid(), 'claim_opened', jsonb_build_object('caregiver_id', p_caregiver_id, 'opened_by', p_opened_by));
  return v_code;
end $$;

-- Primer arranque (solo rol privilegiado: postgres/service_role): crea la familia y su admin.
create function app.bootstrap_family(p_family_name text, p_admin_name text, p_admin_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_family uuid := gen_random_uuid();
  v_cg     uuid := gen_random_uuid();
begin
  insert into app.family (id, name) values (v_family, p_family_name);
  insert into app.family_counter (family_id) values (v_family);
  insert into app.caregiver (id, family_id, display_name, email_normalized, role, status)
  values (v_cg, v_family, p_admin_name, lower(trim(p_admin_email)), 'admin', 'invited');
  return app._new_claim(v_cg, null);
end $$;

-- Un admin abre la ventana de alta para un cuidador invitado de su familia.
create function app.open_claim(p_caregiver_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_family uuid;
  v_me     uuid;
begin
  select family_id into v_family from app.caregiver where id = p_caregiver_id;
  -- Mismo error si no existe o no es de tu familia: no se revela nada.
  if app.family_role(v_family) is distinct from 'admin' then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if not exists (
    select 1 from app.caregiver
    where id = p_caregiver_id and status = 'invited' and auth_user_id is null and deleted_at is null
  ) then
    raise exception 'caregiver_not_claimable' using errcode = 'P0001';
  end if;
  select id into v_me from app.caregiver where auth_user_id = auth.uid() and family_id = v_family;
  return app._new_claim(p_caregiver_id, v_me);
end $$;

-- El usuario recién autenticado (OTP verificado) canjea su código.
-- Devuelve jsonb con `status` en vez de lanzar errores: los intentos fallidos deben
-- persistir (un `raise` revertiría el contador).
create function app.claim_membership(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(trim(auth.jwt() ->> 'email'));
  v_claim app.membership_claim;
  v_ok    boolean;
begin
  if v_uid is null or v_email is null or v_email = '' then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select c.* into v_claim
  from app.membership_claim c
  join app.caregiver g on g.id = c.caregiver_id
  where g.email_normalized = v_email
    and g.status = 'invited' and g.auth_user_id is null and g.deleted_at is null
    and c.closed_at is null
  order by c.created_at desc
  limit 1
  for update of c;

  if not found then
    insert into app.audit_log (actor_auth_uid, event, detail) values (v_uid, 'claim_no_window', '{}');
    return jsonb_build_object('status', 'no_window');
  end if;

  if v_claim.expires_at <= now() then
    update app.membership_claim set closed_at = now(), close_reason = 'expired' where id = v_claim.id;
    insert into app.audit_log (family_id, actor_auth_uid, event, detail)
    values (v_claim.family_id, v_uid, 'claim_expired', jsonb_build_object('caregiver_id', v_claim.caregiver_id));
    return jsonb_build_object('status', 'expired');
  end if;

  v_ok := sha256(convert_to(lower(trim(coalesce(p_code, ''))), 'utf8')) = v_claim.code_hash;

  if not v_ok then
    update app.membership_claim
       set attempts = attempts + 1,
           closed_at = case when attempts + 1 >= max_attempts then now() end,
           close_reason = case when attempts + 1 >= max_attempts then 'locked' end
     where id = v_claim.id;
    insert into app.audit_log (family_id, actor_auth_uid, event, detail)
    values (v_claim.family_id, v_uid, 'claim_bad_code',
            jsonb_build_object('caregiver_id', v_claim.caregiver_id, 'attempt', v_claim.attempts + 1));
    return jsonb_build_object('status', case when v_claim.attempts + 1 >= v_claim.max_attempts then 'locked' else 'invalid' end);
  end if;

  -- Una cuenta de auth no puede vincularse a dos cuidadores.
  if exists (select 1 from app.caregiver where auth_user_id = v_uid) then
    insert into app.audit_log (family_id, actor_auth_uid, event, detail)
    values (v_claim.family_id, v_uid, 'claim_already_linked', jsonb_build_object('caregiver_id', v_claim.caregiver_id));
    return jsonb_build_object('status', 'already_linked');
  end if;

  update app.caregiver
     set auth_user_id = v_uid, status = 'active', rev = rev + 1, updated_at = now()
   where id = v_claim.caregiver_id;
  update app.membership_claim set closed_at = now(), close_reason = 'consumed' where id = v_claim.id;
  insert into app.audit_log (family_id, actor_auth_uid, event, detail)
  values (v_claim.family_id, v_uid, 'claim_ok', jsonb_build_object('caregiver_id', v_claim.caregiver_id));

  return jsonb_build_object('status', 'ok', 'caregiver_id', v_claim.caregiver_id, 'family_id', v_claim.family_id);
end $$;

-- ---------------------------------------------- ejecución: lista blanca explícita
-- Postgres concede EXECUTE a PUBLIC por defecto; se retira de todas las funciones
-- del esquema y se concede solo lo que el cliente puede llamar.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function app.family_role(uuid), app.is_any_admin(),
  app.open_claim(uuid), app.claim_membership(text) to authenticated;

update app.app_meta set value = '0.2.0' where key = 'schema_version';

-- ================================================================
-- 0003_sync.sql
-- ================================================================

-- BabySleep · migración 0003 · sincronización: apply_changes, revisiones y conflictos
--
-- Protocolo (spec §7). El cliente envía una cola de operaciones; el servidor las aplica
-- en orden, cada una en su propia subtransacción (una operación inválida no tumba el lote):
--
--   { "op_id": uuid,            -- idempotencia: una op se aplica una sola vez
--     "table": "sleep_session", -- lista blanca
--     "row_id": uuid,
--     "base_rev": int | null,   -- rev del servidor sobre la que se editó; null = alta
--     "fields": { ... },        -- solo columnas de negocio (nunca id/family/rev/...)
--     "delete": bool }          -- borrado lógico
--
-- Garantías:
--  * La familia y el autor salen de la sesión, jamás del cliente.
--  * Toda referencia (baby_id, session_id, ...) debe apuntar a una fila de la MISMA familia.
--  * Cada escritura aplicada = un change_seq nuevo (contador por familia, bajo bloqueo)
--    + una fila en app.revision (historial append-only). Nada se borra físicamente.
--  * Nunca hay un perdedor irrecuperable: el valor desplazado queda en sync_conflict.
--
-- Reglas de conflicto (spec §7):
--   campo no tocado por otros desde base_rev      -> se aplica (fusión de campos distintos)
--   baby.*                                        -> último por campo
--   sleep_session.sleep_end_utc, dif <= tolerancia -> se conserva el vigente, conflicto 'auto'
--   sleep_session.sleep_end_utc, dif >  tolerancia -> se conserva el vigente, conflicto 'open'
--                                                     y la sesión queda con conflict_open
--   resto de campos en disputa                    -> se conserva el vigente, conflicto 'open'
--   borrado con ediciones posteriores a base_rev  -> NO se borra, conflicto 'open'
--   edición de una fila borrada tras base_rev     -> se restaura la fila, conflicto 'open'

-- Índices para el pull incremental (WHERE family_id = ? AND change_seq > ?).
do $$
declare t text;
begin
  foreach t in array array[
    'baby', 'settling_attempt', 'sleep_session', 'wake_episode', 'tag', 'observation',
    'observation_tag', 'event_category', 'life_event', 'aggregate_period', 'aggregate_item'
  ] loop
    execute format('create index %I on app.%I (family_id, change_seq)', t || '_sync_idx', t);
  end loop;
end $$;

-- ------------------------------------------------------------------- internos

create function app._next_seq(p_family uuid) returns bigint
language sql security definer set search_path = '' as $$
  update app.family_counter set change_seq = change_seq + 1
   where family_id = p_family
  returning change_seq
$$;

create function app._record_revision(
  p_family uuid, p_table text, p_row uuid, p_patch jsonb, p_cg uuid, p_device uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_snap jsonb;
begin
  execute format('select to_jsonb(t) from app.%I t where t.id = $1', p_table) into v_snap using p_row;
  insert into app.revision (family_id, table_name, row_id, rev, change_seq, patch, snapshot, caregiver_id, device_id)
  values (p_family, p_table, p_row, (v_snap ->> 'rev')::int, (v_snap ->> 'change_seq')::bigint,
          p_patch, v_snap, p_cg, p_device);
end $$;

create function app._conflict(
  p_family uuid, p_table text, p_row uuid, p_field text, p_kind text, p_status text,
  p_current jsonb, p_alternate jsonb
) returns uuid
language sql security definer set search_path = '' as $$
  insert into app.sync_conflict (id, family_id, table_name, row_id, field_name, kind, current_value, alternate_value, status)
  values (gen_random_uuid(), p_family, p_table, p_row, p_field, p_kind, p_current, p_alternate, p_status)
  returning id
$$;

-- Aplica UNA operación. Lanza excepción si es inválida (la captura _apply_one).
create function app._apply_core(p_family uuid, p_cg uuid, p_device uuid, p_op jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_tables  constant text[] := array[
    'baby', 'settling_attempt', 'sleep_session', 'wake_episode', 'tag', 'observation',
    'observation_tag', 'event_category', 'life_event', 'aggregate_period', 'aggregate_item'];
  c_managed constant text[] := array[
    'id', 'family_id', 'rev', 'change_seq', 'created_at', 'updated_at',
    'created_by', 'updated_by', 'origin_device_id', 'deleted_at'];
  c_refs    constant jsonb := '{"baby_id":"baby","session_id":"sleep_session","settling_attempt_id":"settling_attempt",
    "period_id":"aggregate_period","observation_id":"observation","tag_id":"tag",
    "category_id":"event_category","merged_into":"sleep_session"}';

  v_table   text    := p_op ->> 'table';
  v_row     uuid    := (p_op ->> 'row_id')::uuid;
  v_base    int     := nullif(p_op ->> 'base_rev', '')::int;
  v_fields  jsonb   := case when (p_op -> 'fields') is null or jsonb_typeof(p_op -> 'fields') = 'null'
                            then '{}'::jsonb else p_op -> 'fields' end;
  v_delete  boolean := coalesce((p_op ->> 'delete')::boolean, false);

  v_allowed text[];
  v_k       text;
  v_target  text;
  v_fam     uuid;
  v_cur     jsonb;
  v_old     jsonb;
  v_in      jsonb;
  v_rev     int;
  v_seq     bigint;
  v_tol     int;
  v_apply   text[] := '{}';
  v_conflicts jsonb := '[]';
  v_open    boolean := false;
  v_flag    boolean := false;
  v_restore boolean := false;
  v_deleted boolean;
  v_diff    numeric;
  v_cid     uuid;
  v_set     text;
  v_cols    text;
  v_patch   jsonb;
begin
  if v_table is null or v_table <> all (c_tables) then raise exception 'unknown_table'; end if;
  if v_row is null then raise exception 'bad_row_id'; end if;
  if jsonb_typeof(v_fields) <> 'object' then raise exception 'bad_fields'; end if;

  -- Columnas que el cliente puede enviar: las de negocio.
  select array_agg(column_name::text) into v_allowed
    from information_schema.columns
   where table_schema = 'app' and table_name = v_table
     and column_name::text <> all (c_managed)
     and not (v_table = 'sleep_session' and column_name = 'conflict_open');

  for v_k in select jsonb_object_keys(v_fields) loop
    if v_k <> all (v_allowed) then raise exception 'unknown_column: %', v_k; end if;
    v_target := c_refs ->> v_k;
    if v_target is not null and v_fields -> v_k <> 'null'::jsonb then
      execute format('select family_id from app.%I where id = $1', v_target)
        into v_fam using (v_fields ->> v_k)::uuid;
      if v_fam is distinct from p_family then raise exception 'invalid_reference: %', v_k; end if;
    end if;
  end loop;

  -- Valores entrantes normalizados con el mismo formato que to_jsonb(fila).
  execute format('select to_jsonb(jsonb_populate_record(null::app.%I, $1))', v_table) into v_in using v_fields;
  execute format('select to_jsonb(t) from app.%I t where t.id = $1 and t.family_id = $2', v_table)
    into v_cur using v_row, p_family;
  select coalesce((settings ->> 'end_conflict_tolerance_s')::int, 120) into v_tol
    from app.family where id = p_family;

  -- ------------------------------------------------------------------ alta
  if v_cur is null then
    if v_delete or v_base is not null then raise exception 'row_not_found'; end if;
    v_seq := app._next_seq(p_family);
    v_in := v_fields || jsonb_build_object(
      'id', v_row, 'family_id', p_family, 'rev', 1, 'change_seq', v_seq,
      'created_by', p_cg, 'updated_by', p_cg, 'origin_device_id', p_device);
    select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(v_in) k;
    execute format('insert into app.%I (%s) select %s from jsonb_populate_record(null::app.%I, $1)',
                   v_table, v_cols, v_cols, v_table) using v_in;
    perform app._record_revision(p_family, v_table, v_row, v_fields, p_cg, p_device);
    return jsonb_build_object('status', 'applied', 'rev', 1, 'change_seq', v_seq);
  end if;

  v_rev := (v_cur ->> 'rev')::int;
  v_deleted := (v_cur ->> 'deleted_at') is not null;

  -- Alta repetida de una fila que ya existe (p. ej. reconciliación tras restaurar): no-op.
  if v_base is null then
    return jsonb_build_object('status', 'noop', 'reason', 'exists', 'rev', v_rev);
  end if;
  if v_base > v_rev then raise exception 'base_rev_ahead'; end if;

  -- --------------------------------------------------------------- borrado
  if v_delete then
    if v_deleted then
      return jsonb_build_object('status', 'noop', 'reason', 'already_deleted', 'rev', v_rev);
    end if;
    if v_base < v_rev then
      v_cid := app._conflict(p_family, v_table, v_row, null, 'delete_vs_edit', 'open', v_cur, null);
      return jsonb_build_object('status', 'conflict', 'rev', v_rev, 'conflicts', jsonb_build_array(v_cid));
    end if;
    v_seq := app._next_seq(p_family);
    execute format('update app.%I set deleted_at = now(), rev = rev + 1, change_seq = $2, updated_at = now(),
                    updated_by = $3, origin_device_id = $4 where id = $1', v_table)
      using v_row, v_seq, p_cg, p_device;
    perform app._record_revision(p_family, v_table, v_row, jsonb_build_object('deleted', true), p_cg, p_device);
    return jsonb_build_object('status', 'applied', 'rev', v_rev + 1, 'change_seq', v_seq);
  end if;

  -- --------------------------------------------------------------- edición
  if v_base < v_rev then
    select snapshot into v_old from app.revision where table_name = v_table and row_id = v_row and rev = v_base;
  end if;

  for v_k in select jsonb_object_keys(v_fields) loop
    if (v_cur -> v_k) is not distinct from (v_in -> v_k) then continue; end if;

    if v_base = v_rev
       or (v_old is not null and (v_cur -> v_k) is not distinct from (v_old -> v_k)) then
      v_apply := v_apply || v_k;                                  -- nadie más lo tocó
    elsif v_table = 'baby' then
      v_apply := v_apply || v_k;                                  -- perfil: último por campo
    elsif v_table = 'sleep_session' and v_k = 'sleep_end_utc'
          and (v_cur ->> v_k) is not null and (v_in ->> v_k) is not null then
      v_diff := abs(extract(epoch from ((v_cur ->> v_k)::timestamptz - (v_in ->> v_k)::timestamptz)));
      if v_diff <= v_tol then
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time_within_tolerance', 'auto', v_cur -> v_k, v_in -> v_k);
      else
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time', 'open', v_cur -> v_k, v_in -> v_k);
        v_open := true;
        v_flag := true;
      end if;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_cid := app._conflict(p_family, v_table, v_row, v_k, 'field', 'open', v_cur -> v_k, v_in -> v_k);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    end if;
  end loop;

  if v_deleted and v_base < v_rev then
    v_restore := true;
    v_open := true;
    v_cid := app._conflict(p_family, v_table, v_row, null, 'edit_after_delete', 'open', v_cur, v_fields);
    v_conflicts := v_conflicts || to_jsonb(v_cid);
  end if;

  if cardinality(v_apply) = 0 and not v_restore and not v_flag then
    return jsonb_build_object('status', case when v_open then 'conflict' else 'noop' end,
                              'rev', v_rev, 'conflicts', v_conflicts);
  end if;

  v_seq := app._next_seq(p_family);
  select string_agg(format('%I = r.%I', k, k), ', ') into v_set from unnest(v_apply) k;
  v_set := concat_ws(', ', v_set,
                     case when v_flag then 'conflict_open = true' end,
                     case when v_restore then 'deleted_at = null' end);
  execute format('update app.%I t set %s, rev = t.rev + 1, change_seq = $3, updated_at = now(),
                  updated_by = $4, origin_device_id = $5
                  from jsonb_populate_record(null::app.%I, $1) r where t.id = $2', v_table, v_set, v_table)
    using v_fields, v_row, v_seq, p_cg, p_device;

  select coalesce(jsonb_object_agg(k, v_in -> k), '{}'::jsonb) into v_patch from unnest(v_apply) k;
  perform app._record_revision(p_family, v_table, v_row, v_patch, p_cg, p_device);

  return jsonb_build_object(
    'status', case when jsonb_array_length(v_conflicts) = 0 then 'applied' else 'merged' end,
    'rev', v_rev + 1, 'change_seq', v_seq, 'conflicts', v_conflicts);
end $$;

-- Idempotencia + aislamiento de errores por operación.
create function app._apply_one(p_family uuid, p_cg uuid, p_device uuid, p_op jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_op_id uuid;
  v_res   jsonb;
begin
  begin
    v_op_id := (p_op ->> 'op_id')::uuid;
  exception when others then
    return jsonb_build_object('status', 'rejected', 'reason', 'bad_op_id');
  end;
  if v_op_id is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'bad_op_id');
  end if;

  select result into v_res from app.applied_op where op_id = v_op_id and family_id = p_family;
  if found then
    return v_res || jsonb_build_object('replayed', true);
  end if;

  begin
    v_res := app._apply_core(p_family, p_cg, p_device, p_op);
  exception when others then
    v_res := jsonb_build_object('status', 'rejected', 'reason', sqlerrm, 'sqlstate', sqlstate);
  end;
  v_res := v_res || jsonb_build_object('op_id', v_op_id);

  insert into app.applied_op (op_id, family_id, device_id, result) values (v_op_id, p_family, p_device, v_res)
  on conflict (op_id) do nothing;
  return v_res;
end $$;

-- ------------------------------------------------------------------ RPC pública

create function app.apply_changes(p_device_id uuid, p_client_time timestamptz, p_ops jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cg      uuid;
  v_family  uuid;
  v_role    text;
  v_op      jsonb;
  v_results jsonb := '[]';
  v_seq     bigint;
begin
  select id, family_id, role into v_cg, v_family, v_role
    from app.caregiver
   where auth_user_id = auth.uid() and status = 'active' and deleted_at is null;
  if v_cg is null or v_role not in ('admin', 'caregiver') then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_ops) is distinct from 'array' or jsonb_array_length(p_ops) > 500 then
    raise exception 'bad_ops' using errcode = '22023';
  end if;

  if p_device_id is not null then
    insert into app.device (id, family_id, caregiver_id, last_seen_at, clock_offset_ms)
    values (p_device_id, v_family, v_cg, now(),
            case when p_client_time is not null then (extract(epoch from (p_client_time - now())) * 1000)::bigint end)
    on conflict (id) do update
      set last_seen_at = now(),
          clock_offset_ms = coalesce(excluded.clock_offset_ms, app.device.clock_offset_ms)
      where app.device.family_id = v_family;
  end if;

  for v_op in select * from jsonb_array_elements(p_ops) loop
    v_results := v_results || jsonb_build_array(app._apply_one(v_family, v_cg, p_device_id, v_op));
  end loop;

  select change_seq into v_seq from app.family_counter where family_id = v_family;
  return jsonb_build_object('results', v_results, 'change_seq', v_seq);
end $$;

-- ---------------------------------------------- ejecución: lista blanca explícita
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function app.family_role(uuid), app.is_any_admin(),
  app.open_claim(uuid), app.claim_membership(text),
  app.apply_changes(uuid, timestamptz, jsonb) to authenticated;

update app.app_meta set value = '0.3.0' where key = 'schema_version';

-- ================================================================
-- 0004_baby_profile.sql
-- ================================================================

-- BabySleep · migración 0004 · perfil ampliado del bebé (contrato v0.2.0)
--
-- Datos opcionales (null = desconocido, nunca 0). La FOTO no existe en el servidor: es solo
-- local y no se sincroniza (decisión de producto). apply_changes acepta estas columnas sin
-- cambios porque deriva la lista de columnas permitidas de information_schema.

alter table app.baby
  add column sex               text     check (sex in ('female', 'male')),
  add column gestational_weeks smallint check (gestational_weeks between 22 and 44),
  add column birth_weight_g    integer  check (birth_weight_g between 300 and 7000),
  add column birth_length_cm   numeric(4, 1) check (birth_length_cm between 20 and 70),
  add column notes             text     check (length(notes) <= 1000);

update app.app_meta set value = '0.4.0' where key = 'schema_version';

-- ================================================================
-- 0005_sync_restore.sql
-- ================================================================

-- BabySleep · migración 0005 · apply_changes: «restaurar» y borrado combinado con edición
--
-- Amplía el formato de operación de la migración 0003:
--   "restore": true  -> la fila vuelve de la papelera (deleted_at = null). No genera conflicto:
--                       el cliente que restaura ya sabe que está borrada.
--   "delete": true   -> ahora puede ir junto a "fields": primero se fusionan los campos
--                       (con las reglas de siempre) y después se borra, salvo que otros hayan
--                       editado la fila desde base_rev (entonces la fila se conserva y se abre
--                       un conflicto 'delete_vs_edit').
-- "delete" y "restore" a la vez se rechazan. El resto de reglas (spec §7) no cambia.

create or replace function app._apply_core(p_family uuid, p_cg uuid, p_device uuid, p_op jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_tables  constant text[] := array[
    'baby', 'settling_attempt', 'sleep_session', 'wake_episode', 'tag', 'observation',
    'observation_tag', 'event_category', 'life_event', 'aggregate_period', 'aggregate_item'];
  c_managed constant text[] := array[
    'id', 'family_id', 'rev', 'change_seq', 'created_at', 'updated_at',
    'created_by', 'updated_by', 'origin_device_id', 'deleted_at'];
  c_refs    constant jsonb := '{"baby_id":"baby","session_id":"sleep_session","settling_attempt_id":"settling_attempt",
    "period_id":"aggregate_period","observation_id":"observation","tag_id":"tag",
    "category_id":"event_category","merged_into":"sleep_session"}';

  v_table   text    := p_op ->> 'table';
  v_row     uuid    := (p_op ->> 'row_id')::uuid;
  v_base    int     := nullif(p_op ->> 'base_rev', '')::int;
  v_fields  jsonb   := case when (p_op -> 'fields') is null or jsonb_typeof(p_op -> 'fields') = 'null'
                            then '{}'::jsonb else p_op -> 'fields' end;
  v_delete  boolean := coalesce((p_op ->> 'delete')::boolean, false);
  v_restore_req boolean := coalesce((p_op ->> 'restore')::boolean, false);

  v_allowed text[];
  v_k       text;
  v_target  text;
  v_fam     uuid;
  v_cur     jsonb;
  v_old     jsonb;
  v_in      jsonb;
  v_rev     int;
  v_seq     bigint;
  v_tol     int;
  v_apply   text[] := '{}';
  v_conflicts jsonb := '[]';
  v_open    boolean := false;
  v_flag    boolean := false;
  v_restore boolean := false;
  v_do_delete boolean := false;
  v_deleted boolean;
  v_diff    numeric;
  v_cid     uuid;
  v_set     text;
  v_cols    text;
  v_patch   jsonb;
begin
  if v_table is null or v_table <> all (c_tables) then raise exception 'unknown_table'; end if;
  if v_row is null then raise exception 'bad_row_id'; end if;
  if jsonb_typeof(v_fields) <> 'object' then raise exception 'bad_fields'; end if;
  if v_delete and v_restore_req then raise exception 'delete_and_restore'; end if;

  select array_agg(column_name::text) into v_allowed
    from information_schema.columns
   where table_schema = 'app' and table_name = v_table
     and column_name::text <> all (c_managed)
     and not (v_table = 'sleep_session' and column_name = 'conflict_open');

  for v_k in select jsonb_object_keys(v_fields) loop
    if v_k <> all (v_allowed) then raise exception 'unknown_column: %', v_k; end if;
    v_target := c_refs ->> v_k;
    if v_target is not null and v_fields -> v_k <> 'null'::jsonb then
      execute format('select family_id from app.%I where id = $1', v_target)
        into v_fam using (v_fields ->> v_k)::uuid;
      if v_fam is distinct from p_family then raise exception 'invalid_reference: %', v_k; end if;
    end if;
  end loop;

  execute format('select to_jsonb(jsonb_populate_record(null::app.%I, $1))', v_table) into v_in using v_fields;
  execute format('select to_jsonb(t) from app.%I t where t.id = $1 and t.family_id = $2', v_table)
    into v_cur using v_row, p_family;
  select coalesce((settings ->> 'end_conflict_tolerance_s')::int, 120) into v_tol
    from app.family where id = p_family;

  -- ------------------------------------------------------------------ alta
  if v_cur is null then
    if v_delete or v_restore_req or v_base is not null then raise exception 'row_not_found'; end if;
    v_seq := app._next_seq(p_family);
    v_in := v_fields || jsonb_build_object(
      'id', v_row, 'family_id', p_family, 'rev', 1, 'change_seq', v_seq,
      'created_by', p_cg, 'updated_by', p_cg, 'origin_device_id', p_device);
    select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(v_in) k;
    execute format('insert into app.%I (%s) select %s from jsonb_populate_record(null::app.%I, $1)',
                   v_table, v_cols, v_cols, v_table) using v_in;
    perform app._record_revision(p_family, v_table, v_row, v_fields, p_cg, p_device);
    return jsonb_build_object('status', 'applied', 'rev', 1, 'change_seq', v_seq);
  end if;

  v_rev := (v_cur ->> 'rev')::int;
  v_deleted := (v_cur ->> 'deleted_at') is not null;

  if v_base is null then
    return jsonb_build_object('status', 'noop', 'reason', 'exists', 'rev', v_rev);
  end if;
  if v_base > v_rev then raise exception 'base_rev_ahead'; end if;

  -- ------------------------------------------------- fusión campo a campo
  if v_base < v_rev then
    select snapshot into v_old from app.revision where table_name = v_table and row_id = v_row and rev = v_base;
  end if;

  for v_k in select jsonb_object_keys(v_fields) loop
    if (v_cur -> v_k) is not distinct from (v_in -> v_k) then continue; end if;

    if v_base = v_rev
       or (v_old is not null and (v_cur -> v_k) is not distinct from (v_old -> v_k)) then
      v_apply := v_apply || v_k;                                  -- nadie más lo tocó
    elsif v_table = 'baby' then
      v_apply := v_apply || v_k;                                  -- perfil: último por campo
    elsif v_table = 'sleep_session' and v_k = 'sleep_end_utc'
          and (v_cur ->> v_k) is not null and (v_in ->> v_k) is not null then
      v_diff := abs(extract(epoch from ((v_cur ->> v_k)::timestamptz - (v_in ->> v_k)::timestamptz)));
      if v_diff <= v_tol then
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time_within_tolerance', 'auto', v_cur -> v_k, v_in -> v_k);
      else
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time', 'open', v_cur -> v_k, v_in -> v_k);
        v_open := true;
        v_flag := true;
      end if;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_cid := app._conflict(p_family, v_table, v_row, v_k, 'field', 'open', v_cur -> v_k, v_in -> v_k);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    end if;
  end loop;

  -- ------------------------------------------------- restaurar / borrar
  if v_restore_req then
    v_restore := v_deleted;                                        -- restaurar una fila viva es un no-op
  elsif v_deleted and v_base < v_rev and not v_delete and cardinality(v_apply) + jsonb_array_length(v_conflicts) > 0 then
    v_restore := true;                                             -- edición de una fila borrada tras base_rev
    v_open := true;
    v_cid := app._conflict(p_family, v_table, v_row, null, 'edit_after_delete', 'open', v_cur, v_fields);
    v_conflicts := v_conflicts || to_jsonb(v_cid);
  end if;

  if v_delete and not v_deleted then
    if v_base < v_rev then
      v_cid := app._conflict(p_family, v_table, v_row, null, 'delete_vs_edit', 'open', v_cur, null);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_do_delete := true;
    end if;
  end if;

  if cardinality(v_apply) = 0 and not v_restore and not v_flag and not v_do_delete then
    return jsonb_build_object('status', case when v_open then 'conflict' else 'noop' end,
                              'rev', v_rev, 'conflicts', v_conflicts);
  end if;

  v_seq := app._next_seq(p_family);
  select string_agg(format('%I = r.%I', k, k), ', ') into v_set from unnest(v_apply) k;
  v_set := concat_ws(', ', v_set,
                     case when v_flag then 'conflict_open = true' end,
                     case when v_restore then 'deleted_at = null' end,
                     case when v_do_delete then 'deleted_at = now()' end);
  execute format('update app.%I t set %s, rev = t.rev + 1, change_seq = $3, updated_at = now(),
                  updated_by = $4, origin_device_id = $5
                  from jsonb_populate_record(null::app.%I, $1) r where t.id = $2', v_table, v_set, v_table)
    using v_fields, v_row, v_seq, p_cg, p_device;

  select coalesce(jsonb_object_agg(k, v_in -> k), '{}'::jsonb) into v_patch from unnest(v_apply) k;
  if v_do_delete then v_patch := v_patch || '{"deleted": true}'; end if;
  if v_restore then v_patch := v_patch || '{"restored": true}'; end if;
  perform app._record_revision(p_family, v_table, v_row, v_patch, p_cg, p_device);

  return jsonb_build_object(
    'status', case when jsonb_array_length(v_conflicts) = 0 then 'applied' else 'merged' end,
    'rev', v_rev + 1, 'change_seq', v_seq, 'conflicts', v_conflicts);
end $$;

update app.app_meta set value = '0.5.0' where key = 'schema_version';

-- ================================================================
-- 0006_family_admin.sql
-- ================================================================

-- BabySleep · migración 0006 · gestión de la familia desde la app (solo administradores)
--
--  * invite_caregiver: da de alta (o re-invita) a un cuidador y devuelve su código de alta (30 min, un uso).
--  * disable_caregiver: retira el acceso a un cuidador (reversible: vuelve a invitarlo).
--
-- El usuario de acceso (auth.users) lo crea el administrador a mano en el panel de Supabase mientras el
-- registro esté cerrado; aquí solo se gestiona la pertenencia a la familia. Todo queda en audit_log.

create function app.invite_caregiver(p_display_name text, p_email text, p_role text default 'caregiver') returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid;
  v_family uuid;
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_name   text := trim(coalesce(p_display_name, ''));
  v_cg     app.caregiver;
begin
  select id, family_id into v_me, v_family
    from app.caregiver
   where auth_user_id = auth.uid() and role = 'admin' and status = 'active' and deleted_at is null;
  if v_me is null then raise exception 'not_admin' using errcode = '42501'; end if;

  if v_name = '' then raise exception 'invalid_name' using errcode = '22023'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email' using errcode = '22023'; end if;
  if p_role not in ('caregiver', 'viewer') then raise exception 'invalid_role' using errcode = '22023'; end if;

  select * into v_cg from app.caregiver where family_id = v_family and email_normalized = v_email;
  if found then
    if v_cg.status = 'active' and v_cg.deleted_at is null then raise exception 'already_member' using errcode = 'P0001'; end if;
    -- Re-invitación (invitado sin canjear, o cuidador desactivado): se reabre y se actualizan nombre y rol.
    update app.caregiver
       set display_name = v_name, role = p_role, status = 'invited', auth_user_id = null,
           deleted_at = null, rev = rev + 1, updated_at = now()
     where id = v_cg.id;
  else
    insert into app.caregiver (id, family_id, display_name, email_normalized, role, status)
    values (gen_random_uuid(), v_family, v_name, v_email, p_role, 'invited')
    returning * into v_cg;
  end if;

  insert into app.audit_log (family_id, actor_auth_uid, event, detail)
  values (v_family, auth.uid(), 'caregiver_invited', jsonb_build_object('caregiver_id', v_cg.id, 'role', p_role));
  return app._new_claim(v_cg.id, v_me);
end $$;

create function app.disable_caregiver(p_caregiver_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid;
  v_family uuid;
  v_target app.caregiver;
begin
  select id, family_id into v_me, v_family
    from app.caregiver
   where auth_user_id = auth.uid() and role = 'admin' and status = 'active' and deleted_at is null;
  if v_me is null then raise exception 'not_admin' using errcode = '42501'; end if;

  select * into v_target from app.caregiver where id = p_caregiver_id and family_id = v_family;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if v_target.id = v_me then raise exception 'cannot_disable_self' using errcode = 'P0001'; end if;

  update app.caregiver set status = 'disabled', rev = rev + 1, updated_at = now() where id = v_target.id;
  update app.membership_claim set closed_at = now(), close_reason = 'superseded'
   where caregiver_id = v_target.id and closed_at is null;
  insert into app.audit_log (family_id, actor_auth_uid, event, detail)
  values (v_family, auth.uid(), 'caregiver_disabled', jsonb_build_object('caregiver_id', v_target.id));
end $$;

-- Ejecución: lista blanca explícita (ver 0002 y 0003).
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function app.family_role(uuid), app.is_any_admin(),
  app.open_claim(uuid), app.claim_membership(text), app.apply_changes(uuid, timestamptz, jsonb),
  app.invite_caregiver(text, text, text), app.disable_caregiver(uuid) to authenticated;

update app.app_meta set value = '0.6.0' where key = 'schema_version';

-- ================================================================
-- 0007_resolve_conflict.sql
-- ================================================================

-- BabySleep · migración 0007 · resolver conflictos de sincronización
--
-- Un conflicto guarda el valor VIGENTE y el valor ALTERNATIVO desplazado (spec §7: nunca hay un perdedor
-- irrecuperable). resolve_conflict(id, uso) deja que una persona decida:
--
--   'current' -> se conserva lo que está ahora; el conflicto se da por resuelto.
--   'other'   -> se aplica el otro valor:
--                  · conflicto de campo / fin de sueño  : el campo toma el valor alternativo
--                  · delete_vs_edit y edit_after_delete : la fila queda BORRADA (a la papelera)
--
-- Cuando una sesión ya no tiene conflictos de fin de sueño abiertos, se limpia su marca `conflict_open`.
-- Todo cambio pasa por la maquinaria de siempre (change_seq y revisión), así que llega a todos los móviles.

create function app.resolve_conflict(p_conflict_id uuid, p_use text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c        app.sync_conflict;
  v_me     uuid;
  v_family uuid;
  v_role   text;
  v_row    jsonb;
  v_applied boolean := false;
  v_seq    bigint;
  v_still  boolean;
begin
  select id, family_id, role into v_me, v_family, v_role
    from app.caregiver
   where auth_user_id = auth.uid() and status = 'active' and deleted_at is null;
  if v_me is null or v_role not in ('admin', 'caregiver') then raise exception 'not_allowed' using errcode = '42501'; end if;
  if p_use is null or p_use not in ('current', 'other') then raise exception 'invalid_choice' using errcode = '22023'; end if;

  select * into c from app.sync_conflict where id = p_conflict_id and family_id = v_family for update;
  if not found then raise exception 'conflict_not_found' using errcode = 'P0001'; end if;
  if c.status = 'resolved' then raise exception 'already_resolved' using errcode = 'P0001'; end if;

  execute format('select to_jsonb(t) from app.%I t where t.id = $1 and t.family_id = $2', c.table_name)
    into v_row using c.row_id, v_family;

  if p_use = 'other' and v_row is not null then
    if c.field_name is not null then
      -- el campo toma el valor alternativo (base = versión actual, por lo que se aplica sin nuevos conflictos)
      perform app._apply_core(v_family, v_me, null, jsonb_build_object(
        'table', c.table_name, 'row_id', c.row_id, 'base_rev', (v_row ->> 'rev')::int,
        'fields', jsonb_build_object(c.field_name, c.alternate_value)));
      v_applied := true;
    elsif c.kind in ('delete_vs_edit', 'edit_after_delete') and (v_row ->> 'deleted_at') is null then
      perform app._apply_core(v_family, v_me, null, jsonb_build_object(
        'table', c.table_name, 'row_id', c.row_id, 'base_rev', (v_row ->> 'rev')::int,
        'fields', '{}'::jsonb, 'delete', true));
      v_applied := true;
    end if;
  end if;

  update app.sync_conflict
     set status = 'resolved', resolved_at = now(), resolved_by = v_me,
         resolution = jsonb_build_object('use', p_use, 'applied', v_applied)
   where id = c.id;

  -- Una sesión sin conflictos de fin abiertos deja de estar marcada
  if c.table_name = 'sleep_session' then
    select exists (
      select 1 from app.sync_conflict
       where table_name = 'sleep_session' and row_id = c.row_id and kind = 'end_time' and status = 'open'
    ) into v_still;
    if not v_still then
      execute format('select to_jsonb(t) from app.%I t where t.id = $1', c.table_name) into v_row using c.row_id;
      if (v_row ->> 'conflict_open')::boolean then
        v_seq := app._next_seq(v_family);
        update app.sleep_session
           set conflict_open = false, rev = rev + 1, change_seq = v_seq, updated_at = now(), updated_by = v_me
         where id = c.row_id;
        perform app._record_revision(v_family, 'sleep_session', c.row_id, jsonb_build_object('conflict_open', false), v_me, null);
      end if;
    end if;
  end if;

  insert into app.audit_log (family_id, actor_auth_uid, event, detail)
  values (v_family, auth.uid(), 'conflict_resolved', jsonb_build_object('conflict_id', c.id, 'use', p_use, 'applied', v_applied));
  return jsonb_build_object('status', 'resolved', 'applied', v_applied);
end $$;

-- Ejecución: lista blanca explícita.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function app.family_role(uuid), app.is_any_admin(),
  app.open_claim(uuid), app.claim_membership(text), app.apply_changes(uuid, timestamptz, jsonb),
  app.invite_caregiver(text, text, text), app.disable_caregiver(uuid),
  app.resolve_conflict(uuid, text) to authenticated;

update app.app_meta set value = '0.7.0' where key = 'schema_version';

-- ================================================================
-- 0008_feeding.sql
-- ================================================================

-- BabySleep · migración 0008 · tomas de comida (contrato v0.3.0)
--
--  * Tabla `feeding`: pecho, biberón o sólidos, con inicio y fin (cronómetro), pecho usado y ml.
--  * Las notas y etiquetas (observation) pueden colgar de una toma: nuevo `feeding_id` y momento 'feeding'.
--  * apply_changes admite la tabla `feeding` y comprueba que `feeding_id` pertenezca a la MISMA familia.
--
-- Las restricciones replican las del contrato: el fin va después del inicio, el pecho solo en tomas de pecho
-- y los ml solo en un biberón. Nada se borra físicamente (borrado lógico, como el resto).

create table app.feeding (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  baby_id          uuid not null references app.baby (id),
  feed_type        text not null check (feed_type in ('breast', 'bottle', 'solids')),
  start_utc        timestamptz not null,
  start_tz         text not null,
  start_quality    text not null default 'exact' check (start_quality in ('exact', 'approx')),
  end_utc          timestamptz,                       -- null = toma en curso
  end_tz           text,
  end_quality      text check (end_quality in ('exact', 'approx')),
  breast_side      text check (breast_side in ('left', 'right', 'both')),
  amount_ml        integer check (amount_ml between 1 and 500),
  source           text not null check (source in ('timer', 'manual', 'import')),
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz,
  check (end_utc is null or end_utc > start_utc),
  check ((end_utc is null) = (end_tz is null)),
  check (breast_side is null or feed_type = 'breast'),
  check (amount_ml is null or feed_type = 'bottle')
);
create index feeding_baby_start_idx on app.feeding (baby_id, start_utc) where deleted_at is null;
create index feeding_open_idx on app.feeding (baby_id) where end_utc is null and deleted_at is null;
create index feeding_sync_idx on app.feeding (family_id, change_seq);

alter table app.feeding enable row level security;
grant select on app.feeding to authenticated;
create policy member_read on app.feeding for select to authenticated
  using (app.family_role(family_id) is not null);

-- Las notas pueden colgar de una toma: exactamente UN destino entre sesión, intento y toma.
alter table app.observation add column feeding_id uuid references app.feeding (id);
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'app.observation'::regclass and contype = 'c'
       and (pg_get_constraintdef(oid) ilike '%session_id IS NULL%' or pg_get_constraintdef(oid) ilike '%moment%')
  loop
    execute format('alter table app.observation drop constraint %I', c.conname);
  end loop;
end $$;
alter table app.observation
  add constraint observation_moment_check check (moment in ('onset', 'during', 'wake', 'settling', 'feeding')),
  add constraint observation_one_target_check check (num_nonnulls(session_id, settling_attempt_id, feeding_id) = 1);
create index observation_feeding_idx on app.observation (feeding_id) where feeding_id is not null;

-- ---------------------------------------------------------------- apply_changes (0005 + feeding)
-- Misma función que en la migración 0005, con `feeding` en la lista blanca de tablas y `feeding_id` en las
-- referencias que deben pertenecer a la misma familia.
create or replace function app._apply_core(p_family uuid, p_cg uuid, p_device uuid, p_op jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_tables  constant text[] := array[
    'baby', 'settling_attempt', 'sleep_session', 'wake_episode', 'tag', 'observation',
    'observation_tag', 'event_category', 'life_event', 'aggregate_period', 'aggregate_item', 'feeding'];
  c_managed constant text[] := array[
    'id', 'family_id', 'rev', 'change_seq', 'created_at', 'updated_at',
    'created_by', 'updated_by', 'origin_device_id', 'deleted_at'];
  c_refs    constant jsonb := '{"baby_id":"baby","session_id":"sleep_session","settling_attempt_id":"settling_attempt",
    "period_id":"aggregate_period","observation_id":"observation","tag_id":"tag",
    "category_id":"event_category","merged_into":"sleep_session","feeding_id":"feeding"}';

  v_table   text    := p_op ->> 'table';
  v_row     uuid    := (p_op ->> 'row_id')::uuid;
  v_base    int     := nullif(p_op ->> 'base_rev', '')::int;
  v_fields  jsonb   := case when (p_op -> 'fields') is null or jsonb_typeof(p_op -> 'fields') = 'null'
                            then '{}'::jsonb else p_op -> 'fields' end;
  v_delete  boolean := coalesce((p_op ->> 'delete')::boolean, false);
  v_restore_req boolean := coalesce((p_op ->> 'restore')::boolean, false);

  v_allowed text[];
  v_k       text;
  v_target  text;
  v_fam     uuid;
  v_cur     jsonb;
  v_old     jsonb;
  v_in      jsonb;
  v_rev     int;
  v_seq     bigint;
  v_tol     int;
  v_apply   text[] := '{}';
  v_conflicts jsonb := '[]';
  v_open    boolean := false;
  v_flag    boolean := false;
  v_restore boolean := false;
  v_do_delete boolean := false;
  v_deleted boolean;
  v_diff    numeric;
  v_cid     uuid;
  v_set     text;
  v_cols    text;
  v_patch   jsonb;
  v_groups  text[];
  v_g       text;
  v_gf      text[];
  v_kk      text;
begin
  if v_table is null or v_table <> all (c_tables) then raise exception 'unknown_table'; end if;
  if v_row is null then raise exception 'bad_row_id'; end if;
  if jsonb_typeof(v_fields) <> 'object' then raise exception 'bad_fields'; end if;
  if v_delete and v_restore_req then raise exception 'delete_and_restore'; end if;

  select array_agg(column_name::text) into v_allowed
    from information_schema.columns
   where table_schema = 'app' and table_name = v_table
     and column_name::text <> all (c_managed)
     and not (v_table = 'sleep_session' and column_name = 'conflict_open');

  for v_k in select jsonb_object_keys(v_fields) loop
    if v_k <> all (v_allowed) then raise exception 'unknown_column: %', v_k; end if;
    v_target := c_refs ->> v_k;
    if v_target is not null and v_fields -> v_k <> 'null'::jsonb then
      execute format('select family_id from app.%I where id = $1', v_target)
        into v_fam using (v_fields ->> v_k)::uuid;
      if v_fam is distinct from p_family then raise exception 'invalid_reference: %', v_k; end if;
    end if;
  end loop;

  execute format('select to_jsonb(jsonb_populate_record(null::app.%I, $1))', v_table) into v_in using v_fields;
  execute format('select to_jsonb(t) from app.%I t where t.id = $1 and t.family_id = $2', v_table)
    into v_cur using v_row, p_family;
  select coalesce((settings ->> 'end_conflict_tolerance_s')::int, 120) into v_tol
    from app.family where id = p_family;

  -- ------------------------------------------------------------------ alta
  if v_cur is null then
    if v_delete or v_restore_req or v_base is not null then raise exception 'row_not_found'; end if;
    v_seq := app._next_seq(p_family);
    v_in := v_fields || jsonb_build_object(
      'id', v_row, 'family_id', p_family, 'rev', 1, 'change_seq', v_seq,
      'created_by', p_cg, 'updated_by', p_cg, 'origin_device_id', p_device);
    select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(v_in) k;
    execute format('insert into app.%I (%s) select %s from jsonb_populate_record(null::app.%I, $1)',
                   v_table, v_cols, v_cols, v_table) using v_in;
    perform app._record_revision(p_family, v_table, v_row, v_fields, p_cg, p_device);
    return jsonb_build_object('status', 'applied', 'rev', 1, 'change_seq', v_seq);
  end if;

  v_rev := (v_cur ->> 'rev')::int;
  v_deleted := (v_cur ->> 'deleted_at') is not null;

  if v_base is null then
    return jsonb_build_object('status', 'noop', 'reason', 'exists', 'rev', v_rev);
  end if;
  if v_base > v_rev then raise exception 'base_rev_ahead'; end if;

  -- ------------------------------------------------- fusión campo a campo
  if v_base < v_rev then
    select snapshot into v_old from app.revision where table_name = v_table and row_id = v_row and rev = v_base;
  end if;

  for v_k in select jsonb_object_keys(v_fields) loop
    if (v_cur -> v_k) is not distinct from (v_in -> v_k) then continue; end if;

    if v_base = v_rev
       or (v_old is not null and (v_cur -> v_k) is not distinct from (v_old -> v_k)) then
      v_apply := v_apply || v_k;                                  -- nadie más lo tocó
    elsif v_table = 'baby' then
      v_apply := v_apply || v_k;                                  -- perfil: último por campo
    elsif v_table = 'sleep_session' and v_k = 'sleep_end_utc'
          and (v_cur ->> v_k) is not null and (v_in ->> v_k) is not null then
      v_diff := abs(extract(epoch from ((v_cur ->> v_k)::timestamptz - (v_in ->> v_k)::timestamptz)));
      if v_diff <= v_tol then
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time_within_tolerance', 'auto', v_cur -> v_k, v_in -> v_k);
      else
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time', 'open', v_cur -> v_k, v_in -> v_k);
        v_open := true;
        v_flag := true;
      end if;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_cid := app._conflict(p_family, v_table, v_row, v_k, 'field', 'open', v_cur -> v_k, v_in -> v_k);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    end if;
  end loop;

  -- ------------------------------------- campos acoplados: juntos o ninguno
  -- Algunos campos solo tienen sentido juntos (el fin de una sesión y su zona; el tipo de toma con el pecho y los
  -- ml). Si otra persona tocó CUALQUIERA de un grupo desde `base_rev`, los cambios de este grupo que traía la
  -- operación no se aplican (quedarían combinaciones imposibles, que la base de datos rechazaría) y cada uno
  -- queda como conflicto abierto, para que una persona decida.
  v_groups := case v_table
    when 'sleep_session' then array['sleep_end_utc,end_tz,end_quality']
    when 'feeding'       then array['feed_type,breast_side,amount_ml', 'end_utc,end_tz,end_quality']
    else array[]::text[]
  end;
  foreach v_g in array v_groups loop
    v_gf := string_to_array(v_g, ',');
    if v_base < v_rev and (v_old is null or exists (
         select 1 from unnest(v_gf) k where (v_cur -> k) is distinct from (v_old -> k))) then
      foreach v_kk in array v_gf loop
        if v_kk = any (v_apply) then
          v_apply := array_remove(v_apply, v_kk);
          v_cid := app._conflict(p_family, v_table, v_row, v_kk, 'field', 'open', v_cur -> v_kk, v_in -> v_kk);
          v_open := true;
          v_conflicts := v_conflicts || to_jsonb(v_cid);
        end if;
      end loop;
    end if;
  end loop;

  -- ------------------------------------------------- restaurar / borrar
  if v_restore_req then
    v_restore := v_deleted;                                        -- restaurar una fila viva es un no-op
  elsif v_deleted and v_base < v_rev and not v_delete and cardinality(v_apply) + jsonb_array_length(v_conflicts) > 0 then
    v_restore := true;                                             -- edición de una fila borrada tras base_rev
    v_open := true;
    v_cid := app._conflict(p_family, v_table, v_row, null, 'edit_after_delete', 'open', v_cur, v_fields);
    v_conflicts := v_conflicts || to_jsonb(v_cid);
  end if;

  if v_delete and not v_deleted then
    if v_base < v_rev then
      v_cid := app._conflict(p_family, v_table, v_row, null, 'delete_vs_edit', 'open', v_cur, null);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_do_delete := true;
    end if;
  end if;

  if cardinality(v_apply) = 0 and not v_restore and not v_flag and not v_do_delete then
    return jsonb_build_object('status', case when v_open then 'conflict' else 'noop' end,
                              'rev', v_rev, 'conflicts', v_conflicts);
  end if;

  v_seq := app._next_seq(p_family);
  select string_agg(format('%I = r.%I', k, k), ', ') into v_set from unnest(v_apply) k;
  v_set := concat_ws(', ', v_set,
                     case when v_flag then 'conflict_open = true' end,
                     case when v_restore then 'deleted_at = null' end,
                     case when v_do_delete then 'deleted_at = now()' end);
  execute format('update app.%I t set %s, rev = t.rev + 1, change_seq = $3, updated_at = now(),
                  updated_by = $4, origin_device_id = $5
                  from jsonb_populate_record(null::app.%I, $1) r where t.id = $2', v_table, v_set, v_table)
    using v_fields, v_row, v_seq, p_cg, p_device;

  select coalesce(jsonb_object_agg(k, v_in -> k), '{}'::jsonb) into v_patch from unnest(v_apply) k;
  if v_do_delete then v_patch := v_patch || '{"deleted": true}'; end if;
  if v_restore then v_patch := v_patch || '{"restored": true}'; end if;
  perform app._record_revision(p_family, v_table, v_row, v_patch, p_cg, p_device);

  return jsonb_build_object(
    'status', case when jsonb_array_length(v_conflicts) = 0 then 'applied' else 'merged' end,
    'rev', v_rev + 1, 'change_seq', v_seq, 'conflicts', v_conflicts);
end $$;

update app.app_meta set value = '0.8.0' where key = 'schema_version';

-- ================================================================
-- 0009_feed_reminders.sql
-- ================================================================

-- BabySleep · migración 0009 · avisos de próxima toma (web push)
--
--  * push_subscription: un registro por móvil que aceptó recibir avisos (la dirección del servicio de avisos
--    del propio dispositivo y sus claves públicas). Los clientes NO leen esta tabla: solo la gestionan por RPC.
--  * feed_reminder: ajustes de la familia (activado + cada cuántos minutos desde el INICIO de la última toma).
--  * feed_reminder_sent: la última toma ya avisada de cada bebé; garantiza UN solo aviso por toma.
--  * claim_due_feed_reminders: la llama la función programada (rol service_role). Reclama de forma atómica las
--    tomas que ya tocan y devuelve a quién avisar. Solo avisa si la toma que tocaba lo hizo en las últimas 3 h
--    (al reactivar los avisos no llega uno de una toma antigua) y nunca por una toma en curso (cronómetro).

create table app.push_subscription (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references app.family (id),
  caregiver_id uuid not null references app.caregiver (id),
  endpoint     text not null unique check (endpoint like 'https://%' and length(endpoint) <= 2048),
  p256dh       text not null check (length(p256dh) between 1 and 512),
  auth         text not null check (length(auth) between 1 and 512),
  failures     integer not null default 0,
  created_at   timestamptz not null default now()
);
create index push_subscription_family_idx on app.push_subscription (family_id);
alter table app.push_subscription enable row level security;   -- sin políticas: ningún cliente la lee

create table app.feed_reminder (
  family_id    uuid primary key references app.family (id),
  enabled      boolean not null default false,
  interval_min integer not null default 180 check (interval_min between 30 and 720),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references app.caregiver (id)
);
alter table app.feed_reminder enable row level security;
grant select on app.feed_reminder to authenticated;
create policy member_read on app.feed_reminder for select to authenticated
  using (app.family_role(family_id) is not null);

create table app.feed_reminder_sent (
  baby_id    uuid primary key references app.baby (id),
  feeding_id uuid not null,
  sent_at    timestamptz not null default now()
);
alter table app.feed_reminder_sent enable row level security;  -- solo el servicio

-- ---------------------------------------------------------------- RPC de los móviles

-- Quien puede registrar (admin o cuidador) pertenece a la familia: devuelve (id, familia) o lanza not_allowed.
create function app._reminder_actor() returns app.caregiver
language plpgsql stable security definer set search_path = '' as $$
declare v_cg app.caregiver;
begin
  select * into v_cg from app.caregiver
   where auth_user_id = auth.uid() and status = 'active' and deleted_at is null
     and role in ('admin', 'caregiver');
  if not found then raise exception 'not_allowed' using errcode = '42501'; end if;
  return v_cg;
end $$;

create function app.register_push(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_cg app.caregiver := app._reminder_actor();
begin
  if coalesce(p_endpoint, '') not like 'https://%' or length(p_endpoint) > 2048 then
    raise exception 'invalid_endpoint' using errcode = '22023';
  end if;
  if coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'invalid_keys' using errcode = '22023';
  end if;
  -- La misma dirección de un móvil puede pasar de una persona a otra: se reasigna y se reinicia el contador de fallos.
  insert into app.push_subscription (family_id, caregiver_id, endpoint, p256dh, auth)
  values (v_cg.family_id, v_cg.id, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set family_id = excluded.family_id, caregiver_id = excluded.caregiver_id,
        p256dh = excluded.p256dh, auth = excluded.auth, failures = 0;
  insert into app.audit_log (family_id, actor_auth_uid, event, detail)
  values (v_cg.family_id, auth.uid(), 'push_registered', jsonb_build_object('caregiver_id', v_cg.id));
end $$;

create function app.unregister_push(p_endpoint text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_cg app.caregiver := app._reminder_actor();
begin
  delete from app.push_subscription where endpoint = p_endpoint and family_id = v_cg.family_id;
end $$;

create function app.set_feed_reminder(p_enabled boolean, p_interval_min integer) returns void
language plpgsql security definer set search_path = '' as $$
declare v_cg app.caregiver := app._reminder_actor();
begin
  if p_interval_min is null or p_interval_min < 30 or p_interval_min > 720 then
    raise exception 'invalid_interval' using errcode = '22023';
  end if;
  insert into app.feed_reminder (family_id, enabled, interval_min, updated_by)
  values (v_cg.family_id, coalesce(p_enabled, false), p_interval_min, v_cg.id)
  on conflict (family_id) do update
    set enabled = excluded.enabled, interval_min = excluded.interval_min, updated_at = now(), updated_by = excluded.updated_by;
end $$;

-- ---------------------------------------------------------------- servicio (función programada)

create type app.due_reminder as (
  subscription_id uuid, endpoint text, p256dh text, auth text,
  baby_id uuid, baby_alias text, feeding_id uuid, interval_min integer, last_start_utc timestamptz
);

create function app.claim_due_feed_reminders(p_now timestamptz default now()) returns setof app.due_reminder
language sql security definer set search_path = '' as $$
  with last_f as (
    select distinct on (f.baby_id) f.baby_id, f.family_id, f.id, f.start_utc, f.end_utc, f.source
      from app.feeding f
     where f.deleted_at is null
     order by f.baby_id, f.start_utc desc
  ), due as (
    select l.baby_id, l.family_id, l.id as feeding_id, l.start_utc, r.interval_min, b.alias
      from last_f l
      join app.feed_reminder r on r.family_id = l.family_id and r.enabled
      join app.baby b on b.id = l.baby_id and b.deleted_at is null
     where not (l.end_utc is null and l.source = 'timer')
       and l.start_utc + make_interval(mins => r.interval_min) <= p_now
       and l.start_utc + make_interval(mins => r.interval_min) > p_now - interval '3 hours'
  ), claimed as (
    insert into app.feed_reminder_sent as s (baby_id, feeding_id, sent_at)
    select d.baby_id, d.feeding_id, p_now from due d
    on conflict (baby_id) do update set feeding_id = excluded.feeding_id, sent_at = excluded.sent_at
      where s.feeding_id <> excluded.feeding_id
    returning s.baby_id, s.feeding_id
  )
  select ps.id, ps.endpoint, ps.p256dh, ps.auth, d.baby_id, d.alias, d.feeding_id, d.interval_min, d.start_utc
    from claimed c
    join due d on d.baby_id = c.baby_id and d.feeding_id = c.feeding_id
    join app.push_subscription ps on ps.family_id = d.family_id and ps.failures < 5
$$;

-- Resultado de un envío: una dirección que ya no existe (404/410) se borra; otros fallos se cuentan.
create function app.report_push_result(p_subscription_id uuid, p_ok boolean, p_gone boolean default false) returns void
language sql security definer set search_path = '' as $$
  with del as (
    delete from app.push_subscription where id = p_subscription_id and p_gone returning id
  )
  update app.push_subscription
     set failures = case when p_ok then 0 else failures + 1 end
   where id = p_subscription_id and not p_gone
$$;

-- Ejecución: lista blanca explícita (ver 0002). El servicio usa el rol service_role.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function app.family_role(uuid), app.is_any_admin(),
  app.open_claim(uuid), app.claim_membership(text), app.apply_changes(uuid, timestamptz, jsonb),
  app.invite_caregiver(text, text, text), app.disable_caregiver(uuid),
  app.resolve_conflict(uuid, text),
  app.register_push(text, text, text), app.unregister_push(text), app.set_feed_reminder(boolean, integer)
  to authenticated;

grant usage on schema app to service_role;
grant execute on function app.claim_due_feed_reminders(timestamptz), app.report_push_result(uuid, boolean, boolean)
  to service_role;

update app.app_meta set value = '0.9.0' where key = 'schema_version';

-- ================================================================
-- 0010_awakenings.sql
-- ================================================================

-- BabySleep · migración 0010 · despertares nocturnos (contrato v0.4.0)
--
--  * Tabla `awakening`: cada despertar de un sueño NOCTURNO, con inicio y fin (cronómetro o manual) y un motivo
--    opcional. Sin fin = en curso (cronómetro) o duración desconocida (manual): nunca se inventa un fin.
--  * `baby.awakening_threshold_min`: desde cuántos minutos un despertar se descuenta del sueño (null = 30).
--    Es una columna del perfil, así que se sincroniza como el resto del perfil (último cambio por campo).
--  * apply_changes admite la tabla `awakening` (misma función que en 0008) y su fin va acoplado a su zona y calidad.
--
-- Que la sesión sea nocturna lo comprueba la app: es una regla entre dos tablas y no una restricción de fila.

create table app.awakening (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  baby_id          uuid not null references app.baby (id),
  session_id       uuid not null references app.sleep_session (id),
  start_utc        timestamptz not null,
  start_tz         text not null,
  start_quality    text not null default 'exact' check (start_quality in ('exact', 'approx')),
  end_utc          timestamptz,                       -- null = en curso (timer) o duración desconocida (manual)
  end_tz           text,
  end_quality      text check (end_quality in ('exact', 'approx')),
  reason           text check (reason in ('feeding', 'diaper', 'crying', 'other')),
  source           text not null check (source in ('timer', 'manual', 'import')),
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz,
  check (end_utc is null or end_utc > start_utc),
  check ((end_utc is null) = (end_tz is null))
);
create index awakening_session_idx on app.awakening (session_id) where deleted_at is null;
create index awakening_baby_start_idx on app.awakening (baby_id, start_utc) where deleted_at is null;
create index awakening_sync_idx on app.awakening (family_id, change_seq);

alter table app.awakening enable row level security;
grant select on app.awakening to authenticated;
create policy member_read on app.awakening for select to authenticated
  using (app.family_role(family_id) is not null);

alter table app.baby add column awakening_threshold_min smallint check (awakening_threshold_min between 5 and 180);

-- ---------------------------------------------------------------- apply_changes (0008 + awakening)
create or replace function app._apply_core(p_family uuid, p_cg uuid, p_device uuid, p_op jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_tables  constant text[] := array[
    'baby', 'settling_attempt', 'sleep_session', 'wake_episode', 'tag', 'observation',
    'observation_tag', 'event_category', 'life_event', 'aggregate_period', 'aggregate_item', 'feeding', 'awakening'];
  c_managed constant text[] := array[
    'id', 'family_id', 'rev', 'change_seq', 'created_at', 'updated_at',
    'created_by', 'updated_by', 'origin_device_id', 'deleted_at'];
  c_refs    constant jsonb := '{"baby_id":"baby","session_id":"sleep_session","settling_attempt_id":"settling_attempt",
    "period_id":"aggregate_period","observation_id":"observation","tag_id":"tag",
    "category_id":"event_category","merged_into":"sleep_session","feeding_id":"feeding"}';

  v_table   text    := p_op ->> 'table';
  v_row     uuid    := (p_op ->> 'row_id')::uuid;
  v_base    int     := nullif(p_op ->> 'base_rev', '')::int;
  v_fields  jsonb   := case when (p_op -> 'fields') is null or jsonb_typeof(p_op -> 'fields') = 'null'
                            then '{}'::jsonb else p_op -> 'fields' end;
  v_delete  boolean := coalesce((p_op ->> 'delete')::boolean, false);
  v_restore_req boolean := coalesce((p_op ->> 'restore')::boolean, false);

  v_allowed text[];
  v_k       text;
  v_target  text;
  v_fam     uuid;
  v_cur     jsonb;
  v_old     jsonb;
  v_in      jsonb;
  v_rev     int;
  v_seq     bigint;
  v_tol     int;
  v_apply   text[] := '{}';
  v_conflicts jsonb := '[]';
  v_open    boolean := false;
  v_flag    boolean := false;
  v_restore boolean := false;
  v_do_delete boolean := false;
  v_deleted boolean;
  v_diff    numeric;
  v_cid     uuid;
  v_set     text;
  v_cols    text;
  v_patch   jsonb;
  v_groups  text[];
  v_g       text;
  v_gf      text[];
  v_kk      text;
begin
  if v_table is null or v_table <> all (c_tables) then raise exception 'unknown_table'; end if;
  if v_row is null then raise exception 'bad_row_id'; end if;
  if jsonb_typeof(v_fields) <> 'object' then raise exception 'bad_fields'; end if;
  if v_delete and v_restore_req then raise exception 'delete_and_restore'; end if;

  select array_agg(column_name::text) into v_allowed
    from information_schema.columns
   where table_schema = 'app' and table_name = v_table
     and column_name::text <> all (c_managed)
     and not (v_table = 'sleep_session' and column_name = 'conflict_open');

  for v_k in select jsonb_object_keys(v_fields) loop
    if v_k <> all (v_allowed) then raise exception 'unknown_column: %', v_k; end if;
    v_target := c_refs ->> v_k;
    if v_target is not null and v_fields -> v_k <> 'null'::jsonb then
      execute format('select family_id from app.%I where id = $1', v_target)
        into v_fam using (v_fields ->> v_k)::uuid;
      if v_fam is distinct from p_family then raise exception 'invalid_reference: %', v_k; end if;
    end if;
  end loop;

  execute format('select to_jsonb(jsonb_populate_record(null::app.%I, $1))', v_table) into v_in using v_fields;
  execute format('select to_jsonb(t) from app.%I t where t.id = $1 and t.family_id = $2', v_table)
    into v_cur using v_row, p_family;
  select coalesce((settings ->> 'end_conflict_tolerance_s')::int, 120) into v_tol
    from app.family where id = p_family;

  -- ------------------------------------------------------------------ alta
  if v_cur is null then
    if v_delete or v_restore_req or v_base is not null then raise exception 'row_not_found'; end if;
    v_seq := app._next_seq(p_family);
    v_in := v_fields || jsonb_build_object(
      'id', v_row, 'family_id', p_family, 'rev', 1, 'change_seq', v_seq,
      'created_by', p_cg, 'updated_by', p_cg, 'origin_device_id', p_device);
    select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(v_in) k;
    execute format('insert into app.%I (%s) select %s from jsonb_populate_record(null::app.%I, $1)',
                   v_table, v_cols, v_cols, v_table) using v_in;
    perform app._record_revision(p_family, v_table, v_row, v_fields, p_cg, p_device);
    return jsonb_build_object('status', 'applied', 'rev', 1, 'change_seq', v_seq);
  end if;

  v_rev := (v_cur ->> 'rev')::int;
  v_deleted := (v_cur ->> 'deleted_at') is not null;

  if v_base is null then
    return jsonb_build_object('status', 'noop', 'reason', 'exists', 'rev', v_rev);
  end if;
  if v_base > v_rev then raise exception 'base_rev_ahead'; end if;

  -- ------------------------------------------------- fusión campo a campo
  if v_base < v_rev then
    select snapshot into v_old from app.revision where table_name = v_table and row_id = v_row and rev = v_base;
  end if;

  for v_k in select jsonb_object_keys(v_fields) loop
    if (v_cur -> v_k) is not distinct from (v_in -> v_k) then continue; end if;

    if v_base = v_rev
       or (v_old is not null and (v_cur -> v_k) is not distinct from (v_old -> v_k)) then
      v_apply := v_apply || v_k;                                  -- nadie más lo tocó
    elsif v_table = 'baby' then
      v_apply := v_apply || v_k;                                  -- perfil: último por campo
    elsif v_table = 'sleep_session' and v_k = 'sleep_end_utc'
          and (v_cur ->> v_k) is not null and (v_in ->> v_k) is not null then
      v_diff := abs(extract(epoch from ((v_cur ->> v_k)::timestamptz - (v_in ->> v_k)::timestamptz)));
      if v_diff <= v_tol then
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time_within_tolerance', 'auto', v_cur -> v_k, v_in -> v_k);
      else
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time', 'open', v_cur -> v_k, v_in -> v_k);
        v_open := true;
        v_flag := true;
      end if;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_cid := app._conflict(p_family, v_table, v_row, v_k, 'field', 'open', v_cur -> v_k, v_in -> v_k);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    end if;
  end loop;

  -- ------------------------------------- campos acoplados: juntos o ninguno
  -- Algunos campos solo tienen sentido juntos (el fin de una sesión y su zona; el tipo de toma con el pecho y los
  -- ml). Si otra persona tocó CUALQUIERA de un grupo desde `base_rev`, los cambios de este grupo que traía la
  -- operación no se aplican (quedarían combinaciones imposibles, que la base de datos rechazaría) y cada uno
  -- queda como conflicto abierto, para que una persona decida.
  v_groups := case v_table
    when 'sleep_session' then array['sleep_end_utc,end_tz,end_quality']
    when 'feeding'       then array['feed_type,breast_side,amount_ml', 'end_utc,end_tz,end_quality']
    when 'awakening'     then array['end_utc,end_tz,end_quality']
    else array[]::text[]
  end;
  foreach v_g in array v_groups loop
    v_gf := string_to_array(v_g, ',');
    if v_base < v_rev and (v_old is null or exists (
         select 1 from unnest(v_gf) k where (v_cur -> k) is distinct from (v_old -> k))) then
      foreach v_kk in array v_gf loop
        if v_kk = any (v_apply) then
          v_apply := array_remove(v_apply, v_kk);
          v_cid := app._conflict(p_family, v_table, v_row, v_kk, 'field', 'open', v_cur -> v_kk, v_in -> v_kk);
          v_open := true;
          v_conflicts := v_conflicts || to_jsonb(v_cid);
        end if;
      end loop;
    end if;
  end loop;

  -- ------------------------------------------------- restaurar / borrar
  if v_restore_req then
    v_restore := v_deleted;                                        -- restaurar una fila viva es un no-op
  elsif v_deleted and v_base < v_rev and not v_delete and cardinality(v_apply) + jsonb_array_length(v_conflicts) > 0 then
    v_restore := true;                                             -- edición de una fila borrada tras base_rev
    v_open := true;
    v_cid := app._conflict(p_family, v_table, v_row, null, 'edit_after_delete', 'open', v_cur, v_fields);
    v_conflicts := v_conflicts || to_jsonb(v_cid);
  end if;

  if v_delete and not v_deleted then
    if v_base < v_rev then
      v_cid := app._conflict(p_family, v_table, v_row, null, 'delete_vs_edit', 'open', v_cur, null);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_do_delete := true;
    end if;
  end if;

  if cardinality(v_apply) = 0 and not v_restore and not v_flag and not v_do_delete then
    return jsonb_build_object('status', case when v_open then 'conflict' else 'noop' end,
                              'rev', v_rev, 'conflicts', v_conflicts);
  end if;

  v_seq := app._next_seq(p_family);
  select string_agg(format('%I = r.%I', k, k), ', ') into v_set from unnest(v_apply) k;
  v_set := concat_ws(', ', v_set,
                     case when v_flag then 'conflict_open = true' end,
                     case when v_restore then 'deleted_at = null' end,
                     case when v_do_delete then 'deleted_at = now()' end);
  execute format('update app.%I t set %s, rev = t.rev + 1, change_seq = $3, updated_at = now(),
                  updated_by = $4, origin_device_id = $5
                  from jsonb_populate_record(null::app.%I, $1) r where t.id = $2', v_table, v_set, v_table)
    using v_fields, v_row, v_seq, p_cg, p_device;

  select coalesce(jsonb_object_agg(k, v_in -> k), '{}'::jsonb) into v_patch from unnest(v_apply) k;
  if v_do_delete then v_patch := v_patch || '{"deleted": true}'; end if;
  if v_restore then v_patch := v_patch || '{"restored": true}'; end if;
  perform app._record_revision(p_family, v_table, v_row, v_patch, p_cg, p_device);

  return jsonb_build_object(
    'status', case when jsonb_array_length(v_conflicts) = 0 then 'applied' else 'merged' end,
    'rev', v_rev + 1, 'change_seq', v_seq, 'conflicts', v_conflicts);
end $$;

update app.app_meta set value = '0.10.0' where key = 'schema_version';

-- ================================================================
-- 0011_health_vaccines.sql
-- ================================================================

-- BabySleep · migración 0011 · ficha de salud y vacunas (contrato v0.5.0)
--
--  * Ficha de salud: nuevas columnas de texto en `baby` (pediatra, enfermera, centro de salud, hospital de nacimiento,
--    alergias, notas de salud y CIPA). Viajan como el resto del perfil (último cambio por campo), así que no hace falta
--    tocar la lógica de fusión. Todas son opcionales: `null` = no consta.
--  * Tabla `vaccination`: solo HECHOS (vacuna puesta o «no procede»). Lo previsto se calcula en la app del calendario
--    oficial y la fecha de nacimiento. `dose_key` (`ANTÍGENO@hito`) enlaza con la dosis del calendario; es null en una
--    vacuna fuera de calendario.
--  * apply_changes admite la tabla `vaccination` (misma función que en 0010).
--
-- Los datos de salud se leen con las mismas reglas que el resto: solo miembros de la familia (RLS).

alter table app.baby
  add column pediatrician           text check (char_length(pediatrician) <= 120),
  add column nurse                  text check (char_length(nurse) <= 120),
  add column health_center_name     text check (char_length(health_center_name) <= 160),
  add column health_center_address  text check (char_length(health_center_address) <= 240),
  add column health_center_phone    text check (char_length(health_center_phone) <= 40),
  add column birth_hospital         text check (char_length(birth_hospital) <= 160),
  add column allergies              text check (char_length(allergies) <= 500),
  add column health_notes           text check (char_length(health_notes) <= 2000),
  add column cipa                   text check (char_length(cipa) <= 40);

create table app.vaccination (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  baby_id          uuid not null references app.baby (id),
  dose_key         text check (char_length(dose_key) between 1 and 60),
  vaccine          text not null check (char_length(vaccine) between 1 and 120),
  status           text not null check (status in ('given', 'not_applicable')),
  given_on         date,
  center           text check (char_length(center) <= 160),
  lot              text check (char_length(lot) <= 60),
  notes            text check (char_length(notes) <= 500),
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz,
  check (status <> 'given' or given_on is not null)
);
create index vaccination_baby_idx on app.vaccination (baby_id, dose_key) where deleted_at is null;
create index vaccination_sync_idx on app.vaccination (family_id, change_seq);

alter table app.vaccination enable row level security;
grant select on app.vaccination to authenticated;
create policy member_read on app.vaccination for select to authenticated
  using (app.family_role(family_id) is not null);

-- ---------------------------------------------------------------- apply_changes (0010 + vaccination)
create or replace function app._apply_core(p_family uuid, p_cg uuid, p_device uuid, p_op jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_tables  constant text[] := array[
    'baby', 'settling_attempt', 'sleep_session', 'wake_episode', 'tag', 'observation',
    'observation_tag', 'event_category', 'life_event', 'aggregate_period', 'aggregate_item', 'feeding', 'awakening',
    'vaccination'];
  c_managed constant text[] := array[
    'id', 'family_id', 'rev', 'change_seq', 'created_at', 'updated_at',
    'created_by', 'updated_by', 'origin_device_id', 'deleted_at'];
  c_refs    constant jsonb := '{"baby_id":"baby","session_id":"sleep_session","settling_attempt_id":"settling_attempt",
    "period_id":"aggregate_period","observation_id":"observation","tag_id":"tag",
    "category_id":"event_category","merged_into":"sleep_session","feeding_id":"feeding"}';

  v_table   text    := p_op ->> 'table';
  v_row     uuid    := (p_op ->> 'row_id')::uuid;
  v_base    int     := nullif(p_op ->> 'base_rev', '')::int;
  v_fields  jsonb   := case when (p_op -> 'fields') is null or jsonb_typeof(p_op -> 'fields') = 'null'
                            then '{}'::jsonb else p_op -> 'fields' end;
  v_delete  boolean := coalesce((p_op ->> 'delete')::boolean, false);
  v_restore_req boolean := coalesce((p_op ->> 'restore')::boolean, false);

  v_allowed text[];
  v_k       text;
  v_target  text;
  v_fam     uuid;
  v_cur     jsonb;
  v_old     jsonb;
  v_in      jsonb;
  v_rev     int;
  v_seq     bigint;
  v_tol     int;
  v_apply   text[] := '{}';
  v_conflicts jsonb := '[]';
  v_open    boolean := false;
  v_flag    boolean := false;
  v_restore boolean := false;
  v_do_delete boolean := false;
  v_deleted boolean;
  v_diff    numeric;
  v_cid     uuid;
  v_set     text;
  v_cols    text;
  v_patch   jsonb;
  v_groups  text[];
  v_g       text;
  v_gf      text[];
  v_kk      text;
begin
  if v_table is null or v_table <> all (c_tables) then raise exception 'unknown_table'; end if;
  if v_row is null then raise exception 'bad_row_id'; end if;
  if jsonb_typeof(v_fields) <> 'object' then raise exception 'bad_fields'; end if;
  if v_delete and v_restore_req then raise exception 'delete_and_restore'; end if;

  select array_agg(column_name::text) into v_allowed
    from information_schema.columns
   where table_schema = 'app' and table_name = v_table
     and column_name::text <> all (c_managed)
     and not (v_table = 'sleep_session' and column_name = 'conflict_open');

  for v_k in select jsonb_object_keys(v_fields) loop
    if v_k <> all (v_allowed) then raise exception 'unknown_column: %', v_k; end if;
    v_target := c_refs ->> v_k;
    if v_target is not null and v_fields -> v_k <> 'null'::jsonb then
      execute format('select family_id from app.%I where id = $1', v_target)
        into v_fam using (v_fields ->> v_k)::uuid;
      if v_fam is distinct from p_family then raise exception 'invalid_reference: %', v_k; end if;
    end if;
  end loop;

  execute format('select to_jsonb(jsonb_populate_record(null::app.%I, $1))', v_table) into v_in using v_fields;
  execute format('select to_jsonb(t) from app.%I t where t.id = $1 and t.family_id = $2', v_table)
    into v_cur using v_row, p_family;
  select coalesce((settings ->> 'end_conflict_tolerance_s')::int, 120) into v_tol
    from app.family where id = p_family;

  -- ------------------------------------------------------------------ alta
  if v_cur is null then
    if v_delete or v_restore_req or v_base is not null then raise exception 'row_not_found'; end if;
    v_seq := app._next_seq(p_family);
    v_in := v_fields || jsonb_build_object(
      'id', v_row, 'family_id', p_family, 'rev', 1, 'change_seq', v_seq,
      'created_by', p_cg, 'updated_by', p_cg, 'origin_device_id', p_device);
    select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(v_in) k;
    execute format('insert into app.%I (%s) select %s from jsonb_populate_record(null::app.%I, $1)',
                   v_table, v_cols, v_cols, v_table) using v_in;
    perform app._record_revision(p_family, v_table, v_row, v_fields, p_cg, p_device);
    return jsonb_build_object('status', 'applied', 'rev', 1, 'change_seq', v_seq);
  end if;

  v_rev := (v_cur ->> 'rev')::int;
  v_deleted := (v_cur ->> 'deleted_at') is not null;

  if v_base is null then
    return jsonb_build_object('status', 'noop', 'reason', 'exists', 'rev', v_rev);
  end if;
  if v_base > v_rev then raise exception 'base_rev_ahead'; end if;

  -- ------------------------------------------------- fusión campo a campo
  if v_base < v_rev then
    select snapshot into v_old from app.revision where table_name = v_table and row_id = v_row and rev = v_base;
  end if;

  for v_k in select jsonb_object_keys(v_fields) loop
    if (v_cur -> v_k) is not distinct from (v_in -> v_k) then continue; end if;

    if v_base = v_rev
       or (v_old is not null and (v_cur -> v_k) is not distinct from (v_old -> v_k)) then
      v_apply := v_apply || v_k;                                  -- nadie más lo tocó
    elsif v_table = 'baby' then
      v_apply := v_apply || v_k;                                  -- perfil: último por campo
    elsif v_table = 'sleep_session' and v_k = 'sleep_end_utc'
          and (v_cur ->> v_k) is not null and (v_in ->> v_k) is not null then
      v_diff := abs(extract(epoch from ((v_cur ->> v_k)::timestamptz - (v_in ->> v_k)::timestamptz)));
      if v_diff <= v_tol then
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time_within_tolerance', 'auto', v_cur -> v_k, v_in -> v_k);
      else
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time', 'open', v_cur -> v_k, v_in -> v_k);
        v_open := true;
        v_flag := true;
      end if;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_cid := app._conflict(p_family, v_table, v_row, v_k, 'field', 'open', v_cur -> v_k, v_in -> v_k);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    end if;
  end loop;

  -- ------------------------------------- campos acoplados: juntos o ninguno
  -- Algunos campos solo tienen sentido juntos (el fin de una sesión y su zona; el tipo de toma con el pecho y los
  -- ml). Si otra persona tocó CUALQUIERA de un grupo desde `base_rev`, los cambios de este grupo que traía la
  -- operación no se aplican (quedarían combinaciones imposibles, que la base de datos rechazaría) y cada uno
  -- queda como conflicto abierto, para que una persona decida.
  v_groups := case v_table
    when 'sleep_session' then array['sleep_end_utc,end_tz,end_quality']
    when 'feeding'       then array['feed_type,breast_side,amount_ml', 'end_utc,end_tz,end_quality']
    when 'awakening'     then array['end_utc,end_tz,end_quality']
    else array[]::text[]
  end;
  foreach v_g in array v_groups loop
    v_gf := string_to_array(v_g, ',');
    if v_base < v_rev and (v_old is null or exists (
         select 1 from unnest(v_gf) k where (v_cur -> k) is distinct from (v_old -> k))) then
      foreach v_kk in array v_gf loop
        if v_kk = any (v_apply) then
          v_apply := array_remove(v_apply, v_kk);
          v_cid := app._conflict(p_family, v_table, v_row, v_kk, 'field', 'open', v_cur -> v_kk, v_in -> v_kk);
          v_open := true;
          v_conflicts := v_conflicts || to_jsonb(v_cid);
        end if;
      end loop;
    end if;
  end loop;

  -- ------------------------------------------------- restaurar / borrar
  if v_restore_req then
    v_restore := v_deleted;                                        -- restaurar una fila viva es un no-op
  elsif v_deleted and v_base < v_rev and not v_delete and cardinality(v_apply) + jsonb_array_length(v_conflicts) > 0 then
    v_restore := true;                                             -- edición de una fila borrada tras base_rev
    v_open := true;
    v_cid := app._conflict(p_family, v_table, v_row, null, 'edit_after_delete', 'open', v_cur, v_fields);
    v_conflicts := v_conflicts || to_jsonb(v_cid);
  end if;

  if v_delete and not v_deleted then
    if v_base < v_rev then
      v_cid := app._conflict(p_family, v_table, v_row, null, 'delete_vs_edit', 'open', v_cur, null);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_do_delete := true;
    end if;
  end if;

  if cardinality(v_apply) = 0 and not v_restore and not v_flag and not v_do_delete then
    return jsonb_build_object('status', case when v_open then 'conflict' else 'noop' end,
                              'rev', v_rev, 'conflicts', v_conflicts);
  end if;

  v_seq := app._next_seq(p_family);
  select string_agg(format('%I = r.%I', k, k), ', ') into v_set from unnest(v_apply) k;
  v_set := concat_ws(', ', v_set,
                     case when v_flag then 'conflict_open = true' end,
                     case when v_restore then 'deleted_at = null' end,
                     case when v_do_delete then 'deleted_at = now()' end);
  execute format('update app.%I t set %s, rev = t.rev + 1, change_seq = $3, updated_at = now(),
                  updated_by = $4, origin_device_id = $5
                  from jsonb_populate_record(null::app.%I, $1) r where t.id = $2', v_table, v_set, v_table)
    using v_fields, v_row, v_seq, p_cg, p_device;

  select coalesce(jsonb_object_agg(k, v_in -> k), '{}'::jsonb) into v_patch from unnest(v_apply) k;
  if v_do_delete then v_patch := v_patch || '{"deleted": true}'; end if;
  if v_restore then v_patch := v_patch || '{"restored": true}'; end if;
  perform app._record_revision(p_family, v_table, v_row, v_patch, p_cg, p_device);

  return jsonb_build_object(
    'status', case when jsonb_array_length(v_conflicts) = 0 then 'applied' else 'merged' end,
    'rev', v_rev + 1, 'change_seq', v_seq, 'conflicts', v_conflicts);
end $$;

update app.app_meta set value = '0.11.0' where key = 'schema_version';

-- ================================================================
-- 0012_appointments.sql
-- ================================================================

-- BabySleep · migración 0012 · citas médicas y avisos (contrato v0.6.0)
--
--  * Tabla `appointment`: cita médica o de vacunación (tipo, título, hora UTC con su zona, duración, lugar, notas,
--    estado) y `remind_before_min`: los avisos por notificación, en minutos antes del inicio (0 = a la hora; máx. 5,
--    hasta 4 semanas). Se sincroniza como el resto de filas.
--  * appointment_reminder_sent: qué aviso (cita + antelación) ya se envió; garantiza UN solo envío por aviso aunque la
--    función programada se ejecute varias veces. Solo la usa el servicio.
--  * claim_due_appointment_reminders: la llama la función programada (rol service_role). Reclama de forma atómica los
--    avisos que ya tocan y devuelve a qué móviles enviarlos. Un aviso solo se envía si su hora de salida cayó en las
--    últimas 2 h (al activar los avisos no llega uno de una cita pasada) y la cita no empezó hace más de 1 h. Las
--    citas hechas, canceladas o eliminadas no avisan.
--  * apply_changes admite la tabla `appointment` (misma función que en 0011).

create table app.appointment (
  id               uuid primary key,
  family_id        uuid not null references app.family (id),
  baby_id          uuid not null references app.baby (id),
  kind             text not null check (kind in ('pediatrician', 'nurse', 'vaccination', 'specialist', 'test', 'other')),
  title            text not null check (char_length(title) between 1 and 160),
  start_utc        timestamptz not null,
  start_tz         text not null,
  duration_min     smallint check (duration_min between 5 and 720),
  place            text check (char_length(place) <= 240),
  notes            text check (char_length(notes) <= 1000),
  status           text not null default 'scheduled' check (status in ('scheduled', 'done', 'cancelled')),
  remind_before_min integer[] not null default '{}'
    check (coalesce(cardinality(remind_before_min), 0) <= 5 and 0 <= all (remind_before_min) and 40320 >= all (remind_before_min)),
  rev              integer not null default 1,
  change_seq       bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references app.caregiver (id),
  updated_by       uuid references app.caregiver (id),
  origin_device_id uuid,
  deleted_at       timestamptz
);
create index appointment_baby_start_idx on app.appointment (baby_id, start_utc) where deleted_at is null;
create index appointment_due_idx on app.appointment (start_utc) where deleted_at is null and status = 'scheduled';
create index appointment_sync_idx on app.appointment (family_id, change_seq);

alter table app.appointment enable row level security;
grant select on app.appointment to authenticated;
create policy member_read on app.appointment for select to authenticated
  using (app.family_role(family_id) is not null);

create table app.appointment_reminder_sent (
  appointment_id uuid not null references app.appointment (id),
  minutes_before integer not null,
  sent_at        timestamptz not null default now(),
  primary key (appointment_id, minutes_before)
);
alter table app.appointment_reminder_sent enable row level security;   -- solo el servicio

create type app.due_appointment_reminder as (
  subscription_id uuid, endpoint text, p256dh text, auth text,
  appointment_id uuid, baby_id uuid, baby_alias text, title text, kind text,
  start_utc timestamptz, start_tz text, place text, minutes_before integer
);

create function app.claim_due_appointment_reminders(p_now timestamptz default now()) returns setof app.due_appointment_reminder
language sql security definer set search_path = '' as $$
  with cand as (
    select a.id, a.family_id, a.baby_id, a.title, a.kind, a.start_utc, a.start_tz, a.place, m.minutes_before
      from app.appointment a
     cross join lateral (select distinct x as minutes_before from unnest(a.remind_before_min) x) m
     where a.deleted_at is null and a.status = 'scheduled'
       and a.start_utc + interval '1 hour' > p_now
       and a.start_utc - make_interval(mins => m.minutes_before) <= p_now
       and a.start_utc - make_interval(mins => m.minutes_before) > p_now - interval '2 hours'
  ), claimed as (
    insert into app.appointment_reminder_sent (appointment_id, minutes_before, sent_at)
    select c.id, c.minutes_before, p_now from cand c
    on conflict (appointment_id, minutes_before) do nothing
    returning appointment_id, minutes_before
  )
  select ps.id, ps.endpoint, ps.p256dh, ps.auth, c.id, c.baby_id, b.alias, c.title, c.kind, c.start_utc, c.start_tz, c.place, c.minutes_before
    from claimed k
    join cand c on c.id = k.appointment_id and c.minutes_before = k.minutes_before
    join app.baby b on b.id = c.baby_id and b.deleted_at is null
    join app.push_subscription ps on ps.family_id = c.family_id and ps.failures < 5
$$;

revoke all on function app.claim_due_appointment_reminders(timestamptz) from public, anon, authenticated;
grant execute on function app.claim_due_appointment_reminders(timestamptz) to service_role;

-- ---------------------------------------------------------------- apply_changes (0011 + appointment)
create or replace function app._apply_core(p_family uuid, p_cg uuid, p_device uuid, p_op jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_tables  constant text[] := array[
    'baby', 'settling_attempt', 'sleep_session', 'wake_episode', 'tag', 'observation',
    'observation_tag', 'event_category', 'life_event', 'aggregate_period', 'aggregate_item', 'feeding', 'awakening',
    'vaccination', 'appointment'];
  c_managed constant text[] := array[
    'id', 'family_id', 'rev', 'change_seq', 'created_at', 'updated_at',
    'created_by', 'updated_by', 'origin_device_id', 'deleted_at'];
  c_refs    constant jsonb := '{"baby_id":"baby","session_id":"sleep_session","settling_attempt_id":"settling_attempt",
    "period_id":"aggregate_period","observation_id":"observation","tag_id":"tag",
    "category_id":"event_category","merged_into":"sleep_session","feeding_id":"feeding"}';

  v_table   text    := p_op ->> 'table';
  v_row     uuid    := (p_op ->> 'row_id')::uuid;
  v_base    int     := nullif(p_op ->> 'base_rev', '')::int;
  v_fields  jsonb   := case when (p_op -> 'fields') is null or jsonb_typeof(p_op -> 'fields') = 'null'
                            then '{}'::jsonb else p_op -> 'fields' end;
  v_delete  boolean := coalesce((p_op ->> 'delete')::boolean, false);
  v_restore_req boolean := coalesce((p_op ->> 'restore')::boolean, false);

  v_allowed text[];
  v_k       text;
  v_target  text;
  v_fam     uuid;
  v_cur     jsonb;
  v_old     jsonb;
  v_in      jsonb;
  v_rev     int;
  v_seq     bigint;
  v_tol     int;
  v_apply   text[] := '{}';
  v_conflicts jsonb := '[]';
  v_open    boolean := false;
  v_flag    boolean := false;
  v_restore boolean := false;
  v_do_delete boolean := false;
  v_deleted boolean;
  v_diff    numeric;
  v_cid     uuid;
  v_set     text;
  v_cols    text;
  v_patch   jsonb;
  v_groups  text[];
  v_g       text;
  v_gf      text[];
  v_kk      text;
begin
  if v_table is null or v_table <> all (c_tables) then raise exception 'unknown_table'; end if;
  if v_row is null then raise exception 'bad_row_id'; end if;
  if jsonb_typeof(v_fields) <> 'object' then raise exception 'bad_fields'; end if;
  if v_delete and v_restore_req then raise exception 'delete_and_restore'; end if;

  select array_agg(column_name::text) into v_allowed
    from information_schema.columns
   where table_schema = 'app' and table_name = v_table
     and column_name::text <> all (c_managed)
     and not (v_table = 'sleep_session' and column_name = 'conflict_open');

  for v_k in select jsonb_object_keys(v_fields) loop
    if v_k <> all (v_allowed) then raise exception 'unknown_column: %', v_k; end if;
    v_target := c_refs ->> v_k;
    if v_target is not null and v_fields -> v_k <> 'null'::jsonb then
      execute format('select family_id from app.%I where id = $1', v_target)
        into v_fam using (v_fields ->> v_k)::uuid;
      if v_fam is distinct from p_family then raise exception 'invalid_reference: %', v_k; end if;
    end if;
  end loop;

  execute format('select to_jsonb(jsonb_populate_record(null::app.%I, $1))', v_table) into v_in using v_fields;
  execute format('select to_jsonb(t) from app.%I t where t.id = $1 and t.family_id = $2', v_table)
    into v_cur using v_row, p_family;
  select coalesce((settings ->> 'end_conflict_tolerance_s')::int, 120) into v_tol
    from app.family where id = p_family;

  -- ------------------------------------------------------------------ alta
  if v_cur is null then
    if v_delete or v_restore_req or v_base is not null then raise exception 'row_not_found'; end if;
    v_seq := app._next_seq(p_family);
    v_in := v_fields || jsonb_build_object(
      'id', v_row, 'family_id', p_family, 'rev', 1, 'change_seq', v_seq,
      'created_by', p_cg, 'updated_by', p_cg, 'origin_device_id', p_device);
    select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(v_in) k;
    execute format('insert into app.%I (%s) select %s from jsonb_populate_record(null::app.%I, $1)',
                   v_table, v_cols, v_cols, v_table) using v_in;
    perform app._record_revision(p_family, v_table, v_row, v_fields, p_cg, p_device);
    return jsonb_build_object('status', 'applied', 'rev', 1, 'change_seq', v_seq);
  end if;

  v_rev := (v_cur ->> 'rev')::int;
  v_deleted := (v_cur ->> 'deleted_at') is not null;

  if v_base is null then
    return jsonb_build_object('status', 'noop', 'reason', 'exists', 'rev', v_rev);
  end if;
  if v_base > v_rev then raise exception 'base_rev_ahead'; end if;

  -- ------------------------------------------------- fusión campo a campo
  if v_base < v_rev then
    select snapshot into v_old from app.revision where table_name = v_table and row_id = v_row and rev = v_base;
  end if;

  for v_k in select jsonb_object_keys(v_fields) loop
    if (v_cur -> v_k) is not distinct from (v_in -> v_k) then continue; end if;

    if v_base = v_rev
       or (v_old is not null and (v_cur -> v_k) is not distinct from (v_old -> v_k)) then
      v_apply := v_apply || v_k;                                  -- nadie más lo tocó
    elsif v_table = 'baby' then
      v_apply := v_apply || v_k;                                  -- perfil: último por campo
    elsif v_table = 'sleep_session' and v_k = 'sleep_end_utc'
          and (v_cur ->> v_k) is not null and (v_in ->> v_k) is not null then
      v_diff := abs(extract(epoch from ((v_cur ->> v_k)::timestamptz - (v_in ->> v_k)::timestamptz)));
      if v_diff <= v_tol then
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time_within_tolerance', 'auto', v_cur -> v_k, v_in -> v_k);
      else
        v_cid := app._conflict(p_family, v_table, v_row, v_k, 'end_time', 'open', v_cur -> v_k, v_in -> v_k);
        v_open := true;
        v_flag := true;
      end if;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_cid := app._conflict(p_family, v_table, v_row, v_k, 'field', 'open', v_cur -> v_k, v_in -> v_k);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    end if;
  end loop;

  -- ------------------------------------- campos acoplados: juntos o ninguno
  -- Algunos campos solo tienen sentido juntos (el fin de una sesión y su zona; el tipo de toma con el pecho y los
  -- ml). Si otra persona tocó CUALQUIERA de un grupo desde `base_rev`, los cambios de este grupo que traía la
  -- operación no se aplican (quedarían combinaciones imposibles, que la base de datos rechazaría) y cada uno
  -- queda como conflicto abierto, para que una persona decida.
  v_groups := case v_table
    when 'sleep_session' then array['sleep_end_utc,end_tz,end_quality']
    when 'feeding'       then array['feed_type,breast_side,amount_ml', 'end_utc,end_tz,end_quality']
    when 'awakening'     then array['end_utc,end_tz,end_quality']
    else array[]::text[]
  end;
  foreach v_g in array v_groups loop
    v_gf := string_to_array(v_g, ',');
    if v_base < v_rev and (v_old is null or exists (
         select 1 from unnest(v_gf) k where (v_cur -> k) is distinct from (v_old -> k))) then
      foreach v_kk in array v_gf loop
        if v_kk = any (v_apply) then
          v_apply := array_remove(v_apply, v_kk);
          v_cid := app._conflict(p_family, v_table, v_row, v_kk, 'field', 'open', v_cur -> v_kk, v_in -> v_kk);
          v_open := true;
          v_conflicts := v_conflicts || to_jsonb(v_cid);
        end if;
      end loop;
    end if;
  end loop;

  -- ------------------------------------------------- restaurar / borrar
  if v_restore_req then
    v_restore := v_deleted;                                        -- restaurar una fila viva es un no-op
  elsif v_deleted and v_base < v_rev and not v_delete and cardinality(v_apply) + jsonb_array_length(v_conflicts) > 0 then
    v_restore := true;                                             -- edición de una fila borrada tras base_rev
    v_open := true;
    v_cid := app._conflict(p_family, v_table, v_row, null, 'edit_after_delete', 'open', v_cur, v_fields);
    v_conflicts := v_conflicts || to_jsonb(v_cid);
  end if;

  if v_delete and not v_deleted then
    if v_base < v_rev then
      v_cid := app._conflict(p_family, v_table, v_row, null, 'delete_vs_edit', 'open', v_cur, null);
      v_open := true;
      v_conflicts := v_conflicts || to_jsonb(v_cid);
    else
      v_do_delete := true;
    end if;
  end if;

  if cardinality(v_apply) = 0 and not v_restore and not v_flag and not v_do_delete then
    return jsonb_build_object('status', case when v_open then 'conflict' else 'noop' end,
                              'rev', v_rev, 'conflicts', v_conflicts);
  end if;

  v_seq := app._next_seq(p_family);
  select string_agg(format('%I = r.%I', k, k), ', ') into v_set from unnest(v_apply) k;
  v_set := concat_ws(', ', v_set,
                     case when v_flag then 'conflict_open = true' end,
                     case when v_restore then 'deleted_at = null' end,
                     case when v_do_delete then 'deleted_at = now()' end);
  execute format('update app.%I t set %s, rev = t.rev + 1, change_seq = $3, updated_at = now(),
                  updated_by = $4, origin_device_id = $5
                  from jsonb_populate_record(null::app.%I, $1) r where t.id = $2', v_table, v_set, v_table)
    using v_fields, v_row, v_seq, p_cg, p_device;

  select coalesce(jsonb_object_agg(k, v_in -> k), '{}'::jsonb) into v_patch from unnest(v_apply) k;
  if v_do_delete then v_patch := v_patch || '{"deleted": true}'; end if;
  if v_restore then v_patch := v_patch || '{"restored": true}'; end if;
  perform app._record_revision(p_family, v_table, v_row, v_patch, p_cg, p_device);

  return jsonb_build_object(
    'status', case when jsonb_array_length(v_conflicts) = 0 then 'applied' else 'merged' end,
    'rev', v_rev + 1, 'change_seq', v_seq, 'conflicts', v_conflicts);
end $$;

update app.app_meta set value = '0.12.0' where key = 'schema_version';
