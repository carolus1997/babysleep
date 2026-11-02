/** Lado mayor máximo de la foto guardada; basta para un fondo y un avatar, y mantiene la base pequeña. */
export const PHOTO_MAX_PX = 1024;
const PHOTO_QUALITY = 0.82;

/**
 * Reduce y recomprime una foto (galería o cámara) a JPEG. Al redibujarla en un canvas se
 * descartan los metadatos EXIF —incluida la ubicación GPS— y se respeta la orientación.
 */
export async function resizeImage(file: Blob, maxPx: number = PHOTO_MAX_PX): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('No es una imagen');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (g === null) throw new Error('Sin canvas');
    g.drawImage(bitmap, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo codificar'))), 'image/jpeg', PHOTO_QUALITY),
    );
  } finally {
    bitmap.close();
  }
}
