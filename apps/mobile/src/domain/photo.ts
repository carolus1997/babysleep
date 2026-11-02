import { toIso } from '@babysleep/core';
import type { Ctx } from './context';
import { DomainError } from './context';

/**
 * Foto del bebé: SOLO LOCAL. Vive en su propia tabla, fuera del contrato, y por eso no pasa por
 * `domain/write.ts` (que es el punto de escritura de las filas sincronizables): no se
 * sincroniza, no entra en las copias JSON/CSV y no se sube a ningún sitio.
 */
export async function setBabyPhoto(ctx: Ctx, babyId: string, blob: Blob): Promise<void> {
  if (!blob.type.startsWith('image/')) throw new DomainError('invalid', 'El archivo no es una imagen');
  if ((await ctx.db.baby.get(babyId)) === undefined) throw new DomainError('not_found', 'Bebé inexistente');
  await ctx.db.baby_photo.put({ baby_id: babyId, blob, updated_at: toIso(ctx.now()) });
}

export async function getBabyPhoto(ctx: Ctx, babyId: string): Promise<Blob | undefined> {
  return (await ctx.db.baby_photo.get(babyId))?.blob;
}

export async function removeBabyPhoto(ctx: Ctx, babyId: string): Promise<void> {
  await ctx.db.baby_photo.delete(babyId);
}
