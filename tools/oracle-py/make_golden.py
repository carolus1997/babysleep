"""Genera fixtures dorados de estadística con numpy (solo oráculo de pruebas, no runtime).

Uso (desde la raíz del repositorio):
    python tools/oracle-py/make_golden.py

Lee  tests/fixtures/synthetic/stats-cases.json
Escribe tests/fixtures/golden/stats-golden.json

Convenciones fijadas: cuantiles con method="linear" (tipo 7, el de numpy por
defecto) y varianza/desviación muestrales (ddof=1). Con n < 2 se escribe null.
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "tests" / "fixtures" / "synthetic" / "stats-cases.json"
DST = ROOT / "tests" / "fixtures" / "golden" / "stats-golden.json"


def main() -> None:
    spec = json.loads(SRC.read_text(encoding="utf-8"))
    points = spec["quantile_points"]
    out = {
        "_comment": "GENERADO por tools/oracle-py/make_golden.py con numpy "
        + np.__version__
        + ". No editar a mano.",
        "synthetic": True,
        "numpy_version": np.__version__,
        "quantile_points": points,
        "cases": {},
    }
    for name, values in spec["cases"].items():
        a = np.asarray(values, dtype=float)
        out["cases"][name] = {
            "values": values,
            "mean": float(np.mean(a)),
            "quantiles": [float(np.quantile(a, q, method="linear")) for q in points],
            "variance": float(np.var(a, ddof=1)) if a.size >= 2 else None,
            "sd": float(np.std(a, ddof=1)) if a.size >= 2 else None,
        }
    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"escrito {DST.relative_to(ROOT)} con numpy {np.__version__}")


if __name__ == "__main__":
    main()
