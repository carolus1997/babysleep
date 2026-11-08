import { t, type I18nKey } from '../i18n/es';
import { Chip, Tabs } from '../ui/primitives';
import { Feeds } from './Feeds';
import { History } from './History';
import { Home } from './Home';

export type HomeSection = 'today' | 'feeds' | 'history';
const SECTIONS: ReadonlyArray<{ id: HomeSection; label: I18nKey }> = [
  { id: 'today', label: 'home.sec.today' },
  { id: 'feeds', label: 'home.sec.feeds' },
  { id: 'history', label: 'home.sec.history' },
];

/** Inicio: «Hoy» (cronómetro y resumen), «Tomas» e «Historial» en un solo sitio, para dejar la barra inferior libre. */
export function HomeShell({ section, onSection, goSettings }: { section: HomeSection; onSection: (s: HomeSection) => void; goSettings: () => void }) {
  return (
    <div className="space-y-4">
      <Tabs label={t('tab.home')}>
        {SECTIONS.map((s) => (
          <Chip key={s.id} active={section === s.id} onClick={() => onSection(s.id)}>
            {t(s.label)}
          </Chip>
        ))}
      </Tabs>
      {section === 'today' && <Home goSettings={goSettings} />}
      {section === 'feeds' && <Feeds />}
      {section === 'history' && <History />}
    </div>
  );
}
