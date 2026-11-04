// Función programada: avisa a los móviles de la familia cuando toca la siguiente toma.
//
// La llama pg_cron cada 5 minutos con la cabecera `x-cron-secret`. Reclama en la base de datos (de forma
// atómica y una sola vez por toma) los avisos pendientes y los envía por web push. Secretos necesarios
// (Supabase → Edge Functions → Secrets), NUNCA en el repositorio:
//   CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (una dirección https de contacto).
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las pone Supabase solo.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { buildPayload, isGone, type DueReminder } from './payload.ts';

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get('CRON_SECRET') ?? '';
  if (secret.length < 16 || req.headers.get('x-cron-secret') !== secret) return new Response('forbidden', { status: 403 });

  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  const priv = Deno.env.get('VAPID_PRIVATE_KEY');
  const subject = Deno.env.get('VAPID_SUBJECT');
  if (!pub || !priv || !subject) return new Response('vapid_not_configured', { status: 500 });
  webpush.setVapidDetails(subject, pub, priv);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    db: { schema: 'app' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const now = Date.now();
  const { data, error } = await sb.rpc('claim_due_feed_reminders', { p_now: new Date(now).toISOString() });
  if (error) return new Response(`claim_failed: ${error.message}`, { status: 500 });

  const due = (data ?? []) as DueReminder[];
  let sent = 0;
  let failed = 0;
  await Promise.all(
    due.map(async (r) => {
      try {
        await webpush.sendNotification(
          { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
          JSON.stringify(buildPayload(r, now)),
          { TTL: 3600, urgency: 'high' },
        );
        sent++;
        await sb.rpc('report_push_result', { p_subscription_id: r.subscription_id, p_ok: true, p_gone: false });
      } catch (e) {
        failed++;
        const status = (e as { statusCode?: number }).statusCode;
        await sb.rpc('report_push_result', { p_subscription_id: r.subscription_id, p_ok: false, p_gone: isGone(status) });
      }
    }),
  );
  return Response.json({ due: due.length, sent, failed });
});
