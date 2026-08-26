# Ley

Places you've saved, pinned on a calm, illustrated 3D globe. Search for a place, drop a pin, and spin
the globe to see everything you've saved so far.

## Stack

- **App**: React Native + Expo (TypeScript)
- **Auth & data**: [Supabase](https://supabase.com) — email/password auth, Postgres for saved places,
  row-level security so each user only ever sees their own rows
- **Place search**: [Foursquare Places API](https://location.foursquare.com/places/)
- **Globe**: a `react-native-webview` hosting a bundled D3 (`d3-geo`) orthographic-projection canvas
  renderer, with hand-rolled pointer gestures (drag to rotate, pinch to zoom, tap to select a pin) and
  a 3-tier Natural Earth country/land dataset that swaps in more detail as you zoom in

This repo is a **pnpm workspace monorepo**: the app lives in `apps/ley`, with auth and UI
primitives factored into `packages/*` so future apps can share them. `prototypes/` holds
standalone prototypes and archived earlier work — see below.

## Setup

1. **Install dependencies** (from the repo root — installs for every app/package at once)

   ```
   pnpm install
   ```

2. **Create a Supabase project** at [supabase.com](https://supabase.com) (free tier is fine).

   - In **Authentication → Providers**, email/password is enabled by default. Decide whether you want
     email confirmation on sign-up (Authentication → Settings) — the sign-up screen handles both cases,
     but for the fastest local iteration you may want to disable "Confirm email" while developing.
   - In the **SQL editor**, run the migrations in `apps/ley/supabase/migrations/` to create the
     `saved_places` table and its row-level security policies.
   - Copy `.env.example` to `.env` **inside `apps/ley`** and fill in your Supabase project's URL/anon
     key and a [Foursquare Places API](https://location.foursquare.com/places/) key:

     ```
     cp apps/ley/.env.example apps/ley/.env
     ```

3. **Run the app**

   ```
   pnpm dev
   ```

   Then open in Expo Go, an iOS simulator, or an Android emulator.

## Regenerating the globe bundle

The WebView's HTML/JS is pre-bundled (via esbuild) and simplified Natural Earth country/land data is
inlined into `src/webview/globeHtml.ts` at build time, rather than loaded as a runtime asset — this
sidesteps WebView local-asset path quirks on Android/iOS. If you change
`apps/ley/webview-src/globe-entry.js` or `apps/ley/scripts/build-globe-html.mjs`, regenerate it
with:

```
pnpm build:globe
```

## Project layout

```
apps/
  ley/                          # the app — see below
packages/
  auth/                        # @ley/auth: AuthProvider/useAuth + Supabase client factory
  ui/                          # @ley/ui: theme tokens, useDebouncedValue
  config/                      # @ley/config: shared ESLint flat config
prototypes/                     # standalone prototypes + archived earlier work, not part of the app
tsconfig.base.json              # shared TypeScript compiler options, extended by every app/package
pnpm-workspace.yaml
```

`apps/ley`:

```
App.tsx                        # font loading, providers, root
src/
  navigation/RootNavigator.tsx # auth -> home, conditional on session state
  screens/                     # SignUp, LogIn, Home
  components/                  # Globe (WebView wrapper), PlaceDetailPanel, SettingsPanel
  lib/foursquarePlaces.ts      # Foursquare place search
webview-src/globe-entry.js     # source for the WebView canvas globe renderer
scripts/build-globe-html.mjs   # bundles the above + country/land data into src/webview/globeHtml.ts
supabase/migrations/           # SQL schema + RLS policies
```

## `prototypes/`

Standalone spaces for trying things out without touching the working app. Each has its own README.

- `maps/` — browser-based globe/map rendering experiments (data pipelines, tiling
  strategies) that informed `apps/ley`'s current globe renderer.
- `astrocartography/` — an earlier, complete app: a birth-chart globe showing where each planet was
  rising, setting, culminating, or at its lowest point at the moment you were born. Archived here
  (not actively developed) rather than kept as a second live app; still a runnable Expo app of its
  own if you want to reference or revive it.
