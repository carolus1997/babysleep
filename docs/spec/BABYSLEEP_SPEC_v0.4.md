# BabySleep Analytics: Especificación consolidada v0.4.1

Estado: **aprobada con correcciones. Fase 0 autorizada.** Esta versión (0.4.1) incorpora las correcciones de la ronda de aprobación. Donde la enmienda contradice el cuerpo, **prevalece la enmienda**.

## Enmiendas v0.4.1 (prevalecen sobre el cuerpo)

**E1. Valores operativos aprobados (provisionales y configurables).** Caducidad del OTP 15 min. Tolerancia de fin de sesión 2 min. Tolerancia para proponer fusión de inicios 5 min. Umbral de revisión de latencia 3 h. Zona `Europe/Madrid`. Idioma español. Las tolerancias son ajustes de familia y **nunca provocan pérdida automática de registros**. Dominio propio para el correo: aprobado en principio, condicionado a confirmar coste y condiciones del proveedor. **No hay contratación ni gasto autorizados.** El proveedor SMTP se elige en la validación técnica.

**E2. Tres vistas temporales distintas** (sustituye al texto de §3 sobre ventanas): *día natural local* (23, 24 o 25 h), *ventana móvil de 24 horas reales* (siempre 24 h) y *noche completa atribuida a la fecha de despertar* (etiqueta que no recorta). Cada métrica lleva su `kind` y su etiqueta visible. Implementado en `packages/core/src/time/sleep.ts` y descrito en `docs/adr/0002-modelo-temporal.md`.

**E3. Sesiones solapadas (nueva regla).** Los totales temporales usan la **unión de intervalos**; dos registros del mismo sueño por distintos cuidadores nunca duplican el total. Ambos registros se conservan (trazabilidad). Los solapes quedan `pending_review`; si los inicios difieren ≤ 5 min se marcan como probable duplicado para proponer una fusión de un toque. Las sesiones fusionadas o eliminadas no cuentan, pero se conservan. Cubierto por pruebas, incluidos duplicados generados sin conexión y propiedades sobre un periodo con cambio de hora.

**E4. `claim_membership()` protegida** (sustituye a §8.4 en lo relativo a la vinculación). No existirá una función libremente invocable. El procedimiento exige:
1. Una **ventana de recuperación abierta por un administrador** (`open_claim_window(caregiver_id)`, función privilegiada, no invocable por `anon` ni `authenticated`). Genera un código de un solo uso de 128 bits, almacenado como hash, con caducidad (30 min) y límite de 5 intentos.
2. Una sesión OTP con el **correo verificado** que coincide con la fila `caregiver` preexistente en estado `invited`.
3. El **código de recuperación entregado fuera de banda** (en persona o por otro canal por el otro progenitor, o por quien opera el proyecto).
4. Registro de auditoría de cada intento. Nunca modifica el rol ni vincula un cuidador ya vinculado salvo ventana abierta expresamente. Aviso al otro progenitor.

Las funciones serán `SECURITY DEFINER` con `search_path` fijo y `EXECUTE` revocado a `public`. **Pruebas de seguridad exigidas (pgTAP):** sin sesión denegado; usuario autenticado con otro correo denegado; correo correcto sin código denegado; código correcto con otro correo denegado; código caducado; código reutilizado; bloqueo tras 5 intentos; no vincula a un cuidador ya vinculado; no escala rol; aislamiento entre familias tras la vinculación; función no ejecutable por `anon`. **Estado: diseñado, aún no implementado ni probado.**

**E5. Cuatro estados de copia, siempre distintos** en la app (columnas de `app.backup_status`): *última copia creada*, *última copia cifrada y almacenada correctamente* (hash verificado), *última restauración técnica satisfactoria* (en CI, antes de cifrar) y *última recuperación completa desde copia cifrada* (simulacro humano con clave real). **Verificar la integridad del archivo no se presenta como verificación de recuperabilidad.** Los simulacros con claves reales se mantienen fuera de CI.

**E6. Criterios de Fase 0 corregidos** (sustituyen a V9 y a cualquier espera de 90 días). El comportamiento de GitHub Actions se valida con **pruebas inmediatas**: ejecución manual y programada, supervisión del estado, detección de una ejecución fallida provocada a propósito y documentación del riesgo residual. La entrega de OTP en menos de un minuto es un **objetivo operativo medido en una tanda de pruebas, no una garantía**. Lo que dependa de observación prolongada se gestiona con seguimiento posterior y **no bloquea** el desarrollo.

**E7. Prioridad: empezar a registrar cuanto antes.** La Fase 0 se divide: **0A (fundamentos)** habilita directamente la Fase 1 (app móvil local). **0B (validaciones de sincronización, autenticación, seguridad y recuperación)** debe completarse antes de la Fase 2 y de depender de la sincronización, pero **no bloquea la Fase 1**. El modelo de datos admite desde el principio todas las funciones aprobadas. Mientras no haya sincronización ni copia automática, la mitigación de pérdida de datos es la **exportación manual JSON/CSV con recordatorio** desde la primera versión.

**E8. Esquema.** Los datos de aplicación viven en el esquema `app` (no `public`). Donde el cuerpo dice «solo el esquema `public`», léase `app`. El acceso del cliente se hará mediante funciones RPC expuestas de forma explícita.

**E9. Privacidad del repositorio.** Los datos reales no entran en el repositorio público. Los fixtures versionados son sintéticos; el conjunto real de cinco días solo existe en `tests/fixtures/private/` (ignorado por git).

---

Sustituye a la v0.3. Integra las decisiones funcionales del propietario y corrige la estrategia de copias.

Convención: **[CERRADO]** es una decisión funcional o arquitectónica ya tomada. **[SPIKE]** es un punto que requiere validación técnica en la Fase 0, con criterio de aceptación explícito (sección 13).

---

## 1. Decisiones cerradas

| # | Decisión |
|---|---|
| F1 | Las duraciones nocturnas históricas (~11–12 h) son **sesiones nocturnas**: inicio = bebé comprobado dormido, fin = despertar. Puede haber despertares intermedios no registrados. No son sueño efectivo continuo ni tiempo en cama. La exhaustividad de despertares es **desconocida**. No se modifican ni se inventan interrupciones. |
| F2 | «Iniciar sueño» significa **«hemos comprobado que el bebé está dormido»**, igual para siestas y noche. No es el inicio de acostarlo. |
| F3 | Registro **opcional** de conciliación: inicio del intento de dormir y colocación en la cuna, ambos opcionales. Inicio y fin del sueño observado son obligatorios. |
| F4 | Latencia = `inicio del sueño observado − inicio del intento`. Sin intento registrado la latencia es **desconocida, nunca cero**. La colocación en cuna no se usa para la latencia. |
| F5 | Zona de referencia `Europe/Madrid`. El modelo conserva IANA, offsets y DST por evento. |
| F6 | Dos cuidadores (Progenitor A y B) con los mismos derechos. El modelo admite más roles después. |
| F7 | Autenticación solo por **OTP de 6 dígitos por correo**. Sin contraseñas ni código maestro. |
| F8 | Copias cifradas con `age`, una identidad de recuperación por progenitor, claves fuera de GitHub y de CI. |
| F9 | D1–D7 aprobadas: núcleo TS compartido, dashboard React en Docker, conflictos (con revisión de D3, ver 7), copias cifradas (condicionada a la sección 8), OTP + región UE, Luxon tras módulo propio, atribución nocturna por fecha de despertar más ventana de 24 h. |
| F10 | React + TS, PWA, GitHub Pages, Dexie, Supabase (UE), Docker Compose oficial, español con i18n, repo público sin datos, alias por bebé, foto opcional **sin sync**, exportación JSON/CSV desde la primera fase. |
| F11 | Latencia de conciliación es métrica oficial. Solo se calcula con marcas suficientes y nunca produce conclusiones causales automáticas. |

---

## 2. Arquitectura v0.4

```text
 Móvil A (Progenitor A)      Móvil B (Progenitor B)         Docker Compose (oficial)
 React PWA · Pages           React PWA · Pages              ├─ dashboard: nginx + SPA React/ECharts
 Dexie + outbox              Dexie + outbox                 ├─ reports: Chromium headless (PDF)
 packages/core (Worker)      packages/core (Worker)         ├─ recovery: herramientas de restauración
        │ OTP + sync                │ OTP + sync            └─ lab (perfil opcional): Python
        └──────────────┬────────────┘                                  │ login OTP del progenitor
                       ▼                                                │ (sin clave de servicio)
          Supabase UE: Postgres · Auth · RLS · RPC apply_changes ◄──────┘
                       │ (conexión por pooler compartido)
                       ▼
     Repositorio PRIVADO de copias · GitHub Actions
       pg_dump → restauración de prueba → cifrado age (2 destinatarios)
       → subida → verificación SHA-256 → backup_status
                       │
     Clave privada A / clave privada B: fuera de GitHub y de CI
```

- **`packages/core`** (TS, único) contiene tiempo, métricas, estadística, predicción e interpretación. Los fixtures dorados se generan con Python/scipy solo en CI.
- **Monorepo:** `apps/{mobile,dashboard}`, `packages/{core,contract,sync,evidence}`, `database/` (migraciones, RLS, RPC, pgTAP), `tools/{oracle-py,recovery}`, `docker/`, `docs/{adr,spec}`.
- **Coste previsto:** Supabase gratuito, GitHub gratuito, Docker gratuito. Único coste recurrente probable: un dominio para el SMTP del OTP (~10–15 €/año, estimación **[SPIKE]**).

---

## 3. Modelo temporal v0.4

**Principio.** Todo evento se guarda como instante UTC más zona IANA y offset vigente. Las duraciones se calculan siempre sobre instantes. Las agrupaciones etiquetan o recortan, nunca alteran una duración.

**Cuatro conceptos que no se mezclan**

| Concepto | Definición |
|---|---|
| Duración registrada | `sleep_end − sleep_start`: de «observado dormido» a «observado despierto» |
| Tiempo despierto registrado | Unión de episodios de despertar conocidos, recortada a la sesión, sin solapes |
| Efectivo dormido | `registrada − despierto registrado`, **solo como cota superior** mientras la exhaustividad sea `unknown` o `partial`. Valor puntual solo si el cuidador marca la sesión como `complete`. La cota inferior no se calcula |
| Sueño en ventana de 24 h | Σ de intersecciones con la ventana (día civil `Europe/Madrid`, que puede medir 23 o 25 h) |

**Atribución.** Una sesión nocturna se atribuye a la fecha local de su despertar (`wake_date_local`). Las siestas se atribuyen a la fecha local de su inicio. La atribución suma duraciones completas. El recorte por ventana las parte. Se muestran con nombres distintos. Invariante: `Σ recortes = Σ atribuidos = Σ duraciones`.

**Semántica fija.** `interval_semantics = observed_asleep_to_observed_awake`. El campo existe para versionar el significado si cambia, pero hoy es constante. El «tiempo en cama» no es una métrica de la v0.4.

**Tiempos aproximados.** Cada marca temporal tiene `*_quality ∈ {exact, approx}`. Una corrección posterior es una edición normal con historial. Si una marca de entrada es aproximada, las métricas derivadas heredan `approx`.

**Entradas locales ambiguas.** Una hora local inexistente (salto de primavera) se rechaza. Una ambigua (retroceso de otoño) pide elegir offset. El cronómetro captura instantes y no sufre este problema.

**Casos de prueba obligatorios** (`Europe/Madrid` salvo indicación)
1. 21:30→06:30: 9 h. Recorte 2,5 h + 6,5 h. Atribuida al día del despertar: 9 h.
2. Salto de primavera: 27-mar-2027 21:00 → 28-mar 07:00 = **9 h reales**. El día 28 mide 23 h.
3. Retroceso de otoño: 24-oct-2026 21:00 → 25-oct 07:00 = **11 h reales**. El día 25 mide 25 h.
4. 25-oct-2026 02:30 es ambigua y exige elección. 28-mar-2027 02:30 no existe y se rechaza.
5. Cambio de zona: 15-ene-2027 22:00 Madrid → 16-ene 06:00 `America/Bogota` = 14 h, marcada `tz_changed`.
6. Sesión abierta: recortada a «ahora» con marca y excluida de medias de duración.
7. Duración negativa, >24 h y solapes: anomalía visible, nunca borrado automático.
8. **Latencia con DST:** intento a las 01:50 CET y sueño a las 03:10 CEST el 28-mar-2027 = 20 min reales, no 80.
9. **Latencia desconocida:** sin intento → `null` (nunca 0). Intento posterior al inicio del sueño → anomalía, latencia `null`. Colocación en cuna posterior al sueño → no interviene.
10. Propiedades con husos y fechas aleatorias: la agrupación no cambia ninguna suma. Efectivo dormido con `unknown` devuelve solo cota superior y con despertares solapados no cuenta dos veces.
11. **Datos históricos:** las duraciones originales no cambian y los agregados no entran en ventanas de vigilia.

---

## 4. Registro opcional de conciliación

**Entidad `settling_attempt`.** Existe antes de que haya sesión, porque el intento ocurre antes de comprobar que duerme.

| Campo | Notas |
|---|---|
| `started_utc` | Opcional. Inicio del intento |
| `put_down_utc` | Opcional. Colocación en la cuna |
| `*_quality` | `exact` o `approx` |
| `status` | `open` → `linked` (se enlaza al iniciar sueño) o `abandoned` (si el intento caduca sin sueño; no se borra) |

Debe existir al menos una de las dos marcas. `sleep_session.settling_attempt_id` es opcional.

**Interacción móvil** (la acción principal no cambia)
- Botón grande: **Iniciar sueño** (= «ya duerme»). Con la sesión abierta pasa a **Finalizar sueño**.
- Botón secundario discreto: **«Empezar a dormirlo»**. Con un intento abierto aparece un chip **«Colocado en la cuna»**. Iniciar sueño enlaza el intento sin pasos extra.
- Tras iniciar el sueño aparece una tira opcional de etiquetas de conciliación (categoría `settling_difficulty`) y una nota, saltables.
- Si se olvida, el intento se puede añadir o corregir a posteriori desde el historial.

**Latencia**
- Se calcula si hay `started_utc` ≤ `sleep_start` y la sesión tiene sueño observado. Calidad = `approx` si alguna marca lo es.
- Anomalía si es negativa o supera un máximo configurable (por defecto 3 h): se marca, no se borra.
- La colocación en cuna genera, si se quiere, una métrica distinta (`crib_to_sleep`), válida solo con `put_down ≤ sleep_start`.

**Métricas y análisis de latencia** (núcleo TS)
- Descriptivas: n, media, mediana, IQR y DE. Con n pequeño no se muestra CV.
- Desglose siesta vs. noche; evolución por semana de edad (medianas con n).
- Asociación con la vigilia anterior: se mide con la **vigilia hasta el inicio del intento** (`fin sueño anterior → started_utc`). Usar la vigilia hasta el sueño observado acoplaría matemáticamente ambas variables, porque la latencia forma parte de ella. Se usa correlación de rangos (Spearman) con IC bootstrap, con umbral mínimo de n.
- Asociación con etiquetas: comparación de medianas con IC bootstrap y umbral de n por grupo.
- Textos siempre descriptivos («se observa», nunca «provoca»). No hay conclusiones causales automáticas.

---

## 5. Usuarios y cuidadores

- `caregiver` es entidad de **aplicación**: `caregiver_id` (estable), `family_id`, `display_name` («Progenitor A/B», editable), `email_normalized`, `auth_user_id` (nulo hasta el primer acceso), `role` (`admin` hoy para ambos; reservados `caregiver` y `viewer`), `status`.
- **Todas las columnas de autoría referencian `caregiver_id`**, nunca `auth.users.id`. Esto desacopla los datos de la tabla de identidades de Supabase y es la base de la recuperación (sección 8).
- RLS: `family_id` está denormalizado en todas las tablas y el acceso se decide con una función `is_family_member(family_id)`. El permiso por bebé queda reservado (`baby_acl`) para ampliaciones.
- Las altas son cerradas: el registro público está deshabilitado y los dos usuarios se crean por administración (ceremonia de arranque documentada). Más cuidadores solo se añadirán con invitación mediante una función de servidor, nunca desde el cliente.

---

## 6. Autenticación OTP

**Validado en documentación oficial** ([fuentes](#14-fuentes))

| Aspecto | Resultado |
|---|---|
| Código de 6 dígitos | Se obtiene incluyendo `{{ .Token }}` en la plantilla de correo (la plantilla «Magic Link» y la de alta). Se verifica con `verifyOtp` (`type: 'email'`) |
| Caducidad | 1 h por defecto, configurable. Más de un día no recomendado. **Es un ajuste compartido** con otros enlaces por correo. Se propone 10–15 min **[SPIKE]** (mínimo permitido) |
| Reintentos | Un OTP por usuario cada 60 s (configurable). Verificación: 30 peticiones/5 min por IP |
| SMTP integrado | Entrega **solo a miembros del equipo de la organización** y 2 correos/hora, sin garantía. **No sirve para producción: requiere SMTP propio** (Resend, Brevo, Postmark, SES…) |
| SMTP propio | Tras configurarlo, entrega a cualquier dirección. Límite inicial 30/h, ampliable. Recomiendan SPF, DKIM, DMARC y dominio propio |
| Alta automática | `signInWithOtp` crea usuarios por defecto. Con registro público deshabilitado y `shouldCreateUser: false` no se pueden crear cuentas desde el cliente |

**Plantilla en español.** Asunto «Tu código de acceso a BabySleep», cuerpo con el código, su caducidad y «si no lo has pedido, ignóralo». Sin enlace.

**No verificado en documentación, a comprobar en un iPhone real [SPIKE]**
- El campo del código con `autocomplete="one-time-code"` y `inputmode="numeric"`, para que iOS sugiera el código desde Mail.
- Al cambiar de la PWA a Mail y volver, el estado de la pantalla de login no debe perderse.
- La sesión persiste entre arranques y tras varios días offline. El refresco del token al reconectar funciona.
- **El almacenamiento de la PWA instalada en iOS es independiente del de Safari.** Si se registra en Safari antes de instalar, esos datos locales no se ven desde la PWA. Mitigación: onboarding «instala primero, inicia sesión después». El sync trae todo tras el primer login.
- Entregabilidad real del correo OTP a ambos proveedores de correo de los progenitores, incluyendo spam.

**Separación de conceptos.** El OTP concede acceso a la app. Las claves `age` solo descifran copias. Son sistemas y guías independientes.

---

## 7. Sincronización y conflictos (D3 revisada)

**Protocolo** (sin cambios): UUIDv7 en cliente, outbox con `op_id` idempotente, RPC transaccional `apply_changes`, `change_seq` por familia, pull incremental, historial de revisiones append-only, sin DELETE para el cliente, desfase de reloj registrado por dispositivo.

**Principio nuevo: nunca hay un «perdedor» irrecuperable.** Cada valor desplazado queda en `revision` y en `sync_conflict`, restaurable con un toque durante toda la vida de los datos. La elección automática afecta solo al valor vigente.

| Caso | Valor vigente | Trazabilidad | Revisión |
|---|---|---|---|
| Campos distintos editados a la vez | Fusión de ambos | Revisión de cada op | No |
| Mismo evento (fin de sueño), diferencia ≤ 2 min | Primero recibido | Valor alternativo guardado, resolución marcada `auto` y listada en un registro de resoluciones | No obligatoria |
| Mismo evento, diferencia > 2 min | Primero recibido, marcado **`conflict_open`** | Ambos valores en `sync_conflict`. La sesión entra en métricas con indicador de calidad, excluible por filtro | **Sí** |
| Dos inicios offline del mismo bebé | Se aceptan ambos | Si difieren ≤ 5 min se propone fusión de un toque; `merged_into` conserva ambos | Sí |
| Edición vs. borrado | **La fila se conserva** y se marca «editada tras eliminar» | Revisión de la edición y del borrado | Sí |
| Observaciones nuevas | Conviven | Cada una con su UUID | No |
| Etiquetas de observación | Unión (gana la adición) | Tombstones por relación | No |
| Perfil del bebé | Último por campo | Historial completo | No |

Las tolerancias son ajustes de familia. El orden de llegada al servidor no es el orden real de los hechos, y por eso nunca decide de forma definitiva un conflicto material.

**Restauración y dispositivos.** Una restauración desde copia crea un nuevo `db_epoch`. Si un cliente detecta epoch distinto, **no descarta su base local**: reconcilia subiendo las filas que el servidor no tiene. Así una copia antigua no destruye registros más recientes que sigan en un móvil.

---

## 8. Copias de seguridad y recuperación (estrategia corregida)

### 8.1 Corrección del problema de v0.3

Descifrar en CI exigiría darle una clave privada. En su lugar, la verificación se divide en cuatro controles, cada uno sin descifrar:

1. **Restaurar antes de cifrar.** En el mismo job, el volcado en claro se restaura en un Postgres efímero (imagen `supabase/postgres`, con roles y esquemas estándar) y se verifica. El texto en claro vive solo en el disco temporal del runner, que se destruye al terminar.
2. **Cifrar** con `age` a dos destinatarios (claves públicas A y B).
3. **Verificar el archivo almacenado:** se vuelve a descargar y se comprueba SHA-256, tamaño y cabecera `age`. Un manifiesto mínimo en claro registra fecha, hash, tamaño, versión de esquema y `db_epoch`. El manifiesto detallado (recuentos, versiones) viaja cifrado dentro del paquete.
4. **Simulacro humano trimestral** con una clave real (8.5).

Residual honesto: CI no puede comprobar que el archivo se descifra con las claves reales. Eso solo lo prueba el simulacro y la ceremonia inicial.

### 8.2 Flujo diario (repositorio privado, GitHub Actions)

`pg_dump` por el **pooler compartido en modo sesión** → restaurar en Postgres efímero → suite de verificación (ver 8.4) → comprimir y cifrar → subir como Release → descargar y comprobar hash → actualizar `backup_status` → retención 7 diarias / 4 semanales / 12 mensuales.

### 8.3 Claves de recuperación sencillas

- Cada progenitor genera su identidad `age` con la herramienta guiada del servicio `recovery` (un comando, sin conocimientos criptográficos). Se guarda la clave en su **gestor de contraseñas y en una copia en papel** guardada en casa. Las claves públicas se publican en el repositorio privado.
- **Ceremonia inicial obligatoria:** se cifra un archivo canario a los dos destinatarios. Cada progenitor lo descifra por su cuenta para demostrar que custodia su clave.
- Cualquiera de las dos claves basta para descifrar. Si se pierden ambas, las copias son irrecuperables. Esa es la limitación a aceptar y mitigar con papel más gestor.
- Rotar o añadir destinatarios afecta solo a copias nuevas; las antiguas se reciclan con una clave válida.

### 8.4 Qué se verifica en cada restauración de prueba

- Estructura: esquema y versión coinciden con las migraciones del repositorio.
- Contenido: recuentos por tabla frente a los de origen tomados en la misma instantánea. Totales de duración. Integridad referencial.
- **RLS:** se comparan las políticas con las de las migraciones y se ejecuta la suite pgTAP de aislamiento sobre la base restaurada, con dos familias de prueba y usuarios sintéticos.
- **Acceso (la cuestión que planteas):** el contrato de restauración es **solo el esquema `public`**. Las identidades de `auth` **no se necesitan** porque los datos referencian `caregiver_id` y no `auth.users`. Al restaurar en un proyecto nuevo, los dos progenitores inician sesión por OTP, obtienen nuevo `auth.uid()` y una función `claim_membership()` los enlaza por **correo verificado** con su fila `caregiver` existente. El test lo recorre con usuarios sintéticos y comprueba que cada uno ve exactamente los datos de su familia.
- Contador `change_seq` y `db_epoch` coherentes tras la carga.

### 8.5 Procedimiento de restauración completa (runbook)

1. Crear un proyecto Supabase en la UE y deshabilitar el registro público.
2. Aplicar las migraciones (`database/`), que recrean tablas, políticas RLS y funciones.
3. Crear los dos usuarios por administración y configurar SMTP.
4. Descifrar la copia con una de las dos claves (`recovery decrypt`).
5. Cargar los datos (solo `public`) y ejecutar el script de verificación.
6. Apuntar PWA y dashboard al nuevo proyecto y generar nuevo `db_epoch`.
7. Cada progenitor inicia sesión; `claim_membership()` enlaza las cuentas; los móviles reconcilian.
8. Comprobar con una sesión de prueba creada en un móvil.

**Simulacro trimestral:** un issue recurrente en el repositorio privado lanza el runbook sobre un proyecto desechable. Lo ejecuta el progenitor que corresponda por turnos con **su** clave, y registra fecha y resultado.

### 8.6 Viabilidad y coste (documentación oficial)

- El plan gratuito de Supabase **no ofrece copias de seguridad automáticas**; recomiendan exportar con la CLI. La estrategia las crea por nuestra cuenta.
- La conexión directa de Supabase es IPv6 y los runners de GitHub Actions son IPv4. **Se usa el pooler compartido** (modo sesión, puerto 5432), disponible sin pago.
- El plan gratuito pausa proyectos con poca actividad en ~7 días. Con uso diario no ocurrirá, y el job diario añade actividad. La ventana de restauración tras una pausa tiene documentación contradictoria (90 días frente a 1 año). Esta estrategia no depende de ella.
- Planes de GitHub: los workflows programados de **repos públicos** se desactivan tras 60 días sin actividad; la documentación no aclara el caso de repos privados. Se cubre con el aviso de «copia caducada» en la app y la copia local opcional.
- Tamaños: base de MBs frente al límite de 500 MB. Coste de Actions estimado <15 min/día, muy por debajo de la cuota gratuita (confirmar cuota vigente **[SPIKE]**).
- **[SPIKE]** El rol de volcado necesita leer todas las filas pese a RLS (`BYPASSRLS` o rol equivalente). Si Supabase no permite crear ese rol, se usa un secreto con el rol `postgres` en el repositorio privado, con rotación documentada.

### 8.7 Otras protecciones

Borrado lógico con papelera de 30 días. Sin DELETE para clientes. Historial de revisiones. Exportación manual JSON/CSV con recordatorio semanal. Aviso en la app si la última copia verificada supera 3 días. Copia local opcional con el servicio `recovery`/`backup` de Compose.

---

## 9. Modelo de datos v0.4

**Columnas comunes** a toda tabla sincronizada: `id` (UUIDv7 de cliente), `family_id`, `rev`, `change_seq`, `created_at`, `updated_at` (servidor), `created_by` y `updated_by` (`caregiver_id`), `origin_device_id`, `deleted_at`.

| Tabla | Campos principales |
|---|---|
| `family` | nombre, `home_tz` (= `Europe/Madrid`), ajustes (tolerancias, máximo de latencia) |
| `caregiver` | ver sección 5 |
| `device` | `caregiver_id`, etiqueta, `last_seen`, `clock_offset_ms` |
| `baby` | alias, fecha de nacimiento, color, ajustes. La foto es **local, no sincronizada** |
| `sleep_session` | `baby_id`, `sleep_start_utc`, `sleep_end_utc` (nulo si abierta), `start_tz`, `end_tz`, offsets, `start_quality`, `end_quality`, `sleep_type`, `type_source`, `interval_semantics`, `awakenings_completeness` (`unknown`/`partial`/`complete`, por defecto `unknown`), `settling_attempt_id`, `source`, `merged_into` |
| `settling_attempt` | `baby_id`, `started_utc`, `put_down_utc`, calidades, `tz`, `status` |
| `wake_episode` | `session_id`, `start_utc`, `end_utc`, calidades, tipo `timed`/`duration_only`, `duration_min` |
| `observation` | `session_id` **o** `settling_attempt_id`, `moment` (`onset`/`during`/`wake`/`settling`), `occurred_utc`, texto, autor |
| `tag` | `tag_slug` estable, categoría (incluye `settling_difficulty`), tipo sistema/personalizada, `label_i18n`, archivada |
| `observation_tag` | `observation_id`, `tag_id`, tombstone |
| `event_category`, `life_event` | `baby_id` (o toda la familia), categoría, fecha inicio/fin (fecha civil), descripción, notas |
| `aggregate_period` + `aggregate_item` | Históricos agregados: etiqueta («Día 1»…), tipo noche/siesta, duración en segundos, semántica `observed_asleep_to_observed_awake`, `awakenings_completeness = unknown`. **Inmutables, separados de las sesiones, sin fechas inventadas** |
| `revision` | tabla, fila, `rev`, `change_seq`, parche, instantánea, autor, dispositivo, instante |
| `sync_conflict` | tabla, fila, campo, valores, tipo, estado (`open`/`auto`/`resolved`), resolución |
| `applied_op` | `op_id`, resultado (idempotencia) |
| `family_counter` | `change_seq` por familia |
| `app_meta` | `db_epoch`, versión de esquema |
| `backup_status` | última copia verificada (escrita solo por CI) |

Solo en el cliente (Dexie): `outbox`, `sync_state` (cursor y epoch), foto local.

**Fixtures sintéticos** marcados con `source = synthetic`, en otra familia, nunca mezclados con registros reales.

---

## 10. Métricas oficiales (núcleo TS)

Duración registrada, despierto registrado, efectivo dormido (rango), sueño en ventana de 24 h, atribuido por día, número de siestas, ventanas de vigilia por posición (fin de sueño → inicio de sueño observado), hora de inicio y despertar (estadística circular), calidad del dato, **latencia de conciliación** (sección 4). Percentiles con método fijo (tipo 7 de numpy) para igualar los fixtures dorados.

---

## 11. Hoja de ruta definitiva

| Fase | Contenido | Criterio de salida |
|---|---|---|
| **0** | ADRs; JSON Schema y fixtures; módulo `time` con todos los casos de la sección 3; migraciones, RLS, RPC y pgTAP; simulador de sync; pipeline de copias completo y ceremonia de claves; prueba OTP en iPhone con SMTP propio; esqueleto de monorepo y CI | Todos los [SPIKE] resueltos y suite verde |
| **1** | Móvil local: perfiles, cronómetro, manual, **conciliación mínima**, notas, diario básico, exportación JSON/CSV, PWA, Pages | Se acumulan datos reales |
| **2** | Sync + OTP + familia de dos cuidadores + bandeja de conflictos + copias L2–L4 en producción | **v1 familiar completa** |
| **3** | Dashboard Docker: estadística descriptiva y avanzada, informes. Primeras fichas de evidencia verificadas | Métricas idénticas a las del móvil |
| **4** | Predicción base en móvil con abstención; backtest en dashboard | Datos reales suficientes (≥2–4 semanas con marcas) |
| **5** | Analítica contextual, antes/después, latencia ampliada, `lab` Python solo si se justifica | |

El modelo de datos completo se implementa en Fase 0/1. La interfaz de cada función llega de forma progresiva.

---

## 12. Riesgos técnicos residuales

| Riesgo | Nivel | Mitigación |
|---|---|---|
| Pérdida de ambas claves `age` | Alto | Gestor + papel, ceremonia, simulacro trimestral |
| CI no puede comprobar el descifrado | Medio | Simulacro humano, canario inicial |
| Entrega del correo OTP (spam, proveedor) | Medio | Dominio propio, SPF/DKIM/DMARC, prueba real |
| Comportamiento de la PWA en iOS (almacenamiento separado, estado al ir a Mail) | Medio | Spike en iPhone real, onboarding |
| Rol de volcado con RLS | Medio | Spike con alternativa documentada |
| Cambios de política del plan gratuito (pausa, cuotas) | Medio | Copia independiente, aviso en app |
| Workflows programados desactivados por inactividad | Medio | Alerta `backup_status` |
| Conflictos con relojes desviados | Medio | Registro de desfase, aviso >2 min |
| Datos de bebé en GitHub privado (cifrados) | Bajo | Cifrado antes de subir, repo privado, sin logs con datos |
| Deriva de métricas TS vs. oráculo | Bajo | Fixtures dorados en CI |

---

## 13. Validaciones técnicas pendientes (Fase 0)

| ID | Validación | Criterio de aceptación |
|---|---|---|
| V1 | OTP en iPhone real con la PWA instalada | Login completo, sesión persistente, sin pérdida de estado al ir a Mail |
| V2 | SMTP propio y plantilla | Entrega a ambos buzones en <1 min sin spam |
| V3 | Caducidad mínima admitida | Fijada a 10–15 min |
| V4 | Rol de volcado y versión de `pg_dump` | Volcado completo vía pooler en CI |
| V5 | Restauración de prueba en `supabase/postgres` | Suite de verificación y pgTAP verdes |
| V6 | Recuperación en proyecto nuevo con `claim_membership()` | Ambos progenitores recuperan acceso en <1 h |
| V7 | Ceremonia de claves | Ambos descifran el canario con su clave |
| V8 | Simulador de sync (N dispositivos offline) | Convergencia y cero pérdida sin rastro |
| V9 | Cuota de Actions y comportamiento de workflows programados en repo privado | Cuota suficiente y sin desactivación en 90 días |
| V10 | Tests temporales (sección 3) | 100 % verdes |

**Decisiones abiertas que requieren tu aprobación**
1. **Dominio para SMTP del OTP** (~10–15 €/año): recomendado. Alternativa sin dominio: no viable para producción según la documentación.
2. **Proveedor de SMTP** (Resend, Brevo, Postmark…): decidir en V2 con una prueba real.
3. **Umbral de caducidad del OTP** (propuesto 10–15 min).
4. **Tolerancias de conflicto** (2 min y 5 min) y **latencia máxima** (3 h): aprobar valores por defecto.
5. **Cada progenitor, ¿gestor de contraseñas propio?** Se necesita para la custodia de la clave.

---

## 14. Fuentes

- Supabase, OTP por correo: https://supabase.com/docs/guides/auth/passwordless-login/auth-email-otp
- Supabase, límites de Auth: https://supabase.com/docs/guides/auth/rate-limits
- Supabase, SMTP: https://supabase.com/docs/guides/auth/auth-smtp
- Supabase, copias de seguridad: https://supabase.com/docs/guides/platform/backups
- Supabase, IPv4/IPv6 y pooler: https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP
- Supabase, límites del plan gratuito: https://supabase.com/docs/guides/platform/billing-on-supabase
- Supabase, pausa de proyectos: https://supabase.com/docs/guides/platform/free-project-pausing
- GitHub, eventos de workflows programados: https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows
