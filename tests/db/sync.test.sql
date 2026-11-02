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

rollback;
