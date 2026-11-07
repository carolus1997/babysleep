-- Pruebas de sincronización (migración 0003): apply_changes, conflictos, historial.
-- Ejecutar tras el shim y las migraciones:
--   psql -v ON_ERROR_STOP=1 -f tests/db/sync.test.sql
-- Todo dentro de una transacción que se revierte; un fallo detiene el script.

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

-- uuid determinista a partir de un entero
create function tests.u(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- construye una operación con op_id nuevo
create function tests.op(tbl text, row_n int, base int, fields jsonb, del boolean default false) returns jsonb
language sql as $$
  select jsonb_build_object('op_id', gen_random_uuid(), 'table', tbl, 'row_id', tests.u(row_n),
                            'base_rev', base, 'fields', fields, 'delete', del)
$$;

-- aplica UNA operación con el usuario actual y devuelve su resultado
create function tests.go(op jsonb) returns jsonb
language sql as $$
  select app.apply_changes(tests.u(900), now(), jsonb_build_array(op)) -> 'results' -> 0
$$;

-- da de alta a un cuidador ya invitado: el admin abre la ventana y él la canjea
create function tests.enroll(admin_uid uuid, admin_mail text, cg_mail text, cg_uid uuid) returns void
language plpgsql as $$
declare v_id uuid; v_code text;
begin
  perform tests.as_superuser();
  select id into v_id from app.caregiver where email_normalized = cg_mail;
  perform tests.as_user(admin_uid, admin_mail);
  v_code := app.open_claim(v_id);
  perform tests.as_user(cg_uid, cg_mail);
  perform tests.assert(app.claim_membership(v_code) ->> 'status' = 'ok', 'fixture: alta de ' || cg_mail);
  perform tests.as_superuser();
end $$;

-- ------------------------------------------------------------------ fixtures
--   admin A a0..01 · cuidador (papá) A a0..02 · lector A a0..03 · admin B b0..01
select set_config('t.code_a', app.bootstrap_family('Familia A', 'Admin A', 'admin-a@example.test'), true);
select set_config('t.code_b', app.bootstrap_family('Familia B', 'Admin B', 'admin-b@example.test'), true);

select tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
select tests.assert(app.claim_membership(current_setting('t.code_a')) ->> 'status' = 'ok', 'fixture: admin A');
select tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
select tests.assert(app.claim_membership(current_setting('t.code_b')) ->> 'status' = 'ok', 'fixture: admin B');
select tests.as_superuser();

insert into app.caregiver (id, family_id, display_name, email_normalized, role, status)
select gen_random_uuid(), f.id, v.n, v.e, v.r, 'invited'
from (values
  ('Familia A', 'Papa',   'papa@example.test',   'caregiver'),
  ('Familia A', 'Lector', 'lector@example.test', 'viewer')
) as v(fam, n, e, r)
join app.family f on f.name = v.fam;

select tests.enroll('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test', 'papa@example.test',   'a0000000-0000-4000-8000-000000000002');
select tests.enroll('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test', 'lector@example.test', 'a0000000-0000-4000-8000-000000000003');

-- ids: bebé A = 1, bebé B = 2, sesiones = 10..
-- ============================================================================
-- S01 · alta: aplica, asigna rev 1 y change_seq, y deja revisión
do $$
declare r jsonb; v_fam uuid; v_rev int; v_cg uuid; v_cnt int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('baby', 1, null, '{"alias":"Bebé A","birth_date":"2026-07-01"}'));
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 1 and (r ->> 'change_seq')::bigint >= 1, 'S01a alta aplicada con rev 1');

  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  r := tests.go(tests.op('baby', 2, null, '{"alias":"Bebé B","birth_date":"2026-08-01"}'));
  perform tests.assert(r ->> 'status' = 'applied', 'S01b alta del bebé B');

  perform tests.as_superuser();
  select b.family_id, b.rev, b.created_by into v_fam, v_rev, v_cg from app.baby b where b.id = tests.u(1);
  perform tests.assert(v_fam = (select id from app.family where name = 'Familia A') and v_cg is not null,
                       'S01c la familia y el autor salen de la sesión');
  select count(*) into v_cnt from app.revision where row_id = tests.u(1) and rev = 1;
  perform tests.assert(v_cnt = 1, 'S01d queda la revisión inicial');
end $$;

-- S02 · idempotencia: repetir la misma op no duplica ni consume change_seq
do $$
declare v_op jsonb; r1 jsonb; r2 jsonb; s1 bigint; s2 bigint; n int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  v_op := tests.op('sleep_session', 10, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual'));
  r1 := tests.go(v_op);
  perform tests.as_superuser();
  select change_seq into s1 from app.family_counter where family_id = (select id from app.family where name = 'Familia A');
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r2 := tests.go(v_op);
  perform tests.as_superuser();
  select change_seq into s2 from app.family_counter where family_id = (select id from app.family where name = 'Familia A');
  select count(*) into n from app.sleep_session where id = tests.u(10);
  perform tests.assert(r1 ->> 'status' = 'applied' and (r2 ->> 'replayed')::boolean and s1 = s2 and n = 1,
                       'S02 una op repetida se aplica una sola vez');
end $$;

-- S03 · quién puede sincronizar
do $$
declare ok boolean;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000003', 'lector@example.test');   -- viewer
  begin perform tests.go(tests.op('baby', 3, null, '{"alias":"X","birth_date":"2026-01-01"}')); ok := false;
  exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'S03a un lector no escribe');

  perform tests.as_user('99999999-0000-4000-8000-000000000001', 'nadie@example.test');    -- sin vincular
  begin perform tests.go(tests.op('baby', 3, null, '{"alias":"X","birth_date":"2026-01-01"}')); ok := false;
  exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'S03b un usuario sin vincular no escribe');

  perform tests.as_anon();
  begin perform tests.go(tests.op('baby', 3, null, '{"alias":"X","birth_date":"2026-01-01"}')); ok := false;
  exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'S03c anon no escribe');
  perform tests.as_superuser();
end $$;

-- S04 · una referencia a otra familia se rechaza
do $$
declare r jsonb; n int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('sleep_session', 11, null, jsonb_build_object(
    'baby_id', tests.u(2), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));      -- baby 2 es de la familia B
  perform tests.as_superuser();
  select count(*) into n from app.sleep_session where id = tests.u(11);
  perform tests.assert(r ->> 'status' = 'rejected' and r ->> 'reason' like 'invalid_reference%' and n = 0,
                       'S04 no se puede colgar una fila de un bebé de otra familia');
end $$;

-- S05 · el cliente no fija columnas gestionadas por el servidor
do $$
declare r jsonb;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('baby', 3, null, jsonb_build_object('alias', 'X', 'birth_date', '2026-01-01', 'family_id', tests.u(777))));
  perform tests.assert(r ->> 'reason' like 'unknown_column%', 'S05a family_id no es enviable');
  r := tests.go(tests.op('baby', 3, null, '{"alias":"X","birth_date":"2026-01-01","rev":99}'));
  perform tests.assert(r ->> 'reason' like 'unknown_column%', 'S05b rev no es enviable');
  r := tests.go(tests.op('sleep_session', 10, 1, '{"conflict_open":true}'));
  perform tests.assert(r ->> 'reason' like 'unknown_column%', 'S05c conflict_open lo fija solo el servidor');
  r := tests.go(tests.op('family', 3, null, '{"name":"X"}'));
  perform tests.assert(r ->> 'reason' = 'unknown_table', 'S05d solo las tablas de la lista blanca');
  perform tests.as_superuser();
end $$;

-- S06 + S07 · edición secuencial y fusión de campos distintos
do $$
declare r jsonb; v_type text; v_aw text; v_rev int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('sleep_session', 10, 1, '{"sleep_type":"nap"}'));
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 2, 'S06 edición con base_rev vigente');

  -- ambos parten de rev 2; papá cambia el tipo, mamá la completitud
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  r := tests.go(tests.op('sleep_session', 10, 2, '{"sleep_type":"night"}'));
  perform tests.assert(r ->> 'status' = 'applied', 'S07a primera edición');
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('sleep_session', 10, 2, '{"awakenings_completeness":"partial"}'));   -- base obsoleta
  perform tests.assert(r ->> 'status' = 'applied', 'S07b edición de otro campo con base obsoleta se fusiona');
  perform tests.as_superuser();
  select sleep_type, awakenings_completeness, rev into v_type, v_aw, v_rev from app.sleep_session where id = tests.u(10);
  perform tests.assert(v_type = 'night' and v_aw = 'partial' and v_rev = 4, 'S07c ambos cambios conviven');
end $$;

-- S08 · mismo fin, diferencia dentro de la tolerancia: gana el primero, queda traza 'auto'
do $$
declare r jsonb; v_end timestamptz; v_flag boolean; n int; v_alt text;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform tests.go(tests.op('sleep_session', 12, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  r := tests.go(tests.op('sleep_session', 12, 1,
    '{"sleep_end_utc":"2027-01-15T05:00:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact"}'));
  perform tests.assert(r ->> 'status' = 'applied', 'S08a papá cierra la sesión');
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('sleep_session', 12, 1,
    '{"sleep_end_utc":"2027-01-15T05:01:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact"}'));  -- +60 s
  perform tests.as_superuser();
  select sleep_end_utc, conflict_open into v_end, v_flag from app.sleep_session where id = tests.u(12);
  select count(*), max(alternate_value #>> '{}') into n, v_alt from app.sync_conflict
   where row_id = tests.u(12) and kind = 'end_time_within_tolerance' and status = 'auto';
  perform tests.assert(v_end = '2027-01-15T05:00:00Z' and v_flag = false and n = 1 and v_alt like '2027-01-15T05:01:00%',
                       'S08b dentro de tolerancia: se conserva el primero, alternativo guardado, sin revisión obligatoria');
end $$;

-- S09 · mismo fin, diferencia mayor: gana el primero y la sesión queda en conflicto abierto
do $$
declare r jsonb; v_end timestamptz; v_flag boolean; n int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform tests.go(tests.op('sleep_session', 13, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  perform tests.go(tests.op('sleep_session', 13, 1,
    '{"sleep_end_utc":"2027-01-15T05:00:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact"}'));
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('sleep_session', 13, 1,
    '{"sleep_end_utc":"2027-01-15T05:10:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact"}'));  -- +10 min
  perform tests.assert(r ->> 'status' = 'merged', 'S09a el resultado avisa del conflicto');
  perform tests.as_superuser();
  select sleep_end_utc, conflict_open into v_end, v_flag from app.sleep_session where id = tests.u(13);
  select count(*) into n from app.sync_conflict where row_id = tests.u(13) and kind = 'end_time' and status = 'open';
  perform tests.assert(v_end = '2027-01-15T05:00:00Z' and v_flag = true and n = 1,
                       'S09b fuera de tolerancia: conserva el primero, conflict_open y conflicto abierto');
end $$;

-- S10 · edición vs borrado: la fila se conserva
do $$
declare r jsonb; v_del timestamptz; v_type text; n int;
begin
  -- a) papá borra; mamá edita con base obsoleta -> se restaura
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 14, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  r := tests.go(tests.op('sleep_session', 14, 1, null, true));
  perform tests.assert(r ->> 'status' = 'applied', 'S10a el borrado se aplica');
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('sleep_session', 14, 1, '{"sleep_type":"nap"}'));
  perform tests.as_superuser();
  select deleted_at, sleep_type into v_del, v_type from app.sleep_session where id = tests.u(14);
  select count(*) into n from app.sync_conflict where row_id = tests.u(14) and kind = 'edit_after_delete' and status = 'open';
  perform tests.assert(v_del is null and v_type = 'nap' and n = 1, 'S10b editar una fila borrada la restaura y abre conflicto');

  -- b) mamá edita; papá borra con base obsoleta -> no se borra
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 15, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  perform tests.go(tests.op('sleep_session', 15, 1, '{"sleep_type":"nap"}'));
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  r := tests.go(tests.op('sleep_session', 15, 1, null, true));
  perform tests.assert(r ->> 'status' = 'conflict', 'S10c borrar con ediciones posteriores devuelve conflicto');
  perform tests.as_superuser();
  select deleted_at into v_del from app.sleep_session where id = tests.u(15);
  select count(*) into n from app.sync_conflict where row_id = tests.u(15) and kind = 'delete_vs_edit' and status = 'open';
  perform tests.assert(v_del is null and n = 1, 'S10d la fila no se borra y queda el conflicto');
end $$;

-- S11 · perfil del bebé: último por campo, con historial completo
do $$
declare v_alias text; n int; c int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform tests.go(tests.op('baby', 1, 1, '{"alias":"Papá"}'));
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('baby', 1, 1, '{"alias":"Mamá"}'));        -- base obsoleta: gana el último
  perform tests.as_superuser();
  select alias into v_alias from app.baby where id = tests.u(1);
  select count(*) into n from app.revision where row_id = tests.u(1);
  select count(*) into c from app.sync_conflict where row_id = tests.u(1);
  perform tests.assert(v_alias = 'Mamá' and n = 3 and c = 0, 'S11 perfil: último por campo, 3 revisiones, sin conflicto');
end $$;

-- S12 · una op inválida no tumba el lote ni consume change_seq
do $$
declare res jsonb; s1 bigint; s2 bigint; n int;
begin
  perform tests.as_superuser();
  select change_seq into s1 from app.family_counter where family_id = (select id from app.family where name = 'Familia A');
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  res := app.apply_changes(tests.u(900), now(), jsonb_build_array(
    tests.op('wake_episode', 20, null, '{"session_id":"00000000-0000-4000-8000-000000000010","kind":"duration_only","duration_s":120}'),
    tests.op('sleep_session', 16, null, jsonb_build_object(            -- fin anterior al inicio: viola un CHECK
      'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'sleep_end_utc', '2027-01-14T19:00:00.000Z',
      'start_tz', 'Europe/Madrid', 'end_tz', 'Europe/Madrid', 'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')),
    tests.op('wake_episode', 21, null, '{"session_id":"00000000-0000-4000-8000-000000000010","kind":"duration_only","duration_s":300}')));
  perform tests.as_superuser();
  select change_seq into s2 from app.family_counter where family_id = (select id from app.family where name = 'Familia A');
  select count(*) into n from app.sleep_session where id = tests.u(16);
  perform tests.assert(
    res -> 'results' -> 0 ->> 'status' = 'applied' and res -> 'results' -> 1 ->> 'status' = 'rejected'
    and res -> 'results' -> 2 ->> 'status' = 'applied' and n = 0 and s2 = s1 + 2,
    'S12 el lote sigue tras una op inválida y solo las aplicadas consumen change_seq');
end $$;

-- S13 · otra familia no puede tocar ni pisar tus filas
do $$
declare r jsonb; v_alias text;
begin
  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  r := tests.go(tests.op('baby', 1, 3, '{"alias":"Hack"}'));                 -- editar el bebé de A
  perform tests.assert(r ->> 'status' = 'rejected' and r ->> 'reason' = 'row_not_found', 'S13a editar una fila ajena no es posible');
  r := tests.go(tests.op('baby', 1, null, '{"alias":"Hack","birth_date":"2026-01-01"}'));   -- reutilizar su id
  perform tests.assert(r ->> 'status' = 'rejected', 'S13b crear con el id de una fila ajena se rechaza');
  r := tests.go(tests.op('baby', 1, 3, null, true));
  perform tests.assert(r ->> 'status' = 'rejected', 'S13c borrar una fila ajena no es posible');
  perform tests.as_superuser();
  select alias into v_alias from app.baby where id = tests.u(1);
  perform tests.assert(v_alias = 'Mamá', 'S13d la fila de A queda intacta');
end $$;

-- S14 · invariantes: una revisión por escritura aplicada; change_seq único y creciente; pull incremental
do $$
declare v_seq bigint; n int; d int; m bigint; v_fam uuid; k int;
begin
  perform tests.as_superuser();
  select id into v_fam from app.family where name = 'Familia A';
  select change_seq into v_seq from app.family_counter where family_id = v_fam;
  select count(*), count(distinct change_seq), max(change_seq) into n, d, m from app.revision where family_id = v_fam;
  perform tests.assert(n = v_seq and d = n and m = v_seq, 'S14a revisiones = escrituras = change_seq (sin huecos ni repetidos)');

  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  select count(*) into k from app.wake_episode where change_seq > v_seq - 2;      -- las 2 últimas escrituras (S12)
  select count(*) into n from app.sleep_session where change_seq > v_seq - 2;
  perform tests.as_superuser();
  perform tests.assert(k = 2 and n = 0, 'S14b el pull incremental por change_seq devuelve solo lo nuevo');
  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  select count(*) into k from app.revision where table_name = 'sleep_session';
  perform tests.as_superuser();
  perform tests.assert(k = 0, 'S14c el historial de A es invisible para B');
end $$;

-- S15 · perfil ampliado del bebé (migración 0004): se sincroniza, se valida y se fusiona por campo
do $$
declare r jsonb; v_rev int; v_w int; v_s text; v_len numeric; v_notes text; n int;
begin
  perform tests.as_superuser();
  select rev into v_rev from app.baby where id = tests.u(1);

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('baby', 1, v_rev, '{"sex":"female","gestational_weeks":36,"birth_weight_g":2850,"birth_length_cm":48.5}'));
  perform tests.assert(r ->> 'status' = 'applied', 'S15a el perfil ampliado se aplica');

  -- papá edita OTRO campo con base obsoleta: se fusiona
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  r := tests.go(tests.op('baby', 1, v_rev, '{"notes":"nació de madrugada"}'));
  perform tests.assert(r ->> 'status' = 'applied', 'S15b otro campo con base obsoleta se fusiona');

  perform tests.as_superuser();
  select sex, birth_weight_g, birth_length_cm, notes into v_s, v_w, v_len, v_notes from app.baby where id = tests.u(1);
  perform tests.assert(v_s = 'female' and v_w = 2850 and v_len = 48.5 and v_notes = 'nació de madrugada', 'S15c ambos cambios conviven');

  -- valores imposibles: los rechaza la base de datos, no solo la app
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  select rev into v_rev from app.baby where id = tests.u(1);
  r := tests.go(tests.op('baby', 1, v_rev, '{"birth_weight_g":5}'));
  perform tests.assert(r ->> 'status' = 'rejected', 'S15d un peso imposible se rechaza');
  r := tests.go(tests.op('baby', 1, v_rev, '{"sex":"x"}'));
  perform tests.assert(r ->> 'status' = 'rejected', 'S15e un sexo no válido se rechaza');
  perform tests.as_superuser();
  select birth_weight_g into v_w from app.baby where id = tests.u(1);
  perform tests.assert(v_w = 2850, 'S15f lo rechazado no altera el perfil');
  -- no existe columna de foto en el servidor
  select count(*) into n from information_schema.columns where table_schema = 'app' and table_name = 'baby' and column_name ilike '%photo%';
  perform tests.assert(n = 0, 'S15g la foto no existe en el servidor');
end $$;

-- S16 · restaurar (0005): vuelve de la papelera sin conflicto; borrar y restaurar a la vez se rechaza
do $$
declare r jsonb; v_rev int; v_del timestamptz; n int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 30, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  r := tests.go(tests.op('sleep_session', 30, 1, null, true));                      -- borrar (rev 2)
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 2, 'S16a borrado aplicado');

  r := tests.go(jsonb_build_object('op_id', gen_random_uuid(), 'table', 'sleep_session', 'row_id', tests.u(30),
                                   'base_rev', 2, 'fields', '{}'::jsonb, 'restore', true));
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 3, 'S16b restaurar aplicado');
  perform tests.as_superuser();
  select deleted_at into v_del from app.sleep_session where id = tests.u(30);
  select count(*) into n from app.sync_conflict where row_id = tests.u(30);
  perform tests.assert(v_del is null and n = 0, 'S16c la fila vuelve y no hay conflicto');

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(jsonb_build_object('op_id', gen_random_uuid(), 'table', 'sleep_session', 'row_id', tests.u(30),
                                   'base_rev', 3, 'fields', '{}'::jsonb, 'restore', true));
  perform tests.assert(r ->> 'status' = 'noop', 'S16d restaurar una fila viva es un no-op');
  r := tests.go(jsonb_build_object('op_id', gen_random_uuid(), 'table', 'sleep_session', 'row_id', tests.u(30),
                                   'base_rev', 3, 'fields', '{}'::jsonb, 'restore', true, 'delete', true));
  perform tests.assert(r ->> 'status' = 'rejected' and r ->> 'reason' = 'delete_and_restore', 'S16e delete y restore a la vez se rechazan');
  perform tests.as_superuser();
end $$;

-- S17 · edición y borrado en la misma op: se fusionan los campos y después se borra
do $$
declare r jsonb; v_type text; v_del timestamptz; v_rev int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 31, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  r := tests.go(tests.op('sleep_session', 31, 1, '{"sleep_type":"nap"}', true));
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 2, 'S17a edición + borrado en una sola escritura');
  perform tests.as_superuser();
  select sleep_type, deleted_at into v_type, v_del from app.sleep_session where id = tests.u(31);
  perform tests.assert(v_type = 'nap' and v_del is not null, 'S17b el campo se aplicó y la fila está borrada');

  -- con ediciones ajenas posteriores a base_rev: los campos se aplican pero la fila NO se borra
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 32, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform tests.go(tests.op('sleep_session', 32, 1, '{"awakenings_completeness":"partial"}'));    -- rev 2
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('sleep_session', 32, 1, '{"sleep_type":"nap"}', true));                  -- base obsoleta
  perform tests.assert(r ->> 'status' = 'merged', 'S17c con ediciones ajenas: se fusiona y se avisa del conflicto');
  perform tests.as_superuser();
  select sleep_type, deleted_at into v_type, v_del from app.sleep_session where id = tests.u(32);
  perform tests.assert(v_type = 'nap' and v_del is null
    and exists (select 1 from app.sync_conflict where row_id = tests.u(32) and kind = 'delete_vs_edit' and status = 'open'),
    'S17d no se borra y queda el conflicto');
end $$;

-- S18 · resolver un conflicto de fin de sueño: «el otro» aplica el valor desplazado y limpia la marca
do $$
declare r jsonb; v_end timestamptz; v_flag boolean; v_cid uuid; v_st text; v_seq0 bigint; v_seq1 bigint; v_fam uuid;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 40, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform tests.go(tests.op('sleep_session', 40, 1, '{"sleep_end_utc":"2027-01-15T05:00:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact"}'));
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 40, 1, '{"sleep_end_utc":"2027-01-15T05:10:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact"}'));

  perform tests.as_superuser();
  select id into v_cid from app.sync_conflict where row_id = tests.u(40) and kind = 'end_time';
  select conflict_open into v_flag from app.sleep_session where id = tests.u(40);
  perform tests.assert(v_cid is not null and v_flag, 'S18a hay un conflicto abierto y la sesión está marcada');
  select id into v_fam from app.family where name = 'Familia A';
  select change_seq into v_seq0 from app.family_counter where family_id = v_fam;

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := app.resolve_conflict(v_cid, 'other');
  perform tests.assert(r ->> 'status' = 'resolved' and (r ->> 'applied')::boolean, 'S18b se resuelve aplicando el otro valor');

  perform tests.as_superuser();
  select sleep_end_utc, conflict_open into v_end, v_flag from app.sleep_session where id = tests.u(40);
  select status into v_st from app.sync_conflict where id = v_cid;
  select change_seq into v_seq1 from app.family_counter where family_id = v_fam;
  perform tests.assert(v_end = '2027-01-15T05:10:00Z' and v_flag = false and v_st = 'resolved', 'S18c el fin toma el valor alternativo, se limpia la marca y el conflicto queda resuelto');
  perform tests.assert(v_seq1 > v_seq0, 'S18d el cambio recibe change_seq (llega a los móviles)');
  perform tests.assert(exists (select 1 from app.revision where row_id = tests.u(40) and (patch ->> 'conflict_open') = 'false'), 'S18e queda en el historial de revisiones');
end $$;

-- S19 · «dejar el actual»: no cambia el valor, pero resuelve y limpia la marca
do $$
declare r jsonb; v_end timestamptz; v_flag boolean; v_cid uuid;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 41, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform tests.go(tests.op('sleep_session', 41, 1, '{"sleep_end_utc":"2027-01-15T05:00:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact"}'));
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 41, 1, '{"sleep_end_utc":"2027-01-15T05:20:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact"}'));
  perform tests.as_superuser();
  select id into v_cid from app.sync_conflict where row_id = tests.u(41) and kind = 'end_time';

  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');      -- también puede el otro cuidador
  r := app.resolve_conflict(v_cid, 'current');
  perform tests.assert(r ->> 'status' = 'resolved' and not (r ->> 'applied')::boolean, 'S19a se resuelve sin aplicar nada');
  perform tests.as_superuser();
  select sleep_end_utc, conflict_open into v_end, v_flag from app.sleep_session where id = tests.u(41);
  perform tests.assert(v_end = '2027-01-15T05:00:00Z' and v_flag = false, 'S19b el valor se mantiene y se limpia la marca');
end $$;

-- S20 · borrar vs editar: «el otro» deja la fila en la papelera
do $$
declare r jsonb; v_del timestamptz; v_cid uuid;
begin
  -- a) delete_vs_edit: la fila se conservó; «el otro» la borra
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 42, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  perform tests.go(tests.op('sleep_session', 42, 1, '{"sleep_type":"nap"}'));
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform tests.go(tests.op('sleep_session', 42, 1, null, true));
  perform tests.as_superuser();
  select id into v_cid from app.sync_conflict where row_id = tests.u(42) and kind = 'delete_vs_edit';
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := app.resolve_conflict(v_cid, 'other');
  perform tests.as_superuser();
  select deleted_at into v_del from app.sleep_session where id = tests.u(42);
  perform tests.assert(v_del is not null and (r ->> 'applied')::boolean, 'S20a delete_vs_edit con «el otro»: la fila se borra');

  -- b) edit_after_delete: la fila se restauró; «el otro» la vuelve a borrar
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 43, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform tests.go(tests.op('sleep_session', 43, 1, null, true));
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('sleep_session', 43, 1, '{"sleep_type":"nap"}'));
  perform tests.as_superuser();
  select id into v_cid from app.sync_conflict where row_id = tests.u(43) and kind = 'edit_after_delete';
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform app.resolve_conflict(v_cid, 'other');
  perform tests.as_superuser();
  select deleted_at into v_del from app.sleep_session where id = tests.u(43);
  perform tests.assert(v_del is not null, 'S20b edit_after_delete con «el otro»: la fila vuelve a la papelera');
end $$;

-- S21 · permisos y errores
do $$
declare v_cid uuid; ok boolean;
begin
  perform tests.as_superuser();
  select id into v_cid from app.sync_conflict where row_id = tests.u(40) and kind = 'end_time';     -- ya resuelto en S18

  perform tests.as_user('a0000000-0000-4000-8000-000000000003', 'lector@example.test');             -- lector
  begin perform app.resolve_conflict(v_cid, 'current'); ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'S21a un lector no resuelve conflictos');

  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');            -- otra familia
  begin perform app.resolve_conflict(v_cid, 'current'); ok := false; exception when sqlstate 'P0001' then ok := true; end;
  perform tests.assert(ok, 'S21b otra familia no ve ni resuelve tus conflictos');

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  begin perform app.resolve_conflict(v_cid, 'current'); ok := false; exception when sqlstate 'P0001' then ok := true; end;
  perform tests.assert(ok, 'S21c un conflicto ya resuelto no se resuelve dos veces');
  begin perform app.resolve_conflict(v_cid, 'quizas'); ok := false; exception when sqlstate '22023' then ok := true; end;
  perform tests.assert(ok, 'S21d una opción desconocida se rechaza');

  perform tests.as_anon();
  begin perform app.resolve_conflict(v_cid, 'current'); ok := false; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'S21e anon no puede');
  perform tests.as_superuser();
end $$;

-- S22 · tomas (0008): alta, validaciones y aislamiento entre familias
do $$
declare r jsonb; n int; v_ml int; v_end timestamptz;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('feeding', 50, null, jsonb_build_object(
    'baby_id', tests.u(1), 'feed_type', 'breast', 'start_utc', '2027-01-14T10:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'end_utc', '2027-01-14T10:20:00.000Z', 'end_tz', 'Europe/Madrid', 'end_quality', 'exact', 'breast_side', 'left', 'source', 'timer')));
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 1, 'S22a toma de pecho con el pecho usado');
  r := tests.go(tests.op('feeding', 51, null, jsonb_build_object(
    'baby_id', tests.u(1), 'feed_type', 'bottle', 'start_utc', '2027-01-14T13:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'end_utc', '2027-01-14T13:15:00.000Z', 'end_tz', 'Europe/Madrid', 'end_quality', 'approx', 'amount_ml', 120, 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'applied', 'S22b biberón con cantidad');
  r := tests.go(tests.op('feeding', 52, null, jsonb_build_object(
    'baby_id', tests.u(1), 'feed_type', 'bottle', 'start_utc', '2027-01-14T16:00:00.000Z', 'start_tz', 'Europe/Madrid', 'source', 'timer')));
  perform tests.assert(r ->> 'status' = 'applied', 'S22c una toma en curso no tiene fin');

  -- lo incoherente lo rechaza la base de datos, no solo la app
  r := tests.go(tests.op('feeding', 53, null, jsonb_build_object('baby_id', tests.u(1), 'feed_type', 'breast', 'start_utc', '2027-01-14T10:00:00.000Z',
    'start_tz', 'Europe/Madrid', 'amount_ml', 100, 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S22d ml en una toma de pecho: rechazado');
  r := tests.go(tests.op('feeding', 54, null, jsonb_build_object('baby_id', tests.u(1), 'feed_type', 'bottle', 'start_utc', '2027-01-14T10:00:00.000Z',
    'start_tz', 'Europe/Madrid', 'breast_side', 'left', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S22e pecho en un biberón: rechazado');
  r := tests.go(tests.op('feeding', 55, null, jsonb_build_object('baby_id', tests.u(1), 'feed_type', 'bottle', 'start_utc', '2027-01-14T10:00:00.000Z',
    'start_tz', 'Europe/Madrid', 'end_utc', '2027-01-14T09:00:00.000Z', 'end_tz', 'Europe/Madrid', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S22f fin anterior al inicio: rechazado');
  r := tests.go(tests.op('feeding', 56, null, jsonb_build_object('baby_id', tests.u(1), 'feed_type', 'bottle', 'start_utc', '2027-01-14T10:00:00.000Z',
    'start_tz', 'Europe/Madrid', 'amount_ml', 0, 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S22g 0 ml: rechazado');
  r := tests.go(tests.op('feeding', 57, null, jsonb_build_object('baby_id', tests.u(1), 'feed_type', 'leche', 'start_utc', '2027-01-14T10:00:00.000Z',
    'start_tz', 'Europe/Madrid', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S22h un tipo desconocido: rechazado');

  -- un bebé de OTRA familia no se puede usar
  r := tests.go(tests.op('feeding', 58, null, jsonb_build_object('baby_id', tests.u(2), 'feed_type', 'breast', 'start_utc', '2027-01-14T10:00:00.000Z',
    'start_tz', 'Europe/Madrid', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'rejected' and r ->> 'reason' like 'invalid_reference%', 'S22i una toma no puede colgar de un bebé de otra familia');

  -- cerrar la toma en curso: fin + ml
  r := tests.go(tests.op('feeding', 52, 1, '{"end_utc":"2027-01-14T16:12:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact","amount_ml":90}'));
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 2, 'S22j se cierra la toma en curso con su cantidad');
  perform tests.as_superuser();
  select amount_ml, end_utc into v_ml, v_end from app.feeding where id = tests.u(52);
  perform tests.assert(v_ml = 90 and v_end = '2027-01-14T16:12:00Z', 'S22k la toma queda con 90 ml y su fin');

  -- visibilidad por familia
  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  select count(*) into n from app.feeding;
  perform tests.as_superuser();
  perform tests.assert(n = 0, 'S22l otra familia no ve tus tomas');
  perform tests.as_user('a0000000-0000-4000-8000-000000000003', 'lector@example.test');             -- lector: ve, pero no escribe
  select count(*) into n from app.feeding;
  perform tests.assert(n = 3, 'S22m un lector de la familia sí las ve');
  perform tests.as_superuser();
end $$;

-- S23 · notas de una toma: exactamente un destino
do $$
declare r jsonb; v_fid uuid; v_sid uuid;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('observation', 60, null, jsonb_build_object('feeding_id', tests.u(50), 'moment', 'feeding', 'note_text', 'tomó bien')));
  perform tests.assert(r ->> 'status' = 'applied', 'S23a una nota se asocia a una toma');
  perform tests.as_superuser();
  select feeding_id, session_id into v_fid, v_sid from app.observation where id = tests.u(60);
  perform tests.assert(v_fid = tests.u(50) and v_sid is null, 'S23b queda ligada a la toma y no a una sesión');

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('observation', 61, null, jsonb_build_object('feeding_id', tests.u(50), 'session_id', tests.u(10), 'moment', 'feeding')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S23c toma y sesión a la vez: rechazado');
  r := tests.go(tests.op('observation', 62, null, jsonb_build_object('moment', 'feeding', 'note_text', 'huérfana')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S23d sin destino: rechazado');
  r := tests.go(tests.op('observation', 63, null, jsonb_build_object('feeding_id', tests.u(50), 'moment', 'otro')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S23e un momento desconocido: rechazado');

  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  r := tests.go(tests.op('observation', 64, null, jsonb_build_object('feeding_id', tests.u(50), 'moment', 'feeding')));
  perform tests.assert(r ->> 'status' = 'rejected' and r ->> 'reason' like 'invalid_reference%', 'S23f no se pueden colgar notas de una toma de otra familia');
  perform tests.as_superuser();
end $$;

-- S24 · dos cuidadores editan la misma toma a la vez: los campos distintos se fusionan
do $$
declare r jsonb; v_ml int; v_side text; n int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('feeding', 70, null, jsonb_build_object(
    'baby_id', tests.u(1), 'feed_type', 'breast', 'start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid', 'source', 'timer')));
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform tests.go(tests.op('feeding', 70, 1, '{"end_utc":"2027-01-14T20:25:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact"}'));
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('feeding', 70, 1, '{"breast_side":"both"}'));               -- base obsoleta, otro campo
  perform tests.assert(r ->> 'status' = 'applied', 'S24a otro campo con base obsoleta se fusiona');
  perform tests.as_superuser();
  select breast_side into v_side from app.feeding where id = tests.u(70);
  select count(*) into n from app.sync_conflict where row_id = tests.u(70);
  perform tests.assert(v_side = 'both' and n = 0, 'S24b ambos cambios conviven sin conflicto');
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('feeding', 70, 3, null, true));            -- tras las dos ediciones la toma va por la versión 3
  perform tests.assert(r ->> 'status' = 'applied', 'S24c una toma se borra de forma lógica');
  perform tests.as_superuser();
  perform tests.assert((select deleted_at is not null from app.feeding where id = tests.u(70)), 'S24d y se conserva en la base de datos');
end $$;

-- S25 · campos acoplados: uno cambia el tipo de toma y otro anota los ml a la vez -> juntos o ninguno
do $$
declare r jsonb; v_type text; v_side text; v_ml int; v_end timestamptz; n int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform tests.go(tests.op('feeding', 80, null, jsonb_build_object(
    'baby_id', tests.u(1), 'feed_type', 'bottle', 'start_utc', '2027-01-14T20:00:00.000Z', 'start_tz', 'Europe/Madrid', 'source', 'timer')));
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  r := tests.go(tests.op('feeding', 80, 1, '{"feed_type":"breast","breast_side":"right"}'));    -- cambia a pecho
  perform tests.assert(r ->> 'status' = 'applied', 'S25a el primero cambia la toma a pecho');

  -- el segundo (base obsoleta) cierra la toma con 90 ml, como si siguiera siendo un biberón
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('feeding', 80, 1,
    '{"end_utc":"2027-01-14T20:15:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact","amount_ml":90}'));
  perform tests.assert(r ->> 'status' = 'merged', 'S25b en vez de rechazarse, se fusiona y avisa del conflicto');

  perform tests.as_superuser();
  select feed_type, breast_side, amount_ml, end_utc into v_type, v_side, v_ml, v_end from app.feeding where id = tests.u(80);
  perform tests.assert(v_type = 'breast' and v_side = 'right' and v_ml is null, 'S25c la toma sigue siendo coherente: pecho, sin ml');
  perform tests.assert(v_end = '2027-01-14T20:15:00Z', 'S25d el fin, que no estaba en disputa, sí se aplicó');
  select count(*) into n from app.sync_conflict where row_id = tests.u(80) and field_name = 'amount_ml' and status = 'open';
  perform tests.assert(n = 1, 'S25e los ml quedan como conflicto abierto (alternativo 90), nada se pierde en silencio');
end $$;

-- S26 · despertares nocturnos (0010): alta, validaciones y aislamiento entre familias
do $$
declare r jsonb; n int; ok boolean;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('sleep_session', 90, null, jsonb_build_object(
    'baby_id', tests.u(1), 'sleep_start_utc', '2027-02-01T21:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'sleep_end_utc', '2027-02-02T06:00:00.000Z', 'end_tz', 'Europe/Madrid', 'end_quality', 'exact',
    'sleep_type', 'night', 'type_source', 'manual', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'applied', 'S26a fixture: noche');

  r := tests.go(tests.op('awakening', 91, null, jsonb_build_object(
    'baby_id', tests.u(1), 'session_id', tests.u(90), 'start_utc', '2027-02-02T01:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'end_utc', '2027-02-02T01:40:00.000Z', 'end_tz', 'Europe/Madrid', 'end_quality', 'approx', 'reason', 'feeding', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 1, 'S26b despertar con fin y motivo');
  r := tests.go(tests.op('awakening', 92, null, jsonb_build_object(
    'baby_id', tests.u(1), 'session_id', tests.u(90), 'start_utc', '2027-02-02T03:00:00.000Z', 'start_tz', 'Europe/Madrid', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'applied', 'S26c sin fin: en curso o duración desconocida, nunca 0');

  r := tests.go(tests.op('awakening', 93, null, jsonb_build_object(
    'baby_id', tests.u(1), 'session_id', tests.u(90), 'start_utc', '2027-02-02T03:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'end_utc', '2027-02-02T02:00:00.000Z', 'end_tz', 'Europe/Madrid', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S26d fin anterior al inicio: rechazado');
  r := tests.go(tests.op('awakening', 94, null, jsonb_build_object(
    'baby_id', tests.u(1), 'session_id', tests.u(90), 'start_utc', '2027-02-02T03:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'end_utc', '2027-02-02T03:10:00.000Z', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S26e el fin y su zona van juntos');
  r := tests.go(tests.op('awakening', 95, null, jsonb_build_object(
    'baby_id', tests.u(1), 'session_id', tests.u(90), 'start_utc', '2027-02-02T03:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'reason', 'hambre', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S26f motivo desconocido: rechazado');

  -- la sesión y el bebé deben ser de la propia familia
  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  r := tests.go(tests.op('awakening', 96, null, jsonb_build_object(
    'baby_id', tests.u(2), 'session_id', tests.u(90), 'start_utc', '2027-02-02T03:00:00.000Z', 'start_tz', 'Europe/Madrid', 'source', 'manual')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S26g la sesión de otra familia no se puede usar');

  perform tests.as_user('a0000000-0000-4000-8000-000000000003', 'lector@example.test');
  begin
    r := tests.go(tests.op('awakening', 97, null, jsonb_build_object(
      'baby_id', tests.u(1), 'session_id', tests.u(90), 'start_utc', '2027-02-02T03:00:00.000Z', 'start_tz', 'Europe/Madrid', 'source', 'manual')));
    ok := false;
  exception when others then ok := sqlerrm like '%not_allowed%'; end;
  perform tests.assert(ok, 'S26h un lector no puede registrar despertares');

  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  select count(*) into n from app.awakening;
  perform tests.assert(n = 0, 'S26i otra familia no ve los despertares');
  perform tests.as_user('a0000000-0000-4000-8000-000000000003', 'lector@example.test');
  select count(*) into n from app.awakening;
  perform tests.assert(n = 2, 'S26j un lector sí los ve');
  perform tests.as_superuser();
end $$;

-- S27 · umbral de despertares en el perfil del bebé
do $$
declare r jsonb; v int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('baby', 1, (select rev from app.baby where id = tests.u(1)), '{"awakening_threshold_min":45}'));
  perform tests.assert(r ->> 'status' = 'applied', 'S27a el umbral se guarda en el perfil');
  r := tests.go(tests.op('baby', 1, (select rev from app.baby where id = tests.u(1)), '{"awakening_threshold_min":3}'));
  perform tests.assert(r ->> 'status' = 'rejected', 'S27b menos de 5 min: rechazado');
  r := tests.go(tests.op('baby', 1, (select rev from app.baby where id = tests.u(1)), '{"awakening_threshold_min":200}'));
  perform tests.assert(r ->> 'status' = 'rejected', 'S27c más de 180 min: rechazado');
  perform tests.as_superuser();
  select awakening_threshold_min into v from app.baby where id = tests.u(1);
  perform tests.assert(v = 45, 'S27d queda el último valor válido');
end $$;

-- S28 · dos cuidadores cierran el mismo despertar con horas distintas: conflicto, no rechazo
do $$
declare r jsonb; n int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('awakening', 92, 1,
    '{"end_utc":"2027-02-02T03:20:00.000Z","end_tz":"Europe/Madrid","end_quality":"exact"}'));
  perform tests.assert(r ->> 'status' = 'applied', 'S28a el primero cierra el despertar');
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  r := tests.go(tests.op('awakening', 92, 1,
    '{"end_utc":"2027-02-02T04:10:00.000Z","end_tz":"Europe/Madrid","end_quality":"approx"}'));
  perform tests.assert(r ->> 'status' in ('merged', 'conflict'), 'S28b el segundo no se rechaza: queda como conflicto');
  perform tests.as_superuser();
  select count(*) into n from app.sync_conflict where row_id = tests.u(92) and status = 'open';
  perform tests.assert(n = 2, 'S28c el fin y su calidad (los campos que difieren) quedan como conflicto abierto');
  perform tests.assert((select end_utc from app.awakening where id = tests.u(92)) = '2027-02-02T03:20:00Z', 'S28d el valor del primero se conserva');
end $$;

-- S29 · ficha de salud en el perfil (0011): se guarda como el resto del perfil y respeta sus límites
do $$
declare r jsonb; v text;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('baby', 1, (select rev from app.baby where id = tests.u(1)),
    '{"pediatrician":"Dra. Prueba","health_center_name":"Centro de Salud de Prueba","allergies":"ninguna conocida","cipa":"TEST0000000000"}'));
  perform tests.assert(r ->> 'status' = 'applied', 'S29a la ficha de salud se guarda en el perfil');
  r := tests.go(tests.op('baby', 1, (select rev from app.baby where id = tests.u(1)), jsonb_build_object('nurse', repeat('x', 121))));
  perform tests.assert(r ->> 'status' = 'rejected', 'S29b un texto demasiado largo: rechazado');
  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  select cipa into v from app.baby where id = tests.u(1);
  perform tests.assert(v is null, 'S29c otra familia no ve el CIPA');
  perform tests.as_superuser();
  select pediatrician into v from app.baby where id = tests.u(1);
  perform tests.assert(v = 'Dra. Prueba', 'S29d el dato queda guardado');
end $$;

-- S30 · vacunas (0011): alta, validaciones, aislamiento y permisos
do $$
declare r jsonb; n int; ok boolean;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('vaccination', 100, null, jsonb_build_object(
    'baby_id', tests.u(1), 'dose_key', 'DTPa@2m', 'vaccine', 'DTPa', 'status', 'given', 'given_on', '2027-01-05', 'center', 'Centro de prueba')));
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 1, 'S30a vacuna puesta con su fecha');
  r := tests.go(tests.op('vaccination', 101, null, jsonb_build_object(
    'baby_id', tests.u(1), 'dose_key', 'RV@2m', 'vaccine', 'Rotavirus', 'status', 'not_applicable')));
  perform tests.assert(r ->> 'status' = 'applied', 'S30b «no procede» no necesita fecha');
  r := tests.go(tests.op('vaccination', 102, null, jsonb_build_object(
    'baby_id', tests.u(1), 'vaccine', 'Gripe 2026-27', 'status', 'given', 'given_on', '2027-01-20')));
  perform tests.assert(r ->> 'status' = 'applied', 'S30c una vacuna fuera de calendario no lleva dose_key');

  r := tests.go(tests.op('vaccination', 103, null, jsonb_build_object(
    'baby_id', tests.u(1), 'dose_key', 'VPI@2m', 'vaccine', 'VPI', 'status', 'given')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S30d una vacuna puesta sin fecha: rechazada');
  r := tests.go(tests.op('vaccination', 104, null, jsonb_build_object(
    'baby_id', tests.u(1), 'dose_key', 'VPI@2m', 'vaccine', 'VPI', 'status', 'quizas', 'given_on', '2027-01-05')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S30e estado desconocido: rechazado');
  r := tests.go(tests.op('vaccination', 105, null, jsonb_build_object(
    'baby_id', tests.u(1), 'dose_key', 'VPI@2m', 'vaccine', '', 'status', 'given', 'given_on', '2027-01-05')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S30f el nombre de la vacuna es obligatorio');

  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  r := tests.go(tests.op('vaccination', 106, null, jsonb_build_object(
    'baby_id', tests.u(1), 'dose_key', 'VPI@2m', 'vaccine', 'VPI', 'status', 'given', 'given_on', '2027-01-05')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S30g el bebé de otra familia no se puede usar');
  select count(*) into n from app.vaccination;
  perform tests.assert(n = 0, 'S30h otra familia no ve las vacunas');

  perform tests.as_user('a0000000-0000-4000-8000-000000000003', 'lector@example.test');
  begin
    r := tests.go(tests.op('vaccination', 107, null, jsonb_build_object(
      'baby_id', tests.u(1), 'dose_key', 'VPI@2m', 'vaccine', 'VPI', 'status', 'given', 'given_on', '2027-01-05')));
    ok := false;
  exception when others then ok := sqlerrm like '%not_allowed%'; end;
  perform tests.assert(ok, 'S30i un lector no puede registrar vacunas');
  select count(*) into n from app.vaccination;
  perform tests.assert(n = 3, 'S30j un lector sí las ve');

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('vaccination', 100, 1, '{"lot":"LOTE-PRUEBA"}'));
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 2, 'S30k editar un dato de una vacuna ya registrada');
  perform tests.as_superuser();
end $$;

-- S31 · citas (0012): alta con avisos (lista de enteros), validaciones y permisos
do $$
declare r jsonb; n int; ok boolean; v int[];
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('appointment', 110, null, jsonb_build_object(
    'baby_id', tests.u(1), 'kind', 'pediatrician', 'title', 'Revisión', 'start_utc', '2027-04-01T08:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'duration_min', 20, 'place', 'Centro de prueba', 'remind_before_min', jsonb_build_array(1440, 60))));
  perform tests.assert(r ->> 'status' = 'applied', 'S31a cita con dos avisos');
  perform tests.as_superuser();
  select remind_before_min into v from app.appointment where id = tests.u(110);
  perform tests.assert(v = array[1440, 60], 'S31b los avisos se guardan como lista de enteros');

  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  r := tests.go(tests.op('appointment', 111, null, jsonb_build_object(
    'baby_id', tests.u(1), 'kind', 'otro', 'title', 'X', 'start_utc', '2027-04-01T08:00:00.000Z', 'start_tz', 'Europe/Madrid')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S31c tipo desconocido: rechazado');
  r := tests.go(tests.op('appointment', 112, null, jsonb_build_object(
    'baby_id', tests.u(1), 'kind', 'other', 'title', 'X', 'start_utc', '2027-04-01T08:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'remind_before_min', jsonb_build_array(60, 120, 180, 240, 300, 360))));
  perform tests.assert(r ->> 'status' = 'rejected', 'S31d más de 5 avisos: rechazado');
  r := tests.go(tests.op('appointment', 113, null, jsonb_build_object(
    'baby_id', tests.u(1), 'kind', 'other', 'title', 'X', 'start_utc', '2027-04-01T08:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'remind_before_min', jsonb_build_array(50000))));
  perform tests.assert(r ->> 'status' = 'rejected', 'S31e un aviso de más de 4 semanas: rechazado');
  r := tests.go(tests.op('appointment', 114, null, jsonb_build_object(
    'baby_id', tests.u(1), 'kind', 'other', 'title', 'X', 'start_utc', '2027-04-01T08:00:00.000Z', 'start_tz', 'Europe/Madrid',
    'remind_before_min', jsonb_build_array(-5))));
  perform tests.assert(r ->> 'status' = 'rejected', 'S31f un aviso negativo: rechazado');
  r := tests.go(tests.op('appointment', 115, null, jsonb_build_object(
    'baby_id', tests.u(1), 'kind', 'other', 'title', '', 'start_utc', '2027-04-01T08:00:00.000Z', 'start_tz', 'Europe/Madrid')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S31g el título es obligatorio');
  r := tests.go(tests.op('appointment', 110, 1, '{"status":"done"}'));
  perform tests.assert(r ->> 'status' = 'applied' and (r ->> 'rev')::int = 2, 'S31h marcar la cita como hecha');

  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  r := tests.go(tests.op('appointment', 116, null, jsonb_build_object(
    'baby_id', tests.u(1), 'kind', 'other', 'title', 'X', 'start_utc', '2027-04-01T08:00:00.000Z', 'start_tz', 'Europe/Madrid')));
  perform tests.assert(r ->> 'status' = 'rejected', 'S31i el bebé de otra familia no se puede usar');
  select count(*) into n from app.appointment;
  perform tests.assert(n = 0, 'S31j otra familia no ve las citas');

  perform tests.as_user('a0000000-0000-4000-8000-000000000003', 'lector@example.test');
  begin
    r := tests.go(tests.op('appointment', 117, null, jsonb_build_object(
      'baby_id', tests.u(1), 'kind', 'other', 'title', 'X', 'start_utc', '2027-04-01T08:00:00.000Z', 'start_tz', 'Europe/Madrid')));
    ok := false;
  exception when others then ok := sqlerrm like '%not_allowed%'; end;
  perform tests.assert(ok, 'S31k un lector no puede crear citas');
  select count(*) into n from app.appointment;
  perform tests.assert(n = 1, 'S31l un lector sí las ve');
  perform tests.as_superuser();
end $$;

rollback;
