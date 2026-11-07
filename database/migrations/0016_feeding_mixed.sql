-- BabySleep · migración 0016 · tomas de pecho y biberón a la vez (contrato v0.10.0)
--
--  * Nuevo tipo de toma `mixed`: da pecho y biberón en la misma toma. Admite a la vez el pecho usado
--    (`breast_side`) y la cantidad (`amount_ml`), que antes iban en tipos excluyentes.
--  * Solo se relajan las restricciones de `app.feeding`: el pecho vale en `breast` y `mixed`, y los ml en
--    `bottle` y `mixed`. Los datos que ya existen siguen siendo válidos tal cual.
--  * `apply_changes` no cambia: ya trata `feed_type`, `breast_side` y `amount_ml` como un solo grupo de campos
--    acoplados, así que dos móviles que editen la misma toma se fusionan igual que antes.

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'app.feeding'::regclass and contype = 'c'
       and (pg_get_constraintdef(oid) ilike '%feed_type%')
  loop
    execute format('alter table app.feeding drop constraint %I', c.conname);
  end loop;
end $$;

-- Nombres propios: `feeding_breast_side_check` y `feeding_amount_ml_check` ya existen (son las restricciones de
-- columna de 0008 sobre los valores del pecho y el rango de ml) y no se tocan. El `drop ... if exists` permite
-- volver a ejecutar el script si una ejecución anterior se quedó a medias.
alter table app.feeding
  drop constraint if exists feeding_feed_type_check,
  drop constraint if exists feeding_breast_side_type_check,
  drop constraint if exists feeding_amount_ml_type_check;
alter table app.feeding
  add constraint feeding_feed_type_check check (feed_type in ('breast', 'bottle', 'mixed', 'solids')),
  add constraint feeding_breast_side_type_check check (breast_side is null or feed_type in ('breast', 'mixed')),
  add constraint feeding_amount_ml_type_check check (amount_ml is null or feed_type in ('bottle', 'mixed'));

update app.app_meta set value = '0.16.0' where key = 'schema_version';
