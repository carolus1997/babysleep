"""Genera apps/mobile/test/fixtures/postgres-rows.json con filas REALES de PostgreSQL.

Arranca un Postgres embebido, aplica las migraciones y las pruebas de apoyo, hace operaciones con `apply_changes`
(datos sintéticos) y vuelca las filas tal como las devolvería la API: la prueba de la app comprueba que el cliente
las entiende (formato de fechas, listas, nulos). Se ejecuta a mano cuando cambia el esquema:

    python tools/dump-server-rows.py .

Requiere el paquete `pgserver` (el mismo que tools/run-db-tests.py).
"""
import os
import pathlib
import subprocess
import sys
import tempfile

import pgserver

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
d = pathlib.Path(tempfile.mkdtemp(prefix='bsdump'))
srv = pgserver.get_server(d, cleanup_mode='stop')
psql = pathlib.Path(pgserver.__file__).parent / 'pginstall' / 'bin' / 'psql.exe'


def run(path, capture=False):
    r = subprocess.run([str(psql), '-v', 'ON_ERROR_STOP=1', '-At', '-f', str(path), srv.get_uri()], capture_output=True, text=True, encoding='utf8', timeout=120, env={**os.environ, 'PGCLIENTENCODING': 'UTF8'})
    if r.returncode:
        print(r.stderr[-3000:])
        raise SystemExit(r.returncode)
    return r.stdout


for f in [root / 'tests/db/00_supabase_shim.sql', *sorted((root / 'database/migrations').glob('*.sql'))]:
    run(f)

src = (root / 'tests/db/sync.test.sql').read_text(encoding='utf-8').replace('\r\n', '\n')
cut = src.index('-- S01 ·')
setup = src[:cut]

body = """
select tests.as_user('a0000000-0000-4000-8000-000000000001', 'admin-a@example.test');
select tests.go(tests.op('baby', 1, null, '{"alias":"Bebe A","birth_date":"2026-07-01"}'));
select tests.go(tests.op('baby', 1, 1, jsonb_build_object(
  'pediatrician', 'Dra. Prueba', 'nurse', 'Enfermera Prueba', 'health_center_name', 'Centro de Salud de Prueba',
  'health_center_address', 'Calle de Prueba 1', 'health_center_phone', '910000000', 'birth_hospital', 'Hospital de Prueba',
  'allergies', 'ninguna conocida', 'health_notes', E'linea 1\\nlinea 2', 'cipa', 'TEST0000000000')));
select tests.go(tests.op('vaccination', 100, null, jsonb_build_object(
  'baby_id', tests.u(1), 'dose_key', 'DTPa@2m', 'vaccine', 'DTPa', 'status', 'given', 'given_on', '2027-01-05', 'center', 'Centro de prueba', 'lot', 'LOTE-1')));
select tests.go(tests.op('vaccination', 101, null, jsonb_build_object(
  'baby_id', tests.u(1), 'dose_key', 'RV@2m', 'vaccine', 'Rotavirus', 'status', 'not_applicable')));
select tests.go(tests.op('vaccination', 102, null, jsonb_build_object(
  'baby_id', tests.u(1), 'vaccine', 'Gripe 2026-27', 'status', 'given', 'given_on', '2027-01-20')));
select tests.go(tests.op('appointment', 110, null, jsonb_build_object(
  'baby_id', tests.u(1), 'kind', 'pediatrician', 'title', 'Revision de los 4 meses', 'start_utc', '2027-04-01T08:00:00.000Z',
  'start_tz', 'Europe/Madrid', 'duration_min', 20, 'place', 'Centro de prueba', 'notes', 'Llevar el documento',
  'remind_before_min', jsonb_build_array(1440, 60))));
select tests.go(tests.op('appointment', 111, null, jsonb_build_object(
  'baby_id', tests.u(1), 'kind', 'other', 'title', 'Sin avisos', 'start_utc', '2027-04-02T08:00:00.000Z', 'start_tz', 'Europe/Madrid')));
select tests.go(tests.op('growth_measure', 120, null, jsonb_build_object(
  'baby_id', tests.u(1), 'measured_on', '2027-01-05', 'weight_g', 5600, 'head_mm', 405, 'place', 'Centro de prueba', 'notes', 'en ayunas')));
select tests.go(tests.op('growth_measure', 121, null, jsonb_build_object('baby_id', tests.u(1), 'measured_on', '2027-01-12', 'length_mm', 625)));
select tests.as_superuser();
select '@@JSON@@';
select jsonb_pretty(jsonb_build_object(
  'baby', (select jsonb_agg(to_jsonb(b)) from app.baby b where b.id = tests.u(1)),
  'vaccination', (select jsonb_agg(to_jsonb(v) order by v.id) from app.vaccination v),
  'appointment', (select jsonb_agg(to_jsonb(a) order by a.id) from app.appointment a),
  'growth_measure', (select jsonb_agg(to_jsonb(g) order by g.id) from app.growth_measure g)));
rollback;
"""

tmp = d / 'dump.sql'
tmp.write_text(setup + body, encoding='utf-8')
out = run(tmp)
payload = out.split('@@JSON@@', 1)[1]
start = payload.index('{')
end = payload.rindex('}') + 1
dest = root / 'apps/mobile/test/fixtures/postgres-rows.json'
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(payload[start:end] + '\n', encoding='utf-8')
print('escrito', dest)
