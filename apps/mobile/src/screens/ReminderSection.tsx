import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext';
import { t } from '../i18n/es';
import {
  currentSubscription,
  disableThisDevice,
  enableThisDevice,
  getReminderSettings,
  INTERVAL_CHOICES_MIN,
  pushSupport,
  setReminderSettings,
  showTestNotification,
  type ReminderSettings,
} from '../sync/push';
import { getSupabaseClient } from '../sync/supabase';
import { Btn, Chip } from '../ui/primitives';

const label = (min: number): string => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
};

/** Avisos de «toca toma»: el ajuste de la familia (cada cuánto) y el interruptor de ESTE móvil. */
export function ReminderSection() {
  const { run, toast } = useApp();
  const support = pushSupport();
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [here, setHere] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await run(async () => getReminderSettings(await getSupabaseClient()));
      if (alive && s) setSettings(s);
      if (support.ok) {
        const sub = await currentSubscription().catch(() => null);
        if (alive) setHere(sub !== null && Notification.permission === 'granted');
      } else if (alive) setHere(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (settings === null) return null;

  const saveInterval = async (min: number) => {
    const next = { ...settings, interval_min: min };
    if (await run(async () => (await setReminderSettings(await getSupabaseClient(), next), true))) setSettings(next);
  };

  const toggleHere = async () => {
    if (here) {
      if (await run(async () => (await disableThisDevice(await getSupabaseClient()), true))) setHere(false);
      return;
    }
    // Se activa el aviso en este móvil y, si la familia no lo tenía encendido, también el ajuste común.
    const ok = await run(async () => {
      const client = await getSupabaseClient();
      await enableThisDevice(client);
      if (!settings.enabled) await setReminderSettings(client, { ...settings, enabled: true });
      return true;
    });
    if (ok) {
      setHere(true);
      setSettings({ ...settings, enabled: true });
      toast(t('remind.on'));
    }
  };

  const familyOff = async () => {
    const next = { ...settings, enabled: false };
    if (await run(async () => (await setReminderSettings(await getSupabaseClient(), next), true))) setSettings(next);
  };

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{t('remind.title')}</h3>
      {!support.ok ? (
        <p className="text-sm text-muted">{t(`remind.unsupported.${support.reason}` as 'remind.unsupported.no_key')}</p>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted">{t('remind.desc')}</p>
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t('remind.every')}>
            <span className="self-center text-sm">{t('remind.every')}</span>
            {INTERVAL_CHOICES_MIN.map((m) => (
              <Chip key={m} active={settings.interval_min === m} onClick={() => saveInterval(m)}>
                {label(m)}
              </Chip>
            ))}
          </div>
          <Btn variant={here ? 'secondary' : 'primary'} className="w-full" onClick={toggleHere} disabled={here === null}>
            {here ? t('remind.disableHere') : t('remind.enableHere')}
          </Btn>
          {here && (
            <Btn variant="ghost" className="mt-1 w-full" onClick={() => void run(async () => (await showTestNotification(), true))}>
              {t('remind.test')}
            </Btn>
          )}
          {settings.enabled && (
            <Btn variant="ghost" className="mt-1 w-full text-muted" onClick={familyOff}>
              {t('remind.familyOff')}
            </Btn>
          )}
          <p className="mt-2 text-xs text-muted">{t('remind.hint')}</p>
        </>
      )}
    </div>
  );
}
