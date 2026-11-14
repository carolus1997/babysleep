import { useEffect, useRef, useState } from 'react';
import { useApp } from '../app/AppContext';
import { t } from '../i18n/es';
import { Chip, Tabs } from '../ui/primitives';
import { Appointments, suggestStart, type AppointmentDraft } from './Appointments';
import type { MedIntent } from '../domain/medIntent';
import { Growth } from './Growth';
import { HealthOverview } from './HealthOverview';
import { HealthProfile } from './HealthProfile';
import { Illness } from './Illness';
import { Medication } from './Medication';
import { Vaccines } from './Vaccines';

type Section = 'overview' | 'vaccines' | 'appointments' | 'growth' | 'medication' | 'illness' | 'profile';

/** Salud: vacunas, citas, crecimiento, medicación, enfermedad y ficha (docs/development/salud-plan.md). */
export function Health({
  medIntent = null,
  onMedIntentUsed = () => {},
  resetKey = 0,
}: {
  medIntent?: MedIntent | null;
  onMedIntentUsed?: () => void;
  /** Sube cada vez que se pulsa «Salud» en la barra: vuelve a la primera pestaña (Resumen). */
  resetKey?: number;
}) {
  const { ctx } = useApp();
  const [section, setSection] = useState<Section>('overview');
  const [draft, setDraft] = useState<AppointmentDraft | null>(null);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setSection('overview');
  }, [resetKey]);
  // El aviso de una dosis abre directamente Medicación.
  useEffect(() => {
    if (medIntent !== null) setSection('medication');
  }, [medIntent]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold">{t('health.title')}</h1>
      <Tabs label={t('health.title')} tour="health-tabs">
        <Chip active={section === 'overview'} onClick={() => setSection('overview')}>
          {t('health.sec.overview')}
        </Chip>
        <Chip active={section === 'vaccines'} onClick={() => setSection('vaccines')}>
          {t('health.sec.vaccines')}
        </Chip>
        <Chip active={section === 'appointments'} onClick={() => setSection('appointments')}>
          {t('health.sec.appointments')}
        </Chip>
        <Chip active={section === 'growth'} onClick={() => setSection('growth')}>
          {t('health.sec.growth')}
        </Chip>
        <Chip active={section === 'medication'} onClick={() => setSection('medication')}>
          {t('health.sec.medication')}
        </Chip>
        <Chip active={section === 'illness'} onClick={() => setSection('illness')}>
          {t('health.sec.illness')}
        </Chip>
        <Chip active={section === 'profile'} onClick={() => setSection('profile')}>
          {t('health.sec.profile')}
        </Chip>
      </Tabs>
      {section === 'overview' && <HealthOverview onGo={setSection} />}
      {section === 'vaccines' && (
        <Vaccines
          onSchedule={(m) => {
            setDraft({ kind: 'vaccination', title: t('appt.vaccineTitle', { age: m.milestone.label }), startLocal: suggestStart(m.dueDate, ctx) });
            setSection('appointments');
          }}
        />
      )}
      {section === 'appointments' && <Appointments draft={draft} onDraftUsed={() => setDraft(null)} />}
      {section === 'growth' && <Growth />}
      {section === 'medication' && <Medication intent={medIntent} onIntentUsed={onMedIntentUsed} />}
      {section === 'illness' && <Illness />}
      {section === 'profile' && <HealthProfile />}
    </div>
  );
}
