# Copias automáticas cifradas

Estado: **scripts y flujo de trabajo listos y probados contra un PostgreSQL real; sin activar.** Falta que crees el repositorio privado, las claves y los secretos (pasos de abajo, los haces tú).

## Qué hace cada día

1. **Vuelca** el esquema `app` de Supabase.
2. **Restaura de prueba, ANTES de cifrar**, en una base de datos desechable y comprueba que cada tabla tiene las mismas filas y que funciones, políticas y seguridad por filas están intactas. Si algo no cuadra, **no hay copia** y el trabajo falla (GitHub te avisa por correo).
3. **Cifra con `age`** para las claves públicas de los dos progenitores: cualquiera de los dos puede abrirla.
4. Calcula el **SHA-256**, guarda el archivo (90 días como artefacto; el día 1 de cada mes, además, como *release* sin caducidad) y **anota el estado** en la base de datos.

Además, al haber actividad diaria, **Supabase no pausa el proyecto** por inactividad.

## Los cuatro estados (no se mezclan)

`app.backup_status` guarda cuatro fechas distintas. Se ven en la app (Ajustes → Cuenta y sincronización, solo administradores):

| Estado | Qué significa | Quién lo anota |
|---|---|---|
| Copia **creada** | Se hizo el volcado | `backup.sh` |
| **Restauración de prueba** | Se restauró en una base vacía y coincide | `backup.sh` |
| Copia **almacenada** | Cifrada, con hash verificado y subida | `mark-stored.sh`, tras subirla |
| **Simulacro con clave real** | Una persona descifró y restauró de verdad | **tú**, cada ~3 meses |

Una copia que nunca se ha restaurado **no cuenta como copia**.

## Puesta en marcha (la haces tú)

### 1. Repositorio privado
En GitHub: **New repository → `babysleep-backups` → Private**. Aquí vivirán el flujo de trabajo, los secretos y las copias. **No** uses el repositorio público.

### 2. Claves (una por progenitor, en su propio dispositivo)
La clave **privada** es lo único que abre las copias: **sin ella no hay recuperación**, y **nadie más** (ni Claude, ni GitHub, ni Supabase) la ve.

1. Instala `age`: en Windows `winget install FiloSottile.age`; en Mac `brew install age`.
2. Genera tu par: `age-keygen -o babysleep.key`. Muestra una línea `Public key: age1…`.
3. **Guarda `babysleep.key` en tu gestor de contraseñas** y haz **otra copia** fuera del móvil/portátil (USB guardado, o impresa). Perder esa clave y la de tu pareja = perder las copias.
4. Comparte **solo la clave pública** (`age1…`) con quien configura el repositorio. Es seguro compartirla.
5. **Prueba tu clave antes de confiar en ella:**
   ```bash
   echo hola > prueba.txt
   age -r age1TU_CLAVE_PUBLICA -o prueba.txt.age prueba.txt
   age -d -i babysleep.key prueba.txt.age     # debe imprimir «hola»
   ```

### 3. Secreto y variable en el repositorio privado
**Settings → Secrets and variables → Actions:**

- **Variable** `AGE_RECIPIENTS`: las dos claves públicas, una por línea.
- **Secreto** `SUPABASE_DB_URL`: en Supabase, **Connect → Session pooler** (compatible con IPv4, puerto 5432), con la contraseña de la base de datos ya dentro de la URL. **No la pegues en el chat.**

### 4. El flujo de trabajo
Copia [`workflow-template/backup.yml`](workflow-template/backup.yml) a `.github/workflows/backup.yml` del repositorio privado y sustituye `REEMPLAZA_POR_EL_SHA_DEL_COMMIT` por el commit del repositorio público que quieras fijar (40 caracteres; Claude te lo dice). Se fija a propósito: si el script cambiara de forma maliciosa, podría leer tus secretos. **Actualiza ese SHA solo tras revisar el cambio.**

### 5. Primera ejecución
**Actions → Copia diaria cifrada → Run workflow.** Debe terminar en verde en unos 3 minutos. Comprueba que aparece el artefacto `babysleep-copia-…` y que en la app el estado muestra la copia creada, la restauración de prueba y la almacenada.

### 6. Simulacro con clave real (cada ~3 meses)
1. Descarga el `.age` y su `.sha256`; comprueba el hash: `sha256sum -c archivo.dump.age.sha256`.
2. Descifra con **tu** clave: `age -d -i babysleep.key -o copia.dump archivo.dump.age`.
3. Restaura en una base de datos nueva (un Postgres local o un proyecto Supabase desechable): `pg_restore --no-owner --no-privileges -d "<url>" copia.dump` (antes, `tests/db/00_supabase_shim.sql` si no es Supabase).
4. Comprueba que ves los bebés y las sesiones.
5. Anótalo: `update app.backup_status set last_full_recovery_drill_at = now(), updated_at = now() where id = 1;`

## Si hay que recuperar de verdad
- La copia solo contiene el esquema `app`. Los **usuarios de acceso** (`auth.users`) se vuelven a crear a mano en el proyecto nuevo (Authentication → Users) con los mismos correos.
- Las cuentas se vuelven a vincular con un código de alta (`app.bootstrap_family` / invitar), como la primera vez.
- Tras una restauración, los móviles conservan sus datos locales y los vuelven a subir: la base local **nunca** se descarta.

## Pruebas
`ops/backups/test-backup.sh` prueba todo esto sobre un PostgreSQL real (19 comprobaciones: cifrado, descifrado con **cada** clave, clave ajena rechazada, archivo manipulado detectado, cuatro estados independientes, fallos que impiden la copia). Se ejecuta en CI y en local con `python tools/test-backup.py`.
