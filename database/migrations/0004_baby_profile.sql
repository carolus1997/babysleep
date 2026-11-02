-- BabySleep · migración 0004 · perfil ampliado del bebé (contrato v0.2.0)
--
-- Datos opcionales (null = desconocido, nunca 0). La FOTO no existe en el servidor: es solo
-- local y no se sincroniza (decisión de producto). apply_changes acepta estas columnas sin
-- cambios porque deriva la lista de columnas permitidas de information_schema.

alter table app.baby
  add column sex               text     check (sex in ('female', 'male')),
  add column gestational_weeks smallint check (gestational_weeks between 22 and 44),
  add column birth_weight_g    integer  check (birth_weight_g between 300 and 7000),
  add column birth_length_cm   numeric(4, 1) check (birth_length_cm between 20 and 70),
  add column notes             text     check (length(notes) <= 1000);

update app.app_meta set value = '0.4.0' where key = 'schema_version';
