// Función programada: avisa a los móviles de la familia cuando toca la siguiente toma y antes de cada cita médica.
//
// La llama pg_cron cada 5 minutos con la cabecera `x-cron-secret`. Reclama en la base de datos (de forma
// atómica y una sola vez por toma o por aviso de cita) los avisos pendientes y los envía por web push. Secretos necesarios
// (Supabase → Edge Functions → Secrets), NUNCA en el repositorio:
//   CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (una dirección https de contacto).
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las pone Supabase solo.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { buildAppointmentPayload, buildPayload, isGone, type DueAppointmentReminder, type DueReminder, type PushPayload } from './payload.ts';

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
  const nowIso = new Date(now).toISOString();
  const feeds = await sb.rpc('claim_due_feed_reminders', { p_now: nowIso });
  if (feeds.error) return new Response(`claim_failed: ${feeds.error.message}`, { status: 500 });
  const appts = await sb.rpc('claim_due_appointment_reminders', { p_now: nowIso });
  if (appts.error) return new Response(`claim_appointments_failed: ${appts.error.message}`, { status: 500 });

  const jobs: Array<{ to: { subscription_id: string; endpoint: string; p256dh: string; auth: string }; payload: PushPayload; ttl: number }> = [
    ...((feeds.data ?? []) as DueReminder[]).map((r) => ({ to: r, payload: buildPayload(r, now), ttl: 3600 })),
    // Un aviso de cita vale más tiempo: si el móvil estaba apagado, que llegue al encenderlo (hasta 2 h).
    ...((appts.data ?? []) as DueAppointmentReminder[]).map((r) => ({ to: r, payload: buildAppointmentPayload(r), ttl: 7200 })),
  ];
  let sent = 0;
  let failed = 0;
  await Promise.all(
    jobs.map(async ({ to, payload, ttl }) => {
      try {
        await webpush.sendNotification({ endpoint: to.endpoint, keys: { p256dh: to.p256dh, auth: to.auth } }, JSON.stringify(payload), { TTL: ttl, urgency: 'high' });
        sent++;
        await sb.rpc('report_push_result', { p_subscription_id: to.subscription_id, p_ok: true, p_gone: false });
      } catch (e) {
        failed++;
        const status = (e as { statusCode?: number }).statusCode;
        await sb.rpc('report_push_result', { p_subscription_id: to.subscription_id, p_ok: false, p_gone: isGone(status) });
      }
    }),
  );
  return Response.json({ feeds: (feeds.data ?? []).length, appointments: (appts.data ?? []).length, sent, failed });
});
