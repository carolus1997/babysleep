#!/usr/bin/env bash
# Prueba de extremo a extremo de backup.sh sobre un PostgreSQL real (local o servicio de CI).
#
#   PG_ADMIN_URL=postgresql://postgres:pw@localhost:5432/postgres bash ops/backups/test-backup.sh
#
# Necesita en el PATH: psql, pg_dump, pg_restore, age y age-keygen. Crea y borra sus propias bases de datos.
set -euo pipefail
: "${PG_ADMIN_URL:?Falta PG_ADMIN_URL (superusuario)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
tmp="$(mktemp -d)"
# psql con la URL AL FINAL (la versión de psql para Windows no admite opciones después de ella)
psqlu() { local url="$1"; shift; psql --no-psqlrc -v ON_ERROR_STOP=1 "$@" "$url"; }
trap 'psqlu "$PG_ADMIN_URL" -q -c "drop database if exists bs_source" >/dev/null 2>&1 || true; psqlu "$PG_ADMIN_URL" -q -c "drop database if exists bs_scratch" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

pass=0
ok()   { pass=$((pass + 1)); printf 'ok - %s\n' "$*"; }
fail() { printf 'FALLA: %s\n' "$*" >&2; exit 1; }
sql()  { psqlu "$1" -tA -q -c "$2"; }
url_for() { printf '%s' "$PG_ADMIN_URL" | sed -E "s#/[^/?]*(\\?.*)?\$#/$1\\1#"; }

SRC="$(url_for bs_source)"
SCR="$(url_for bs_scratch)"
sql "$PG_ADMIN_URL" "drop database if exists bs_source"
sql "$PG_ADMIN_URL" "drop database if exists bs_scratch"
sql "$PG_ADMIN_URL" "create database bs_source"
sql "$PG_ADMIN_URL" "create database bs_scratch"

# ---- origen: shim + migraciones + algunos datos ----------------------------------------------
psqlu "$SRC" -q -f "$ROOT/tests/db/00_supabase_shim.sql"
for f in "$ROOT"/database/migrations/*.sql; do psqlu "$SRC" -q -f "$f"; done
sql "$SRC" "select app.bootstrap_family('Familia de prueba', 'Admin', 'admin@example.test')" > /dev/null
sql "$SRC" "insert into app.baby (id, family_id, alias, birth_date) select gen_random_uuid(), id, 'Bebe de prueba', date '2026-07-01' from app.family"
sql "$SRC" "insert into app.sleep_session (id, family_id, baby_id, sleep_start_utc, sleep_end_utc, start_tz, end_tz, sleep_type, type_source, source)
            select gen_random_uuid(), family_id, id, timestamptz '2027-01-14 20:00+00', timestamptz '2027-01-15 05:00+00', 'Europe/Madrid', 'Europe/Madrid', 'night', 'manual', 'manual' from app.baby"

# ---- dos progenitores, cada uno con su clave --------------------------------------------------
age-keygen -o "$tmp/madre.key" 2> /dev/null
age-keygen -o "$tmp/padre.key" 2> /dev/null
age-keygen -o "$tmp/intrusa.key" 2> /dev/null
pub() { age-keygen -y "$1"; }
RECIPS="$(pub "$tmp/madre.key")
$(pub "$tmp/padre.key")"

export SOURCE_DB_URL="$SRC" SCRATCH_DB_URL="$SCR" AGE_RECIPIENTS="$RECIPS" OUT_DIR="$tmp/out" WRITE_STATUS=1

# ---- 1. copia correcta ------------------------------------------------------------------------
out="$(bash "$HERE/backup.sh" 2> "$tmp/log.txt" | tail -n 1)" || { cat "$tmp/log.txt" >&2; fail "backup.sh falló con datos correctos"; }
[ -s "$out" ] && ok "se genera el archivo cifrado"
[ -s "$out.sha256" ] && (cd "$(dirname "$out")" && sha256sum -c "$(basename "$out").sha256" > /dev/null) && ok "el SHA-256 coincide"
ls "$tmp/out" | grep -vq '\.age\(\.sha256\)\?$' && fail "en la salida hay algo que no es .age ni .sha256 (¿volcado en claro?)"
ok "en la salida solo hay el archivo cifrado y su hash"
grep -aq 'PGDMP' "$out" && fail "el archivo cifrado contiene el volcado en claro"
ok "el archivo cifrado no contiene el volcado en claro"
grep -q 'Restauración de prueba correcta' "$tmp/log.txt" && ok "se hizo la restauración de prueba antes de cifrar"

# ---- 2. CADA progenitor puede descifrar y el volcado es restaurable ---------------------------
for who in madre padre; do
  age -d -i "$tmp/$who.key" -o "$tmp/$who.dump" "$out" || fail "$who no puede descifrar"
  head -c 5 "$tmp/$who.dump" | grep -q 'PGDMP' || fail "lo descifrado por $who no es un volcado de pg_dump"
  pg_restore -l "$tmp/$who.dump" | grep -q 'TABLE app baby' || fail "el volcado de $who no contiene la tabla baby"
  ok "$who descifra la copia y es un volcado válido"
done
cmp -s "$tmp/madre.dump" "$tmp/padre.dump" && ok "las dos claves descifran exactamente lo mismo"

# ---- 3. una clave ajena NO puede ---------------------------------------------------------------
if age -d -i "$tmp/intrusa.key" -o "$tmp/intrusa.dump" "$out" 2> /dev/null; then fail "una clave ajena descifró la copia"; fi
ok "una clave ajena no puede descifrarla"

# ---- 4. la manipulación se detecta ------------------------------------------------------------
cp "$out" "$tmp/tampered.age"
printf 'X' | dd of="$tmp/tampered.age" bs=1 seek=100 conv=notrunc 2> /dev/null
if age -d -i "$tmp/madre.key" -o "$tmp/t.dump" "$tmp/tampered.age" 2> /dev/null; then fail "age aceptó un archivo manipulado"; fi
( cd "$tmp" && cp "$out.sha256" t.sha256 && sed -i "s#  .*#  tampered.age#" t.sha256 && ! sha256sum -c t.sha256 > /dev/null 2>&1 ) && ok "un archivo manipulado se detecta (cifrado autenticado y SHA-256)"

# ---- 5. estados en app.backup_status ----------------------------------------------------------
created="$(sql "$SRC" "select last_backup_created_at is not null from app.backup_status")"
restore="$(sql "$SRC" "select last_technical_restore_at is not null from app.backup_status")"
stored="$(sql "$SRC" "select last_backup_stored_at is not null from app.backup_status")"
drill="$(sql "$SRC" "select last_full_recovery_drill_at is not null from app.backup_status")"
[ "$created,$restore,$stored,$drill" = "t,t,f,f" ] && ok "los cuatro estados son independientes: creada y restaurada sí; almacenada y simulacro aún no"
SOURCE_DB_URL="$SRC" bash "$HERE/mark-stored.sh" 2> /dev/null
[ "$(sql "$SRC" "select last_backup_stored_at is not null from app.backup_status")" = "t" ] && ok "mark-stored anota la copia como almacenada"

# ---- 6. fallos que DEBEN impedir la copia ------------------------------------------------------
if AGE_RECIPIENTS="$(pub "$tmp/madre.key")" OUT_DIR="$tmp/out2" bash "$HERE/backup.sh" > /dev/null 2>&1; then fail "se aceptó una sola clave"; fi
ok "con una sola clave pública no se genera copia (deben poder abrirla los dos progenitores)"
if AGE_RECIPIENTS="no-es-una-clave
tampoco" OUT_DIR="$tmp/out3" bash "$HERE/backup.sh" > /dev/null 2>&1; then fail "se aceptaron claves inválidas"; fi
ok "claves inválidas se rechazan"
[ ! -e "$tmp/out2" ] || [ -z "$(ls -A "$tmp/out2" 2> /dev/null)" ] && ok "tras un fallo no queda ningún archivo en la salida"

# Restauración que no coincide: se corrompe el esquema de la base desechable justo antes de comparar
# (se simula con un SCRATCH que ya tiene objetos incompatibles y sin permiso para borrarlos).
bad_before="$(sql "$SRC" "select count(*) from app.baby")"
if SCRATCH_DB_URL="postgresql://nadie:mal@localhost:1/none" OUT_DIR="$tmp/out4" bash "$HERE/backup.sh" > /dev/null 2>&1; then fail "se dio por buena una restauración imposible"; fi
ok "si la restauración de prueba no se puede hacer, no se genera copia"
[ "$(sql "$SRC" "select count(*) from app.baby")" = "$bad_before" ] && ok "la copia no altera los datos del origen"

# Una restauración que NO coincide con el origen debe impedir la copia: se corrompe a propósito la base
# desechable justo antes de comparar (en una copia del script, para no tocar el real).
sed 's|^counts "\$SCRATCH_DB_URL" > restored.csv|psqlu "$SCRATCH_DB_URL" -q -c "delete from app.sleep_session"\n&|' "$HERE/backup.sh" > "$HERE/.backup-corrupt.sh"
grep -q 'delete from app.sleep_session' "$HERE/.backup-corrupt.sh" || fail "no se pudo preparar la prueba de corrupción"
if OUT_DIR="$tmp/out5" bash "$HERE/.backup-corrupt.sh" > /dev/null 2> "$tmp/corrupt.log"; then rm -f "$HERE/.backup-corrupt.sh"; fail "se dio por buena una restauración que NO coincide con el origen"; fi
rm -f "$HERE/.backup-corrupt.sh"
grep -q 'NO coincide con el origen' "$tmp/corrupt.log" && ok "una restauración que no coincide con el origen impide la copia"
[ -z "$(ls -A "$tmp/out5" 2> /dev/null)" ] && ok "y no deja ningún archivo cifrado"

printf '\n%s comprobaciones correctas\n' "$pass"
