# Map prototypes

Isolated space for trying out map/globe approaches before they touch `apps/places`. Each
subdirectory is a standalone, self-contained experiment — its own `package.json`, its own build
step, its own output — so nothing here can break the working app, and nothing in the working app
constrains what an experiment is allowed to try.

Nothing in this directory is wired into `apps/places`. Promoting an experiment means manually
porting the relevant pieces (data files, build logic, renderer code) back into the app once it's
proven out — not pointing the app at this directory.

## Experiments

- `natural-earth-tiers/` — three-tier (110m/50m/10m) Natural Earth country data with zoom-based
  level-of-detail switching, as a replacement for the app's current fixed two-tier
  (coarse/detail) mapshaper setup.
