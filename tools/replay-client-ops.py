"""Reproduce contra PostgreSQL REAL las operaciones que envía el móvil (datos de salud).

`apps/mobile/test/fixtures/client-ops.json` lo genera la prueba `gen-client-ops.test.ts` con el motor de sincronización
de la app (`UPDATE_FIXTURES=1 npx vitest run apps/mobile/test/gen-client-ops.test.ts`). Aquí se aplican, lote a lote,
con `app.apply_changes` sobre una base de datos con todas las migraciones, como el usuario administrador de una familia
de prueba. Cualquier operación rechazada hace fallar el script: significa que la app envía algo que el servidor no acepta.

    python tools/replay-client-ops.py .

Requiere el paquete `pgserver` (el mismo que tools/run-db-tests.py).
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

import pgserver

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
d = pathlib.Path(tempfile.mkdtemp(prefix='bsreplay'))
srv = pgserver.get_server(d, cleanup_mode='stop')
psql = pathlib.Path(pgserver.__file__).parent / 'pginstall' / 'bin' / 'psql.exe'


def run(path):
    r = subprocess.run(
        [str(psql), '-v', 'ON_ERROR_STOP=1', '-At', '-f', str(path), srv.get_uri()],
        capture_output=True, text=True, encoding='utf8', timeout=180, env={**os.environ, 'PGCLIENTENCODING': 'UTF8'},
    )
    if r.returncode:
        print(r.stderr[-3000:])
        raise SystemExit(r.returncode)
    return r.stdout


for f in [root / 'tests/db/00_supabase_shim.sql', *sorted((root / 'database/migrations').glob('*.sql'))]:
    run(f)

batches = json.loads((root / 'apps/mobile/test/fixtures/client-ops.json').read_text(encoding='utf-8'))
src = (root / 'tests/db/sync.test.sql').read_text(encoding='utf-8').replace('\r\n', '\n')
setup = src[: src.index('-- S01 ·')]

lines = ["select tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');"]
for i, ops in enumerate(batches):
    payload = json.dumps(ops, ensure_ascii=False)
    assert '$ops$' not in payload
    lines.append(f"select '@@BATCH {i}@@';")
    lines.append(f"select (app.apply_changes(tests.u(901), now(), $ops${payload}$ops$::jsonb) -> 'results')::text;")
lines.append('rollback;')

tmp = d / 'replay.sql'
tmp.write_text(setup + '\n'.join(lines) + '\n', encoding='utf-8')
out = run(tmp)

failures = []
total = 0
parts = out.split('@@BATCH ')[1:]
assert len(parts) == len(batches), f'se esperaban {len(batches)} lotes y hay {len(parts)}'
for part, ops in zip(parts, batches):
    results = json.loads(part.split('@@\n', 1)[1].strip().splitlines()[0])
    assert len(results) == len(ops)
    for op, res in zip(ops, results):
        total += 1
        if res['status'] not in ('applied', 'merged', 'noop'):
            failures.append((op['table'], op['row_id'], res))

if failures:
    for tbl, rid, res in failures:
        print('RECHAZADA', tbl, rid, res)
    raise SystemExit(1)
print(f'ok: {total} operaciones reales aplicadas en PostgreSQL ({len(batches)} lotes)')
