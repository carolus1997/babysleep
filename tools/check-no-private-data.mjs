// Falla si algún archivo de tests/fixtures/private (salvo el README) está rastreado por git.
// Si el directorio no es un repositorio git todavía, no hay nada que comprobar.
import { execFileSync } from 'node:child_process';

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '--', 'tests/fixtures/private'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch {
  console.log('check:private-data omitido (no es un repositorio git).');
  process.exit(0);
}

const offenders = tracked.filter((f) => !f.endsWith('/README.md'));
if (offenders.length > 0) {
  console.error('Datos privados rastreados por git:\n' + offenders.join('\n'));
  process.exit(1);
}
console.log('check:private-data OK');
