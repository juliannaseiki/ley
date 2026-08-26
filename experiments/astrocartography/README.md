# Astrocartography — archived app

A calm, illustrated 3D globe of your personal astrocartography chart — where each planet was rising,
setting, culminating, or at its lowest point at the moment you were born, projected across the map.
Tap anywhere on the globe to see how the chart reads from that point.

This was Ley's original app, built before `apps/places`. It's archived here rather than kept as a
second live app in `apps/`, since the project settled on one app going forward. It's a complete,
independently runnable Expo app — not a stripped-down prototype — so it's a reasonable starting point
if this feature direction gets revisited later, but it isn't being actively developed and won't
receive the fixes/dependency bumps `apps/places` gets.

## Stack

- **App**: React Native + Expo (TypeScript), sharing `@ley/auth`/`@ley/ui` with `apps/places`
- **Auth & data**: [Supabase](https://supabase.com) — email/password auth, Postgres for birth data,
  row-level security so each user only ever sees their own row
- **Ephemeris**: [`astronomy-engine`](https://github.com/cosinekitty/astronomy) — pure JS/TS, runs
  entirely on-device, no backend compute needed
- **Geocoding & timezone**: [Nominatim](https://nominatim.org/) (OpenStreetMap) + `tz-lookup` + `luxon`
- **Globe**: a `react-native-webview` hosting a bundled D3 (`d3-geo`) orthographic-projection canvas
  renderer (its own earlier version, predating the 3-tier Natural Earth pipeline `apps/places` uses),
  with hand-rolled pointer gestures (drag to rotate, pinch to zoom, tap to relocate) and a slow ambient
  auto-rotation when idle

## Running it

It's a normal workspace package (`@ley/astrocartography`), so from the repo root:

1. Create a Supabase project (or reuse an existing one — the schema is independent of `places`'s).
   Run the migration in `supabase/migrations/0001_init.sql` to create the `birth_data` table and its
   RLS policies.
2. Copy `.env.example` to `.env` in this directory and fill in your Supabase project's URL and anon
   key:
   ```
   cp experiments/astrocartography/.env.example experiments/astrocartography/.env
   ```
3. `pnpm --filter @ley/astrocartography start`, then open in Expo Go, an iOS simulator, or an Android
   emulator.

Regenerate the globe's WebView bundle after editing `webview-src/globe-entry.js`:

```
pnpm --filter @ley/astrocartography build:globe
```

## Layout

```
App.tsx                        # font loading, providers, root
src/
  navigation/RootNavigator.tsx # auth -> birth data -> globe, conditional on state
  screens/                     # SignUp, LogIn, BirthData, Globe
  components/                  # Globe (WebView wrapper), RelocatedChartPanel
  lib/astro/                   # ephemeris, astrocartography line math, house/angle math
  lib/geocode.ts               # Nominatim place search
  lib/birthData.ts             # Supabase reads/writes for birth_data
webview-src/globe-entry.js     # source for the WebView canvas globe renderer
scripts/build-globe-html.mjs   # bundles the above into src/webview/globeHtml.ts
supabase/migrations/           # SQL schema + RLS policies
```

## Notes on the astrology math

- Planetary positions are geocentric, apparent, equator/ecliptic **of date** (not J2000), which is the
  convention astrology software uses. Right ascension/declination and sidereal time come straight from
  `astronomy-engine`; the astrocartography and house formulas (rise/set hour angle, Ascendant, Midheaven)
  are standard spherical-astronomy formulas layered on top.
- Houses use the **whole-sign** system (house 1 is the entire zodiac sign containing the Ascendant).
  It's the simplest system to compute reliably at any latitude — quadrant systems like Placidus have
  no defined cusps inside the polar circles and were out of scope for this pass.
- Bodies tracked: Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto. Each has an
  MC (culminating), IC (anti-culminating), AC (rising), and DC (setting) line.
