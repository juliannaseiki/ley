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

const usStatesTopology = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules/us-atlas/states-10m.json'), 'utf8')
);
const usStateBorderGeoJson = mesh(usStatesTopology, usStatesTopology.objects.states, (a, b) => a !== b);

const theme = {
  oceanLight: '#FFFFFF',
  oceanDeep: '#FFFFFF',
  land: '#F4FAF2',
  landStroke: '#DCEEDA',
  countryBorder: '#CBE4CC',
  usStateBorder: '#DCEEDA',
  globeOutline: '#EAF3FA',
  pin: '#28312C',
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
window.US_STATE_BORDER_GEOJSON = ${JSON.stringify(usStateBorderGeoJson)};
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
