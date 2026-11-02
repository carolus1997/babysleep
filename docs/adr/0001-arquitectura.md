# ADR 0001: Arquitectura general

- Estado: **Aceptada** (v0.4, aprobada por el propietario)
- Fecha: 2026-11-01
- Referencia: `docs/spec/BABYSLEEP_SPEC_v0.4.md`

## Contexto

Herramienta doméstica para registrar, analizar y predecir el sueño infantil. Dos progenitores registran desde el móvil, con y sin conexión, sobre los mismos perfiles. Se prioriza empezar a registrar datos reales cuanto antes, sin comprometer la integridad de los datos ni la privacidad.

## Decisión

1. **Móvil:** React + TypeScript + Vite, PWA, publicada en GitHub Pages. Almacenamiento local-first en IndexedDB mediante Dexie, con cola de operaciones (outbox).
2. **Núcleo analítico único en TypeScript (`packages/core`).** Es código puro, sin DOM ni I/O. Lo usan el móvil (en un Web Worker) y el dashboard. La predicción se ejecuta en el dispositivo, así que funciona sin el ordenador del dashboard.
3. **Python no es runtime.** Se usa como oráculo en CI (`tools/oracle-py`, numpy) para generar fixtures dorados que el núcleo TS debe reproducir. Un perfil `lab` opcional de Compose queda reservado para análisis que TS no cubra.
4. **Dashboard:** SPA React + ECharts servida por nginx en Docker Compose, que es el despliegue oficial. Inicia sesión con el usuario del progenitor (OTP) y nunca contiene claves de servicio.
5. **Backend:** Supabase (región UE): Postgres, Auth y RLS. Sincronización mediante una RPC transaccional. Autenticación solo por OTP de 6 dígitos por correo; registro público deshabilitado.
6. **Datos de aplicación en el esquema `app`**, no expuesto por la API REST de Supabase, con RLS activada y sin políticas hasta que se definan y se prueben. El acceso del cliente pasará por funciones RPC expuestas explícitamente.
7. **Los datos referencian `caregiver.id`**, nunca `auth.users`, para que la recuperación no dependa del esquema `auth`.
8. **Copias:** `pg_dump` diario en un repositorio privado, restauración técnica antes de cifrar, cifrado con `age` a las claves públicas de ambos progenitores, claves privadas fuera de GitHub y de CI. Detalle en la especificación §8.
9. **Monorepo** con npm workspaces: `apps/*`, `packages/{contract,core}` (más `sync` y `evidence` cuando se necesiten), `database/`, `tools/`, `docs/`, `tests/`.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Python como motor estadístico (Streamlit) | Exigía duplicar el predictor para el móvil o aceptar predicciones obsoletas con el ordenador apagado |
| Sincronización con CRDT o servicios gestionados (Dexie Cloud, PowerSync) | Menos transparencia ante conflictos; el volumen no lo justifica |
| Datos en el esquema `public` | Quedarían expuestos por la API ante cualquier error de política |
| Referenciar `auth.users` en los datos | Acopla la recuperación al esquema `auth` |

## Consecuencias

- Una sola implementación de cada métrica y una sola suite de pruebas. El riesgo de deriva se controla con fixtures dorados.
- La estadística avanzada queda limitada a lo que se implemente en TS. Los métodos que lo superen se estudiarán en el perfil `lab`, etiquetados como exploratorios.
- La sincronización exige pruebas propias (simulador multi-dispositivo) antes de declarar completa la versión familiar.
- Los datos reales nunca entran en el repositorio público: `tests/fixtures/private/` está en `.gitignore` y `npm run check:private-data` falla si algo se rastrea.

## Pendiente de validación (Fase 0)

OTP en iPhone real, SMTP propio, rol de volcado frente a RLS, restauración de prueba y simulacro, simulador de sincronización. Ver especificación §13.
