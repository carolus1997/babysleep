/**
 * Etiquetas y categorías de sistema. El `slug` es el identificador estable: el
 * texto visible puede cambiar sin alterar las estadísticas históricas. La categoría
 * de una etiqueta coincide con el momento de la observación al que se aplica.
 */
export interface SeedTag {
  slug: string;
  category: 'settling' | 'onset' | 'during' | 'wake';
  es: string;
}

export const SEED_TAGS: readonly SeedTag[] = [
  // Conciliación (dificultad para dormirse)
  { slug: 'settling.easy', category: 'settling', es: 'Se calmó fácil' },
  { slug: 'settling.hard_to_settle', category: 'settling', es: 'Costó calmarlo' },
  { slug: 'settling.crying', category: 'settling', es: 'Lloraba' },
  { slug: 'settling.restless', category: 'settling', es: 'Inquieto' },
  { slug: 'settling.very_tired', category: 'settling', es: 'Muy cansado' },
  { slug: 'settling.after_feeding', category: 'settling', es: 'Tras comer' },
  { slug: 'settling.in_arms', category: 'settling', es: 'En brazos' },
  // Al dormirse
  { slug: 'onset.fell_easily', category: 'onset', es: 'Se durmió fácilmente' },
  { slug: 'onset.hard_to_fall_asleep', category: 'onset', es: 'Le costó dormirse' },
  { slug: 'onset.in_arms', category: 'onset', es: 'En brazos' },
  { slug: 'onset.in_crib', category: 'onset', es: 'En la cuna' },
  { slug: 'onset.during_walk', category: 'onset', es: 'Durante un paseo' },
  { slug: 'onset.in_car', category: 'onset', es: 'En el coche' },
  { slug: 'onset.after_feeding', category: 'onset', es: 'Tras comer' },
  // Durante el sueño
  { slug: 'during.outside_noise', category: 'during', es: 'Ruido exterior' },
  { slug: 'during.brief_wake', category: 'during', es: 'Despertar breve' },
  { slug: 'during.caregiver_intervention', category: 'during', es: 'Intervención del cuidador' },
  { slug: 'during.moved', category: 'during', es: 'Cambio de ubicación' },
  { slug: 'during.back_to_sleep_alone', category: 'during', es: 'Volvió a dormir solo' },
  // Al despertar
  { slug: 'wake.happy', category: 'wake', es: 'Despertó contento' },
  { slug: 'wake.crying', category: 'wake', es: 'Despertó llorando' },
  { slug: 'wake.still_tired', category: 'wake', es: 'Parecía cansado' },
  { slug: 'wake.spontaneous', category: 'wake', es: 'Despertó solo' },
  { slug: 'wake.noise', category: 'wake', es: 'Por un ruido' },
  { slug: 'wake.woken_by_caregiver', category: 'wake', es: 'Lo despertamos' },
  { slug: 'wake.calm', category: 'wake', es: 'Tranquilo' },
];

export const SEED_EVENT_CATEGORIES: ReadonlyArray<{ slug: string; es: string }> = [
  { slug: 'trip', es: 'Viaje' },
  { slug: 'vaccine', es: 'Vacunación' },
  { slug: 'room_change', es: 'Cambio de habitación' },
  { slug: 'routine_change', es: 'Cambio de rutina' },
  { slug: 'family_visit', es: 'Visita familiar' },
  { slug: 'illness', es: 'Enfermedad' },
  { slug: 'daycare', es: 'Guardería' },
  { slug: 'environment', es: 'Cambio ambiental' },
  { slug: 'other', es: 'Otro' },
];
