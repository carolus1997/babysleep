import { t } from '../i18n/es';

/** Compartir la app con el menú nativo; sin él, copia el enlace. */
export async function shareApp(toast: (m: string) => void) {
  const url = window.location.origin + window.location.pathname;
  try {
    if (navigator.share) await navigator.share({ title: 'BabySleep', text: t('help.shareText'), url });
    else {
      await navigator.clipboard.writeText(url);
      toast(t('help.shareCopied'));
    }
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) toast(t('help.shareFail'));
  }
}
