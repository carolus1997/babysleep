import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { t } from '../i18n/es';
import { Card, Chip } from '../ui/primitives';
import { Appointments, suggestStart, type AppointmentDraft } from './Appointments';
import { HealthProfile } from './HealthProfile';
import { Vaccines } from './Vaccines';

type Section = 'vaccines' | 'appointments' | 'profile';

/** Salud: vacunas, citas y ficha; el resto de módulos (crecimiento, medicación…) llega por fases (docs/development/salud-plan.md). */
export function Health() {
  const { ctx } = useApp();
  const [section, setSection] = useState<Section>('vaccines');
  const [draft, setDraft] = useState<AppointmentDraft | null>(null);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('health.title')}</h1>
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('health.title')}>
        <Chip active={section === 'vaccines'} onClick={() => setSection('vaccines')}>
          {t('health.sec.vaccines')}
        </Chip>
        <Chip active={section === 'appointments'} onClick={() => setSection('appointments')}>
          {t('health.sec.appointments')}
        </Chip>
        <Chip active={section === 'profile'} onClick={() => setSection('profile')}>
          {t('health.sec.profile')}
        </Chip>
      </div>
      {section === 'vaccines' && (
        <Vaccines
          onSchedule={(m) => {
            setDraft({ kind: 'vaccination', title: t('appt.vaccineTitle', { age: m.milestone.label }), startLocal: suggestStart(m.dueDate, ctx) });
            setSection('appointments');
          }}
        />
      )}
      {section === 'appointments' && <Appointments draft={draft} onDraftUsed={() => setDraft(null)} />}
      {section === 'profile' && <HealthProfile />}
      <Card title={t('health.soon')}>
        <p className="text-sm text-muted">{t('health.items')}</p>
      </Card>
    </div>
  );
}
