-- BabySleep · migración 0017 · varios motivos por despertar (contrato v0.11.0)
--
--  * `awakening.reasons`: los motivos de un despertar (se pueden marcar varios): toma, enfermedad, incomodidad,
--    sueño u otro. `diaper` y `crying` ya no se ofrecen, pero se admiten porque hay registros antiguos.
--  * `awakening.reason_note`: texto libre para explicar el motivo «otro».
--  * La columna antigua `reason` se conserva: los registros de antes siguen tal cual y los móviles aún sin actualizar
--    pueden seguir enviando datos.
--  * `apply_changes` no cambia: admite las columnas que tenga la tabla.
--
-- HAY QUE EJECUTARLA ANTES de publicar la versión de la app que la usa: si no, el servidor rechaza los despertares.

alter table app.awakening
  add column if not exists reasons text[] not null default '{}',
  add column if not exists reason_note text;

alter table app.awakening
  drop constraint if exists awakening_reasons_check,
  drop constraint if exists awakening_reason_note_check;
alter table app.awakening
  add constraint awakening_reasons_check
    check (reasons <@ array['feeding', 'illness', 'discomfort', 'sleep', 'other', 'diaper', 'crying']::text[]
           and cardinality(reasons) <= 7),
  add constraint awakening_reason_note_check check (reason_note is null or char_length(reason_note) <= 500);

update app.app_meta set value = '0.17.0' where key = 'schema_version';
