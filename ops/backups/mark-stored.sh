#!/usr/bin/env bash
# Anota en app.backup_status que la copia cifrada ya está ALMACENADA (con su hash verificado).
# Se ejecuta como ÚLTIMO paso del trabajo, después de subir el archivo: si la subida falla, no se anota.
set -euo pipefail
: "${SOURCE_DB_URL:?Falta SOURCE_DB_URL}"
# La URL va al final: la versión de psql para Windows no admite opciones después de ella.
psql --no-psqlrc -v ON_ERROR_STOP=1 -q -c "update app.backup_status set last_backup_stored_at = now(), updated_at = now() where id = 1" "$SOURCE_DB_URL"
echo "Copia marcada como almacenada" >&2
