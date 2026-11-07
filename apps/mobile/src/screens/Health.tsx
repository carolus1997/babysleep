import { t } from '../i18n/es';
import { Card } from '../ui/primitives';

/** Salud: por ahora solo el sitio reservado; se llena por fases (ver docs/development/salud-plan.md). */
export function Health() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('health.title')}</h1>
      <Card title={t('health.soon')}>
        <p className="text-sm">{t('health.intro')}</p>
        <p className="mt-3 text-sm text-muted">{t('health.items')}</p>
      </Card>
    </div>
  );
}
