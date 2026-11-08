/**
 * Qué partes del tutorial ya se vieron, por dispositivo (no se sincroniza: cada móvil aprende a su ritmo).
 * Con el almacenamiento bloqueado todo funciona igual; solo se vuelve a mostrar en la siguiente carga.
 */
const PREFIX = 'bs-tut-';

export type TutorialKey = 'tour' | 'hint-today' | 'hint-forecast' | 'hint-feeds' | 'hint-history' | 'hint-stats' | 'hint-health';

const memory = new Set<string>();

export function isSeen(key: TutorialKey): boolean {
  if (memory.has(key)) return true;
  try {
    return localStorage.getItem(PREFIX + key) === '1';
  } catch {
    return false;
  }
}

export function markSeen(key: TutorialKey): void {
  memory.add(key);
  try {
    localStorage.setItem(PREFIX + key, '1');
  } catch {
    /* sin almacenamiento: solo dura esta sesión */
  }
}

/** «Ver el tutorial otra vez»: olvida el tour y todas las pistas. */
export function resetTutorial(): void {
  memory.clear();
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {
    /* nada que borrar */
  }
}
