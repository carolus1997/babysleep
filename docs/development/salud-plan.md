# Módulo de Salud: plan por fases

Estado (7 nov 2026): **fase 0 hecha**; el resto es propuesta.

## Qué se quiere

1. **Inicio** pasa a absorber el Historial y las Tomas, para liberar espacio de navegación.
2. **Salud** como sección propia:
   - datos de salud de la niña: centro de salud, pediatra, contactos y CIPA (código de identificación personal autonómico, el de la tarjeta sanitaria);
   - calendario de vacunación de la Comunidad de Madrid;
   - citas médicas y vacunas con avisos, y sincronización con Google Calendar;
   - peso, talla y perímetro cefálico con curvas de crecimiento;
   - informes de síntomas para cuando está enferma;
   - control de medicación con cronómetro y avisos al móvil.
3. **Extra en Inicio:** al abrir la app, tiempo que lleva despierta (desde el fin de la última siesta o noche).

## Principios (los mismos del proyecto, más estrictos aquí)

- **No es un producto sanitario.** No diagnostica, no recomienda dosis, no dice «normal» ni «anormal». Lo que se muestra viene de lo que la familia anota o de tablas oficiales citadas con su fuente y edición.
- **Medicación:** solo se registra y se recuerda lo que el médico pautó (nombre, dosis y frecuencia los escribe la familia). La app nunca sugiere una dosis ni un intervalo.
- **Desconocido ≠ 0:** una vacuna sin fecha anotada es «sin confirmar», no «no puesta»; una medida sin anotar es un hueco en la curva.
- **Privacidad:** ningún dato real de la niña en el repositorio. El CIPA es un identificador oficial: la familia ha decidido guardarlo (fase 1), pero será un campo opcional, se verá oculto por defecto con un toque para mostrarlo, y no entrará nunca en informes ni en el texto compartido salvo que se marque a propósito.
- **Nunca perder datos:** las tablas nuevas entran en el JSON de copia, en la sincronización y en las copias cifradas.
- **Sin coste:** todo sobre Supabase gratuito, web push propio y datos oficiales estáticos.

## Lo que se ha comprobado en las fuentes

| Tema | Hallazgo | Fuente |
|---|---|---|
| Calendario vacunal | Existe el «Calendario de vacunación/inmunización a lo largo de toda la vida 2026» (edición febrero 2026, Dirección General de Salud Pública). Se ha leído la tabla infantil (ver abajo). | [Vacunas, información para profesionales](https://www.comunidad.madrid/servicios/salud/vacunas-informacion-profesionales), [PDF oficial](https://gestiona3.madrid.org/bvirtual/BVCM051768.pdf) |
| Cambios 2026 | Desde el 1 ene 2026 la dosis de MenC de los 12 meses pasa a MenACWY. Campaña VRS 2026-27 desde el 1 oct 2026 (lactantes nacidos 1 abr–30 sep 2026 y recién nacidos hasta 31 mar 2027). | misma página |
| Curvas OMS | Hay tablas de niñas de 0 a 5 años en Excel y PDF (peso/edad, longitud-talla/edad, perímetro cefálico/edad, peso/longitud), en z-scores y percentiles, y tablas «expanded» para tarjetas de salud. | [OMS, estándares](https://www.who.int/tools/child-growth-standards/standards) |
| Licencia OMS | Las publicaciones OMS van con CC BY-NC-SA 3.0 IGO: uso no comercial, con atribución y compartir igual. No se ha confirmado que los archivos de tablas tengan exactamente esa licencia. Para una app familiar sin ánimo de lucro encaja; hay que citar la fuente. | [Términos OMS](https://www.who.int/about/policies/terms-of-use) |
| Google Calendar | `events.insert` admite `reminders.overrides` (hasta 5, `popup` o `email`, de 0 a 40320 min). Con el modelo de token de Google Identity Services **no hay refresh token** en el navegador: el token dura poco y se renueva con un gesto del usuario. | [events.insert](https://developers.google.com/calendar/api/v3/reference/events/insert), [token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model) |

**No se ha podido confirmar** (hay que probarlo en la fase correspondiente): columnas L/M/S en las tablas de la OMS; si Google exige verificación de la app para escribir en el calendario de dos usuarios en modo «testing»; si Google Calendar convierte los `VALARM` de un `.ics` importado en recordatorios; qué es «BICA».

### Calendario infantil de Madrid 2026 (leído del PDF oficial, **a verificar contra el Documento de Salud Infantil**)

| Edad | Inmunización |
|---|---|
| Embarazo | dTpa desde la semana 27; gripe en temporada; COVID según temporada |
| 0–5 meses | Anticuerpo frente al VRS (estacional, según fecha de nacimiento) |
| Nacimiento | Hepatitis B solo en hijos de madre AgHBs+ o serología desconocida (en las primeras 24 h) |
| 2 meses | VHB, DTPa, VPI, Hib, VNC, Men B, RV |
| 4 meses | VHB, DTPa, VPI, Hib, VNC, Men B, MenC, RV |
| 11 meses | VHB, DTPa, VPI, Hib, VNC |
| 12 meses | Triple vírica (TV), Men B, MenACWY |
| 15 meses | Varicela (VVZ) |
| 3–4 años | Tetravírica (SRPV) |
| 6 años | DTPa-VPI |
| 12 años | MenACWY, VPH |
| 14 años | dTpa |
| 6–59 meses | Gripe anual |

Esta tabla vive como **dato versionado** (`edición 2026`) en el código, con la fuente, para poder actualizarla cuando Madrid publique otra. La app nunca la presenta como instrucción: la fuente de verdad es el Documento de Salud Infantil y el pediatra.

## Fases

Cada fase es publicable por sí sola, lleva sus tests y, si toca la base de datos, su migración (que se aplica en Supabase **antes** de publicar la web que la usa).

### Fase 0: navegación nueva y «tiempo despierta» (sin servidor) — HECHA
- Inicio con tres secciones (Hoy / Tomas / Historial) en vez de pestañas aparte. Los accesos de las notificaciones (`?feed=…`) siguen abriendo Tomas.
- Barra inferior: Inicio · Salud · Estadísticas · Ajustes. Salud empieza vacía con «Próximamente».
- Tarjeta fija arriba en Inicio: **«Despierta desde hace 1 h 25 min»** (desde el fin del último descanso; si duerme, «Durmiendo desde las…»). Si hay previsión fiable, añade la ventana habitual de la fase de análisis.
- Riesgo: bajo. Es solo interfaz y reutiliza lo existente.

### Fase 1: ficha de salud y contactos
- Datos: pediatra, enfermera, centro de salud (nombre, dirección, teléfono, horario), hospital de nacimiento, alergias y notas médicas, contactos de urgencia.
- Migración 0011 (tablas con las mismas reglas de seguridad que el resto), contrato 0.5.0, entrada en copia JSON y sincronización.
- **CIPA** (opcional): oculto por defecto, con botón de mostrar/copiar. Se sincroniza como el resto de datos de la ficha y se cifra en las copias de seguridad. No aparece en informes ni en el texto compartido salvo que se marque expresamente.

### Fase 2: calendario de vacunación
- Cálculo de las fechas previstas a partir de la fecha de nacimiento (y de la edad corregida si es prematura, solo como aviso, porque las vacunas se cuentan por edad cronológica).
- Registro por dosis: vacuna, fecha administrada, centro, lote (opcional), nota. Estados: **Pendiente, Próxima (30 días), Puesta, Fuera de plazo, Sin confirmar**.
- Vista de lista por edad y «lo siguiente».
- Caso especial VRS: depende de la fecha de nacimiento y de la temporada.
- Migración 0012.

### Fase 3: citas y avisos (Google Calendar)
- Citas médicas (tipo, fecha y hora, lugar, motivo, notas, quién va) y vacunas previstas como citas.
- **Avisos con el sistema propio** (web push, que ya funciona y es gratis): 1 día antes y 1 h antes, configurables. Es lo más fiable porque no depende de terceros.
- **Google Calendar en dos escalones**:
  1. «Añadir a mi calendario» con un archivo `.ics` (con recordatorios) y un enlace de «añadir a Google Calendar». Sin cuenta, sin permisos, sin verificación.
  2. Más adelante y solo si hace falta: crear los eventos directamente con la API (token de corta duración, se renueva con un toque). Requiere dar de alta un proyecto de Google y probar si el modo «testing» con las dos cuentas basta sin verificación.
- Migración 0013 (citas y generalización de recordatorios).

### Fase 4: crecimiento
- Medidas: fecha, peso, talla/longitud, perímetro cefálico; quién la tomó y dónde (opcional).
- Curvas OMS para niñas de 0 a 5 años con la niña dibujada encima (percentil y z-score por medida), usando edad cronológica o corregida si es prematura (se muestra cuál).
- Tablas de la OMS convertidas **una sola vez** a JSON estático con un script, con atribución y edición. Si no están las columnas L/M/S, se usan las tablas de percentiles (3, 15, 50, 85, 97) con interpolación.
- Gráfica y lista; tendencia entre medidas; **sin interpretar** («has bajado de percentil» sí es un hecho, «está mal» no).
- Averiguar si el Documento de Salud Infantil de Madrid usa las curvas OMS u otras (Orbegozo), y avisar de ello.
- Migración 0014.

### Fase 5: medicación con cronómetro
- Tratamiento: nombre, dosis **tal como la escribió el médico**, intervalo en horas, inicio y fin, notas; todo lo escribe la familia.
- Registro de cada toma con hora y quién la dio. Cuenta atrás hasta la próxima.
- **Aviso al móvil** cuando toca (mismo mecanismo que el aviso de tomas), con botón «Ya la di» en la notificación.
- Protección contra dobles dosis entre cuidadores: si ya se registró una toma hace poco, la app lo dice **antes** de registrar otra.
- Límite diario opcional que escribe la familia (de la receta); la app solo avisa de que se ha alcanzado, nunca lo propone.
- Migración 0015 (y función programada análoga a la de tomas).

### Fase 6: episodios de enfermedad e informe de síntomas
- Episodio (inicio, fin) con anotaciones: temperatura (hora y valor), síntomas (lista elegible), cuánto come, pañales, cómo duerme, medicación dada (enlazada con la fase 5).
- Línea de tiempo del episodio y **informe para el pediatra** (misma tubería que el informe semanal): resumen, evolución de la temperatura, medicación dada con horas.
- Cruce con sueño y tomas durante el episodio, con el mismo cuidado que «Contexto».
- Migración 0016.

### Fase 7: cierre
- Bloqueo con PIN o biometría (ahora hay datos de salud, deja de ser opcional).
- Copias cifradas con las tablas nuevas; CSV; revisión de privacidad; pruebas de seguridad (RLS) de todas las tablas de salud; documentación para la familia.

## Orden recomendado y por qué

0 → 2 → 1 → 3 → 4 → 5 → 6 → 7, con la 5 adelantable si hay una necesidad real (un tratamiento en curso).

- La **0** libera sitio y entrega ya el extra pedido.
- La **2** (vacunas) da valor inmediato y no necesita nada externo. La **1** (ficha) es pequeña y puede ir junto.
- La **3** (avisos) depende de las citas y vacunas existentes.
- La **5** reutiliza el sistema de avisos de la 3.
- La **6** necesita la 5 para enlazar medicación.

## Decisiones tomadas

- «BICA» era el **CIPA**: se guarda en la ficha de salud (fase 1), opcional y con las cautelas de arriba.
- Los detalles técnicos pendientes (columnas L/M/S de la OMS, verificación de Google, `VALARM` en `.ics`, curvas que usa el Documento de Salud Infantil de Madrid) se resuelven al llegar a cada fase, sin prisa.

## Preguntas abiertas

1. **Google Calendar:** se propone empezar con avisos propios + archivo `.ics`/enlace (sin permisos de Google) y dejar la conexión directa para más adelante.
2. ¿Hay ya un tratamiento en curso que haga prioritaria la medicación (fase 5)?
