# ADR 0002: Modelo temporal

- Estado: **Aceptada** (v0.4 con las correcciones de la ronda de aprobación)
- Implementación: `packages/core/src/time/*`
- Pruebas: `packages/core/test/{time,overlaps,latency-awake}.test.ts`

## Contexto

Las sesiones atraviesan la medianoche y los cambios de hora, dos cuidadores pueden registrar el mismo evento, y no sabemos si los despertares nocturnos están registrados por completo. El modelo debe producir totales correctos sin simplificar por el hecho de usar hoy una sola zona (`Europe/Madrid`).

## Decisión

### 1. Instantes, no horas de pared

Cada evento guarda un instante UTC (`timestamptz`) más la zona IANA y el offset vigentes. **Toda duración se calcula con instantes.** Una noche de 21:00 a 07:00 mide 9 h el día del salto de primavera y 11 h el del retroceso de otoño. Luxon se usa solo a través de `time/zone.ts`, para poder sustituirlo.

### 2. Semántica del intervalo (decisiones F1 y F2)

`sleep_start` es «comprobado dormido» y `sleep_end` es «se despierta». El campo `interval_semantics` es hoy constante. La exhaustividad de despertares (`awakenings_completeness`) es `unknown` por defecto y nunca cambia sola. Las duraciones nocturnas históricas no se modifican ni se reinterpretan como tiempo en cama ni como sueño efectivo.

### 3. Tres vistas que NO se mezclan

| Vista | Definición | Duración de la ventana |
|---|---|---|
| `natural_day` | Día civil local; suma de la intersección con la sesión | 23, 24 o 25 h |
| `rolling_24h` | Ventana de 24 horas reales que termina en un instante | Siempre 24 h |
| `attributed_by_wake_date` | Etiqueta: la noche pertenece a la fecha local de su despertar; la siesta, a la de su inicio | No recorta: suma duraciones completas |

Cada resultado lleva su `kind`, y las etiquetas visibles (`METRIC_KIND_LABELS_ES`) son distintas. Invariante comprobado por propiedades: la agrupación nunca altera una duración (`Σ por día natural = unión total`; sin solapes, `Σ atribuido = Σ duraciones`).

### 4. Solapes entre cuidadores

Los totales usan la **unión de intervalos**: cada instante dormido cuenta una vez. Dos registros del mismo sueño no duplican el total.

- Los solapes **no se resuelven automáticamente**: se devuelven como `overlaps` con estado `pending_review`.
- Si los inicios difieren ≤ 5 min (configurable) se marcan `probableDuplicate` para proponer fusión.
- Las sesiones fusionadas (`merged_into`) o eliminadas (`deleted_at`) quedan en la base, con su trazabilidad, pero no cuentan.
- La base de datos no impone unicidad de sesión abierta ni de no solape, porque bloquear un registro hecho sin conexión perdería información.
- Mezclar sesiones de varios bebés en un cálculo lanza un error.

### 5. Efectivo dormido como rango

`recorded` es la duración registrada. El despierto registrado es la unión de los episodios con extensión conocida, recortada a la sesión. El efectivo es `recorded − despierto`, **cota superior** salvo que el cuidador marque `complete`. La cota inferior no se calcula.

### 6. Latencia de conciliación

`latencia = sleep_start − settling_attempt.started_utc`. Sin intento es **desconocida** (nunca 0). Un intento posterior al sueño es una anomalía. Por encima del umbral (3 h por defecto) pasa a `needs_review`: el valor se conserva y no entra en los resúmenes hasta revisarlo. La colocación en cuna no interviene. La calidad `approx` se hereda de cualquiera de los extremos.

### 7. Entradas locales ambiguas

`resolveLocal` devuelve `ambiguous` (retroceso de otoño, con los dos instantes) o `nonexistent` (salto de primavera). Nunca corrige en silencio. El cronómetro captura instantes y no sufre el problema.

### 8. Sesiones abiertas y anomalías

Una sesión abierta se excluye de los totales salvo que se pase `nowMs`; entonces se cierra virtualmente y el resultado indica `includesOpen`. Las noches abiertas no se atribuyen a ninguna fecha. Duración ≤ 0: anomalía y excluida. Duración > 24 h: anomalía, **se conserva**.

## Consecuencias

- Los totales por día natural no suman 24 h los días de cambio de hora, y la interfaz debe decir qué vista muestra.
- El recorte por día natural y la atribución por despertar pueden dar números distintos para el mismo día; es intencionado y se etiqueta.
- La detección de solapes es cuadrática en el peor caso, aceptable para el volumen previsto.

## Pendiente

Ventanas de vigilia, hora habitual y estadística circular, y la validación en un dispositivo real de cómo el navegador resuelve zonas. Ver especificación §13.
