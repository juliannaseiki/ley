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

// City labels, shown at deep zoom, prioritized by Natural Earth's SCALERANK (0 = major world
// cities, higher = smaller places) so bigger cities appear first and smaller ones fill in as you
// zoom further. Source: ne_50m_populated_places (1,251 cities globally), reduced to
// [name, lon, lat, scalerank] tuples — no polygon geometry to simplify, so no mapshaper step,
// just stripped straight from the downloaded geojson's properties.
const cities = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data/cities.json'), 'utf8'));

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
