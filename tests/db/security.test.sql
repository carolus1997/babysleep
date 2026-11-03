-- Pruebas de seguridad (migración 0002) en SQL plano, sin extensiones.
-- Ejecutar tras tests/db/00_supabase_shim.sql y las migraciones:
--   psql -v ON_ERROR_STOP=1 -f tests/db/security.test.sql
-- Todo corre dentro de una transacción que se revierte al final. Cualquier fallo
-- lanza una excepción y detiene el script (código de salida != 0).

\set ON_ERROR_STOP on
begin;

create schema tests;
grant usage on schema tests to public;

create function tests.assert(cond boolean, name text) returns void
language plpgsql as $$
begin
  if cond is not true then raise exception 'FALLA: %', name; end if;
  raise notice 'ok - %', name;
end $$;

create function tests.as_user(uid uuid, mail text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'email', mail)::text, true);
  execute 'set local role authenticated';
end $$;

create function tests.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
end $$;

create function tests.as_superuser() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ------------------------------------------------------------------ fixtures
-- Usuarios de auth (uid): admin A, admin B, y uno por cada escenario de alta.
--   admin A  a0000000-0000-4000-8000-000000000001   admin-a@example.test
--   admin B  b0000000-0000-4000-8000-000000000001   admin-b@example.test

select set_config('t.code_a', app.bootstrap_family('Familia A', 'Admin A', 'admin-a@example.test'), true);
select set_config('t.code_b', app.bootstrap_family('Familia B', 'Admin B', 'admin-b@example.test'), true);

select tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
select tests.assert(app.claim_membership(current_setting('t.code_a')) ->> 'status' = 'ok', 'fixture: el admin A canjea su código');
select tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
select tests.assert(app.claim_membership(current_setting('t.code_b')) ->> 'status' = 'ok', 'fixture: el admin B canjea su código');
select tests.as_superuser();

insert into app.caregiver (id, family_id, display_name, email_normalized, role, status)
select gen_random_uuid(), f.id, v.n, v.e, v.r, 'invited'
from (values
  ('Familia A', 'Lock',    'lock@example.test',    'caregiver'),
  ('Familia A', 'Exp',     'exp@example.test',     'caregiver'),
  ('Familia A', 'Ok',      'ok@example.test',      'caregiver'),
  ('Familia A', 'Wrong',   'wrong@example.test',   'caregiver'),
  ('Familia B', 'AdminA2', 'admin-a@example.test', 'caregiver')   -- mismo correo, otra familia
) as v(fam, n, e, r)
join app.family f on f.name = v.fam;

insert into app.baby (id, family_id, alias, birth_date)
select gen_random_uuid(), f.id, 'Bebé ' || right(f.name, 1), date '2026-07-01' from app.family f;

-- ============================================================================
-- T01 · anon no puede leer ni llamar nada
do $$
declare ok boolean;
begin
  perform tests.as_anon();
  begin perform 1 from app.baby; ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T01a anon no puede leer app.baby');
  begin perform app.claim_membership('x'); ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T01b anon no puede llamar claim_membership');
  perform tests.as_superuser();
end $$;

-- T02 · usuario autenticado sin vincular: no ve nada
do $$
declare n int; m int;
begin
  perform tests.as_user('99999999-0000-4000-8000-000000000001', 'nadie@example.test');
  select count(*) into n from app.baby;
  select count(*) into m from app.family;
  perform tests.as_superuser();
  perform tests.assert(n = 0 and m = 0, 'T02 un usuario sin vincular no ve datos');
end $$;

-- T03 · cada miembro ve solo su familia
do $$
declare a text; b text;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  select string_agg(alias, ',') into a from app.baby;
  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  select string_agg(alias, ',') into b from app.baby;
  perform tests.as_superuser();
  perform tests.assert(a = 'Bebé A' and b = 'Bebé B', 'T03 aislamiento entre familias');
end $$;

-- T04 · los clientes no escriben directamente (ni escalan su rol)
do $$
declare ok boolean;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  begin
    insert into app.baby (id, family_id, alias, birth_date)
      select gen_random_uuid(), id, 'X', date '2026-01-01' from app.family limit 1;
    ok := false;
  exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T04a INSERT directo denegado');
  begin update app.baby set alias = 'Hack'; ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T04b UPDATE directo denegado');
  begin delete from app.baby; ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T04c DELETE directo denegado');
  begin update app.caregiver set role = 'admin'; ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T04d no se puede cambiar el rol de un cuidador');
  perform tests.as_superuser();
end $$;

-- T05 · tablas internas inaccesibles para clientes
do $$
declare ok boolean;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  begin perform 1 from app.membership_claim; ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T05a membership_claim ilegible');
  begin perform 1 from app.applied_op; ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T05b applied_op ilegible');
  begin perform 1 from app.app_meta; ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T05c app_meta ilegible');
  perform tests.as_superuser();
end $$;

-- T06 · bloqueo tras 5 intentos fallidos, aunque luego llegue el código correcto
do $$
declare
  v_id uuid; v_code text; r jsonb; i int; v_attempts int; v_reason text; v_linked uuid;
begin
  select id into v_id from app.caregiver where email_normalized = 'lock@example.test';
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  v_code := app.open_claim(v_id);

  perform tests.as_user('c0000000-0000-4000-8000-000000000001', 'lock@example.test');
  for i in 1..4 loop
    r := app.claim_membership('codigo-incorrecto');
    perform tests.assert(r ->> 'status' = 'invalid', 'T06a intento ' || i || ' inválido');
  end loop;
  r := app.claim_membership('codigo-incorrecto');
  perform tests.assert(r ->> 'status' = 'locked', 'T06b el quinto fallo bloquea la ventana');
  r := app.claim_membership(v_code);
  perform tests.assert(r ->> 'status' = 'no_window', 'T06c el código correcto ya no sirve tras el bloqueo');

  perform tests.as_superuser();
  select attempts, close_reason into v_attempts, v_reason from app.membership_claim where caregiver_id = v_id;
  select auth_user_id into v_linked from app.caregiver where id = v_id;
  perform tests.assert(v_attempts = 5 and v_reason = 'locked' and v_linked is null, 'T06d estado final: 5 intentos, locked, sin vincular');
end $$;

-- T07 · el código correcto no sirve a otra persona (correo distinto)
do $$
declare v_id uuid; v_code text; r jsonb; v_linked uuid;
begin
  select id into v_id from app.caregiver where email_normalized = 'wrong@example.test';
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  v_code := app.open_claim(v_id);
  perform tests.as_user('d0000000-0000-4000-8000-000000000001', 'intruso@example.test');
  r := app.claim_membership(v_code);
  perform tests.as_superuser();
  select auth_user_id into v_linked from app.caregiver where id = v_id;
  perform tests.assert(r ->> 'status' = 'no_window' and v_linked is null, 'T07 un intruso con el código no se vincula');
end $$;

-- T08 · la ventana caduca (30 min)
do $$
declare v_id uuid; v_code text; r jsonb; v_linked uuid;
begin
  select id into v_id from app.caregiver where email_normalized = 'exp@example.test';
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  v_code := app.open_claim(v_id);
  perform tests.as_superuser();
  update app.membership_claim set expires_at = now() - interval '1 minute' where caregiver_id = v_id;
  perform tests.as_user('e0000000-0000-4000-8000-000000000001', 'exp@example.test');
  r := app.claim_membership(v_code);
  perform tests.as_superuser();
  select auth_user_id into v_linked from app.caregiver where id = v_id;
  perform tests.assert(r ->> 'status' = 'expired' and v_linked is null, 'T08 un código caducado no se acepta');
end $$;

-- T09 · alta correcta: vincula, es de un solo uso y da acceso a los datos de la familia
do $$
declare v_id uuid; v_code text; r jsonb; n int; v_status text; v_linked uuid;
begin
  select id into v_id from app.caregiver where email_normalized = 'ok@example.test';
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  v_code := app.open_claim(v_id);

  perform tests.as_user('f0000000-0000-4000-8000-000000000001', 'OK@example.test ');  -- el correo se normaliza
  select count(*) into n from app.baby;
  perform tests.assert(n = 0, 'T09a antes de canjear no ve datos');
  r := app.claim_membership(v_code);
  perform tests.assert(r ->> 'status' = 'ok', 'T09b canje correcto');
  select count(*) into n from app.baby;
  perform tests.assert(n = 1, 'T09c tras canjear ve los datos de su familia');
  r := app.claim_membership(v_code);
  perform tests.assert(r ->> 'status' = 'no_window', 'T09d el código es de un solo uso');

  perform tests.as_superuser();
  select status, auth_user_id into v_status, v_linked from app.caregiver where id = v_id;
  perform tests.assert(v_status = 'active' and v_linked = 'f0000000-0000-4000-8000-000000000001', 'T09e cuidador activo y vinculado');
end $$;

-- T10 · solo un admin de la MISMA familia abre ventanas
do $$
declare v_wrong uuid; ok boolean;
begin
  select id into v_wrong from app.caregiver where email_normalized = 'wrong@example.test';

  perform tests.as_user('f0000000-0000-4000-8000-000000000001', 'ok@example.test');   -- cuidador, no admin
  begin perform app.open_claim(v_wrong); ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T10a un cuidador no abre ventanas');

  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');  -- admin de OTRA familia
  begin perform app.open_claim(v_wrong); ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T10b el admin de otra familia no abre ventanas');
  perform tests.as_superuser();
end $$;

-- T11 · una cuenta ya vinculada no puede vincularse a un segundo cuidador
do $$
declare v_id uuid; v_code text; r jsonb; v_linked uuid; v_status text;
begin
  select c.id into v_id from app.caregiver c join app.family f on f.id = c.family_id
   where f.name = 'Familia B' and c.email_normalized = 'admin-a@example.test';
  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  v_code := app.open_claim(v_id);

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');  -- ya es admin de A
  r := app.claim_membership(v_code);
  perform tests.as_superuser();
  select auth_user_id, status into v_linked, v_status from app.caregiver where id = v_id;
  perform tests.assert(r ->> 'status' = 'already_linked' and v_linked is null and v_status = 'invited', 'T11 no se vincula una cuenta a dos cuidadores');
end $$;

-- T12 · un cuidador desactivado pierde el acceso
do $$
declare n int;
begin
  update app.caregiver set status = 'disabled' where email_normalized = 'ok@example.test';
  perform tests.as_user('f0000000-0000-4000-8000-000000000001', 'ok@example.test');
  select count(*) into n from app.baby;
  perform tests.as_superuser();
  perform tests.assert(n = 0, 'T12 un cuidador desactivado no ve datos');
end $$;

-- T13 · las funciones privilegiadas no son llamables por clientes
do $$
declare ok boolean;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  begin perform app.bootstrap_family('Intrusa', 'X', 'x@example.test'); ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T13a bootstrap_family no es llamable');
  begin perform app._new_claim(gen_random_uuid(), null); ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T13b _new_claim no es llamable');
  perform tests.as_superuser();
end $$;

-- T14 · el código no se guarda en claro; la auditoría existe y solo la ve un admin
do $$
declare v_code text; n int; a int; c int;
begin
  v_code := current_setting('t.code_a');
  select count(*) into n from app.membership_claim m where m::text like '%' || v_code || '%';
  perform tests.assert(n = 0, 'T14a el código en claro no aparece en membership_claim');
  select count(*) into n from app.audit_log al where al::text like '%' || v_code || '%';
  perform tests.assert(n = 0, 'T14b el código en claro no aparece en audit_log');
  select count(*) into n from app.audit_log where event = 'claim_ok';
  perform tests.assert(n >= 3, 'T14c la auditoría registra los canjes correctos');

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  select count(*) into a from app.audit_log;
  perform tests.as_user('f0000000-0000-4000-8000-000000000001', 'ok@example.test');
  select count(*) into c from app.audit_log;
  perform tests.as_superuser();
  perform tests.assert(a > 0 and c = 0, 'T14d solo un admin ve la auditoría');
end $$;

-- T15 · invitar a un cuidador (0006): código de un solo uso, correo normalizado y acceso tras canjearlo
do $$
declare v_code text; r jsonb; n int; v_role text; v_status text;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  v_code := app.invite_caregiver('Nuevo', '  NUEVO@Example.test ', 'caregiver');
  perform tests.assert(length(v_code) = 64, 'T15a la invitación devuelve un código de alta');
  perform tests.as_superuser();
  select role, status into v_role, v_status from app.caregiver where email_normalized = 'nuevo@example.test';
  perform tests.assert(v_role = 'caregiver' and v_status = 'invited', 'T15b queda invitado y con el correo normalizado');

  perform tests.as_user('10000000-0000-4000-8000-000000000001', 'nuevo@example.test');
  r := app.claim_membership(v_code);
  select count(*) into n from app.baby;
  perform tests.as_superuser();
  perform tests.assert(r ->> 'status' = 'ok' and n = 1, 'T15c el invitado canjea el código y ve los datos de su familia');
end $$;

-- T16 · solo un admin invita; validaciones; aislamiento entre familias
do $$
declare ok boolean; v_code text; v_fam text;
begin
  perform tests.as_user('10000000-0000-4000-8000-000000000001', 'nuevo@example.test');      -- cuidador, no admin
  begin perform app.invite_caregiver('X', 'x@example.test'); ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T16a un cuidador no puede invitar');
  begin perform app.disable_caregiver(gen_random_uuid()); ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T16b un cuidador no puede retirar accesos');

  perform tests.as_anon();
  begin perform app.invite_caregiver('X', 'x@example.test'); ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'T16c anon no puede invitar');

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  begin perform app.invite_caregiver('   ', 'x@example.test'); ok := false; exception when sqlstate '22023' then ok := true; end;
  perform tests.assert(ok, 'T16d nombre vacío rechazado');
  begin perform app.invite_caregiver('X', 'no-es-un-correo'); ok := false; exception when sqlstate '22023' then ok := true; end;
  perform tests.assert(ok, 'T16e correo inválido rechazado');
  begin perform app.invite_caregiver('X', 'x@example.test', 'admin'); ok := false; exception when sqlstate '22023' then ok := true; end;
  perform tests.assert(ok, 'T16f no se puede invitar a otro administrador desde la app');
  begin perform app.invite_caregiver('Otra', 'admin-a@example.test'); ok := false; exception when sqlstate 'P0001' then ok := true; end;
  perform tests.assert(ok, 'T16g no se re-invita a quien ya es miembro activo');

  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  v_code := app.invite_caregiver('Abuela', 'abuela@example.test', 'viewer');
  perform tests.as_superuser();
  select f.name into v_fam from app.caregiver c join app.family f on f.id = c.family_id where c.email_normalized = 'abuela@example.test';
  perform tests.assert(v_fam = 'Familia B', 'T16h la invitación va a la familia de quien invita, nunca a otra');
end $$;

-- T17 · retirar acceso y re-invitar
do $$
declare v_id uuid; v_me uuid; v_code text; r jsonb; n int; ok boolean;
begin
  select id into v_id from app.caregiver where email_normalized = 'nuevo@example.test';
  select id into v_me from app.caregiver where auth_user_id = 'a0000000-0000-4000-8000-000000000001';

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  begin perform app.disable_caregiver(v_me); ok := false; exception when sqlstate 'P0001' then ok := true; end;
  perform tests.assert(ok, 'T17a un admin no puede retirarse el acceso a sí mismo');

  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  begin perform app.disable_caregiver(v_id); ok := false; exception when sqlstate 'P0001' then ok := true; end;
  perform tests.assert(ok, 'T17b el admin de otra familia no puede tocar a tus cuidadores');

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform app.disable_caregiver(v_id);
  perform tests.as_user('10000000-0000-4000-8000-000000000001', 'nuevo@example.test');
  select count(*) into n from app.baby;
  perform tests.assert(n = 0, 'T17c el cuidador desactivado pierde el acceso');

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  v_code := app.invite_caregiver('Nuevo', 'nuevo@example.test');
  perform tests.as_user('10000000-0000-4000-8000-000000000001', 'nuevo@example.test');
  r := app.claim_membership(v_code);
  select count(*) into n from app.baby;
  perform tests.assert(r ->> 'status' = 'ok' and n = 1, 'T17d tras re-invitarlo y canjear el código recupera el acceso');

  perform tests.as_superuser();
  select count(*) into n from app.audit_log where event in ('caregiver_invited', 'caregiver_disabled');
  perform tests.assert(n = 4, 'T17e las invitaciones y las bajas quedan en la auditoría');
end $$;

rollback;
