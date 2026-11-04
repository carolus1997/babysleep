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
