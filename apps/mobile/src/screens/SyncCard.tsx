import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext';
import { t } from '../i18n/es';
import { claimMembership, currentSession, disableCaregiver, inviteCaregiver, isLinked, listFamily, requestCode, signOut, verifyCode, type FamilyMember } from '../sync/auth';
import { syncOnce } from '../sync/engine';
import { connectDevice } from '../sync/identity';
import { rejectedEntries, retryRejected } from '../sync/outbox';
import { getSupabaseClient, hasStoredSession, supabaseTransport } from '../sync/supabase';
import type { SyncStatus } from '../sync/useAutoSync';
import { useLive } from '../ui/hooks';
import { Btn, Card, Chip, Field, inputCls, Sheet } from '../ui/primitives';

type Phase = 'checking' | 'signed_out' | 'code_sent' | 'needs_claim' | 'linked' | 'connected';

/** Familia: quién tiene acceso. Solo los administradores pueden invitar, re-invitar o retirar el acceso. */
function FamilySection() {
  const { ctx, run, toast } = useApp();
  const [members, setMembers] = useState<FamilyMember[] | null>(null);
  const [sheet, setSheet] = useState<{ name: string; email: string; role: 'caregiver' | 'viewer' } | null>(null);
  const [issued, setIssued] = useState<{ name: string; email: string; code: string } | null>(null);

  const reload = async () => {
    const list = await run(async () => listFamily(await getSupabaseClient()));
    if (list) setMembers(list);
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  const me = members?.find((m) => m.id === ctx.caregiverId);
  if (members === null) return null;
  const isAdmin = me?.role === 'admin';

  const issue = async (name: string, email: string, role: 'caregiver' | 'viewer') => {
    const code = await run(async () => inviteCaregiver(await getSupabaseClient(), name, email, role));
    if (code) {
      setSheet(null);
      setIssued({ name, email, code });
      void reload();
    }
  };

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{t('family.title')}</h3>
      <ul className="divide-y divide-line">
        {members.map((m) => (
          <li key={m.id} className="py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span>
                <strong>{m.display_name}</strong>
                <span className="block text-xs text-muted">
                  {m.email_normalized} · {t(`family.role.${m.role}` as 'family.role.admin')} · {t(`family.status.${m.status}` as 'family.status.active')}
                </span>
              </span>
              {isAdmin && m.id !== ctx.caregiverId && (
                <span className="flex shrink-0 gap-1">
                  {m.status !== 'active' && m.role !== 'admin' && (
                    <Btn variant="ghost" onClick={() => issue(m.display_name, m.email_normalized, m.role === 'viewer' ? 'viewer' : 'caregiver')}>
                      {t('family.newCode')}
                    </Btn>
                  )}
                  {m.status === 'active' && (
                    <Btn
                      variant="ghost"
                      onClick={async () => {
                        if (!window.confirm(t('family.removeConfirm', { name: m.display_name }))) return;
                        const ok = await run(async () => {
                          await disableCaregiver(await getSupabaseClient(), m.id);
                          return true;
                        });
                        if (ok) {
                          toast(t('family.removed'));
                          void reload();
                        }
                      }}
                    >
                      {t('family.remove')}
                    </Btn>
                  )}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {isAdmin && (
        <Btn className="mt-2 w-full" onClick={() => setSheet({ name: '', email: '', role: 'caregiver' })}>
          + {t('family.invite')}
        </Btn>
      )}

      {sheet && (
        <Sheet title={t('family.invite')} onClose={() => setSheet(null)}>
          <Field label={t('family.name')}>
            <input className={inputCls} value={sheet.name} onChange={(e) => setSheet({ ...sheet, name: e.target.value })} />
          </Field>
          <Field label={t('family.email')}>
            <input className={inputCls} type="email" inputMode="email" autoCapitalize="none" value={sheet.email} onChange={(e) => setSheet({ ...sheet, email: e.target.value })} />
          </Field>
          <div className="mb-4" role="group" aria-label={t('family.role')}>
            <span className="mb-1 block text-sm font-medium text-muted">{t('family.role')}</span>
            <div className="flex gap-2">
              {(['caregiver', 'viewer'] as const).map((r) => (
                <Chip key={r} active={sheet.role === r} onClick={() => setSheet({ ...sheet, role: r })}>
                  {t(`family.role.${r}` as 'family.role.caregiver')}
                </Chip>
              ))}
            </div>
          </div>
          <Btn variant="primary" className="w-full" disabled={sheet.name.trim() === '' || !sheet.email.includes('@')} onClick={() => issue(sheet.name, sheet.email, sheet.role)}>
            {t('family.send')}
          </Btn>
        </Sheet>
      )}

      {issued && (
        <Sheet title={t('family.codeTitle')} onClose={() => setIssued(null)}>
          <p className="mb-3 text-sm text-muted">{t('family.codeHelp', { name: issued.name, email: issued.email })}</p>
          <p className="mb-3 break-all rounded-2xl border border-line bg-surface2 p-3 font-mono text-sm" data-testid="invite-code">
            {issued.code}
          </p>
          <Btn
            variant="primary"
            className="w-full"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(issued.code);
                toast(t('family.copied'));
              } catch {
                /* sin portapapeles: se puede seleccionar el texto a mano */
              }
            }}
          >
            {t('family.copy')}
          </Btn>
        </Sheet>
      )}
    </div>
  );
}

/** Cuenta y sincronización. Con el móvil sin conectar, no descarga nada de la librería hasta que se necesita. */
export function SyncCard() {
  const { ctx, run, toast, replaceCtx } = useApp();
  const [phase, setPhase] = useState<Phase>(ctx.db.syncEnabled || hasStoredSession() ? 'checking' : 'signed_out');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [claim, setClaim] = useState('');
  const [busy, setBusy] = useState(false);
  const status = useLive(async () => (await ctx.db.meta.get('sync_status'))?.value as SyncStatus | undefined, [ctx], undefined as SyncStatus | undefined);
  const pending = useLive(() => ctx.db.outbox.count(), [ctx], 0);
  const rejected = useLive(async () => (await rejectedEntries(ctx.db)).length, [ctx], 0);

  useEffect(() => {
    if (phase !== 'checking') return;
    let live = true;
    void (async () => {
      try {
        const client = await getSupabaseClient();
        const s = await currentSession(client);
        if (!live) return;
        if (s === null) return setPhase('signed_out');
        setEmail(s.email);
        if (ctx.db.syncEnabled) return setPhase('connected');
        setPhase((await isLinked(client, s.userId)) ? 'linked' : 'needs_claim');
      } catch {
        if (live) setPhase(ctx.db.syncEnabled ? 'connected' : 'signed_out');
      }
    })();
    return () => {
      live = false;
    };
  }, [phase, ctx]);

  const guarded = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    try {
      return await run(fn);
    } finally {
      setBusy(false);
    }
  };

  const send = () =>
    guarded(async () => {
      await requestCode(await getSupabaseClient(), email);
      setPhase('code_sent');
    });

  const verify = () =>
    guarded(async () => {
      const client = await getSupabaseClient();
      await verifyCode(client, email, code);
      setCode('');
      const s = await currentSession(client);
      if (s === null) throw new Error('No se pudo iniciar la sesión');
      setPhase(ctx.db.syncEnabled ? 'connected' : (await isLinked(client, s.userId)) ? 'linked' : 'needs_claim');
    });

  const doClaim = () =>
    guarded(async () => {
      await claimMembership(await getSupabaseClient(), claim);
      setClaim('');
      setPhase('linked');
    });

  const connect = () =>
    guarded(async () => {
      const client = await getSupabaseClient();
      const r = await connectDevice(ctx, supabaseTransport(client));
      replaceCtx(r.ctx);
      toast(t('sync.connectedToast', { sent: r.report.pushed, got: r.report.pulled }));
      setPhase('connected');
    });

  const now = () =>
    guarded(async () => {
      const client = await getSupabaseClient();
      const r = await syncOnce(ctx, supabaseTransport(client));
      if (!r.ok) throw new Error(r.error ?? 'No se pudo sincronizar');
      toast(t('sync.done'));
    });

  const out = () =>
    guarded(async () => {
      await signOut(await getSupabaseClient());
      setPhase('signed_out');
    });

  return (
    <Card title={t('sync.title')}>
      {phase === 'checking' && <p className="text-sm text-muted">{t('common.loading')}</p>}

      {phase === 'signed_out' && (
        <>
          {status?.sessionExpired && <p role="alert" className="mb-2 text-sm text-danger">{t('sync.expired')}</p>}
          <p className="mb-3 text-sm text-muted">{t('sync.intro')}</p>
          <Field label={t('sync.email')}>
            <input className={inputCls} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Btn variant="primary" className="w-full" disabled={busy || !email.includes('@')} onClick={send}>
            {t('sync.sendCode')}
          </Btn>
        </>
      )}

      {phase === 'code_sent' && (
        <>
          <p className="mb-3 text-sm text-muted">{t('sync.codeSent', { email })}</p>
          <Field label={t('sync.code')}>
            <input
              className={`${inputCls} text-center font-mono text-2xl tracking-[0.4em]`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Btn variant="primary" className="w-full" disabled={busy || code.length < 6} onClick={verify}>
            {t('sync.enter')}
          </Btn>
          <Btn variant="ghost" className="mt-1 w-full" onClick={() => setPhase('signed_out')}>
            {t('sync.changeEmail')}
          </Btn>
        </>
      )}

      {phase === 'needs_claim' && (
        <>
          <p className="mb-3 text-sm text-muted">{t('sync.claimHelp')}</p>
          <Field label={t('sync.claimCode')}>
            <input className={`${inputCls} font-mono`} autoComplete="off" autoCapitalize="none" spellCheck={false} value={claim} onChange={(e) => setClaim(e.target.value)} />
          </Field>
          <Btn variant="primary" className="w-full" disabled={busy || claim.trim().length < 20} onClick={doClaim}>
            {t('sync.claim')}
          </Btn>
        </>
      )}

      {phase === 'linked' && (
        <>
          <p className="mb-3 text-sm text-muted">{t('sync.connectHelp')}</p>
          <Btn variant="primary" className="w-full" disabled={busy} onClick={connect}>
            {t('sync.connect')}
          </Btn>
        </>
      )}

      {phase === 'connected' && (
        <>
          <p className="font-semibold">{t('sync.connectedAs', { email: email || '…' })}</p>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            <li>{t('sync.pending', { n: pending })}</li>
            {rejected > 0 && <li className="text-danger">{t('sync.rejected', { n: rejected })}</li>}
            <li>
              {status ? t('sync.last', { when: new Date(status.at).toLocaleString('es-ES', { timeZone: ctx.zone }) }) : t('sync.never')}
            </li>
            {status?.error && <li className="text-danger">{t('sync.error', { msg: status.error })}</li>}
            {status?.sessionExpired && <li className="text-danger">{t('sync.expired')}</li>}
          </ul>
          <div className="mt-3 flex flex-col gap-2">
            <Btn variant="primary" disabled={busy} onClick={now}>
              {t('sync.now')}
            </Btn>
            {rejected > 0 && (
              <Btn disabled={busy} onClick={() => guarded(() => retryRejected(ctx.db))}>
                {t('sync.retry')}
              </Btn>
            )}
            {status?.sessionExpired ? (
              <Btn disabled={busy} onClick={() => setPhase('signed_out')}>
                {t('sync.enter')}
              </Btn>
            ) : (
              <Btn variant="ghost" disabled={busy} onClick={out}>
                {t('sync.signOut')}
              </Btn>
            )}
          </div>
          {!status?.sessionExpired && <FamilySection />}
        </>
      )}
    </Card>
  );
}
