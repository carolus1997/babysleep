import { useState } from 'react';
import { t } from '../i18n/es';
import { Card, Chip } from '../ui/primitives';
import { HealthProfile } from './HealthProfile';
import { Vaccines } from './Vaccines';

type Section = 'vaccines' | 'profile';

/** Salud: ficha y vacunas; el resto de módulos (citas, crecimiento, medicación…) llega por fases (docs/development/salud-plan.md). */
export function Health() {
  const [section, setSection] = useState<Section>('vaccines');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('health.title')}</h1>
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('health.title')}>
        <Chip active={section === 'vaccines'} onClick={() => setSection('vaccines')}>
          {t('health.sec.vaccines')}
        </Chip>
        <Chip active={section === 'profile'} onClick={() => setSection('profile')}>
          {t('health.sec.profile')}
        </Chip>
      </div>
      {section === 'vaccines' ? <Vaccines /> : <HealthProfile />}
      <Card title={t('health.soon')}>
        <p className="text-sm text-muted">{t('health.items')}</p>
      </Card>
    </div>
  );
}
