import type { BabyT } from '@babysleep/contract';
import { useEffect, useState } from 'react';
import { Avatar } from './photo';

/** Posiciones fijas (en %) de las estrellas; el retraso y el tamaño se reparten en CSS con `--i`. */
const STARS: ReadonlyArray<readonly [number, number]> = [
  [14, 18],
  [82, 14],
  [26, 34],
  [70, 30],
  [8, 52],
  [90, 48],
  [18, 70],
  [78, 68],
  [50, 10],
  [38, 82],
  [64, 84],
];

// Tiempos en ms: lo que dura la intro antes de pasar a los perfiles (o de irse) y el desvanecimiento final.
const INTRO_MS = 2300;
const INTRO_REDUCED_MS = 600;
const FADE_MS = 400;

type Phase = 'intro' | 'pick' | 'leaving';

/**
 * Bienvenida del arranque en frío, al estilo de una plataforma de vídeo: una intro con la luna y el logo y,
 * después, «¿De quién cuidamos hoy?» con el avatar de cada bebé para elegir el perfil. Un toque salta la intro.
 * Sin perfiles (primer uso) o con `pick` en falso (se abrió desde un aviso) se desvanece al acabar la intro.
 * Con «reducir movimiento» se muestra fija y la intro dura poco.
 */
export function Splash({ babies, activeId, pick, onPick }: { babies: readonly BabyT[]; activeId: string | null; pick: boolean; onPick: (id: string) => void }) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [gone, setGone] = useState(false);
  const canPick = pick && babies.length > 0;

  // Fin de la intro: a los perfiles o, si no hay nada que elegir, a desvanecerse.
  useEffect(() => {
    if (phase !== 'intro') return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const id = window.setTimeout(() => setPhase(canPick ? 'pick' : 'leaving'), reduced ? INTRO_REDUCED_MS : INTRO_MS);
    return () => window.clearTimeout(id);
  }, [phase, canPick]);

  // La lista de bebés se carga de forma asíncrona: si llega tarde, la fase de perfiles aún puede aparecer.
  useEffect(() => {
    if (phase === 'pick' && !canPick) setPhase('leaving');
  }, [phase, canPick]);

  useEffect(() => {
    if (phase !== 'leaving') return;
    const id = window.setTimeout(() => setGone(true), FADE_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  if (gone) return null;

  return (
    <div
      className={`splash${phase === 'leaving' ? ' splash-leaving' : ''}`}
      role={phase === 'pick' ? 'dialog' : 'presentation'}
      aria-label={phase === 'pick' ? '¿De quién cuidamos hoy?' : undefined}
      onClick={phase === 'intro' ? () => setPhase(canPick ? 'pick' : 'leaving') : undefined}
      style={{ ['--splash-fade' as string]: `${FADE_MS}ms` }}
    >
      {STARS.map(([x, y], i) => (
        <span key={i} aria-hidden className="splash-star" style={{ left: `${x}%`, top: `${y}%`, ['--i' as string]: i }} />
      ))}

      {phase === 'intro' && (
        <div className="splash-center">
          <svg aria-hidden className="splash-moon" viewBox="0 0 64 64" width="72" height="72">
            <path
              d="M44 8a26 26 0 1 0 12 40A22 22 0 0 1 44 8Z"
              fill="var(--seg-nap)"
              stroke="var(--seg-nap)"
              strokeWidth="3"
              strokeLinejoin="round"
            />
          </svg>
          <h1 className="splash-logo">BabySleep</h1>
          <span aria-hidden className="splash-glint" />
        </div>
      )}

      {phase !== 'intro' && (
        <div className="splash-pick">
          <h1 className="splash-pick-title">¿De quién cuidamos hoy?</h1>
          <ul className="splash-profiles">
            {babies.map((b, i) => (
              <li key={b.id} style={{ ['--i' as string]: i }}>
                <button
                  className="splash-profile"
                  data-active={b.id === activeId ? '' : undefined}
                  disabled={phase === 'leaving'}
                  onClick={() => {
                    onPick(b.id);
                    setPhase('leaving');
                  }}
                >
                  <span className="splash-avatar" style={{ ['--ring' as string]: b.color ?? 'var(--accent)' }}>
                    <Avatar baby={b} size={104} />
                  </span>
                  <span className="splash-name">{b.alias}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
