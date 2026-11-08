import type { I18nKey } from '../i18n/es';
import type { IconName } from '../ui/Icon';

/** Dónde debe estar la app al entrar en un paso del tour. */
export type TourGo = { tab: 'home' | 'health' | 'stats' | 'settings'; section?: 'today' | 'forecast' | 'feeds' | 'history' };

/**
 * Pasos del tour. `card`: tarjeta a pantalla completa. `spot`: foco sobre un elemento real de la app (`data-tour`);
 * con `tap` el paso avanza solo cuando la persona toca ese elemento (siempre se puede usar «Siguiente»).
 * Los focos nunca guardan datos: lo que se invita a tocar es solo navegación.
 */
export type TourStep =
  | { kind: 'card'; icon: IconName; title: I18nKey; body: I18nKey; go?: TourGo }
  | { kind: 'spot'; target: string; tap?: boolean; title: I18nKey; body: I18nKey; go?: TourGo };

export const HOME_TODAY: TourGo = { tab: 'home', section: 'today' };

export const TOUR_STEPS: ReadonlyArray<TourStep> = [
  { kind: 'card', icon: 'moon', title: 'tour.welcome.title', body: 'tour.welcome.body', go: HOME_TODAY },
  { kind: 'spot', target: 'round', title: 'tour.round.title', body: 'tour.round.body', go: HOME_TODAY },
  { kind: 'spot', target: 'ring', title: 'tour.ring.title', body: 'tour.ring.body', go: HOME_TODAY },
  { kind: 'spot', target: 'chip-forecast', tap: true, title: 'tour.forecast.title', body: 'tour.forecast.body', go: HOME_TODAY },
  { kind: 'spot', target: 'tab-health', tap: true, title: 'tour.health.title', body: 'tour.health.body', go: { tab: 'home', section: 'forecast' } },
  { kind: 'spot', target: 'tab-settings', tap: true, title: 'tour.help.title', body: 'tour.help.body', go: { tab: 'health' } },
  { kind: 'card', icon: 'user', title: 'tour.family.title', body: 'tour.family.body', go: { tab: 'settings' } },
];
