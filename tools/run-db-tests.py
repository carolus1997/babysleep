import pgserver, sys, subprocess, pathlib, tempfile
d = pathlib.Path(tempfile.mkdtemp(prefix="bspg"))
srv = pgserver.get_server(d, cleanup_mode='stop')
psql = pathlib.Path(pgserver.__file__).parent/'pginstall'/'bin'/'psql.exe'
root = pathlib.Path(sys.argv[1])
files = [root/'tests/db/00_supabase_shim.sql', *sorted((root/'database/migrations').glob('*.sql')), *sorted((root/'tests/db').glob('*.test.sql'))]
for f in files:
    r = subprocess.run([str(psql), '-v', 'ON_ERROR_STOP=1', '-f', str(f), srv.get_uri()], capture_output=True, text=True, encoding='utf8', timeout=60)
    if f.name.endswith('.test.sql') or r.returncode:
        print('==', f.name, 'rc', r.returncode); print(r.stderr[-3500:])
    if r.returncode: break
