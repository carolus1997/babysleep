// Comprueba que ops/backups/scratch-shim.sql es una copia fiel de tests/db/00_supabase_shim.sql
// (solo cambia la cabecera de dos líneas). Si divergen, la restauración de prueba podría pasar o fallar por
// motivos que no se corresponden con las pruebas de la base de datos.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const norm = (s) => s.replace(/\r\n/g, '\n').trim();
const original = norm(readFileSync(join(root, 'tests', 'db', '00_supabase_shim.sql'), 'utf8'));
const copy = norm(readFileSync(join(root, 'ops', 'backups', 'scratch-shim.sql'), 'utf8')).split('\n').slice(2).join('\n').trim();

if (original !== copy) {
  console.error('ops/backups/scratch-shim.sql difiere de tests/db/00_supabase_shim.sql. Cópialo de nuevo (conservando su cabecera de 2 líneas).');
  process.exit(1);
}
console.log('backup shim OK');
