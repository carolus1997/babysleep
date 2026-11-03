#!/usr/bin/env bash
# BabySleep · copia cifrada de la base de datos.
#
#   1. Vuelca el esquema `app` (pg_dump, formato custom).
#   2. PRUEBA TÉCNICA DE RESTAURACIÓN, antes de cifrar: restaura el volcado en una base de datos vacía y
#      comprueba que cada tabla tiene las mismas filas, y que funciones, políticas y RLS están intactas.
#      Si falla, NO hay copia (no se cifra algo que no se sabe restaurar).
#   3. Cifra con `age` para TODAS las claves públicas indicadas (mínimo 2: una por progenitor, de modo que
#      cualquiera de los dos pueda descifrar). La clave privada nunca pasa por este script ni por el servidor.
#   4. Calcula el SHA-256 del archivo cifrado y lo verifica. El volcado en claro se destruye.
#
# Variables de entorno:
#   SOURCE_DB_URL    base de datos a copiar (en Supabase: «Session pooler», compatible con IPv4)
#   SCRATCH_DB_URL   base de datos VACÍA y desechable donde se hace la prueba de restauración
#   AGE_RECIPIENTS   claves públicas age (age1…), una por línea; mínimo 2 distintas
#   OUT_DIR          dónde dejar el .age y su .sha256 (por defecto ./out)
#   WRITE_STATUS     1 = anota en app.backup_status la copia creada y la restauración de prueba
#
# Cada paso escribe en stderr; la última línea de stdout es la ruta del archivo cifrado.
set -euo pipefail

: "${SOURCE_DB_URL:?Falta SOURCE_DB_URL}"
: "${SCRATCH_DB_URL:?Falta SCRATCH_DB_URL}"
: "${AGE_RECIPIENTS:?Falta AGE_RECIPIENTS}"
WRITE_STATUS="${WRITE_STATUS:-0}"
OUT_DIR="${OUT_DIR:-out}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"   # rutas relativas: evita conversiones de rutas con las herramientas nativas de Windows

# ---- 0. destinatarios --------------------------------------------------------------------------
printf '%s\n' "$AGE_RECIPIENTS" | tr -d '\r' | grep -E '^age1[0-9a-z]{50,}$' | sort -u > recipients.txt || true
n_recipients="$(wc -l < recipients.txt | tr -d ' ')"
[ "$n_recipients" -ge 2 ] || die "Se necesitan al menos 2 claves públicas age distintas (una por progenitor); hay $n_recipients"

stamp="$(date -u +%Y%m%d-%H%M%S)"
base="babysleep-$stamp"

# psql con la URL AL FINAL: la versión de psql para Windows no admite opciones después de ella.
psqlu() { local url="$1"; shift; psql --no-psqlrc -v ON_ERROR_STOP=1 "$@" "$url"; }
counts() { psqlu "$1" -tA -f "$HERE/counts.sql"; }

# ---- 1. volcado --------------------------------------------------------------------------------
log "Contando filas del origen (antes)"
counts "$SOURCE_DB_URL" > before.csv
log "Volcando el esquema app"
pg_dump --schema=app --no-owner --no-privileges --format=custom --file="$base.dump" "$SOURCE_DB_URL"
counts "$SOURCE_DB_URL" > after.csv
[ -s "$base.dump" ] || die "El volcado está vacío"
if [ "$WRITE_STATUS" = "1" ]; then
  psqlu "$SOURCE_DB_URL" -q -c "update app.backup_status set last_backup_created_at = now(), updated_at = now() where id = 1"
fi

# ---- 2. prueba técnica de restauración (ANTES de cifrar) ---------------------------------------
log "Restaurando en una base de datos desechable"
psqlu "$SCRATCH_DB_URL" -q -c "drop schema if exists app cascade; drop schema if exists auth cascade;"
psqlu "$SCRATCH_DB_URL" -q -f "$HERE/scratch-shim.sql"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$SCRATCH_DB_URL" "$base.dump"
counts "$SCRATCH_DB_URL" > restored.csv

# Cada tabla restaurada debe estar entre el recuento de antes y el de después del volcado (la base puede
# recibir escrituras mientras se vuelca; las tablas solo crecen). Funciones, políticas y RLS: iguales.
awk -F',' '
  FILENAME == ARGV[1] { b[$1] = $2; next }
  FILENAME == ARGV[2] { a[$1] = $2; next }
  { r[$1] = $2 }
  END {
    bad = 0
    for (t in b) {
      if (!(t in r)) { printf "  falta la tabla %s\n", t; bad = 1; continue }
      if (r[t] + 0 < b[t] + 0 || r[t] + 0 > a[t] + 0) { printf "  %s: antes=%s restaurada=%s después=%s\n", t, b[t], r[t], a[t]; bad = 1 }
    }
    for (t in r) if (!(t in b)) { printf "  sobra la tabla %s\n", t; bad = 1 }
    exit bad
  }' before.csv after.csv restored.csv >&2 || die "La restauración de prueba NO coincide con el origen: no se genera copia"
grep -q '^tablas_sin_rls(app),0$' restored.csv || die "En la restauración hay tablas sin seguridad por filas"
log "Restauración de prueba correcta ($(wc -l < restored.csv | tr -d ' ') comprobaciones)"
if [ "$WRITE_STATUS" = "1" ]; then
  psqlu "$SOURCE_DB_URL" -q -c "update app.backup_status set last_technical_restore_at = now(), updated_at = now() where id = 1"
fi

# ---- 3. cifrado y hash -------------------------------------------------------------------------
log "Cifrando para $n_recipients destinatarios"
age -R recipients.txt -o "$base.dump.age" "$base.dump"
[ -s "$base.dump.age" ] || die "El archivo cifrado está vacío"
# El formato custom de pg_dump empieza por «PGDMP»; si aparece en el archivo cifrado, el cifrado no se aplicó.
if grep -aq 'PGDMP' "$base.dump.age"; then die "El archivo cifrado contiene el volcado en claro"; fi
sha256sum "$base.dump.age" > "$base.dump.age.sha256"
sha256sum -c "$base.dump.age.sha256" > /dev/null || die "El hash no coincide"

mv "$base.dump.age" "$base.dump.age.sha256" "$OUT_DIR/"
rm -f "$base.dump"
log "Copia lista: $base.dump.age ($(wc -c < "$OUT_DIR/$base.dump.age" | tr -d ' ') bytes)"
printf '%s\n' "$OUT_DIR/$base.dump.age"
