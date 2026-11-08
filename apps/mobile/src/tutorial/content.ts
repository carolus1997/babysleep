import type { I18nKey } from '../i18n/es';
import type { IconName } from '../ui/Icon';

/** Pasos del tour de bienvenida. Para añadir uno: una entrada aquí y sus dos textos en i18n/es.ts. */
export const TOUR_STEPS: ReadonlyArray<{ icon: IconName; title: I18nKey; body: I18nKey }> = [
  { icon: 'moon', title: 'tour.sleep.title', body: 'tour.sleep.body' },
  { icon: 'clock', title: 'tour.ring.title', body: 'tour.ring.body' },
  { icon: 'milk', title: 'tour.feeds.title', body: 'tour.feeds.body' },
  { icon: 'chart', title: 'tour.insights.title', body: 'tour.insights.body' },
  { icon: 'user', title: 'tour.family.title', body: 'tour.family.body' },
];
