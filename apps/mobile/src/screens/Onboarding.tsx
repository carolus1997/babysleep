import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { createBaby } from '../domain/bootstrap';
import { t } from '../i18n/es';
import { Btn, Chip, Field, inputCls } from '../ui/primitives';
import { SyncCard } from './SyncCard';

/**
 * Primera pantalla de un móvil sin ningún bebé. Dos caminos: empezar de cero, o entrar con la cuenta de la
 * familia para traer al bebé y sus registros (sin crear un perfil «falso» que luego haya que fusionar).
 */
export function Onboarding() {
  const { ctx, run } = useApp();
  const [mode, setMode] = useState<'new' | 'account'>('new');
  const [alias, setAlias] = useState('');
  const [birth, setBirth] = useState('');
  const connected = ctx.db.syncEnabled; // ya conectado a la familia, pero esta aún no tiene ningún bebé

  return (
    <main className="mx-auto max-w-md p-6 pt-[max(2rem,env(safe-area-inset-top))]">
      <h1 className="mb-2 text-3xl font-bold">{t('onboarding.title')}</h1>
      <p className="mb-4 text-muted">{connected ? t('onboarding.connected') : t('onboarding.intro')}</p>

      {!connected && (
        <div className="mb-5 flex flex-wrap gap-2" role="tablist">
          <Chip role="tab" active={mode === 'new'} onClick={() => setMode('new')}>
            {t('onboarding.modeNew')}
          </Chip>
          <Chip role="tab" active={mode === 'account'} onClick={() => setMode('account')}>
            {t('onboarding.modeAccount')}
          </Chip>
        </div>
      )}

      {mode === 'account' && !connected ? (
        <>
          <p className="mb-3 text-sm text-muted">{t('onboarding.accountIntro')}</p>
          <SyncCard fresh />
        </>
      ) : (
        <>
          <Field label={t('onboarding.alias')}>
            <input className={inputCls} value={alias} onChange={(e) => setAlias(e.target.value)} autoFocus />
          </Field>
          <Field label={t('onboarding.birth')}>
            <input className={inputCls} type="date" value={birth} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setBirth(e.target.value)} />
          </Field>
          <Btn variant="primary" className="w-full" disabled={alias.trim() === '' || birth === ''} onClick={() => run(() => createBaby(ctx, { alias, birthDate: birth }))}>
            {t('onboarding.create')}
          </Btn>
        </>
      )}
    </main>
  );
}
