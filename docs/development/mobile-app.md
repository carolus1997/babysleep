# App móvil (Fase 1)

PWA local-first en `apps/mobile`: React 19, TypeScript, Vite, Tailwind 4, Dexie (IndexedDB) y `vite-plugin-pwa`. Los datos viven **solo en el dispositivo**; no hay sincronización hasta la Fase 2.

## Ejecutar

```bash
npm install
npm run dev -w @babysleep/mobile     # http://localhost:5173
npm run build:mobile                 # genera apps/mobile/dist
```

Para volver a generar los iconos: `node tools/make-icons.mjs`.

## Estructura

| Ruta | Contenido |
|---|---|
| `src/db/schema.ts` | Base Dexie con las mismas tablas que el contrato y el SQL |
| `src/domain/*` | Lógica sin React: arranque, sueño, conciliación, notas, diario, resumen, exportación |
| `src/domain/write.ts` | **Único punto de escritura**: valida contra `@babysleep/contract` y sube `rev`. En la Fase 2 aquí se añade la cola de sincronización |
| `src/screens/*`, `src/app/*`, `src/ui/*` | Interfaz |
| `src/i18n/es.ts` | Textos (español) con claves tipadas, listos para otros idiomas |

Toda la estadística y el tiempo salen de `@babysleep/core`; la app no recalcula nada por su cuenta.

## Qué hace

- **Perfiles** de varios bebés con cambio rápido (color en la cabecera para no registrar en el perfil equivocado).
- **Perfil ampliado**, todo opcional (`null` = desconocido, nunca 0): sexo, semanas de gestación, peso y talla al nacer y notas. Se validan en la app, en el contrato y en la base de datos del servidor (migración 0004).
- **Entrar con la cuenta en un móvil limpio** (o con el almacenamiento borrado): la pantalla de bienvenida ofrece **«Empezar de cero»** y **«Ya tengo cuenta»**. Este segundo camino pide el correo, el código de 6 dígitos y, solo la primera vez, el código de alta, y **trae al bebé y sus registros** de la familia sin crear ningún perfil nuevo. No hay contraseñas: la sesión queda guardada en el móvil y se renueva sola; si caduca, Inicio lo avisa y se vuelve a entrar con un código por correo. La **foto del bebé** no viaja (decisión de producto): en un móvil nuevo hay que volver a ponerla.
- **Cerrar sesión, con tres niveles** (Ajustes → Cuenta y sincronización → «Cerrar sesión…»): **solo este móvil** (conserva sus datos y la cola de cambios; funciona también sin conexión), **en todos mis dispositivos** (revoca todas las sesiones; para perder un móvil o si lo usó otra persona; exige conexión y avisa si no la hay) y **cerrar y borrar los datos de este móvil** (para vender o prestar: antes sincroniza, dice cuántos cambios sin enviar se perderían, ofrece la copia JSON y pide escribir BORRAR; la familia conserva todo en el servidor). Si la sesión queda inválida (p. ej. se cerró en todos los dispositivos), el móvil lo detecta, la olvida y avisa en Inicio en vez de reintentar cada minuto. Si el administrador retira el acceso a alguien, su móvil lo dice con palabras y conserva sus cambios. Para dejar a otra persona sin acceso **de inmediato**, el administrador usa «Quitar acceso» en Familia.
- **Tomas de comida** (pestaña «Tomas» y tarjeta en Inicio): pecho, biberón y sólidos / otros, con un icono pequeño junto al texto. Cronómetro («Pecho / Biberón / Sólidos» → «Terminar toma», que pide opcionalmente el pecho usado o los ml) y registro manual de una toma pasada con su hora; la duración es **opcional**: sin ella la toma queda sin fin («Sin duración»), no cuenta como «en curso» y no suma tiempo al pecho (en curso = cronómetro sin fin). Se guardan hora de inicio y fin, pecho usado (solo en pecho) y ml (solo en biberón); lo que no se sabe queda **vacío, nunca en 0**. Una toma admite notas y etiquetas propias («Comió bien», «Tomó poco», «Regurgitó», «Se durmió comiendo»…). Corrección rápida del inicio, eliminar con deshacer, resumen por día (nº de tomas, ml de los biberones con cantidad, tiempo al pecho) y CSV propio. Entra en la copia completa y se sincroniza como el resto.
- **Eliminar, fusionar y recuperar perfiles.** Ajustes → Editar → «Eliminar perfil» (pide escribir el nombre). El perfil y sus registros se **conservan** en «Perfiles eliminados» y se pueden recuperar; con la sincronización activada desaparece también en los demás móviles. No se puede eliminar el único perfil. «Fusionar perfiles» pasa los registros de uno a otro (útil con duplicados).
- **Edad corregida** para prematuros: si se indicó que nació antes de la semana 37, la cabecera y la lista muestran además la edad corregida (la real menos lo que faltó hasta las 40 semanas), hasta los 24 meses. Si aún no ha llegado a su fecha prevista de parto, lo dice con palabras. Es orientativa y no sustituye al pediatra.
- **Foto del bebé** desde la galería o la cámara. Se reduce a 1024 px y se recomprime en JPEG en el propio teléfono, lo que elimina los metadatos (incluida la ubicación GPS). Se guarda **solo en este dispositivo**, en una tabla aparte (`baby_photo`): no se sincroniza, no entra en las copias JSON/CSV y no existe en el servidor. Sirve de avatar y, **solo en el tema claro**, de fondo muy tenue (en oscuro y noche no se muestra).
- **Iniciar sueño** = «hemos comprobado que está dormido», igual para siesta y noche. Se guardan instantes, no un contador: el cronómetro sobrevive a cerrar la app.
- **Conciliación opcional**: «Empezar a dormirlo» y «Colocado en la cuna». Se enlaza sola al iniciar sueño. Sin ella, la latencia queda *desconocida* (nunca 0).
- **«No quiere dormir»**: con un intento abierto, cancela el intento (queda guardado como abandonado). Con el sueño ya iniciado, **«No llegó a dormirse»** lo manda a la papelera, no cuenta en ninguna estadística y deja el intento como fallido. Ambos se pueden deshacer desde el aviso.
- **Registro manual** con horas locales en `Europe/Madrid`; las horas ambiguas o inexistentes por el cambio de horario se piden o se rechazan, no se corrigen en silencio.
- **Notas y etiquetas** en secciones separadas y numeradas («Antes: al dormirse», «Durante el sueño», «Despertar») y en la conciliación. Opcionales y editables después. Las etiquetas de sistema nuevas se añaden solas al abrir una versión más reciente de la app (por `slug`, sin tocar las existentes).
- **Historial** por día, con papelera (borrado lógico) y aviso de solapes pendientes de revisión.
- **Día de sueño** (Inicio y Estadísticas): empieza con la primera siesta y acaba con el despertar de la noche siguiente. Cada sesión cuenta ENTERA en el día en que empezó (una noche que empieza antes de las 05:00 cuenta en el día anterior), así que «Total del día» ya no arrastra la noche anterior. Inicio muestra siestas, noche y total por separado; por la mañana, antes de la primera siesta, enseña «Noche pasada». Es una agrupación (`sleepDayTotals`, ADR 0002 vista 4): no recorta duraciones.
- **Estadísticas** de 7/14/28 días con calidad del dato visible; los promedios (total, siestas al día, noche) usan solo días completos con datos: un día con una noche aún en curso no entra.
- **Diario de acontecimientos** básico (visible en el historial).
- **Exportación** JSON (copia completa con la papelera) y CSV (sesiones). Recordatorio de copia: a los 3 días del primer registro y luego cada 7.
- **Restauración de copias** (Ajustes → Datos → Restaurar copia): valida el archivo y cada fila contra el contrato, enseña una vista previa y **solo añade lo que falta**. Las etiquetas y categorías de sistema se enlazan por `slug` (no se duplican). Lo que tenga una versión más reciente en la copia solo se reemplaza si se marca expresamente. Un archivo con cualquier error no escribe nada. Detalle en `src/domain/import.ts`.
- Temas claro, oscuro y **noche** (negro con tonos cálidos).

## Despliegue en GitHub Pages

1. En el repositorio: Settings → Pages → Source: **GitHub Actions**.
2. El workflow `deploy-pages.yml` compila con `BASE_PATH=/<repositorio>/` y publica `apps/mobile/dist`.
3. La app queda en `https://<usuario>.github.io/<repositorio>/`. El sitio solo contiene código: **nunca datos**.

## Uso en iPhone

1. Abre la URL en Safari → Compartir → **Añadir a pantalla de inicio**.
2. Abre la app desde el icono. **Instálala antes de registrar**: el almacenamiento de la app instalada es distinto del de Safari y no comparten datos.
3. Haz una copia (Ajustes → Datos) con regularidad: sin sincronización, la copia manual es la única protección frente a un borrado del almacenamiento.

## Limitaciones conocidas

- Sin sincronización ni cuentas (Fase 2). Un solo dispositivo por perfil.
- La descarga de archivos y la selección del archivo de copia desde una PWA en iOS no se han probado en un iPhone real. Tampoco la cámara y la galería para la foto del bebé.
- La foto no viaja en las copias: al restaurar en otro dispositivo hay que volver a ponerla.
- Al restaurar en otro dispositivo, la autoría de los registros pasa a ser la del cuidador local (no hay cuentas hasta la Fase 2).
- El «almacenamiento protegido» depende del navegador; se solicita, pero no está garantizado.
- Aún no hay ventanas de vigilia, hora habitual ni predicción (Fases 3–4).
