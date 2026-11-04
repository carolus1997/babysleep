# Aviso de próxima toma (web push) — puesta en marcha

Coste: **0 €** (plan gratuito de Supabase). No hace falta Apple Developer ni App Store.

## Cómo funciona

1. Cada móvil que lo activa guarda en Supabase su «dirección de aviso» (la da el propio iPhone) y dos claves públicas. Los clientes no pueden leer esa tabla.
2. Cada 5 minutos, `pg_cron` llama a la función `feed-reminders` (`supabase/functions/feed-reminders`).
3. La función pide a la base de datos (`app.claim_due_feed_reminders`) las tomas que ya tocan: han pasado X minutos desde el **inicio** de la última toma de cada bebé, hay avisos activados, la toma no está en curso y lo que tocaba pasó hace menos de 3 h. La base de datos marca la toma como avisada en la misma operación, así que **solo hay un aviso por toma**.
4. Envía el aviso a cada móvil de la familia (web push, cifrado de extremo a extremo hacia el móvil).
5. Al tocar el aviso la app se abre. Los botones **Pecho / Biberón** del aviso empiezan la toma directamente (con «Deshacer»). Si el sistema no muestra los botones, tocar el aviso abre la app y se empieza con los botones de siempre.

Límites honestos: el aviso puede llegar con hasta ~5 minutos de retraso; iOS decide cuándo entrega y cómo muestra los botones; solo funciona con la app **instalada en la pantalla de inicio**.

## Pasos (una sola vez)

### 1. Migración 0009
Supabase → SQL Editor → pega **solo** `database/migrations/0009_feed_reminders.sql` → Run. Comprueba con `select value from app.app_meta where key = 'schema_version';` → `0.9.0`.

### 2. Extensiones
Supabase → Database → Extensions → activa **pg_cron** y **pg_net**.

### 3. Claves del servicio de avisos (VAPID)
En tu ordenador:

```bash
npx web-push generate-vapid-keys
```

Salen dos claves. La **pública** es la que me pasas (no es secreta). La **privada NO la pegues en ningún chat ni archivo del repositorio.**

### 4. Secretos de la función
Supabase → Edge Functions → Secrets (o `npx supabase secrets set`), cuatro valores:

| Nombre | Valor |
|---|---|
| `VAPID_PUBLIC_KEY` | la clave pública |
| `VAPID_PRIVATE_KEY` | la clave privada |
| `VAPID_SUBJECT` | una dirección https de contacto, p. ej. la de la app en GitHub Pages (no uses tu correo del trabajo) |
| `CRON_SECRET` | una cadena larga y aleatoria que inventes (mínimo 16 caracteres) |

### 5. Desplegar la función

```bash
npx supabase login
npx supabase functions deploy feed-reminders --no-verify-jwt --project-ref tvdqmbkmzmclgzfbgdqv
```

`--no-verify-jwt` es necesario porque quien la llama es la base de datos con la cabecera `x-cron-secret`, no un usuario.

### 6. Programarla
En el SQL Editor, cambiando `TU_CRON_SECRET` por el mismo valor del paso 4 (este SQL **no** se guarda en el repositorio):

```sql
select cron.schedule('feed-reminders', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://tvdqmbkmzmclgzfbgdqv.supabase.co/functions/v1/feed-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'TU_CRON_SECRET'),
    body := '{}'::jsonb
  );
$$);
```

Para pararlo: `select cron.unschedule('feed-reminders');`

### 7. En la app
Pon la clave pública en `apps/mobile/src/sync/config.ts` (`VAPID_PUBLIC_KEY`) y publica. Después, en cada móvil: Ajustes → Cuenta y sincronización → **Aviso de próxima toma** → «Activar el aviso en este móvil» (pide permiso de notificaciones).

## Probar de punta a punta
- «Probar cómo se ve el aviso» enseña una notificación local (comprueba permisos y aspecto, no el servidor).
- Para probar el servidor sin esperar horas: pon el intervalo en 2 h, registra una toma con inicio hace algo más de 2 h y espera ≤ 5 min. Revisa Edge Functions → Logs si no llega.
