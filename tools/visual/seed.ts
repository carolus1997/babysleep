/**
 * Datos sintéticos para las capturas: se ejecuta DENTRO de la página (page.evaluate) y usa las mismas funciones de
 * dominio que la app, con un reloj controlado. No es código de producción y no se importa desde la app.
 * Genera a «Leo» con 8 días de historial: una noche y tres siestas por día, más unas tomas.
 */
export async function seedBaby(): Promise<void> {
  const { BabySleepDb } = await import(/* @vite-ignore */ '/src/db/schema.ts');
  const { ensureBootstrap, createBaby } = await import(/* @vite-ignore */ '/src/domain/bootstrap.ts');
  const sleep = await import(/* @vite-ignore */ '/src/domain/sleep.ts');
  const db = new BabySleepDb();
  let t = Date.now();
  const ctx = await ensureBootstrap(db, () => t);
  const birth = new Date(Date.now() - 158 * 86_400_000).toISOString().slice(0, 10);
  const baby = await createBaby(ctx, { alias: 'Leo', birthDate: birth });
  const H = 3_600_000;
  const M = 60_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const at = (dayOffset: number, hour: number, min = 0) => today.getTime() + dayOffset * 86_400_000 + hour * H + min * M;
  const span = async (startMs: number, durMs: number) => {
    t = startMs;
    const s = await sleep.startSleep(ctx, baby.id);
    t = startMs + durMs;
    await sleep.finishSleep(ctx, s.id);
  };
  for (let d = -8; d <= -1; d++) {
    await span(at(d, 21, 10 + (d % 3) * 5), (10 + ((d + 8) % 3) * 0.2) * H);
    await span(at(d + 1, 9, 40), (50 + ((d + 8) % 4) * 10) * M);
    await span(at(d + 1, 12, 50), (75 + ((d + 8) % 3) * 8) * M);
    if (d !== -1) await span(at(d + 1, 16, 30), 45 * M);
  }
  db.close();
}

export async function startOpenSleep(): Promise<void> {
  const { BabySleepDb } = await import(/* @vite-ignore */ '/src/db/schema.ts');
  const { ensureBootstrap } = await import(/* @vite-ignore */ '/src/domain/bootstrap.ts');
  const sleep = await import(/* @vite-ignore */ '/src/domain/sleep.ts');
  const db = new BabySleepDb();
  const ctx = await ensureBootstrap(db, () => Date.now() - 72 * 60_000);
  const baby = (await db.baby.toArray())[0];
  await sleep.startSleep(ctx, baby!.id);
  db.close();
}
