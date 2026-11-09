# BabySleep — Sistema de diseño (dirección D · «Marea Crepúsculo»)

Estado: **propuesta para aprobar** (fase 3). Cuando se apruebe, este documento es la referencia permanente: toda pantalla nueva se construye con estos tokens y componentes, sin improvisar estilos.

Alcance: solo presentación y navegación. No cambia modelos, contrato, motor analítico, persistencia, autenticación, sincronización ni reglas de cálculo.

Decisiones por defecto tomadas (corrígelas si no te valen): la barra inferior mantiene «Estadísticas»; se mantiene `auto` + claro/oscuro/noche.

## 1. Principios

1. **Una acción dominante por pantalla**, abajo, al alcance del pulgar.
2. **El dato que importa primero** (tiempo despierto, duración actual), en grande; el resto, subordinado.
3. **Calma**: sin rojo salvo error real; sin animaciones que no informen; sin brillo en modo noche.
4. **Todo se puede deshacer o corregir** a 1–2 toques.
5. **El anillo muestra una ventana habitual, nunca un objetivo.** No usar verde/rojo de «logro» ni porcentajes de cumplimiento con el sueño.
6. **Nada depende solo del color** (siempre texto o forma además).
7. Un único idioma de iconos y un único set de componentes.

## 2. Design tokens

Se mantienen los nombres existentes de `index.css` (`--bg --surface --surface2 --fg --muted --accent --accent-fg --line --danger --ok --seg-night --seg-nap`) para no romper las 6.400 líneas actuales; se **añaden** los que faltan. Mapeo a Tailwind: ya existe vía `@theme inline`.

### 2.1 Color (por tema)

| Token | Claro | Oscuro | Noche | Uso |
|---|---|---|---|---|
| `--bg` | `#f7f0e6` | `#181226` | `#050304` | fondo de página |
| `--surface` | `#fffaf3` | `#231a36` | `#0f0a08` | tarjetas, hojas |
| `--surface2` | `#efe5d6` | `#2e2445` | `#1a120d` | campos, chips, tiles secundarios |
| `--fg` | `#2b2038` | `#f2e9ff` | `#d8b48a` | texto |
| `--muted` | `#675b74` | `#b3a6c9` | `#a38660` | texto secundario |
| `--accent` | `#a84817` | `#f0955a` | `#c27a3e` | acción principal (texto y fondo; ≥4,5:1 sobre las tres superficies), anillo, foco |
| `--accent-fg` | `#ffffff` | `#2a1406` | `#140a03` | texto sobre acento |
| `--line` | `#e3d7c4` | `#3a2f55` | `#2a1d14` | bordes, separadores |
| `--seg-nap` | `#b5760f` | `#f0b855` | `#9c7a4a` | siesta en gráficos |
| `--seg-night` | `#4a3a7a` | `#9c88e8` | `#c27a3e` | noche en gráficos |
| `--ok` | `#2f7a4f` | `#7fd1a0` | `#8fbf8a` | confirmación |
| `--danger` | `#b3261e` | `#ff8a80` | `#e0856b` | error / destructivo |

Nuevos tokens: `--surface3` (hover/pressed = mezcla de `--surface2` y `--fg` al 6 %), `--ring-track` (= `--surface2`), `--accent-soft` (= `color-mix(in srgb, var(--accent) 18%, transparent)`), `--shadow-card` (ver 2.5).

**Nota importante:** el ámbar de siesta de los prototipos (`#e0a43a`) **no pasa** 3:1 sobre las superficies claras (≈2,0:1). En claro se usa `#b5760f`. Verificado con [`tools/check-contrast.mjs`](../../tools/check-contrast.mjs) (14 pares × 3 temas, WCAG 1.4.3 y 1.4.11): **sin fallos**. Ese script debe ejecutarse al cambiar cualquier color.

Reglas:
- Noche: nada de blanco ni de colores saturados; sin sombras; sin foto de fondo; sin emoji.
- La foto de fondo del bebé (hoy 16 % en claro) **se elimina del sistema** por complejidad y riesgo de contraste; el bebé se identifica por el avatar. *(Decisión a confirmar.)*
- `meta theme-color`: claro `#f7f0e6`, oscuro `#181226`, noche `#050304`.

### 2.2 Tipografía

Familia única **Manrope** (variable, 500–800), empaquetada con `@fontsource-variable/manrope` (offline, como Baloo 2 hoy). Baloo 2 se mantiene **solo** en el splash/logo.

| Token | Tamaño / alto de línea | Peso | Uso |
|---|---|---|---|
| `display` | 40–66 / 1 | 800, `tabular-nums` | cifra héroe (tiempo despierto, cronómetro) |
| `title` | 24 / 1.15 | 800 | título de pantalla |
| `heading` | 18 / 1.25 | 800 | título de hoja, cifra de tarjeta |
| `body` | 16 / 1.4 | 500 | texto |
| `label` | 13 / 1.3 | 700 | etiquetas de campo y tarjeta |
| `caption` | 12 / 1.3 | 600 | ayuda y notas |

Reglas: **mínimo 12 px** (se eliminan los `text-[10px]`); los `text-xs` actuales (112 usos) pasan a `caption` (12) o `label` (13) según función; texto de lectura ≥ 14; cifras siempre `tabular-nums`; sin `uppercase` + `tracking-wide` en títulos largos. Respetar el tamaño de texto del sistema (usar `rem`).

### 2.3 Espaciado y forma

- Escala base 4 px: `1=4, 2=8, 3=12, 4=16, 5=20, 6=24, 8=32`. Margen lateral de pantalla: 16 (hoy `px-4`, se conserva).
- Separación entre bloques: 8 (relacionados) / 16 (secciones).
- Radios: `sm 12` (campos, chips pequeños), `md 18` (tiles), `lg 24` (tarjetas), `pill 9999` (chips, botones principales), `round 50%` (botón circular, avatar).
- Objetivos táctiles: **mínimo 44×44** (WCAG 2.5.8 pide 24; Apple 44). Primarios: 56–92.

### 2.4 Iconografía

- Set **Lucide** (`lucide-react`, importando solo los iconos usados), trazo 1,75, tamaños 16/20/24/28.
- Prohibido: caracteres Unicode como icono (☾ ✚ ▥ ⚙ ✕ ⇅) y emoji en la interfaz.
- Mapa: Inicio `moon`, Salud `heart-pulse`, Estadísticas `chart-column`, Ajustes `sliders-horizontal`, cerrar `x`, cambiar bebé `chevrons-up-down`, toma `droplet`/`milk`, despierto `sun`, notas `pencil`, más `ellipsis`, vacunas `shield-check`, citas `calendar`, medicación `pill`, crecimiento `trending-up`, enfermedad `thermometer`, ficha `user-round`.
- Un icono siempre acompaña a una etiqueta de texto, salvo cerrar, más y avatar (con `aria-label`).
- Bonus de rendimiento: sustituir el emoji de las tomas elimina también el aspecto «a todo color» en noche.

### 2.5 Elevación y movimiento

- Tarjeta claro: `0 2px 0 var(--line), 0 12px 24px -16px <fg al 40%>`. Oscuro: borde 1 px `--line`, sin sombra. Noche: borde, sin sombra.
- Halo del botón circular: anillo de 8 px de `--accent` al 22 % (14 % en noche).
- Movimiento: 150–200 ms, solo para feedback (pulsar = `scale(.97)`). Todo se anula con `prefers-reduced-motion` (ya implementado). El splash conserva su animación.

## 3. Componentes

Todos viven en `apps/mobile/src/ui/` y son la **única** fuente de estilo; las pantallas no usan clases de color/tamaño propias salvo layout.

### 3.1 Botones

| Variante | Aspecto | Uso | Altura |
|---|---|---|---|
| `Round` (nuevo) | círculo 92 px, `--accent`, icono 28 + etiqueta de una palabra, halo | acción dominante de Hoy: **Dormir / Despierto** | 92 |
| `primary` | pill `--accent` | confirmar en hojas y formularios | 56 |
| `secondary` | pill `--surface2`, texto `--fg` | acciones alternativas | 48 |
| `tile` (nuevo) | rectángulo radio 18, `--surface`, icono arriba y etiqueta | registrar toma, acciones rápidas | 64 |
| `ghost` | texto `--accent`, sin fondo | terciarias («Empezar a dormirlo») | 44 |
| `danger` | contorno `--danger` | cancelar/borrar (siempre con deshacer o confirmación) | 48 |

Estados: reposo · `:hover` (solo puntero) `--surface3` · `:active` `scale(.97)` · `:focus-visible` anillo 3 px `--accent` con 2 px de separación · `disabled` 45 % de opacidad **y** `aria-disabled` · `loading` spinner + texto («Guardando…») sin cambiar el ancho.
Reglas: etiquetas de **una o dos palabras**; una sola `Round` o `primary` por pantalla; el texto nunca debe desbordar el botón (probar con tamaño de texto +30 %).

### 3.2 Chips y segmentos
Semántica separada (hoy `Chip` hace de todo):
- `Segmented`: elección excluyente en una fila (7d/14d/28d; Siesta/Noche). `role="radiogroup"`.
- `Filter`: activa/desactiva una condición (`aria-pressed`).
- `ActionChip`: acción puntual («−5 min»).
- `Tabs`: **sub-navegación** de Salud y Estadísticas, con scroll horizontal y degradado en el borde; sustituye los chips con `flex-wrap`. Máximo 5 pestañas visibles + «Más».

### 3.3 Tarjetas y contenedores
- `Card` (radio 24, `--surface`, sombra 2.5): bloque principal.
- `Tile` (radio 18–22): dato corto o acción en mosaico.
- `Inset` (radio 16, `--surface2`): bloque anidado. **Prohibido anidar `Card` dentro de `Card`.**
- `Sheet`: hoja inferior con *grabber* y botón `x` de 44 px; cierre con gesto, Escape o fondo; `max-h 92dvh`, safe-area. Ya existe con buen comportamiento: se conserva la mecánica, cambia el aspecto.
- `Banner` (nuevo): avisos (`sessionExpired` → `danger`, `backupDue` → neutro), con icono, texto y acción.

### 3.4 Formularios
- `Field`: etiqueta `label` arriba, campo 48–52 px, radio 12, borde `--line`, fondo `--surface2`; 16 px de texto (evita zoom iOS, ya aplicado).
- Estados: `:focus` borde `--accent` + anillo; `error` borde `--danger` + icono + mensaje bajo el campo (`aria-describedby`, `aria-invalid`); `disabled`; ayuda en `caption`.
- Hora/fecha: controles nativos; atajos en `ActionChip` (±5/10/15).
- Tras guardar: toast con **Deshacer** (ya existe).

### 3.5 Navegación
- Barra inferior de 4 pestañas (Inicio, Salud, Estadísticas, Ajustes): icono 24 + etiqueta 11–12 px, pestaña activa con píldora `--accent-soft` tras el icono, `aria-current="page"`. Altura 64 + safe-area. Etiqueta siempre visible.
- **Al cambiar de pestaña se reinicia el scroll arriba** (bug C5), salvo regreso con «atrás» a una lista.
- Cabecera: avatar con aro del color del bebé + nombre + edad y botón «Cambiar» (solo si hay >1 bebé). Sin borde de 4 px.
- Sub-navegación: `Tabs` (3.2).

### 3.6 Componentes de estadísticas
- `HeroStat`: etiqueta + cifra `display` + delta con **flecha y texto** (↑ 25 min), no solo color.
- `StatTile`: punto de color de la serie + etiqueta + cifra `heading`.
- `BarChart` apilado (7 días) con valor sobre cada barra, media punteada y leyenda; **para 14/28 días**: barras horizontales (una por día) o barras finas con valores en eje; etiquetas ≥ 11 px. Texto alternativo resumido (`role="img"` + `aria-label`) y tabla de datos accesible oculta visualmente.
- `Ring`: solo para ventana habitual (vigilia) y duración actual; track `--surface2`; el trazo nunca supera visualmente el 100 % como «logro».
- Colores de serie: `--seg-nap` / `--seg-night`; no usar `--ok`/`--danger` para series de sueño.
- Valores faltantes: «—», no 0.

### 3.7 Estados vacío, carga y error
- **Vacío:** icono 28 en `--accent-soft`, frase de una línea que dice qué falta y qué hacer, con botón (p. ej. «Aún no hay registros. Empieza con **Dormir**»). Sustituye los «0 min / 0 min / 0 min» y los guiones sin contexto.
- **Carga:** `Skeleton` del mismo tamaño que el contenido (sin spinner a pantalla completa); respeta `reduced-motion`.
- **Error:** `Banner` `danger` con causa en lenguaje llano + «Reintentar»; los datos locales siguen visibles (offline-first).
- **Datos insuficientes** (estadísticas con <3 días): aviso neutro en `Inset`, sin tono de alarma.

## 4. Pantallas objetivo (resumen)

- **Hoy:** cabecera → `Card` con `Ring` (tiempo despierto vs ventana habitual) + chip «Próxima siesta» → `Round` «Dormir» → mosaico de 4 tomas → `Inset` «Hoy» (siestas/noche/total). «Empezar a dormirlo» como `ghost`.
- **Hoy con sesión:** `Ring` con el cronómetro → `Segmented` Siesta/Noche → `Round` «Despierto» → 3 `Tile` (Se durmió antes, Notas, Más) + `ActionChip` −5/−10/−15. «No llegó a dormirse» y «Despertar nocturno» dentro de «Más».
- **Estadísticas:** título + `Segmented` de rango → `HeroStat` + `BarChart` → 4 `StatTile` → `Tabs`/lista «más análisis».
- **Salud:** mosaico (vacunas en anillo X/Y, próxima cita, medicación de hoy, crecimiento con mini-curva, enfermedad, citas); cada tile abre su sección.
- **Noche:** mismo layout; tokens nocturnos; `Round` con halo reducido.

Textos largos de ayuda (p. ej. «El día cuenta desde la primera siesta…») pasan a un icono «i» que abre una hoja, o a `caption` colapsable.

## 5. Accesibilidad (checklist por componente)

- Contraste verificado con `tools/check-contrast.mjs` (texto 4,5:1; iconos/barras/anillo 3:1).
- Objetivos ≥ 44 px; separación ≥ 8 px.
- `:focus-visible` siempre visible.
- Nombres accesibles en botones de icono; `aria-live="polite"` en toasts; el cronómetro **no** anuncia cada segundo (`aria-live="off"`, ya así).
- Se prueba con texto del sistema al 130 %, en 320 px de ancho y en horizontal.
- `prefers-reduced-motion` y `prefers-color-scheme` respetados.
- Información nunca solo por color.

## 6. Verificación visual (exigida en cada fase)

1. **Playwright** (`@playwright/test` como `devDependency`; carpeta `tools/visual/`): 360×800 y 390×844; temas claro, oscuro y noche; estados vacío, con datos y sesión activa; pantallas Hoy, Estadísticas, Salud, Ajustes y las hojas principales. Capturas en `docs/design/screens/`.
2. **axe-core** sobre las mismas pantallas (CI).
3. **Test de desbordes:** el texto de cada botón no supera su caja (a 130 % de texto).
4. Un script de *seed* que carga datos sintéticos en IndexedDB para tener capturas con datos. (Esto requiere una utilidad de desarrollo, **no** código de producción.)
5. Revisión manual en un iPhone y un Android real, de noche, con una mano.

*Nota:* en la sesión de la auditoría se usó el navegador integrado; el plugin/paquete de Playwright **no está instalado** y hay que añadirlo en el paso 0.

## 7. Plan de implementación incremental

Cada paso es una PR pequeña, con capturas antes/después, que pasa `npm run check`. Ninguno toca dominio, contrato ni sync.

| Paso | Contenido | Riesgo |
|---|---|---|
| **0. Red de seguridad** | Playwright + seed + axe + `check-contrast` en `npm run check`; capturas «antes» | Bajo |
| **1. Tokens** | Nuevos valores en `index.css` (claro/oscuro/noche), `--surface3/--accent-soft`, tipografía Manrope (`@fontsource`), escala; sin cambiar componentes | Bajo (cambia aspecto global) |
| **2. Iconos** | Añadir `lucide-react`; `ui/Icon`; reemplazar ☾ ✚ ▥ ⚙ ✕ ⇅ y emojis; barra inferior nueva; reinicio de scroll al cambiar pestaña | Bajo |
| **3. Primitivas** | `Btn` (variantes + `Round`, `tile`), `Segmented/Filter/ActionChip/Tabs`, `Card/Tile/Inset`, `Sheet` con grabber, `Field` con estados, `Banner`, `Skeleton`, `EmptyState` (compat: se conservan los nombres existentes para no reescribir 140 usos) | Medio |
| **4. Hoy** | Rediseño de `Home` y `HomeShell` con `Ring`, `Round`, mosaico de tomas, estados vacíos | Medio-alto (pantalla crítica; probar de noche) |
| **5. Estadísticas** | `Stats` con `HeroStat`, `BarChart` nuevo, `Tabs`; el resto de vistas (Ritmo, Línea, etc.) solo heredan tokens | Medio |
| **6. Salud** | Panel «Lo próximo» y mosaico; secciones heredan primitivas | Medio |
| **7. Resto** | Historial, Ajustes, Onboarding, Splash (alinear a la identidad), formularios largos de Medicación/Enfermedad/Vacunas | Medio |
| **8. Pulido** | Auditoría de contraste y desbordes completa, pruebas en dispositivos, retirar clases obsoletas y la foto de fondo | Bajo |

Los pasos 1–3 son aprobables y desplegables de forma independiente; el 4 es el que cambia el hábito diario de uso y conviene probar una semana antes del 5.

## 8. Reglas para futuras pantallas

1. Antes de maquetar, elige: ¿cuál es la acción dominante? Solo una `Round`/`primary`.
2. Usa solo tokens (`bg-surface`, `text-muted`…) y componentes de `ui/`; ningún color hexadecimal ni tamaño suelto.
3. Sin iconos Unicode/emoji; solo Lucide.
4. Todo estado vacío, de carga y de error tiene su componente.
5. Toda acción destructiva o de registro tiene deshacer.
6. Comprueba con Playwright en claro, oscuro y noche antes de dar por terminada la pantalla.
7. Si necesitas algo que no existe, se añade aquí primero.

## 9. Decisiones pendientes de aprobación

1. ¿Se elimina la foto de fondo del bebé? (recomendado: sí).
2. ¿Un solo tipo (Manrope) o se recupera un serif para cifras (A/B)? (recomendado: Manrope, como en D).
3. ¿Se acepta añadir dependencias `lucide-react`, `@fontsource-variable/manrope`, `@playwright/test` y `axe-core`?
4. ¿Se empieza por el paso 0 y el 1 (sin riesgo funcional)?

## 10. Estado de implementación

- **Paso 0 (hecho):** `npm run visual` (Playwright, `tools/visual/`) siembra a «Leo» con 8 días de datos usando las funciones de dominio de la app y captura 390×844 y 360×800 en claro/oscuro/noche (vacío, con datos, sesión activa) en `docs/design/screens/<VISUAL_TAG>/`; pasa axe (WCAG 2.2 AA, `axe.txt`; `VISUAL_STRICT=1` lo convierte en fallo). `npm run check:contrast` lee los colores de `index.css` y forma parte de `npm run check`. Capturas: `screens/antes` y `screens/despues`.
- **Paso 1 (hecho):** tokens de las tres paletas, `--surface3`, `--accent-soft`, `--shadow-card`, Manrope empaquetada (solo subconjunto latino) y colores de `theme-color`/manifest. Sin cambios en componentes.
- **Pendiente conocido del paso 1:** el color por defecto del bebé (índigo, guardado en datos) sigue pintando el avatar y el borde de la cabecera; se resuelve en el paso 2–4 sin tocar datos (usar `--accent` cuando el color sea el valor por defecto).
- **Pasos 2–7 (hechos en `rediseno-ui`):** iconos Lucide (`ui/Icon.tsx`), barra inferior y cabecera nuevas, reinicio de scroll al cambiar de pestaña, primitivas D (`Btn`, `Round`, `Tile`, `Chip`, `Tabs`, `Card`, `Inset`, `Banner`, `EmptyState`, `Skeleton`, `Ring`, `Sheet` con grabber, `Field`), Hoy (anillo + botón circular + tomas en mosaico + estado vacío), Estadísticas (cifra héroe, gráfico con valores y línea de media, `Tabs`), Salud (pestaña «Resumen» / Lo próximo) y limpieza (sin `uppercase`, sin `text-[10px]`, sin emoji ni Unicode como icono, sin foto de fondo). El acento claro pasó a `#a84817` para cumplir 4,5:1 como texto sobre las tres superficies.
- **Pendiente (paso 8):** formularios largos y hojas de Medicación/Enfermedad/Vacunas solo heredan tokens (revisarlos uno a uno), Splash/Onboarding, prueba en móvil real, texto del sistema al 130 %.
- **Acceso (hecho):** bienvenida, registro del bebé y entrada con correo en pantalla completa (`Onboarding`, `SyncCard page`), casillas de código (`ui/CodeInput`), «Reenviar» con espera de 45 s y aviso inline de código incorrecto. Verificado en capturas (bienvenida, registro y correo en claro/oscuro/noche, con axe). **Sin verificar visualmente:** las pantallas de código, vinculación y «Cuenta vinculada», que necesitan el servidor de cuentas.
- **Paso 8 (hecho):** revisión de todas las secciones de Salud, Estadísticas, Historial y Ajustes y de las hojas con formularios (medicación, cita, vacunas, medida, enfermedad, descanso, acontecimiento, bebé) en capturas (`sec-*.png`, `hoja-*.png`, generadas por `npm run visual`). Casillas y opciones con el acento de la paleta. Todo heredaba bien tokens y primitivas; no hizo falta tocar más pantallas.
- **Sigue pendiente:** prueba en móvil real de noche y con texto al 130 %; hoja de la Ficha de salud (no capturada); vistas de análisis con gráficos antiguos (Ritmo, Días, Tendencias) y cifras que parten línea («2 h 25 / min»); iconos de la app instalada; color por defecto del avatar.
- **Toma con anillo en Hoy (hecho):** tarjeta «Toma» bajo el anillo de sueño, con mini anillo neutro (solo el de sueño usa el acento) y botón circular pequeño `Round small`. El cronómetro arranca sin preguntar; «Terminar» abre la hoja «¿Cómo ha sido la toma?» (pecho izquierdo/derecho/ambos, biberón con ml, sólidos; todo opcional). `✕` no termina la toma; «⋯» da «Opciones de la toma» (corregir inicio, cancelar). Se guarda con los tipos existentes (`composeFeedType`: pecho + biberón = «mixta»). La pestaña «Historial» de Inicio pasa a llamarse «Sueño».
- **Pendiente del diseño nuevo:** el modo de sueño en dos pasos (Siesta/Noche + «¿cómo se duerme?» con porteo + «Prepararlo para dormir») y el orden de Hoy (R5, R8 de la vista «Revisión UX»).
