# BabySleep Analytics

Registro, análisis y predicción orientativa del sueño infantil. Local-first, privada, sin fines diagnósticos.

> **Estado: Fase 0A completada y Fase 1 (app móvil local) en curso.** Hay app móvil local (sin sincronización) y todavía no hay dashboard. Consulta `docs/spec/BABYSLEEP_SPEC_v0.4.md` para la especificación vigente y `docs/development/mobile-app.md` para la app.

## Estructura

| Ruta | Contenido |
|---|---|
| `packages/contract` | Esquemas Zod del contrato de datos (snake_case, igual que SQL) |
| `packages/core` | Núcleo en TypeScript: módulo temporal, intervalos, latencia, estadística |
| `database/migrations` | Esquema relacional (esquema `app`, RLS activada sin políticas) |
| `tests/fixtures` | `synthetic/` y `golden/` (versionados); `private/` (solo local, ignorado) |
| `tools/oracle-py` | Oráculo numpy que genera fixtures dorados (solo CI/pruebas) |
| `docs/adr`, `docs/spec` | Decisiones de arquitectura y especificación |
| `apps/mobile` | PWA local-first (React, Dexie). `dashboard` queda reservado |

## Comandos

```bash
npm install
npm run check        # datos privados + typecheck + pruebas
npm test
```

Regenerar los fixtures dorados (requiere Python con numpy; ver `tools/oracle-py/requirements.txt`):

```bash
python tools/oracle-py/make_golden.py
```

## Datos reales

**Este repositorio será público: no contiene datos reales del bebé.** Los fixtures sintéticos están marcados como tales. Los datos reales para pruebas locales viven en `tests/fixtures/private/`, ignorada por git. `npm run check:private-data` falla si algo de esa carpeta se rastrea.

## Avisos

BabySleep no es un producto sanitario ni una herramienta de diagnóstico. Las asociaciones estadísticas que muestre no implican causalidad.
