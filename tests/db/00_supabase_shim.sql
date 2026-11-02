-- Solo para CI/local: imita lo mínimo de Supabase que usan las migraciones
-- (roles anon/authenticated/service_role y auth.uid()/auth.jwt()).
-- NUNCA se aplica en Supabase real: allí estos objetos ya existen.

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

create schema if not exists auth;

-- En Supabase, PostgREST rellena request.jwt.claims con el JWT del usuario.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
