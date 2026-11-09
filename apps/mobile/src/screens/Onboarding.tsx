import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { createBaby } from '../domain/bootstrap';
import { t } from '../i18n/es';
import { Icon } from '../ui/Icon';
import { Logo } from '../ui/Logo';
import { Btn, Field, inputCls } from '../ui/primitives';
import { SyncCard } from './SyncCard';

type Step = 'welcome' | 'profile' | 'account';

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={t('auth.back')}
      className="grid size-11 place-items-center rounded-full bg-surface2 text-fg transition-transform hover:bg-surface3 active:scale-[0.95]"
    >
      <Icon name="next" className="rotate-180" />
    </button>
  );
}

/**
 * Primera pantalla de un móvil sin ningún bebé: bienvenida y dos caminos. Empezar de cero (registro del bebé) o
 * entrar con la cuenta de la familia para traer al bebé y sus registros (sin crear un perfil «falso» que luego
 * haya que fusionar). Diseño: docs/design/prototypes (vista «Acceso»).
 */
export function Onboarding() {
  const { ctx, run } = useApp();
  const connected = ctx.db.syncEnabled; // ya conectado a la familia, pero esta aún no tiene ningún bebé
  const [step, setStep] = useState<Step>(connected ? 'profile' : 'welcome');
  const [alias, setAlias] = useState('');
  const [birth, setBirth] = useState('');

  const shell = 'mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-6 pt-[max(1.25rem,env(safe-area-inset-top))]';

  if (step === 'welcome')
    return (
      <main className={shell}>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <span className="mb-4 grid size-32 place-items-center rounded-full [background:radial-gradient(circle,color-mix(in_srgb,var(--seg-nap)_28%,transparent),transparent_68%)]">
            <Logo size={104} />
          </span>
          <h1 className="text-[44px] font-extrabold leading-tight" style={{ fontFamily: "'Baloo 2', var(--font-sans)" }}>
            BabySleep
          </h1>
          <p className="mt-3 max-w-xs text-[15px] font-medium text-muted">{t('onboarding.intro')}</p>
        </div>
        <div className="flex flex-col gap-2.5">
          <Btn variant="primary" className="h-14 w-full text-base" onClick={() => setStep('profile')}>
            {t('onboarding.modeNew')}
          </Btn>
          <Btn className="h-14 w-full text-base" onClick={() => setStep('account')}>
            {t('onboarding.modeAccount')}
          </Btn>
          <p className="mt-1 flex items-center justify-center gap-1.5 text-[12px] font-semibold text-muted">
            <Icon name="vaccine" size={14} />
            {t('auth.private')}
          </p>
        </div>
      </main>
    );

  if (step === 'account')
    return (
      <main className={shell}>
        <div className="mb-3 min-h-11">
          <BackBtn onClick={() => setStep('welcome')} />
        </div>
        <SyncCard fresh page />
      </main>
    );

  const initial = alias.trim().slice(0, 1).toUpperCase();
  return (
    <main className={shell}>
      <div className="mb-3 min-h-11">{!connected && <BackBtn onClick={() => setStep('welcome')} />}</div>
      <h1 className="text-[26px] font-extrabold leading-tight">{t('auth.profileTitle')}</h1>
      <p className="mb-5 mt-2 text-sm font-medium text-muted">{connected ? t('onboarding.connected') : t('auth.profileIntro')}</p>
      <div className="mb-5 flex justify-center">
        <span aria-hidden className="grid size-[76px] place-items-center rounded-full border-[3.5px] border-accent bg-surface2 text-[32px] font-extrabold text-accent">
          {initial || <Icon name="baby" size={34} />}
        </span>
      </div>
      <Field label={t('onboarding.alias')}>
        <input className={inputCls} value={alias} onChange={(e) => setAlias(e.target.value)} autoComplete="off" autoFocus />
      </Field>
      <Field label={t('onboarding.birth')}>
        <input className={inputCls} type="date" value={birth} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setBirth(e.target.value)} />
      </Field>
      <div className="mt-auto pt-6">
        <Btn variant="primary" className="h-14 w-full text-base" disabled={alias.trim() === '' || birth === ''} onClick={() => run(() => createBaby(ctx, { alias, birthDate: birth }))}>
          {t('onboarding.create')}
        </Btn>
      </div>
    </main>
  );
}
