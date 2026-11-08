# BabySleep — Propuesta visual (Fase 2)

Prototipos: [`prototypes/index.html`](prototypes/index.html) — ábrelo en el navegador. Botones para cambiar tamaño (S/M/L/1:1), pantalla y fila. Cada dirección muestra: Hoy sin sesión, Hoy con sesión, Estadísticas, Salud y **Noche** (sesión activa en tema nocturno).

Son maquetas HTML estáticas con datos de ejemplo (Leo, 5 meses). No hay cambios en la app. Los tres comparten las mismas decisiones estructurales, que responden a la auditoría; lo que cambia es el carácter.

## Decisiones comunes (resuelven C1–C5, A1, A5, A6)

| Problema | Respuesta común |
|---|---|
| C1 Hoy activa saturada | Un solo CTA dominante abajo (zona del pulgar); correcciones y notas pasan a nivel secundario; «No llegó a dormirse» baja a «Más» / lista |
| C2 Hoy sin sesión | El **tiempo despierto** y la ventana habitual pasan a ser el protagonista; «Dormir» fijo abajo; «Empezar a dormirlo» como acción terciaria |
| C3 Sub-navegación en chips | Estadísticas: 3 cifras + gráfico y lista «más análisis» (o pestañas con scroll); Salud: panel «Lo próximo» antes de las secciones |
| C4 Gráfico | Valor sobre cada barra, media punteada, leyenda, etiquetas ≥10,5 px; tonos de siesta/noche con ≥3:1 (por validar con herramienta) |
| A1 Iconos | Un único set de trazo (estilo Lucide, 1,75 px) en lugar de Unicode/emoji. Los prototipos usan trazados propios equivalentes |
| A5/A6 | Sin ceros vacíos y con panel de Salud (en fase 3 se definen estados vacíos) |

## Las tres direcciones

### A · Crepúsculo
- **Concepto:** la hora azul de la habitación del bebé: cálida, cercana, algo de «objeto bien hecho».
- **Personalidad:** afectuosa y serena; serif suave en cifras y títulos, el resto sans humanista.
- **Tipografía:** Fraunces (cifras/títulos) + DM Sans (UI). *Propuesta; ambas son Google Fonts con licencia OFL.*
- **Paleta claro:** crema `#f7f0e6`, tinta ciruela `#2b2038`, terracota `#b9531f`, siesta ámbar `#e0a43a`, noche violeta `#4a3a7a`. **Oscuro:** ciruela `#181226` + melocotón `#f0955a`. **Noche:** `#050304`, ámbar apagado `#c27a3e`.
- **Iconos:** trazo fino, redondeado.
- **Composición:** centrada; héroe numérico enorme; bloques tonales sin borde.
- **Botones/tarjetas:** píldora de 62–70 px, sombra cálida (solo en claro/oscuro); tarjetas de radio 20–22 con fondo tonal.
- **Gráficos:** barras apiladas redondeadas con valor encima y línea de media.
- **Noche:** negro puro, sin sombras, ámbar tenue; ningún color saturado.
- **Riesgo:** puede leerse «demasiado bonita/blanda» si se abusa del serif. Es la más cercana a lo que ya existe (splash lunar).

### B · Cuaderno
- **Concepto:** el cuaderno de un buen pediatra o un diario de padres: papel, tinta, listas.
- **Personalidad:** serena, adulta, de confianza; casi sin «cajas».
- **Tipografía:** Newsreader (cifras y frases) + Instrument Sans (UI).
- **Paleta claro:** papel `#f5f0e4`, tinta `#22241e`, salvia `#3f6b4f`, siesta ocre `#c98f2f`, noche azul tinta `#35506e`. **Oscuro:** `#14160f` + salvia clara `#8fbf9a`. **Noche:** `#070604` + ámbar `#b98a45`.
- **Composición:** jerarquía por tipografía y filas con puntos guía (`Siestas ······ 1 h 40`); frase-estado: «Lleva 1 h 25 despierto».
- **Botones/tarjetas:** CTA rectangular suave (radio 12), botones de contorno; en vez de tarjetas, separadores de 1 px.
- **Gráficos:** barras horizontales por día (más legibles con 14/28 días), tira de 24 h con las siestas del día.
- **Noche:** papel → negro cálido; el menor brillo posible por ausencia de superficies.
- **Riesgo:** menos «táctil»; la sub-navegación con pestañas subrayadas exige scroll horizontal (se ve cortada a propósito).
- **Fortaleza:** máxima densidad útil sin ruido; la más diferenciada del resto de apps.

### C · Marea
- **Concepto:** instrumentos claros; anillo de tiempo y mosaicos de datos; frescura nórdica.
- **Personalidad:** moderna, tecnológica, precisa, tranquila.
- **Tipografía:** Manrope (única familia, pesos 500–800).
- **Paleta claro:** niebla `#e9f0f1`, tinta `#0d2f38`, petróleo `#14707f`, siesta arena `#e8b45a`, noche azul `#1b5a8f`. **Oscuro:** `#08171c` + turquesa `#5ec2d1`. **Noche:** `#020506` + ámbar `#b8863f`.
- **Composición:** anillo de progreso (ventana de vigilia/duración) + botón circular grande «Dormir/Despertó»; Salud como mosaico (bento).
- **Botones/tarjetas:** círculo de 92 px con halo; tarjetas de radio 22–26 con sombra de 2 px; chips de acción.
- **Gráficos:** barras con valor, mini-curva de crecimiento, anillo de vacunas (8/14).
- **Noche:** anillo ámbar sobre negro; halo reducido.
- **Riesgo:** el anillo comunica «objetivo» y puede sugerir que hay que llegar a algo (¡no es lo que queremos para el sueño del bebé!). Habría que usarlo solo como indicación de ventana habitual. Puede parecer app de fitness.

## Comparación

| Criterio | A Crepúsculo | B Cuaderno | C Marea |
|---|---|---|---|
| Calidez | ★★★ | ★★ | ★ |
| Una mano de noche | ★★★ (CTA píldora) | ★★ (CTA ancho) | ★★★ (botón circular) |
| Densidad informativa | ★★ | ★★★ | ★★ |
| Evita «IA genérica» | ★★ | ★★★ | ★★ |
| Evita «hospitalario» | ★★★ | ★★★ | ★★ |
| Evita «infantil» | ★★ | ★★★ | ★★★ |
| Coste de implementación (sobre Tailwind actual) | Bajo | Medio (quitar cajas) | Medio-alto (anillos, mosaicos) |
| Continuidad con la app (splash lunar) | Alta | Media | Baja |

## Mi recomendación

**A como base, con elementos de B**: A por la calidez y por ser la que menos rompe lo existente (el splash ya es lunar y cálido); de B conviene tomar la frase-estado («Lleva 1 h 25 despierto»), las barras horizontales para 14/28 días y las filas con puntos guía en las cifras. De C, solo el botón circular grande si quieres probarlo en pruebas de uso nocturno. Evitaría el anillo de objetivo (ver riesgo de C).

Esto es una opinión mía; la decisión es tuya.

## Límites de estos prototipos

- Maquetas estáticas: no sustituyen una prueba con la app real ni con padres.
- Los contrastes mostrados son estimaciones; en la Fase 3 se validan con script (WCAG 1.4.3 / 1.4.11).
- Pendiente de diseñar en fase 3: formularios, hojas inferiores, estados vacío/carga/error, Ajustes, Historial, y los dos tamaños de texto del sistema.
- Las fuentes se cargan desde Google Fonts para los prototipos; en la app se empaquetarían con `@fontsource` (como ya se hace con Baloo 2) para funcionar sin conexión.

## Qué necesito de ti

1. Dirección elegida (A, B, C o una mezcla concreta).
2. ¿Mantener «Estadísticas» o acortar a «Datos» en la barra inferior?
3. ¿Mantener el tema `auto` + claro/oscuro/noche, o simplificar?

## Añadido: D · Marea Crepúsculo

Estructura de C (anillo, botón circular, mosaicos) con la paleta de A (crema/terracota/ámbar/violeta; oscuro ciruela; noche ámbar). Mantiene Manrope; las sombras de las tarjetas se tiñen de ciruela. El botón circular dice «Despierto» (cabe en los 92 px; también en C). El riesgo del anillo como «objetivo» (ver C) se mantiene.
