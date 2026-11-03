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
