import type { BabyT } from '@babysleep/contract';
import { useEffect, useState } from 'react';
import { Avatar, useBabyPhotoUrl } from './photo';

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

// Tiempos en ms: cuánto se queda antes de desvanecerse y lo que dura el desvanecimiento.
const HOLD_MS = 2100;
const HOLD_REDUCED_MS = 700;
const FADE_MS = 400;

/**
 * Pantalla de bienvenida del arranque en frío: luna y estrellas, el logo y, debajo, la foto del bebé activo
 * con su nombre. Se desvanece sola y un toque la salta. Con «reducir movimiento» se muestra fija y breve.
 */
export function Splash({ baby }: { baby: BabyT | null }) {
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  const photo = useBabyPhotoUrl(baby?.id ?? '');

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const t1 = window.setTimeout(() => setLeaving(true), reduced ? HOLD_REDUCED_MS : HOLD_MS);
    return () => window.clearTimeout(t1);
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const t2 = window.setTimeout(() => setGone(true), FADE_MS);
    return () => window.clearTimeout(t2);
  }, [leaving]);

  if (gone) return null;

  return (
    <div
      className={`splash${leaving ? ' splash-leaving' : ''}`}
      role="presentation"
      onClick={() => setLeaving(true)}
      style={{ ['--splash-fade' as string]: `${FADE_MS}ms` }}
    >
      {photo && <div aria-hidden className="splash-photo" style={{ backgroundImage: `url(${photo})` }} />}
      {STARS.map(([x, y], i) => (
        <span key={i} aria-hidden className="splash-star" style={{ left: `${x}%`, top: `${y}%`, ['--i' as string]: i }} />
      ))}
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
        {baby !== null && (
          <>
            <div className="splash-baby" style={{ ['--ring' as string]: baby.color ?? 'var(--accent)' }}>
              <Avatar baby={baby} size={112} />
            </div>
            <p className="splash-name">{baby.alias}</p>
          </>
        )}
      </div>
    </div>
  );
}
