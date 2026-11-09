import { t, type I18nKey } from '../i18n/es';
import { Chip, Tabs } from '../ui/primitives';
import { Hint } from '../ui/Tutorial';
import { Feeds } from './Feeds';
import { Forecast } from './Forecast';
import { History } from './History';
import { Home } from './Home';

export type HomeSection = 'today' | 'forecast' | 'feeds' | 'history';
const SECTIONS: ReadonlyArray<{ id: HomeSection; label: I18nKey }> = [
  { id: 'today', label: 'home.sec.today' },
  { id: 'forecast', label: 'home.sec.forecast' },
  { id: 'feeds', label: 'home.sec.feeds' },
  { id: 'history', label: 'home.sec.history' },
];

/** Inicio: «Hoy» (cronómetro y resumen), «Tomas» y «Sueño» (el historial de descansos) en un solo sitio, para dejar la barra inferior libre. */
export function HomeShell({ section, onSection, goSettings }: { section: HomeSection; onSection: (s: HomeSection) => void; goSettings: () => void }) {
  return (
    <div className="space-y-4">
      <Tabs label={t('tab.home')}>
        {SECTIONS.map((s) => (
          <Chip key={s.id} data-tour={`chip-${s.id}`} active={section === s.id} onClick={() => onSection(s.id)}>
            {t(s.label)}
          </Chip>
        ))}
      </Tabs>
      {section === 'today' && <Hint id="hint-today">{t('hint.today')}</Hint>}
      {section === 'forecast' && <Hint id="hint-forecast">{t('hint.forecast')}</Hint>}
      {section === 'feeds' && <Hint id="hint-feeds">{t('hint.feeds')}</Hint>}
      {section === 'history' && <Hint id="hint-history">{t('hint.history')}</Hint>}
      {section === 'today' && <Home goSettings={goSettings} />}
      {section === 'forecast' && <Forecast />}
      {section === 'feeds' && <Feeds />}
      {section === 'history' && <History />}
    </div>
  );
}
