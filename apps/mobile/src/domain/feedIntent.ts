import type { FeedingT } from '@babysleep/contract';
import type { Ctx } from './context';
import { getOpenFeeding, startFeeding } from './feeding';

/** Qué pide el aviso de «toca toma»: `breast` y `bottle` (los botones del aviso) empiezan la toma; `ask`, solo abre la app. */
export type FeedIntent = 'breast' | 'bottle' | 'ask';

/** Lee la intención de una dirección (`?feed=breast`). Cualquier otro valor se ignora. */
export function parseFeedIntent(search: string): FeedIntent | null {
  const v = new URLSearchParams(search).get('feed');
  return v === 'breast' || v === 'bottle' || v === 'ask' ? v : null;
}

export type FeedIntentResult =
  | { kind: 'started'; feeding: FeedingT }
  | { kind: 'already_running'; feeding: FeedingT }
  | { kind: 'ask' };

/**
 * Aplica la intención. Nunca crea una segunda toma en curso: si ya hay una (p. ej. se tocó dos veces el aviso o
 * la otra persona ya la empezó y se sincronizó), no se hace nada más y se avisa.
 */
export async function applyFeedIntent(ctx: Ctx, babyId: string, intent: FeedIntent): Promise<FeedIntentResult> {
  if (intent === 'ask') return { kind: 'ask' };
  const open = await getOpenFeeding(ctx, babyId);
  if (open !== undefined) return { kind: 'already_running', feeding: open };
  return { kind: 'started', feeding: await startFeeding(ctx, babyId, intent) };
}
