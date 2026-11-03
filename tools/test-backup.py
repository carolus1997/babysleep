"""Ejecuta ops/backups/test-backup.sh en local sin Docker: levanta un PostgreSQL embebido (pip install pgserver)
y busca age/age-keygen en el PATH o en la carpeta indicada con AGE_BIN.

    python tools/test-backup.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile

import pgserver

root = pathlib.Path(__file__).resolve().parent.parent
pg_bin = pathlib.Path(pgserver.__file__).parent / 'pginstall' / 'bin'
server = pgserver.get_server(pathlib.Path(tempfile.mkdtemp(prefix='bsbackup')), cleanup_mode='stop')

env = dict(os.environ)
extra = [str(pg_bin)]
if os.environ.get('AGE_BIN'):
    extra.append(os.environ['AGE_BIN'])
env['PATH'] = os.pathsep.join(extra + [env['PATH']])
env['PG_ADMIN_URL'] = server.get_uri()

bash = os.environ.get('BASH', r'C:\Program Files\Git\bin\bash.exe')
r = subprocess.run([bash, str(root / 'ops' / 'backups' / 'test-backup.sh')], env=env)
sys.exit(r.returncode)
