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
