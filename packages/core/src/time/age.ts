const MS_PER_DAY = 86_400_000;

/** Una gestación a término son 40 semanas; por debajo de 37 se considera prematuro. */
export const TERM_WEEKS = 40;
export const PRETERM_BELOW_WEEKS = 37;
/** La edad corregida se aplica hasta los 24 meses de edad cronológica (convención clínica habitual). */
export const CORRECTION_UNTIL_DAYS = 730;

/** Días cumplidos desde el nacimiento (fecha civil `YYYY-MM-DD`), nunca negativos. */
export function ageDays(birthDate: string, nowMs: number): number {
  const birth = Date.parse(`${birthDate}T00:00:00Z`);
  return Math.max(0, Math.floor((nowMs - birth) / MS_PER_DAY));
}

/**
 * Edad corregida en días, o `null` si no procede: gestación desconocida, a término (≥ 37 semanas) o más de
 * 24 meses de edad cronológica. Es edad cronológica menos lo que faltó hasta las 40 semanas. **Puede ser
 * negativa**: el bebé aún no ha llegado a su fecha prevista de parto.
 *
 * No es un dato clínico ni sustituye la valoración del pediatra: sirve para interpretar el sueño y los hitos
 * de un prematuro con la edad que le corresponde.
 */
export function correctedAgeDays(birthDate: string, gestationalWeeks: number | null | undefined, nowMs: number): number | null {
  if (gestationalWeeks === null || gestationalWeeks === undefined || gestationalWeeks >= PRETERM_BELOW_WEEKS) return null;
  const chronological = ageDays(birthDate, nowMs);
  if (chronological >= CORRECTION_UNTIL_DAYS) return null;
  return chronological - (TERM_WEEKS - gestationalWeeks) * 7;
}
