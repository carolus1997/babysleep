import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { createBaby } from '../domain/bootstrap';
import { t } from '../i18n/es';
import { Btn, Field, inputCls } from '../ui/primitives';

export function Onboarding() {
  const { ctx, run } = useApp();
  const [alias, setAlias] = useState('');
  const [birth, setBirth] = useState('');
  return (
    <main className="mx-auto max-w-md p-6 pt-[max(2rem,env(safe-area-inset-top))]">
      <h1 className="mb-2 text-3xl font-bold">{t('onboarding.title')}</h1>
      <p className="mb-6 text-muted">{t('onboarding.intro')}</p>
      <Field label={t('onboarding.alias')}>
        <input className={inputCls} value={alias} onChange={(e) => setAlias(e.target.value)} autoFocus />
      </Field>
      <Field label={t('onboarding.birth')}>
        <input className={inputCls} type="date" value={birth} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setBirth(e.target.value)} />
      </Field>
      <Btn variant="primary" className="w-full" disabled={alias.trim() === '' || birth === ''} onClick={() => run(() => createBaby(ctx, { alias, birthDate: birth }))}>
        {t('onboarding.create')}
      </Btn>
    </main>
  );
}
