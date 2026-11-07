"""Convierte UNA SOLA VEZ las tablas de la OMS (niñas, 0-5 años) en un módulo TypeScript estático.

Uso (los archivos se bajan a mano de https://www.who.int/tools/child-growth-standards/standards y NO se guardan en el repo):

    python -I tools/build-who-tables.py <wfa-girls-zscore-expanded-tables.xlsx> <hcfa_girls_0_5_percentiles.pdf> [<lhfa-girls-...xlsx>]

- Peso para la edad: tabla «expanded» en xlsx, un renglón por DÍA (0-1856) con L, M y S.
- Perímetro cefálico para la edad: PDF de percentiles, un renglón por MES (0-60) con L, M y S; se lee con `pdftotext -layout`.
- Longitud/talla para la edad: opcional (xlsx expanded con columnas Day, L, M, S). Si no se pasa, la app no dibuja esa curva.

Escribe packages/core/src/health/whoGirlsData.ts. La OMS publica los estándares de 2006 (CC BY-NC-SA 3.0 IGO para sus
publicaciones; uso familiar sin ánimo de lucro, con atribución).
"""
import re
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
OUT = 'packages/core/src/health/whoGirlsData.ts'


def read_xlsx_first_sheet(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall('m:si', NS):
            shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    sheet = sorted((n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml', n)), key=lambda n: int(re.findall(r'\d+', n)[0]))[0]
    rows = []
    for r in ET.fromstring(z.read(sheet)).iter('{%s}row' % NS['m']):
        row = []
        for c in r.findall('m:c', NS):
            v = c.find('m:v', NS)
            if v is None:
                row.append(None)
            elif c.get('t') == 's':
                row.append(shared[int(v.text)])
            else:
                row.append(float(v.text))
        rows.append(row)
    return rows


def lms_daily(path):
    rows = read_xlsx_first_sheet(path)
    head = rows[0]
    col = {name: head.index(name) for name in ('L', 'M', 'S')}
    key = 'Day' if 'Day' in head else 'Age'
    k = head.index(key)
    data = [r for r in rows[1:] if r and r[k] is not None]
    days = [int(r[k]) for r in data]
    assert days == list(range(days[0], days[0] + len(days))), 'los días no son consecutivos'
    return days[0], [r[col['L']] for r in data], [r[col['M']] for r in data], [r[col['S']] for r in data]


def lms_pdf_monthly(path):
    text = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True, check=True).stdout
    rx = re.compile(r'^\s*(\d+):\s*(\d+)\s+(\d+)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)')
    found = {}
    for line in text.splitlines():
        m = rx.match(line)
        if m:
            found[int(m.group(3))] = (float(m.group(4)), float(m.group(5)), float(m.group(6)))
    months = sorted(found)
    assert months == list(range(0, 61)), f'faltan meses en el PDF: {sorted(set(range(61)) - set(months))}'
    return [found[m][0] for m in months], [found[m][1] for m in months], [found[m][2] for m in months]


def fmt(xs):
    return '[' + ','.join(repr(x) if x != int(x) else str(int(x)) for x in xs) + ']'


wfa_path, hc_path = sys.argv[1], sys.argv[2]
lfa_path = sys.argv[3] if len(sys.argv) > 3 else None

d0, wl, wm, ws = lms_daily(wfa_path)
assert d0 == 0 and len(wm) == 1857, (d0, len(wm))
hl, hm, hs = lms_pdf_monthly(hc_path)
# Comprobaciones con valores conocidos publicados por la OMS (peso al nacer niñas: M=3.2322; HC al nacer: M=33.8787, S=0.03496).
assert abs(wm[0] - 3.2322) < 1e-9 and abs(hm[0] - 33.8787) < 1e-9 and abs(hs[0] - 0.03496) < 1e-9

parts = [
    '// GENERADO por tools/build-who-tables.py. No editar a mano.',
    '// Fuente: OMS, Estándares de crecimiento infantil (2006), niñas de 0 a 5 años: https://www.who.int/tools/child-growth-standards/standards',
    '// Peso para la edad: tablas «expanded» (un renglón por día). Perímetro cefálico: tabla de percentiles (un renglón por mes).',
    '// Publicaciones de la OMS: CC BY-NC-SA 3.0 IGO (uso no comercial, con atribución).',
    '',
    'export interface LmsTable {',
    '  /** Unidad del eje de edad de la tabla. */',
    "  unit: 'day' | 'month';",
    '  /** Edad del primer renglón. */',
    '  first: number;',
    '  L: readonly number[];',
    '  M: readonly number[];',
    '  S: readonly number[];',
    '}',
    '',
    f"export const WFA_GIRLS: LmsTable = {{ unit: 'day', first: 0, L: {fmt(wl)}, M: {fmt(wm)}, S: {fmt(ws)} }};",
    f"export const HCFA_GIRLS: LmsTable = {{ unit: 'month', first: 0, L: {fmt(hl)}, M: {fmt(hm)}, S: {fmt(hs)} }};",
]
if lfa_path:
    ld, ll, lm, ls = lms_daily(lfa_path)
    parts.append(f"export const LFA_GIRLS: LmsTable | null = {{ unit: 'day', first: {ld}, L: {fmt(ll)}, M: {fmt(lm)}, S: {fmt(ls)} }};")
else:
    parts.append('export const LFA_GIRLS: LmsTable | null = null;')
parts.append('')
open(OUT, 'w', encoding='utf-8', newline='\n').write('\n'.join(parts))
print('escrito', OUT, 'peso:', len(wm), 'dias; perimetro cefalico:', len(hm), 'meses; talla:', 'si' if lfa_path else 'no')
