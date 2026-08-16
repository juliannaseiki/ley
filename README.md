# Ley

A calm, illustrated 3D globe of your personal astrocartography chart — where each planet was rising,
setting, culminating, or at its lowest point at the moment you were born, projected across the map.
Tap anywhere on the globe to see how the chart reads from that point.

This is the first screen only: authentication, a required birth-data form, and the interactive globe.
No saved places, no recommendations yet.

## Stack

- **App**: React Native + Expo (TypeScript)
- **Auth & data**: [Supabase](https://supabase.com) — email/password auth, Postgres for birth data,
  row-level security so each user only ever sees their own row
- **Ephemeris**: [`astronomy-engine`](https://github.com/cosinekitty/astronomy) — pure JS/TS, runs
  entirely on-device, no backend compute needed
- **Geocoding & timezone**: [Nominatim](https://nominatim.org/) (OpenStreetMap) + `tz-lookup` + `luxon`
- **Globe**: a `react-native-webview` hosting a bundled D3 (`d3-geo`) orthographic-projection canvas
  renderer, with hand-rolled pointer gestures (drag to rotate, pinch to zoom, tap to relocate) and a
  slow ambient auto-rotation when idle

This repo is a **pnpm workspace monorepo**: the app lives in `apps/astrocartography`, with auth and
UI primitives factored into `packages/*` so future apps can share them.

## Setup

1. **Install dependencies** (from the repo root — installs for every app/package at once)

   ```
   pnpm install
   ```

2. **Create a Supabase project** at [supabase.com](https://supabase.com) (free tier is fine).

   - In **Authentication → Providers**, email/password is enabled by default. Decide whether you want
     email confirmation on sign-up (Authentication → Settings) — the sign-up screen handles both cases,
     but for the fastest local iteration you may want to disable "Confirm email" while developing.
   - In the **SQL editor**, run the migration in `apps/astrocartography/supabase/migrations/0001_init.sql`
     to create the `birth_data` table and its row-level security policies.
   - Copy `.env.example` to `.env` **inside `apps/astrocartography`** and fill in your project's URL and
     anon key (Project Settings → API):

     ```
     cp apps/astrocartography/.env.example apps/astrocartography/.env
     ```

3. **Run the app**

   ```
   pnpm dev
   ```

   Then open in Expo Go, an iOS simulator, or an Android emulator.

## Regenerating the globe bundle

The WebView's HTML/JS is pre-bundled (via esbuild) and simplified world landmass data (via
`world-atlas` + `topojson-client`) is inlined into `src/webview/globeHtml.ts` at build time, rather
than loaded as a runtime asset — this sidesteps WebView local-asset path quirks on Android/iOS.
If you change `apps/astrocartography/webview-src/globe-entry.js`, regenerate it with:

```
pnpm build:globe
```

## Project layout

```
apps/
  astrocartography/            # the app — see below
packages/
  auth/                        # @ley/auth: AuthProvider/useAuth + Supabase client factory
  ui/                          # @ley/ui: theme tokens, GradientButton/TextField/ScreenContainer, useDebouncedValue
  config/                      # @ley/config: shared ESLint flat config
tsconfig.base.json              # shared TypeScript compiler options, extended by every app/package
pnpm-workspace.yaml
```

`apps/astrocartography`:

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
