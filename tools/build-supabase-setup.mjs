// Genera database/supabase/setup.sql: todas las migraciones, en orden, en un único archivo para pegar
// en el SQL Editor de Supabase. Es solo una concatenación; las migraciones siguen siendo la fuente.
//
//   node tools/build-supabase-setup.mjs           escribe el archivo
//   node tools/build-supabase-setup.mjs --check   falla si el archivo no está al día (para `npm run check`)
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrations = join(root, 'database', 'migrations');
const out = join(root, 'database', 'supabase', 'setup.sql');

const files = readdirSync(migrations).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();

const header = `-- BabySleep · instalación completa para Supabase (GENERADO: no lo edites).
-- Fuente: database/migrations/*.sql. Regenerar con: node tools/build-supabase-setup.mjs
--
-- Pégalo ENTERO en Supabase → SQL Editor → Run. Se ejecuta una sola vez.
-- Después crea tu familia (ver docs/development/supabase-setup.md):
--   select app.bootstrap_family('Mi familia', 'Tu nombre', 'tu-correo@ejemplo.com');
--
-- Contiene: ${files.join(', ')}
`;

const body = files.map((f) => `\n-- ================================================================\n-- ${f}\n-- ================================================================\n\n${norm(readFileSync(join(migrations, f), 'utf8'))}\n`).join('');
const content = `${header}${body}`;

if (process.argv.includes('--check')) {
  const current = existsSync(out) ? norm(readFileSync(out, 'utf8')) : '';
  if (current !== norm(content)) {
    console.error('database/supabase/setup.sql no está al día. Ejecuta: node tools/build-supabase-setup.mjs');
    process.exit(1);
  }
  console.log('setup.sql OK');
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  console.log(`Escrito ${out} (${files.length} migraciones)`);
}
