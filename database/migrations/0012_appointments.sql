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
