import type { BabyT } from '@babysleep/contract';
import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext';
import { getBabyPhoto } from '../domain/photo';
import { useLive } from './hooks';

/** URL temporal de la foto local del bebé (o null). Se libera sola al cambiar o desmontar. */
export function useBabyPhotoUrl(babyId: string): string | null {
  const { ctx } = useApp();
  const blob = useLive(() => (babyId === '' ? Promise.resolve(undefined) : getBabyPhoto(ctx, babyId)), [ctx, babyId], undefined as Blob | undefined);
  return useBlobUrl(blob ?? null);
}

/** URL de objeto para un Blob, liberada al cambiar. */
export function useBlobUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (blob === null) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/** Avatar: la foto si existe; si no, la inicial sobre el color del bebé (que lo distingue de otros perfiles). */
export function Avatar({ baby, size = 32 }: { baby: BabyT; size?: number }) {
  const url = useBabyPhotoUrl(baby.id);
  const color = baby.color ?? 'var(--accent)';
  const box = { width: size, height: size, boxShadow: `0 0 0 2px ${color}` };
  return url ? (
    <img src={url} alt="" className="shrink-0 rounded-full object-cover" style={box} />
  ) : (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ ...box, background: color, fontSize: size * 0.45 }}
    >
      {baby.alias.slice(0, 1).toUpperCase()}
    </span>
  );
}
