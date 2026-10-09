# Airspace 3D

3D view of US terminal procedures and airspace: how SIDs, STARs and approaches
stack inside and around Class B, for every airport in the FAA CIFP. Static site (CesiumJS + React +
Mantine); data is pre-baked from FAA sources by a Python pipeline.

## Data

| Layer | Source |
|---|---|
| SIDs, STARs, approaches (legs, altitude/speed restrictions, holds) | FAA CIFP (ARINC 424), 28-day AIRAC cycle |
| Class B/C/D, special use airspace | FAA AIS Open Data (ArcGIS feature services) |

Display rule: only what a procedure publishes is drawn.
- Ground tracks are drawn only for legs with a defined path (IF, TF, CF, DF, RF, AF, FC).
  Heading/course-to-altitude, vector, intercept and DME-terminated legs break the
  track and appear as notes in the info panel.
- Each leg is drawn at its legal altitude band: arrivals/approaches only descend
  and departures/missed approaches only climb, so every published restriction
  bounds the band on one side of its fix. No climb or descent gradient is
  assumed. Sides without a published limit fade out. Final segments with a
  published glideslope/VPA are drawn on that path.

## Develop

```sh
python -m pipeline.build            # downloads current CIFP, writes web/public/data/
cd web && npm install && npm run dev
```

`python -m pipeline.build --cifp path/to/FAACIFP18 --skip-airspace` reuses a local CIFP file.

Output: `web/public/data/index.json` (airport list), `airports/<ID>.json` per
airport, and `airspace/<x>_<y>.json` tiles. The viewer loads airports and tiles
in view only.

## Deploy

`.github/workflows/pages.yml` rebuilds data and deploys to GitHub Pages on push
and daily (a new AIRAC cycle is picked up on its effective date). Enable Pages
with "GitHub Actions" as the source.

Not for navigation.
