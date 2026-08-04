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

// City/town labels, shown at deep zoom. Source: GeoNames' cities1000 dump (every populated place
// with population >= 1,000 - https://download.geonames.org/export/dump/cities1000.zip), reduced
// to [name, lon, lat, population] tuples in scripts/data/cities.json - no polygon geometry to
// simplify, so no mapshaper step, just name/lat/lon/population stripped straight from the
// downloaded dump (tab-separated columns 2/5/6/15). Population is converted to each city's
// reveal-zoom threshold here at build time (not in the renderer): the renderer scans this list
// every frame, not just at the discrete recompute moments the astro line labels use, so a log10
// call per city per frame across 170,569 places isn't worth paying for — do it once here instead
// and ship the plain number.
// Pinch-zoom is ratio-based (current finger distance / distance when the pinch started) and
// compounds only across repeated pinch gestures, not one continuous one — a single realistic
// pinch on a phone screen realistically reaches roughly 5-8x, not the kind of 12-20x a naive
// log-population spread wants. These constants keep every population tier reachable within
// that range; MAX_ZOOM going higher than this is about the globe surface feeling deep to
// explore, not a requirement for any city tier to ever show up.
const CITY_BASE_MIN_ZOOM = 2.8; // cities start a bit after region borders (fade ends at zoom 2.2) are fully in
const CITY_LOG_POP_MAX = 7.4; // roughly Tokyo-scale (~37M) - the top of the log-population range
const CITY_ZOOM_PER_LOG_POP = 1.3;
function minZoomForPopulation(population) {
  const logPop = Math.log10(Math.max(population, 10));
  return Math.round((CITY_BASE_MIN_ZOOM + Math.max(0, CITY_LOG_POP_MAX - logPop) * CITY_ZOOM_PER_LOG_POP) * 100) / 100;
}
const cities = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data/cities.json'), 'utf8')).map(
  ([name, lon, lat, population]) => [name, lon, lat, minZoomForPopulation(population)]
);

// Flat, pastel elevation-tinted terrain (land only — ocean keeps its existing plain fill). No
// npm package or Natural Earth vector product ships classified elevation polygons directly, so
// this is our own conversion: NOAA's ETOPO1 global relief grid (1 arc-minute, ice-surface,
// grid-registered - https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO1/data/ice_surface/
// grid_registered/netcdf/ETOPO1_Ice_g_gmt4.grd.gz), downsampled to 0.1deg with gdal_translate,
// then polygonized into fixed elevation bands with gdal_contour -p (one flat-fillable polygon per
// band, not a raster/hillshade — matches the "flat colors, no shading" ask directly since there's
// nothing to shade), then simplified 3% and quantized to topojson via mapshaper, same as
// admin1-provinces:
//   gdal_translate -outsize 3600 1800 -r average ETOPO1_Ice_g_gmt4.grd etopo1_0.1deg.tif
//   gdal_contour -p -amin elevmin -amax elevmax \
//     -fl -11000 -4000 -200 0 200 500 1000 2000 4000 9000 \
//     -f GeoJSON etopo1_0.1deg.tif elevation_bands.geojson
//   npx mapshaper -i elevation_bands.geojson -simplify 3% \
//     -o format=topojson quantization=1e5 elevation-bands.json
const ELEVATION_BAND_COLORS = {
  0: '#F1F5EE', // 0-200m: lowlands/coastal plains
  200: '#EDF2E9', // 200-500m: hills/plains
  500: '#E9EFE3', // 500-1000m: uplands
  1000: '#E5ECDE', // 1000-2000m: low mountains
  2000: '#E1E9D8', // 2000-4000m: mountains
  4000: '#DDE6D3', // 4000m+: high peaks
};
const elevationTopology = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/data/elevation-bands.json'), 'utf8')
);
const elevationBandGeoJson = {
  type: 'FeatureCollection',
  features: feature(elevationTopology, elevationTopology.objects.elevation_bands)
    .features.filter((f) => f.properties.elevmin >= 0)
    .map((f) => ({ ...f, properties: { color: ELEVATION_BAND_COLORS[f.properties.elevmin] } })),
};

// Inland water — lakes and other bodies of water, filled the same white as the ocean so they
// read as "water" rather than land-colored gaps. world-atlas's land layer doesn't carve lakes
// out as holes at all (too coarse a resolution to bother), so this is its own source: Natural
// Earth, fetched from https://github.com/nvkelso/natural-earth-vector.
//
// Two tiers, same idea as region borders/cities — a coarse layer that's always drawn, and a
// finer layer that only costs anything once zoomed in:
//   - lakesMajorGeoJson: ne_50m_lakes (~400 of the largest lakes worldwide), simplified 5%.
//     Matches the ~110m resolution of the land/ocean/border layers it's drawn alongside every
//     frame, including through continuous idle auto-rotation — cheap by design, not just by luck.
//   - lakesDetailGeoJson: ne_10m_lakes (~1,350 lakes — covers regionally-notable ones the 50m
//     tier misses, e.g. Lake Champlain), simplified 8%, faded in over the same zoom range as
//     region borders (reusing REGION_BORDER_FADE_START/END in the renderer, not a separate
//     constant) so its cost only applies once actually zoomed in, rather than every frame forever
//     at rest. Drawing the full 10m set unconditionally made the globe painfully slow — a
//     resolution that fine has no business being an always-on layer.
//
// keep-shapes matters here in a way it didn't for the coastline/border layers: without it, most
// lakes are small enough relative to the whole dataset that simplification collapsed them to
// nothing — 285 of 412 "major" lakes (Tahoe, the Dead Sea, Salton Sea included) came out with
// null geometry at a plain 5% simplify, silently dropped rather than just less detailed.
//   npx mapshaper -i ne_50m_lakes.geojson -simplify 5% keep-shapes -filter-fields name \
//     -o format=topojson quantization=1e5 lakes-major.json
//   npx mapshaper -i ne_10m_lakes.geojson -simplify 8% keep-shapes -filter-fields name \
//     -o format=topojson quantization=1e5 lakes-detail.json
//
// d3-geo's polygon clipping (used here via clipAngle for the orthographic projection) uses ring
// winding to decide which side of a clipped edge is "inside"; get it backwards and a lake can
// clip to its complement instead — the entire visible hemisphere renders in the lake's fill
// color. Confirmed empirically against d3-geo directly (not just by re-deriving the same formula
// used to "fix" it, which is tautological): d3-geo wants the exterior ring wound CLOCKWISE under
// a planar shoelace formula with x=longitude, y=latitude — the opposite of what GeoJSON/RFC 7946
// states, and the opposite of an earlier version of this fix, which flipped the (correct, as it
// turns out) majority of rings and broke them. Rewinding here, right before injection, is
// deliberate: mapshaper normalizes ring order to its own convention when it builds the topology,
// so fixing the source .geojson before that step doesn't stick — this has to be the last
// operation before the data reaches the renderer.
function ringSignedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}
function rewindPolygonCoords(coords) {
  coords.forEach((ring, i) => {
    const shouldBeClockwise = i === 0; // exterior ring first, holes after
    const isClockwise = ringSignedArea(ring) < 0;
    if (isClockwise !== shouldBeClockwise) ring.reverse();
  });
}
function rewindGeometry(geometry) {
  if (!geometry) return;
  if (geometry.type === 'Polygon') rewindPolygonCoords(geometry.coordinates);
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(rewindPolygonCoords);
}
function loadLakes(fileName, objectKey) {
  const topology = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data', fileName), 'utf8'));
  const geoJson = feature(topology, topology.objects[objectKey]);
  geoJson.features = geoJson.features.filter((f) => f.geometry);
  geoJson.features.forEach((f) => rewindGeometry(f.geometry));
  return geoJson;
}

const lakesMajorGeoJson = loadLakes('lakes-major.json', 'ne_50m_lakes');
const lakesMajorNames = new Set(lakesMajorGeoJson.features.map((f) => f.properties.name));
// Excludes anything already covered by the major tier — both are the same flat white, so a
// duplicate lake costs real render time for zero visual difference.
const lakesDetailGeoJson = loadLakes('lakes-detail.json', 'ne_10m_lakes');
lakesDetailGeoJson.features = lakesDetailGeoJson.features.filter(
  (f) => !lakesMajorNames.has(f.properties.name)
);

const theme = {
  oceanLight: '#FFFFFF',
  oceanDeep: '#FFFFFF',
  land: '#F4FAF2',
  landStroke: '#DCEEDA',
  countryBorder: '#7FAE87',
  regionBorder: '#AACDAF',
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
window.ELEVATION_BAND_GEOJSON = ${JSON.stringify(elevationBandGeoJson)};
window.LAKES_MAJOR_GEOJSON = ${JSON.stringify(lakesMajorGeoJson)};
window.LAKES_DETAIL_GEOJSON = ${JSON.stringify(lakesDetailGeoJson)};
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
