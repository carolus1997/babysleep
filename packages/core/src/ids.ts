/**
 * UUIDv7 (RFC 9562): 48 bits de marca de tiempo en ms + aleatorio. Se genera en el
 * cliente, de modo que los registros hechos sin conexión tienen id definitivo y
 * ordenable por creación.
 */
export function uuidv7(nowMs: number = Date.now(), random?: Uint8Array): string {
  const b = random ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  if (b.length !== 16) throw new RangeError('Se necesitan 16 bytes aleatorios');
  const out = Uint8Array.from(b);
  out[0] = Math.floor(nowMs / 2 ** 40) & 0xff;
  out[1] = Math.floor(nowMs / 2 ** 32) & 0xff;
  out[2] = (nowMs >>> 24) & 0xff;
  out[3] = (nowMs >>> 16) & 0xff;
  out[4] = (nowMs >>> 8) & 0xff;
  out[5] = nowMs & 0xff;
  out[6] = ((out[6] as number) & 0x0f) | 0x70; // versión 7
  out[8] = ((out[8] as number) & 0x3f) | 0x80; // variante RFC
  const hex = Array.from(out, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
