// One-time (re-run on globe changes) build step: bundles the webview globe
// renderer and inlines it, along with simplified world landmass data, into a
// single self-contained HTML string committed as src/webview/globeHtml.ts.
// Keeping this as a generated file (rather than loading assets at runtime)
// sidesteps WebView local-asset path quirks on Android/iOS entirely.
import { build } from 'esbuild';
import { feature, mesh } from 'topojson-client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const landTopology = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules/world-atlas/land-110m.json'), 'utf8')
);
const landGeoJson = feature(landTopology, landTopology.objects.land);

const countriesTopology = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules/world-atlas/countries-110m.json'), 'utf8')
);
const borderGeoJson = mesh(countriesTopology, countriesTopology.objects.countries, (a, b) => a !== b);

// State/province-level boundaries for every country, not just the US. world-atlas/us-atlas only
// bundle country-level and US-only data respectively; no npm package wraps Natural Earth's global
// admin-1 set, so this is our own locally-committed conversion. Source: Natural Earth's
// ne_10m_admin_1_states_provinces (the only admin-1 resolution with full global coverage — 110m/
// 50m only cover the US and a handful of other countries), fetched from
// https://github.com/nvkelso/natural-earth-vector, then simplified 1% and stripped to
// name/admin properties via mapshaper:
//   npx mapshaper -i ne_10m_admin_1_states_provinces.geojson -simplify 1% \
//     -filter-fields name,admin -o format=topojson quantization=1e5 admin1-provinces.json
const regionsTopology = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/data/admin1-provinces.json'), 'utf8')
);
const regionBorderGeoJson = mesh(regionsTopology, regionsTopology.objects.ne_10m_admin_1, (a, b) => a !== b);

// City labels, shown at deep zoom. Source: GeoNames' cities5000 dump (every populated place with
// population >= 5,000 - https://download.geonames.org/export/dump/), reduced to
// [name, lon, lat, population] tuples in scripts/data/cities.json - no polygon geometry to
// simplify, so no mapshaper step, just name/lat/lon/population stripped straight from the
// downloaded dump. Population is converted to each city's reveal-zoom threshold here at build
// time (not in the renderer): the renderer scans this list every frame, not just at the discrete
// recompute moments the astro line labels use, so a log10 call per city per frame across 69,562
// cities isn't worth paying for — do it once here instead and ship the plain number.
// Pinch-zoom is ratio-based (current finger distance / distance when the pinch started) and
// compounds only across repeated pinch gestures, not one continuous one — a single realistic
// pinch on a phone screen realistically reaches roughly 5-8x, not the kind of 12-20x a naive
// log-population spread wants. These constants keep every population tier reachable within
// that range; MAX_ZOOM going higher than this is about the globe surface feeling deep to
// explore, not a requirement for any city tier to ever show up.
const CITY_BASE_MIN_ZOOM = 2.2; // cities start once region borders (fade ends at zoom 2.2) are fully in
const CITY_LOG_POP_MAX = 7.4; // roughly Tokyo-scale (~37M) - the top of the log-population range
const CITY_ZOOM_PER_LOG_POP = 1.0;
function minZoomForPopulation(population) {
  const logPop = Math.log10(Math.max(population, 10));
  return Math.round((CITY_BASE_MIN_ZOOM + Math.max(0, CITY_LOG_POP_MAX - logPop) * CITY_ZOOM_PER_LOG_POP) * 100) / 100;
}
const cities = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data/cities.json'), 'utf8')).map(
  ([name, lon, lat, population]) => [name, lon, lat, minZoomForPopulation(population)]
);

const theme = {
  oceanLight: '#FFFFFF',
  oceanDeep: '#FFFFFF',
  land: '#F4FAF2',
  landStroke: '#DCEEDA',
  countryBorder: '#CBE4CC',
  regionBorder: '#DCEEDA',
  globeOutline: '#EAF3FA',
  pin: '#28312C',
  cityDot: '#8FA396',
  cityLabel: '#5B655F',
};

const bundle = await build({
  entryPoints: [path.join(root, 'webview-src/globe-entry.js')],
  bundle: true,
  format: 'iife',
  target: 'es2019',
  minify: true,
  write: false,
});
const bundledJs = bundle.outputFiles[0].text;

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #FFFFFF; overscroll-behavior: none; }
  #globe { display: block; width: 100%; height: 100%; touch-action: none; }
</style>
</head>
<body>
<canvas id="globe"></canvas>
<script>
window.LAND_GEOJSON = ${JSON.stringify(landGeoJson)};
window.BORDER_GEOJSON = ${JSON.stringify(borderGeoJson)};
window.REGION_BORDER_GEOJSON = ${JSON.stringify(regionBorderGeoJson)};
window.CITIES = ${JSON.stringify(cities)};
window.THEME = ${JSON.stringify(theme)};
</script>
<script>
${bundledJs}
</script>
</body>
</html>
`;

const output = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/build-globe-html.mjs
export const GLOBE_HTML = ${JSON.stringify(html)};
`;

const outPath = path.join(root, 'src/webview/globeHtml.ts');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, output);
console.log(`Wrote ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
