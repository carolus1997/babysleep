# Plan de seguridad

Estado (7 nov 2026): **aprobado con los cambios de abajo; S0 en marcha** (repositorio privado `babysleep-backups` creado). Sustituye y amplía la «Fase 7: cierre» de `salud-plan.md`. Nada de esto está hecho todavía salvo lo que figura en «Lo que ya hay».

## Qué se protege y de quién

**Qué:** datos de salud de una niña (ficha con CIPA, vacunas, citas, peso/talla, medicación, enfermedades), sus rutinas de sueño y tomas, la identidad de los dos cuidadores y las claves del servicio.

**Amenazas realistas para una app familiar (de más a menos probables):**

| # | Amenaza | Daño |
|---|---|---|
| A | **Perder datos** (móvil perdido o roto, error al borrar, proyecto de Supabase pausado o borrado) | El peor: irrecuperable. Hoy no hay copia automática activa. |
| B | **Móvil perdido, robado o desbloqueado en manos de otra persona** | Lectura de todo lo guardado y sesión abierta en el servidor |
| C | **Cuenta de correo o de GitHub/Supabase comprometida** (el acceso es por código al correo) | Acceso a todos los datos y a las claves |
| D | **Fallo de configuración en el servidor** (una tabla nueva sin seguridad por filas, una función demasiado abierta) | Fuga entre familias o a anónimos |
| E | **Código malicioso en la web** (dependencia comprometida, XSS) | Robo de la sesión guardada en el móvil |
| F | **Fuga por «efectos laterales»**: notificaciones en pantalla bloqueada, archivos exportados sin cifrar, secretos en el repositorio público | Datos de salud a la vista o publicados |

**Lo que NO es objetivo** (y por qué): defenderse de un atacante con acceso físico y experto al móvil desbloqueado (iOS ya cifra el almacenamiento con el código del teléfono); cifrado de extremo a extremo de todos los datos (impide el análisis en el servidor y la recuperación si se pierde la clave; con dos cuidadores y datos de bebé, el coste supera al beneficio); cumplir normativa de empresa (es uso doméstico).

## Lo que ya hay

| Medida | Dónde |
|---|---|
| Seguridad por filas en todas las tablas; los clientes solo **leen** lo de su familia; escribir solo con `apply_changes` | migraciones, `security.test.sql` (T01–T17) |
| Alta por invitación: código de un solo uso, caduca a 30 min, se bloquea tras 5 fallos, no se guarda en claro | `security.test.sql` |
| Auditoría de altas y bajas, visible solo para administradores | `audit_log` |
| Inicio de sesión por código al correo, sin crear cuentas nuevas desde la app (`shouldCreateUser: false`) | `sync/auth.ts` |
| Aislamiento entre familias y permisos de lector verificados **tabla por tabla** en cada fase de salud | `sync.test.sql` (S31–S35) |
| Foto del bebé solo en el móvil; ningún dato real en el repositorio (`check:private-data`) | CI |
| Borrado de este móvil solo si no quedan cambios sin enviar | `sync/wipe.ts` |
| Copias cifradas con `age` (dos destinatarios), restauración de prueba **antes** de cifrar, cuatro estados | `ops/backups/` — **sin activar** |
| Informes sin CIPA; secretos fuera del repositorio (`.gitignore`) | por diseño |

## Huecos que el plan cierra

1. **Copias sin activar.** Supabase Free no hace copias automáticas (a comprobar en el panel): hoy un error o una pausa del proyecto puede perder todo.
2. **No hay bloqueo de la app.** Quien coja el móvil desbloqueado abre datos de salud y la sesión.
3. **Las pruebas de seguridad son por tabla, a mano.** Una tabla futura sin seguridad por filas pasaría desapercibida.
4. **Notificaciones con detalle** (nombre del medicamento, de la niña) visibles en la pantalla bloqueada.
5. **La exportación JSON va sin cifrar** y la sesión vive en `localStorage` sin política de contenido (CSP) que limite scripts.
6. **Cadena de suministro y repositorio público** sin vigilancia automática (secretos, dependencias).
7. **No hay lista de dispositivos ni procedimiento** para «he perdido el móvil» o «se ha filtrado una clave».

## Fases (cada una es publicable por sí sola, con sus pruebas)

Orden por riesgo/esfuerzo. «Tú» = cuentas y secretos tuyos; «Yo» = lo hago en el código.

### S0 · Copias activadas y comprobadas  *(amenaza A, la primera)* — EN MARCHA
- Hecho: repositorio privado `carolus1997/babysleep-backups` con el flujo `backup.yml` y los scripts fijados al commit `01f1998a6ad0644ee65aa478deb4a34b95909454` del repositorio público.
- Falta (tuyo): las claves `age`, la variable `AGE_RECIPIENTS` y el secreto `SUPABASE_DB_URL`; después, primera ejecución y simulacro.
- **Tú:** repositorio privado de copias, par de claves `age` por progenitor (clave privada **fuera** de GitHub y del chat), secretos del flujo, siguiendo `ops/backups/README.md`.
- **Yo:** guiarte paso a paso, comprobar que `counts.sql` cubre las tablas nuevas (es genérico: cuenta todas las del esquema `app`), y la **prueba de recuperación completa**: descargar una copia, descifrarla con tu clave y restaurarla en un Postgres desechable.
- **Hecho cuando:** hay una copia diaria con los cuatro estados en verde en Ajustes y el simulacro de restauración se ha hecho una vez con clave real. Repetir cada ~3 meses (la app ya lo recuerda).

### S1 · Endurecer el servidor, el repositorio y la web  *(amenazas C, E, F)*
- **Tú, en los paneles (lista de comprobación que te daré):** *(decidido: sin verificación en dos pasos; es un riesgo aceptado, y por eso importan más una contraseña única y larga en cada cuenta y las copias de S0)* desactivar el registro libre de usuarios en Supabase; caducidad del código por correo corta y límites de envío; revisar «Security Advisor»; confirmar la región (UE) y que el proyecto no es público; activar *secret scanning* y *push protection* en GitHub, protección de la rama `main`.
- **Yo:** Dependabot y `npm audit` en CI; acciones de GitHub fijadas por versión exacta; comparación en tiempo constante del `CRON_SECRET` de la función programada; política de contenido (CSP) en la web: solo scripts propios, conexiones solo a Supabase, sin `eval` (hay que mover el pequeño script del tema a un archivo; GitHub Pages no permite cabeceras, así que va como `<meta>`, y se prueba en el navegador y en el iPhone).
- **Hecho cuando:** la lista está marcada, CI falla con una dependencia vulnerable conocida y la app funciona con la CSP puesta (sincronización, avisos, instalación como app).

### S2 · Seguridad verificada automáticamente  *(amenaza D)*
Pruebas SQL que **recorren el catálogo** en vez de nombrar tablas, para que una tabla o función nueva no pueda saltarse las reglas:
- Toda tabla de `app` tiene seguridad por filas y solo una política de lectura por miembro; ningún rol de cliente tiene `insert/update/delete` directos.
- Toda función `security definer` fija `search_path` y no es ejecutable por `anon` ni `authenticated`, salvo una lista blanca explícita (las que la app llama).
- Para cada tabla sincronizada: un lector no escribe, otra familia no ve ni referencia filas (se genera desde `SYNC_TABLES`; si falta una, la prueba falla).
- **Hecho cuando:** corre en CI y falla al añadir una tabla sin registrar.
- Pruebas del lado de la app: ningún informe, texto compartido, `.ics` ni aviso contiene el CIPA (prueba con un perfil con CIPA relleno).

### S3 · Bloqueo de la app y avisos discretos  *(amenaza B y F)*
- **PIN de 6 cifras** por dispositivo (derivado con PBKDF2 y sal, nunca guardado), bloqueo al pasar a segundo plano tras un tiempo elegible (decidido: **sin tiempo configurable**; se bloquea siempre que se sale de la app (a confirmar)), pantalla de bloqueo que **no pinta datos** y también al volver del selector de apps. Reintentos con espera creciente (nunca borra datos). Olvido del PIN = cerrar sesión y volver a entrar con el código del correo (los datos están en el servidor; si hay cambios sin enviar, la app lo avisa antes).
- **Face ID** (decidido que se quiere) con WebAuthn si funciona en la PWA instalada en iOS (hay que **probarlo en un iPhone real**; si no funciona, queda el PIN).
- **Avisos con detalle (decidido):** las notificaciones siguen mostrando nombre y dosis en la pantalla bloqueada, porque se necesitan así. No hay opción de ocultarlos ni migración para ello. Se deja dicho en la guía: quien vea la pantalla bloqueada ve esos datos.
- **Límite honesto, que se dirá en la app:** es un bloqueo de pantalla, no cifrado de la base de datos local; la protección del almacenamiento la da el código del teléfono.
- **Hecho cuando:** pruebas del temporizador, de los reintentos y de que nada se renderiza bloqueado; prueba manual en iPhone.

### S4 · Datos al exportar y en reposo  *(amenaza F)*
- Exportación JSON **cifrada con contraseña** (AES-GCM con clave derivada por PBKDF2 con muchas iteraciones, todo con WebCrypto, sin dependencias nuevas) y aviso claro cuando se elige sin cifrar; la importación reconoce ambos formatos. El CSV de la fase 7 original entra aquí.
- `navigator.storage.persist()` para que iOS no desaloje la base local; aviso si lo deniega.
- **Decisión pendiente (CIPA):** dejarlo como campo opcional protegido por seguridad por filas, TLS y bloqueo de app (**recomendado**), o cifrarlo en el móvil con una frase de la familia (más protección, pero si se olvida la frase se pierde y no se puede buscar ni migrar).
- **Hecho cuando:** exportar, importar en otro móvil y verificar; contraseña incorrecta falla sin dañar nada.

### S5 · Sesiones, dispositivos y respuesta a incidentes
- Pantalla **Dispositivos** (administrador): qué móviles tienen sesión, última actividad, y «retirar este dispositivo» (borra su suscripción de avisos y cierra su sesión).
- Más eventos en la auditoría: altas y bajas de dispositivos, cambios de rol, descarga de copias, y aviso en pantalla al administrador.
- **Guía de incidentes** en `docs/development/seguridad-incidentes.md`: «he perdido el móvil» (retirar acceso, cerrar sesiones, cambiar PIN), «he pegado un secreto donde no debía» (qué rotar y cómo: `service_role`, `CRON_SECRET`, claves VAPID, SMTP, claves `age`), «el repositorio filtró algo», y una revisión anual de 10 puntos.
- **Hecho cuando:** se ha ensayado una retirada de dispositivo real y la guía se ha seguido una vez.

## Orden y esfuerzo

| Fase | Quién | Esfuerzo | Riesgo si se pospone |
|---|---|---|---|
| S0 | Tú + yo | medio (la parte tuya son cuentas y claves) | **Alto** |
| S2 | Yo | pequeño | Medio, crece con cada tabla nueva |
| S1 | Tú + yo | medio | Alto en cuentas, bajo en código |
| S3 | Yo (+ prueba en tu iPhone) | grande | Medio |
| S4 | Yo | medio | Bajo-medio |
| S5 | Yo + tú | medio | Bajo, pero lo necesitarás el día que pase algo |

Sugerencia: **S0 y S2 ya**, S1 en paralelo (tú en los paneles mientras yo hago S2), luego S3, S4 y S5. Las migraciones de S3 y S5 (0016 en adelante) siguen la regla de siempre: se aplican en Supabase antes de publicar la web que las usa.

## Decisiones (7 nov 2026)

- **Copias:** sí, se activan (S0). El repositorio privado ya está creado.
- **Verificación en dos pasos:** no.
- **Bloqueo:** PIN y Face ID; sin tiempo de bloqueo configurable (a confirmar que significa «bloquear siempre al salir de la app»).
- **Avisos:** con detalle en la pantalla bloqueada.
- **Supabase:** en la UE, plan gratuito (confirmado).
- **Pendiente:** CIPA (dejarlo como está, recomendado, o cifrarlo con una frase de la familia).
