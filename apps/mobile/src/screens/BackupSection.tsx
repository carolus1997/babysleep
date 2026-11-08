import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext';
import { t } from '../i18n/es';
import { backupHealth, getBackupStatus, type BackupHealth } from '../sync/backups';
import { getSupabaseClient } from '../sync/supabase';
import { useNow } from '../ui/hooks';

/** Estado de las copias automáticas. Solo lo ven los administradores; para el resto no se muestra nada. */
export function BackupSection() {
  const { ctx } = useApp();
  const now = useNow(60_000);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getBackupStatus>>>(null);

  useEffect(() => {
    let live = true;
    void getSupabaseClient()
      .then(getBackupStatus)
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx]);

  if (status === null) return null;
  const h: BackupHealth = backupHealth(status, now);
  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="mb-1 text-[13px] font-bold text-muted">{t('backups.title')}</h3>
      <p className={`text-sm font-medium ${h.level === 'ok' ? 'text-ok' : 'text-danger'}`} role={h.level === 'ok' ? undefined : 'alert'}>
        {h.headline}
      </p>
      <ul className="mt-1 space-y-0.5 text-xs text-muted">
        {h.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}
