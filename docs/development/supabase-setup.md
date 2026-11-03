# Puesta en marcha de Supabase (la haces tú)

Nada de esto lo puede hacer Claude: son cuentas y secretos tuyos. **No pegues en el chat** la contraseña de la base de datos, la clave `service_role` ni la clave SMTP. A Claude solo le hacen falta dos datos, que son públicos por diseño: la **URL del proyecto** y la **clave pública (anon / publishable)**.

> Los nombres de los menús de Supabase y Brevo cambian de vez en cuando; si algo no se llama exactamente igual, busca el equivalente.

Tiempo estimado: 30–40 min. Coste: 0 € (plan gratuito).

## 1. Proyecto en Supabase

1. Entra en <https://supabase.com> (puedes usar tu cuenta de GitHub, que debe tener la verificación en dos pasos activada).
2. **New project**. Nombre: `babysleep`. Plan: **Free**.
3. **Región: UE** (p. ej. Frankfurt). Importa: son datos de un menor.
4. **Contraseña de la base de datos**: que la genere Supabase (larga) y guárdala en tu gestor de contraseñas. No se usa en el día a día.

## 2. Cerrar el registro

En **Authentication → Sign In / Providers**:

- **Desactiva «Allow new users to sign up»** (nadie puede crearse una cuenta).
- Proveedor **Email** activado. Longitud del código OTP: **6**. Caducidad: **900 s** (15 min).

## 3. Correo propio (SMTP)

El correo integrado de Supabase solo envía a miembros del equipo y con un límite muy bajo. Hace falta uno propio.

**Opción recomendada: Brevo** (plan gratuito, no exige dominio propio):

1. Crea cuenta en <https://www.brevo.com>.
2. **Senders, domains & IPs → Senders**: añade tu correo como remitente y verifícalo con el enlace que te llega.
3. **SMTP & API → SMTP → Generate a new SMTP key**. Guárdala en tu gestor.
4. En Supabase, **Authentication → Emails → SMTP Settings → Enable custom SMTP**:
   - Host: `smtp-relay.brevo.com` · Puerto: `587`
   - Usuario: el login SMTP que muestra Brevo · Contraseña: la clave SMTP
   - Remitente: el correo verificado en el paso 2

*Alternativa:* una cuenta de Gmail con verificación en dos pasos y una «contraseña de aplicación» (host `smtp.gmail.com`, puerto `587`). Válida para dos personas.

## 4. Plantilla del correo: código de 6 dígitos

**Authentication → Emails → Templates → «Magic Link»** (es la plantilla que se usa para el código). El cuerpo debe contener el código, no un enlace:

```html
<h2>Tu código de BabySleep</h2>
<p>Código: <strong>{{ .Token }}</strong></p>
<p>Caduca en 15 minutos. Si no lo has pedido tú, ignora este correo.</p>
```

## 5. Crear los dos usuarios (a mano)

Con el registro cerrado, los usuarios los creas tú. **Authentication → Users → Add user → Create new user**:

- Correo de cada progenitor.
- Marca **Auto Confirm User**.
- Contraseña: una larga aleatoria que no necesitarás (se entra con código, no con contraseña).

## 6. Crear las tablas

1. **SQL Editor → New query**.
2. Pega **entero** el contenido de [`database/supabase/setup.sql`](../../database/supabase/setup.sql) y pulsa **Run**. Debe terminar sin errores. (Es la suma de las migraciones 0001–0005; se ejecuta **una sola vez**.)
3. En otra consulta, crea tu familia con **tu** correo (el mismo del paso 5):

   ```sql
   select app.bootstrap_family('Mi familia', 'Tu nombre', 'tu-correo@ejemplo.com');
   ```

   Devuelve un **código de alta** (64 caracteres). **Se muestra una sola vez**: guárdalo en tu gestor. Caduca a los 30 minutos y es de un solo uso. Lo usarás en la app al entrar por primera vez.
4. Para tu pareja (u otra persona): crea su usuario en **Authentication → Users** (paso 5) y, desde la app, **Ajustes → Cuenta y sincronización → Familia → Invitar a alguien**. La app genera su código de alta (30 min, un uso). Ya no hace falta SQL.

## 7. Exponer el esquema `app`

**Settings → API → Exposed schemas**: añade `app` (junto a `public`) y guarda. Todas las tablas tienen seguridad por filas (RLS) y los clientes solo pueden **leer** lo de su familia; escribir solo se puede mediante `apply_changes`.

## 8. Lo único que hay que pasarle a Claude

En **Settings → API Keys**:

- **Project URL**: `https://xxxxxxxx.supabase.co`
- **Publishable / anon key**: la clave pública.

Es seguro compartirlas: la clave pública no da acceso a nada sin una sesión válida y sin las políticas de seguridad. **Nunca** `service_role`, la contraseña de la base de datos ni la clave SMTP.

## 9. Qué hace la app con esto

La URL y la clave pública están en `apps/mobile/src/sync/config.ts` (públicas por diseño; el sitio publicado las lleva de todos modos). En Ajustes → «Cuenta y sincronización»: correo → código de 6 dígitos → código de alta (solo la primera vez) → «Conectar este móvil».

## Actualizar un proyecto que ya tienes

`setup.sql` es solo para el **primer** montaje. Si ya lo ejecutaste, cuando salga una migración nueva se ejecuta **solo esa** (SQL Editor → pegar el archivo → Run), en orden:

| Migración | Qué añade | Estado en tu proyecto |
|---|---|---|
| 0001–0005 | Tablas, seguridad, sincronización, perfil, restaurar | Aplicadas |
| `0006_family_admin.sql` | Invitar y retirar cuidadores desde la app | **Pendiente** |

## Cosas que conviene saber

- **Plan gratuito:** Supabase **pausa** el proyecto tras ~7 días sin actividad y **no hace copias automáticas**. Por eso las copias diarias propias (cifradas) son importantes y están en el plan.
- **Probar el correo:** tras configurar el SMTP, pide un código desde Authentication → Users (enviar «magic link» a tu correo) y comprueba que llega, que no cae en spam y que muestra el código.
- **Sin cobros:** en el plan Free no se pide tarjeta. Si en algún momento te la pide, no continúes y avísame.
