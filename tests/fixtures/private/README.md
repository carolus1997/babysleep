# Fixtures privados

Esta carpeta está en `.gitignore` (salvo este archivo). Aquí, **solo en tu equipo**, pueden vivir datos reales del bebé para validar el motor. Las pruebas que dependen de ellos se omiten si el archivo no existe, por lo que CI no los necesita.

- `five-days-aggregate.json`: los 5 días agregados originales (esquema igual que `../synthetic/aggregate-five-days.json`).

El script `npm run check:private-data` falla si algún archivo de esta carpeta (distinto de este README) está rastreado por git.
