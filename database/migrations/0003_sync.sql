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
