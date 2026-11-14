import type { I18nKey } from '../i18n/es';
import type { IconName } from '../ui/Icon';

/** Dónde debe estar la app al entrar en un paso del tour. */
export type TourGo = { tab: 'home' | 'health' | 'stats' | 'settings'; section?: 'today' | 'forecast' | 'feeds' | 'history' };

type Common = { chapter: I18nKey; title: I18nKey; body: I18nKey; go?: TourGo };

/**
 * Pasos del tour, agrupados en capítulos.
 *  - `card`: tarjeta a pantalla completa (con `share`, añade el botón de compartir la app).
 *  - `demo`: práctica con una maqueta del botón Dormir/Despierto; no guarda nada.
 *  - `spot`: foco sobre un elemento real de la app (`data-tour`); con `tap` avanza al tocarlo (siempre vale «Siguiente»).
 * Los focos nunca guardan datos: lo que se invita a tocar es solo navegación.
 */
export type TourStep =
  | (Common & { kind: 'card'; icon: IconName; share?: boolean })
  | (Common & { kind: 'demo' })
  | (Common & { kind: 'spot'; target: string; tap?: boolean });

export const HOME_TODAY: TourGo = { tab: 'home', section: 'today' };

export const TOUR_STEPS: ReadonlyArray<TourStep> = [
  { kind: 'card', icon: 'moon', chapter: 'tour.ch.start', title: 'tour.welcome.title', body: 'tour.welcome.body', go: HOME_TODAY },

  { kind: 'demo', chapter: 'tour.ch.sleep', title: 'tour.demo.title', body: 'tour.demo.body', go: HOME_TODAY },
  { kind: 'spot', chapter: 'tour.ch.sleep', target: 'round', title: 'tour.round.title', body: 'tour.round.body', go: HOME_TODAY },
  { kind: 'spot', chapter: 'tour.ch.sleep', target: 'ring', title: 'tour.ring.title', body: 'tour.ring.body', go: HOME_TODAY },

  { kind: 'spot', chapter: 'tour.ch.feeds', target: 'feeding', title: 'tour.feeding.title', body: 'tour.feeding.body', go: HOME_TODAY },
  { kind: 'spot', chapter: 'tour.ch.feeds', target: 'today', title: 'tour.today.title', body: 'tour.today.body', go: HOME_TODAY },

  { kind: 'spot', chapter: 'tour.ch.more', target: 'chip-forecast', tap: true, title: 'tour.forecast.title', body: 'tour.forecast.body', go: HOME_TODAY },
  { kind: 'spot', chapter: 'tour.ch.more', target: 'chip-feeds', tap: true, title: 'tour.feeds.title', body: 'tour.feeds.body', go: { tab: 'home', section: 'forecast' } },
  { kind: 'spot', chapter: 'tour.ch.more', target: 'chip-history', tap: true, title: 'tour.history.title', body: 'tour.history.body', go: { tab: 'home', section: 'feeds' } },

  { kind: 'spot', chapter: 'tour.ch.health', target: 'tab-health', tap: true, title: 'tour.health.title', body: 'tour.health.body', go: { tab: 'home', section: 'history' } },
  { kind: 'spot', chapter: 'tour.ch.health', target: 'health-tabs', title: 'tour.healthTabs.title', body: 'tour.healthTabs.body', go: { tab: 'health' } },

  { kind: 'spot', chapter: 'tour.ch.stats', target: 'tab-stats', tap: true, title: 'tour.stats.title', body: 'tour.stats.body', go: { tab: 'health' } },
  { kind: 'spot', chapter: 'tour.ch.stats', target: 'stats-tabs', title: 'tour.statsTabs.title', body: 'tour.statsTabs.body', go: { tab: 'stats' } },

  { kind: 'spot', chapter: 'tour.ch.settings', target: 'tab-settings', tap: true, title: 'tour.settings.title', body: 'tour.settings.body', go: { tab: 'stats' } },
  { kind: 'spot', chapter: 'tour.ch.settings', target: 'help', title: 'tour.help.title', body: 'tour.help.body', go: { tab: 'settings' } },

  { kind: 'card', icon: 'user', chapter: 'tour.ch.end', title: 'tour.family.title', body: 'tour.family.body', go: { tab: 'settings' }, share: true },
];
