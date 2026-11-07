/** Qué pide el aviso de medicación: abrir la app en ese tratamiento; con `given`, preparar el registro de una dosis. */
export interface MedIntent {
  medicationId: string;
  /** El botón «Ya la di» del aviso. Solo abre la hoja de registro: la persona confirma la hora. */
  given: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lee la intención de una dirección (`?med=<id>&given=1`). Cualquier valor que no sea un identificador se ignora. */
export function parseMedIntent(search: string): MedIntent | null {
  const q = new URLSearchParams(search);
  const id = q.get('med');
  if (id === null || !UUID.test(id)) return null;
  return { medicationId: id.toLowerCase(), given: q.get('given') === '1' };
}
