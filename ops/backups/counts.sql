-- Recuento de filas de TODAS las tablas del esquema app, más el número de funciones, de políticas y de tablas
-- sin seguridad por filas. Salida (con psql -tA): «nombre,cantidad», ordenada. Sirve para comparar el origen
-- con la restauración de prueba. Genera una consulta con un `count(*)` por tabla y la ejecuta con \gexec
-- (sin depender de extensiones ni de soporte XML).
select string_agg(format('select %L || %L || count(*)::text from app.%I', table_name, ',', table_name), E'\nunion all\n' order by table_name)
    || E'\nunion all select ''funciones(app),'' || count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = ''app'''
    || E'\nunion all select ''politicas(app),'' || count(*)::text from pg_policies where schemaname = ''app'''
    || E'\nunion all select ''tablas_sin_rls(app),'' || count(*)::text from pg_tables where schemaname = ''app'' and not rowsecurity'
    || E'\norder by 1'
from information_schema.tables
where table_schema = 'app' and table_type = 'BASE TABLE'
\gexec
