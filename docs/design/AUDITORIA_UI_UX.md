# BabySleep — Auditoría UI/UX (Fase 1)

Estado: **borrador para revisión**. No se ha tocado código de la app.
Método: lectura de `App.tsx`, `index.css`, `ui/primitives.tsx`, `ui/Splash.tsx`, `screens/*` y capturas reales de la app en ejecución (390×844, tema oscuro del sistema, bebé de prueba recién creado).

## 0. Honestidad sobre las fuentes

- **Verificado en esta sesión:** el código del repositorio y el comportamiento observado en el navegador integrado.
- **No verificado en esta sesión:** no se han consultado en línea Refactoring UI, NN/g, Apple HIG, WCAG 2.2, Mobbin, Nara Baby, Huckleberry, shadcn/ui ni Lucide. Las referencias a ellos son **criterios conocidos** (p. ej. objetivos táctiles de 44 pt de Apple, contraste 4.5:1 y 3:1 de WCAG 1.4.3/1.4.11, tamaño de objetivo 24 px de WCAG 2.5.8, heurísticas de Nielsen) y se marcan como *[criterio]*. Las propuestas propias se marcan como *[propuesta]*. Antes de la fase 2 se pueden contrastar en línea si se desea.
- Playwright no está instalado en el repo; las capturas se hicieron con el navegador integrado. Para la fase 3 se propone añadir un script Playwright de capturas (ver §7).

## 1. Radiografía técnica

| Dato | Valor |
|---|---|
| Pila | React 19, Tailwind 4 (`@theme inline` sobre variables CSS), Vite, PWA |
| Código UI | ~6.400 líneas; 12 hojas inferiores; 53 `Chip`, 140 `Btn`, 55 `Card` |
| Primitivas | `Btn` (4 variantes), `Chip`, `Card`, `Sheet`, `Field`, `inputCls` — 102 líneas |
| Temas | `light`, `dark`, `night` (más `auto`), por variables CSS en `index.css` |
| Tipografía | `system-ui` en toda la app; **Baloo 2 solo en el splash** |
| Iconos | Caracteres Unicode (☾ ✚ ▥ ⚙ ✕ ⇅) y emojis (🤱 🍼) |
| Texto pequeño | 112 usos de `text-xs`, 6 de `text-[10px]`, 191 de `text-sm` |

## 2. Lo que merece conservarse

1. **Arquitectura de tokens por variables CSS + tema `night`** ya existente: base correcta para el sistema de diseño. El tema noche (negro puro, tonos ámbar, sin foto de fondo) está bien razonado.
2. **Cuidados de plataforma**: `env(safe-area-inset-*)`, 16 px en inputs (evita zoom iOS), `overscroll`, bloqueo de scroll tras `Sheet`, `prefers-reduced-motion` global, `:focus-visible` de 3 px.
3. **Botón principal grande** (`h-28`) para iniciar/finalizar sueño: acierta con la acción más frecuente.
4. **Deshacer** tras acciones (finalizar, cancelar, tomas): excelente prevención de errores *[criterio: heurística 5 y 3 de Nielsen]*.
5. **Splash y selector de perfiles**: tiene personalidad (luna, estrellas, Baloo 2). Es lo único con identidad propia hoy.
6. **Accesibilidad estructural**: `aria-pressed` en chips, `role="dialog"`, `aria-modal`, `aria-current` en la navegación.
7. **Textos con matiz** (edad corregida, avisos de calidad de datos): valor de producto; hay que reordenarlos, no eliminarlos.

## 3. Problemas por gravedad

### Críticos (afectan al uso real o a la accesibilidad)

**C1. La pantalla «Hoy» no responde a “¿cómo va el día?” de un vistazo.** Con sesión activa, el cronómetro, tipo, finalizar, despertares, ajustar inicio, info adicional y cancelar viven en **una sola tarjeta de ~7 bloques** y 3 jerarquías de botón casi idénticas (`secondary` y `ghost` sobre `surface2`). Visto en captura: «Info adicional» tiene el mismo peso visual que «−5 min». Fricción alta de madrugada. *Evidencia:* `Home.tsx:123-168`.

**C2. Sin sesión activa, la primera pantalla es un bloque de botones de igual peso.** «Iniciar sueño», «Empezar a dormirlo», cuatro botones de toma y el resumen compiten. No se ve el dato más útil para el padre: **cuánto lleva despierto y cuándo toca la próxima siesta** (existe `awakeStatus`, pero se muestra más abajo/arriba según el estado y como tarjeta más). *Evidencia:* captura de «Hoy» y `Home.tsx:106-121,170-199`.

**C3. Pestaña «Estadísticas»: 8 vistas en chips planos con `flex-wrap`.** En 390 px los chips se parten en 3 filas, sin orden ni agrupación (Resumen, Ritmo, Línea, Tomas, Tendencias, Informe, Previsión, Contexto). Es un menú, no una navegación. *Evidencia:* `Stats.tsx:34-61`; igual en Salud con 6 chips (`Health.tsx:27-46`).

**C4. Gráfico de barras sin valores y con contraste insuficiente en claro.** `--seg-nap #f2a93b` sobre fondo blanco/lila ≈ 1.9:1 (<3:1, *[criterio WCAG 1.4.11]*). Las barras no tienen etiqueta de valor; el dato solo está en `title` (no existe en táctil). Con datos vacíos el gráfico queda como un hueco con letras L M X J V S D (captura). *Evidencia:* `Stats.tsx:143-166`.

**C5. El scroll no se reinicia al cambiar de pestaña.** En captura, tras bajar en «Estadísticas» y pulsar «Salud», Salud abre a mitad de la lista de vacunas. Desorienta; viola «visibilidad del estado» *[criterio: heurística 1]*.

### Altos

**A1. Iconografía improvisada.** ☾ ✚ ▥ ⚙ ✕ ⇅ y emojis dependen de la fuente del sistema: tamaño, peso y color cambian entre Android/iOS/Windows; el emoji de «Sólidos» aparece como un cuenco azul ajeno al tema; en noche, los emojis a todo color rompen la paleta cálida y deslumbran. `✚` para Salud connota cruz médica (estética hospitalaria). `⇅` para cambiar de bebé es ambiguo.

**A2. Tipografía sin sistema.** Todo en `system-ui` con tamaños sueltos (`text-xs/sm/xl/2xl/4xl/5xl`). Sin escala nombrada. La marca (Baloo 2) solo aparece 2 segundos en el splash y luego desaparece: promesa visual no cumplida. 112 `text-xs` en una app de uso nocturno y con cansancio: demasiado texto pequeño *[criterio: Apple recomienda ≥11 pt para texto mínimo; legibilidad real baja con poca luz]*.

**A3. Tarjetas anidadas y uniformes.** `Card` = `rounded-3xl border bg-surface` en 55 sitios, y dentro `rounded-2xl bg-surface2`. Todo tiene el mismo radio, borde y elevación: no hay jerarquía de contenedores (principal / secundario / informativo). Efecto «lista de cajas».

**A4. Foto de fondo + tarjetas translúcidas (solo claro).** Complejidad (`data-photo`, `z-index` sensible) para un efecto al 16 % de opacidad; riesgo de contraste variable bajo texto `muted`.

**A5. Estado vacío = «0 min / 0 min / 0 min».** Un bebé recién creado ve tres ceros y un párrafo largo («El día cuenta desde la primera siesta…») en lugar de una invitación. Los estados vacíos de Estadísticas muestran guiones y textos explicativos, sin ilustración ni acción.

**A6. Salud no tiene pantalla principal.** Al entrar se cae directamente en la lista de vacunas (sección por defecto), sin resumen de «lo próximo» (próxima vacuna, cita, medicación de hoy, último peso). Es contenido, no panel.

**A7. El botón «✕» de `Sheet` es un `Btn ghost` de 48 px con texto y sin forma de icono; las hojas no tienen *grabber* ni gesto de cierre.** Acción de cierre pobre en una app de una mano.

### Medios

- **M1.** Acciones de corrección dispersas: «Se durmió antes −5/−10/−15» solo al inicio; no hay edición en la pantalla activa del final ni de la hora completa (existe en Historial).
- **M2.** Cabecera con borde inferior de 4 px del color del bebé: elemento fuerte y poco refinado; con `sticky` ocupa ~70 px de pantalla útil.
- **M3.** `⇅` solo aparece si hay >1 bebé, pero el botón completo se comporta igual con uno.
- **M4.** Mensajes de aviso (`sessionExpired`, `backupDue`) como tarjetas de texto plano idénticas entre sí; el crítico (sesión caducada) solo se distingue por borde rojo.
- **M5.** Textos «muted» en `text-xs` sobre `surface2` en oscuro (`#a2a8c6` sobre `#20243f`) rondan ~6:1: pasa, pero con tamaño de 12 px y poca luz cuesta *[criterio WCAG 1.4.3 solo valora ratio, no tamaño percibido]*.
- **M6.** Los pocos `text-[10px]` (etiquetas del gráfico) quedan por debajo de cualquier mínimo razonable.
- **M7.** Conmutador Hoy/Tomas/Historial y chips de Estadísticas/Salud comparten estilo con filtros y acciones: un `Chip` sirve de pestaña, de filtro, de botón de acción rápida y de selector. Sin significado diferenciado *[criterio: consistencia, heurística 4]*.

### Bajos

- **B1.** `Btn` sin estados `hover`/`pressed` más allá de `scale`; sin estado de carga.
- **B2.** `inputCls` no define `focus` propio, `error` ni `disabled`.
- **B3.** `tracking-wide uppercase` en títulos de tarjeta resta legibilidad en español con texto largo.
- **B4.** El selector de perfiles del splash y la cabecera usan lenguajes distintos (grande, Baloo, avatares con anillo vs. línea pequeña): oportunidad para unificar.

## 4. Evaluación por criterio (síntesis)

| Criterio | Nota (0–5) | Comentario |
|---|---|---|
| Jerarquía visual | 2 | Una acción dominante bien resuelta; todo lo demás al mismo nivel. |
| Composición y espaciado | 3 | `space-y-4` consistente, pero sin ritmo ni agrupación. |
| Tipografía | 2 | Sistema del navegador, sin escala, mucho `xs`. |
| Color | 3 | Paleta correcta e inocua (índigo); poca personalidad; claro con ámbar flojo. |
| Iconografía | 1 | Unicode/emoji. |
| Navegación | 2 | 4 pestañas bien; sub-navegación por chips sin estructura. |
| Accesibilidad | 3 | Buenas bases semánticas; fallos de contraste no textual y tamaños. |
| Consistencia | 3 | Primitivas compartidas; semántica de `Chip` sobrecargada. |
| Densidad | 2 | Demasiado en «Hoy» activa y en Estadísticas. |
| Claridad de acciones | 3 | Primaria clara; secundarias confusas. |
| Modo noche | 4 | Mejor parte de la app; ajustar emojis y superficies. |

## 5. Contexto de uso (restricciones de diseño que se derivan)

1. **Madrugada, una mano, luz mínima:** acción primaria alcanzable con el pulgar (zona inferior), contraste cómodo pero sin brillo, nada de blanco puro en noche.
2. **Poca atención:** 1 decisión por pantalla en el flujo activo; deshacer siempre visible.
3. **Consulta frecuente de estadísticas:** primero 3 cifras clave y una gráfica legible; el resto, bajo demanda.
4. **Corregir errores:** editar/descartar un registro debe estar a 1–2 toques desde donde se ve.

## 6. Qué NO se toca (según tu encargo)

Modelos de datos, contrato, motor analítico (`@babysleep/core`), persistencia Dexie, autenticación, sincronización, reglas de cálculo y textos funcionales en `i18n/es.ts` (solo se reubicarían/abreviarían si se aprueba). La reorganización propuesta es de **presentación y navegación**.

## 7. Plan de verificación visual (propuesto para fases 2 y 3)

- Añadir `tools/screenshots/` con Playwright (móvil 360×800 y 390×844; temas claro/oscuro/noche; estados vacío/con datos/sesión activa) alimentado por un *seed* de datos sintéticos en IndexedDB.
- Revisión de contraste automatizada con axe-core en esas mismas capturas.
- Las capturas se guardan en `docs/design/screens/` para comparar antes/después.

## 8. Próximo paso (Fase 2)

Tres direcciones estéticas + prototipos HTML comparables de: Hoy sin sesión, Hoy con sesión, Estadísticas, Salud y modo noche. Tras tu elección → `docs/design/BABYSLEEP_DESIGN_SYSTEM.md` (Fase 3). **No se implementará nada hasta que apruebes la propuesta visual.**
