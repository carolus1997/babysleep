-- Pruebas de los avisos de próxima toma (migración 0009).
-- Ejecutar tras el shim y las migraciones:
--   psql -v ON_ERROR_STOP=1 -f tests/db/push.test.sql
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

create function tests.u(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
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

-- Bebé A (id 1) y bebé B (id 2), directamente como superusuario.
insert into app.baby (id, family_id, alias, birth_date)
select tests.u(1), f.id, 'Bebé A', '2026-07-01' from app.family f where f.name = 'Familia A';
insert into app.baby (id, family_id, alias, birth_date)
select tests.u(2), f.id, 'Bebé B', '2026-08-01' from app.family f where f.name = 'Familia B';

create function tests.feed(n int, baby int, fam text, start_ts timestamptz, ended boolean default true, src text default 'manual') returns void
language sql as $$
  insert into app.feeding (id, family_id, baby_id, feed_type, start_utc, start_tz, end_utc, end_tz, source)
  select tests.u(n), f.id, tests.u(baby), 'bottle', start_ts, 'Europe/Madrid',
         case when ended then start_ts + interval '15 minutes' end, case when ended then 'Europe/Madrid' end, src
    from app.family f where f.name = fam
$$;

-- ============================================================================
-- P01 · registro de móviles
do $$
declare n int; ok boolean;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  perform app.register_push('https://push.example.test/a1', 'p256-a1', 'auth-a1');
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform app.register_push('https://push.example.test/a2', 'p256-a2', 'auth-a2');
  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  perform app.register_push('https://push.example.test/b1', 'p256-b1', 'auth-b1');

  perform tests.as_superuser();
  select count(*) into n from app.push_subscription;
  perform tests.assert(n = 3, 'P01a se registran tres móviles');

  -- registrar dos veces la misma dirección no duplica
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform app.register_push('https://push.example.test/a2', 'p256-a2-nuevo', 'auth-a2');
  perform tests.as_superuser();
  select count(*) into n from app.push_subscription where endpoint = 'https://push.example.test/a2';
  perform tests.assert(n = 1 and (select p256dh from app.push_subscription where endpoint = 'https://push.example.test/a2') = 'p256-a2-nuevo',
    'P01b repetir la dirección la actualiza, no la duplica');

  -- el lector no puede
  perform tests.as_user('a0000000-0000-4000-8000-000000000003', 'lector@example.test');
  ok := false;
  begin perform app.register_push('https://push.example.test/v', 'k', 'a'); exception when others then ok := sqlerrm like '%not_allowed%'; end;
  perform tests.assert(ok, 'P01c un lector no puede registrar avisos');

  -- sin sesión, tampoco
  perform tests.as_anon();
  ok := false;
  begin perform app.register_push('https://push.example.test/x', 'k', 'a'); exception when others then ok := true; end;
  perform tests.assert(ok, 'P01d sin sesión no se puede');

  -- datos no válidos
  perform tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
  ok := false;
  begin perform app.register_push('http://inseguro.example.test/x', 'k', 'a'); exception when others then ok := sqlerrm like '%invalid_endpoint%'; end;
  perform tests.assert(ok, 'P01e solo direcciones https');
  ok := false;
  begin perform app.register_push('https://push.example.test/y', '', 'a'); exception when others then ok := sqlerrm like '%invalid_keys%'; end;
  perform tests.assert(ok, 'P01f las claves son obligatorias');

  -- los clientes no leen la tabla de móviles ni pueden reclamar avisos
  ok := false;
  begin perform count(*) from app.push_subscription; exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'P01g los clientes no pueden leer las direcciones de los móviles');
  ok := false;
  begin perform * from app.claim_due_feed_reminders(now()); exception when insufficient_privilege then ok := true; end;
  perform tests.assert(ok, 'P01h los clientes no pueden reclamar avisos');

  -- darse de baja solo borra la dirección de la propia familia
  perform app.unregister_push('https://push.example.test/b1');
  perform tests.as_superuser();
  perform tests.assert((select count(*) from app.push_subscription where endpoint = 'https://push.example.test/b1') = 1,
    'P01i no se puede dar de baja el móvil de otra familia');
  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  perform app.unregister_push('https://push.example.test/b1');
  perform tests.as_superuser();
  perform tests.assert((select count(*) from app.push_subscription where endpoint = 'https://push.example.test/b1') = 0, 'P01j darse de baja funciona');
end $$;

-- ============================================================================
-- P02 · ajustes de la familia
do $$
declare ok boolean; n int;
begin
  perform tests.as_user('a0000000-0000-4000-8000-000000000002', 'papa@example.test');
  perform app.set_feed_reminder(true, 180);
  ok := false;
  begin perform app.set_feed_reminder(true, 10); exception when others then ok := sqlerrm like '%invalid_interval%'; end;
  perform tests.assert(ok, 'P02a intervalo fuera de 30–720 minutos rechazado');

  select count(*) into n from app.feed_reminder;
  perform tests.assert(n = 1, 'P02b cada familia solo ve sus ajustes');

  perform tests.as_user('a0000000-0000-4000-8000-000000000003', 'lector@example.test');
  select count(*) into n from app.feed_reminder;
  perform tests.assert(n = 1, 'P02c el lector puede ver los ajustes');
  ok := false;
  begin perform app.set_feed_reminder(false, 120); exception when others then ok := sqlerrm like '%not_allowed%'; end;
  perform tests.assert(ok, 'P02d el lector no puede cambiarlos');

  perform tests.as_user('b0000000-0000-4000-8000-000000000001', 'admin-b@example.test');
  select count(*) into n from app.feed_reminder;
  perform tests.assert(n = 0, 'P02e otra familia no ve los ajustes de la A');
end $$;

-- ============================================================================
-- P03 · cuándo toca avisar
do $$
declare n int; r record; t0 timestamptz := '2027-01-15 08:00:00+00';
begin
  perform tests.as_superuser();
  perform tests.feed(10, 1, 'Familia A', t0);

  select count(*) into n from app.claim_due_feed_reminders(t0 + interval '179 minutes');
  perform tests.assert(n = 0, 'P03a antes de tiempo no se avisa');

  select count(*) into n from app.claim_due_feed_reminders(t0 + interval '181 minutes');
  perform tests.assert(n = 2, 'P03b al pasar el intervalo se avisa a los dos móviles de la familia A (y a nadie más)');

  select count(*) into n from app.claim_due_feed_reminders(t0 + interval '185 minutes');
  perform tests.assert(n = 0, 'P03c nunca se avisa dos veces por la misma toma');

  perform tests.feed(11, 1, 'Familia A', t0 + interval '4 hours');
  select * into r from app.claim_due_feed_reminders(t0 + interval '4 hours' + interval '181 minutes') limit 1;
  perform tests.assert(r.baby_alias = 'Bebé A' and r.feeding_id = tests.u(11) and r.interval_min = 180,
    'P03d una toma nueva vuelve a avisar, con alias e intervalo');

  -- toma en curso (cronómetro): no se avisa
  perform tests.feed(12, 1, 'Familia A', t0 + interval '10 hours', false, 'timer');
  select count(*) into n from app.claim_due_feed_reminders(t0 + interval '14 hours');
  perform tests.assert(n = 0, 'P03e una toma en curso no dispara el aviso');

  -- una toma eliminada no cuenta: vale la anterior, que ya se avisó
  update app.feeding set deleted_at = now() where id = tests.u(12);
  update app.feeding set deleted_at = now() where id = tests.u(11);
  select count(*) into n from app.claim_due_feed_reminders(t0 + interval '4 hours' + interval '183 minutes');
  perform tests.assert(n = 0, 'P03f con la toma eliminada vale la anterior, que ya se avisó');
end $$;

-- P04 · límites: aviso obsoleto, desactivado, otra familia, fallos de envío
do $$
declare n int; t0 timestamptz := '2027-02-01 08:00:00+00'; v_sub uuid;
begin
  perform tests.as_superuser();
  perform tests.feed(20, 1, 'Familia A', t0);
  select count(*) into n from app.claim_due_feed_reminders(t0 + interval '180 minutes' + interval '181 minutes');
  perform tests.assert(n = 0, 'P04a si lo que tocaba pasó hace más de 3 h no llega un aviso viejo');

  update app.feed_reminder set enabled = false;
  select count(*) into n from app.claim_due_feed_reminders(t0 + interval '181 minutes');
  perform tests.assert(n = 0, 'P04b con los avisos desactivados no se envía nada');
  update app.feed_reminder set enabled = true;

  perform tests.feed(21, 2, 'Familia B', t0);
  select count(*) into n from app.claim_due_feed_reminders(t0 + interval '181 minutes') where baby_id = tests.u(2);
  perform tests.assert(n = 0, 'P04c una familia sin ajustes no recibe avisos');

  select id into v_sub from app.push_subscription where endpoint = 'https://push.example.test/a1';
  for i in 1..5 loop perform app.report_push_result(v_sub, false, false); end loop;
  perform tests.feed(22, 1, 'Familia A', t0 + interval '5 hours');
  select count(*) into n from app.claim_due_feed_reminders(t0 + interval '5 hours' + interval '181 minutes');
  perform tests.assert(n = 1, 'P04d un móvil con 5 fallos seguidos deja de recibir avisos');

  perform app.report_push_result(v_sub, true, false);
  perform tests.assert((select failures from app.push_subscription where id = v_sub) = 0, 'P04e un envío correcto reinicia los fallos');

  perform app.report_push_result(v_sub, false, true);
  perform tests.assert((select count(*) from app.push_subscription where id = v_sub) = 0, 'P04f una dirección que ya no existe se borra');
end $$;

rollback;
