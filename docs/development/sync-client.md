# Sincronización: cliente (Fase 2)

Estado: **motor completo y probado contra un servidor simulado; sin conectar a ningún servicio real y sin activar en la app.** Hoy la app escribe exactamente igual que antes (`db.syncEnabled = false`).

## Piezas

| Archivo | Qué hace |
|---|---|
| `database/migrations/0005_sync_restore.sql` | `apply_changes` admite `restore` y `delete` junto con `fields` |
| `src/sync/outbox.ts` | Cola de operaciones pendientes (`outbox`) |
| `src/sync/engine.ts` | `syncOnce`: envía y después recibe. Normaliza las filas del servidor |
| `src/sync/identity.ts` | `connectDevice`: adopta la familia del servidor, reconcilia etiquetas y sube lo existente |
| `src/sync/tables.ts`, `types.ts` | Tablas sincronizables, columnas gestionadas por el servidor, interfaz `Transport` |
| `src/domain/write.ts` | Único punto de escritura: encola cada cambio **en la misma transacción** que la fila |
| `test/sim-server.ts` | Servidor simulado con las reglas de `apply_changes` |

## Reglas que hacen que sea seguro

- **Nada se activa solo.** La cola solo se alimenta con `sync_enabled`. Con él apagado no hay lecturas ni escrituras extra.
- **Idempotencia.** Cada operación lleva un `op_id`. Si se envía y la respuesta se pierde, reenviarla no la aplica dos veces.
- **Contenido congelado al intentar enviar.** Una operación ya intentada no se modifica: las ediciones posteriores van detrás, con su propio `op_id`. Si no, una edición nueva se perdería al «reproducirse» la antigua.
- **Una operación por fila y pasada**, para que el `base_rev` de cada una sea el que dejó la anterior.
- **Borrar/restaurar guardan el estado final deseado**, no una resta. «Borrar y restaurar» sin enviar **no** equivale a «nada»: en el servidor la fila puede estar ya borrada. (Lo encontró la prueba aleatoria.)
- **Un rechazo no pierde nada.** La operación queda en la cola con su motivo, la fila local se conserva y no bloquea el resto. `retryRejected` la reintenta.
- **Lo pendiente se ve.** Al recibir una fila con cambios locales sin enviar, se conserva el valor local de esos campos.

## Conectar un dispositivo (orden importante)

1. Adopta la identidad del servidor: reescribe `family_id` y la autoría de todas las filas locales.
2. Activa la cola y **recibe** lo que ya hay (sin enviar).
3. Reconcilia las etiquetas y categorías de sistema por `slug` (las crea cada móvil por su cuenta; sin esto aparecerían duplicadas).
4. Encola un alta por cada fila local que el servidor no conoce, con los padres antes que los hijos.
5. Sincroniza.

## Cómo se prueba

`test/sync.test.ts`: conexión de un móvil con datos y de uno nuevo, fusión de campos, conflictos de fin de sueño (≤ y > 2 min), editar vs borrar, cancelar/deshacer, red caída, respuesta perdida (con y sin edición posterior del mismo campo), rechazos y una **prueba aleatoria**: dos móviles hacen acciones y fallos al azar y, tras sincronizar, deben tener el mismo contenido que el servidor.

```bash
SYNC_SEEDS=500 npx vitest run apps/mobile/test/sync.test.ts   # búsqueda amplia (≈ 2 min)
SYNC_TRACE=1 …                                                  # imprime las acciones de un caso que falle
```

## Límites conocidos (pendientes)

- **No hay transporte real.** Falta implementar `Transport` contra Supabase (RPC `apply_changes` y lecturas por `change_seq`) y decidir cuándo se sincroniza (al abrir, tras escribir, al recuperar la red).
- **Perfiles de bebé duplicados.** Si cada móvil creó su propio perfil del mismo bebé, al conectar aparecerán dos. Hace falta una herramienta de «fusionar perfiles».
- **Sin bandeja de conflictos ni `resolve_conflict`.** El servidor guarda cada valor desplazado, pero aún no hay pantalla para elegir.
- **El simulador copia las reglas del SQL, no las ejecuta.** Si divergen, las pruebas del simulador no lo detectarían. Pendiente: pasar los mismos escenarios contra PostgreSQL real.
- **Metadatos locales.** Si una edición del móvil resulta ser un no-op para el servidor (p. ej. restaurar algo vivo), el móvil conserva su `rev`/`updated_*` propios. El **contenido** converge siempre; la prueba solo tolera esos campos.
- **Campos relacionados se fusionan uno a uno** (p. ej. fin de sueño y su zona). Una combinación imposible se rechazaría (y se conservaría en la cola). La prueba aleatoria no ha producido ninguna.
- **La foto del bebé no se sincroniza** (decisión de producto).
