# Airspace 3D

3D view of terminal airspace around major US metro areas: how SIDs, STARs and
approaches stack inside and around Class B. Static site (CesiumJS + React +
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
- Altitude restrictions are drawn as gates above their fix: a dot for "at",
  an arrow for "at or above" / "at or below", a bar for "between". No altitude
  is interpolated between fixes.

## Develop

```sh
python -m pipeline.build            # downloads current CIFP, writes web/public/data/
cd web && npm install && npm run dev
```

`python -m pipeline.build --cifp path/to/FAACIFP18 --skip-airspace` reuses a local CIFP file.

Metro areas are defined in `metros/*.json` (airports, bounding box, initial camera,
geoid offset for MSL → ellipsoid heights).

## Deploy

`.github/workflows/pages.yml` rebuilds data and deploys to GitHub Pages on push
and daily (a new AIRAC cycle is picked up on its effective date). Enable Pages
with "GitHub Actions" as the source.

Not for navigation.
