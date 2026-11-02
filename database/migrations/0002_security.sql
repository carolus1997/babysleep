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
