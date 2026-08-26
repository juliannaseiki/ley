// Frozen snapshot of apps/ley/scripts/build-globe-html.mjs, taken just before the app's globe
// was switched to the natural-earth-tiers three-tier approach (see ../README.md). Same data
// pipeline verbatim; the only change is the final step, which writes a self-contained
// dist/index.html for standalone viewing instead of wrapping the HTML as a committed .ts export
// for the RN WebView. If this needs to be restored, copy scripts/data/*.json and webview-src/*
// back into apps/ley and re-run its own build:globe.
import { build } from 'esbuild';
import { feature, mesh, merge } from 'topojson-client';
import { geoArea, geoCentroid } from 'd3-geo';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function ringNeedsReversal(ring) {
  const area = Math.abs(geoArea({ type: 'Polygon', coordinates: [ring] }));
  return area > 2 * Math.PI;
}
function rewindPolygonCoords(coords) {
  coords.forEach((ring) => {
    if (ringNeedsReversal(ring)) ring.reverse();
  });
}
function rewindGeometry(geometry) {
  if (!geometry) return;
  if (geometry.type === 'Polygon') rewindPolygonCoords(geometry.coordinates);
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(rewindPolygonCoords);
}

function accumulateBounds(node, bounds) {
  if (typeof node[0] === 'number') {
    const [lon, lat] = node;
    if (lon < bounds.minLon) bounds.minLon = lon;
    if (lon > bounds.maxLon) bounds.maxLon = lon;
    if (lat < bounds.minLat) bounds.minLat = lat;
    if (lat > bounds.maxLat) bounds.maxLat = lat;
  } else {
    for (const child of node) accumulateBounds(child, bounds);
  }
}
function bboxOf(coordinates) {
  const bounds = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  accumulateBounds(coordinates, bounds);
  if (bounds.minLon === Infinity || bounds.maxLon - bounds.minLon > 180) return null;
  const round3 = (n) => Math.round(n * 1e3) / 1e3;
  return [round3(bounds.minLon), round3(bounds.minLat), round3(bounds.maxLon), round3(bounds.maxLat)];
}

function loadCountries(fileName) {
  const topology = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data', fileName), 'utf8'));
  const object = topology.objects.ne_10m_admin_0_countries;
  const landGeom = merge(topology, object.geometries);
  rewindGeometry(landGeom);
  const borderGeoJson = mesh(topology, object, (a, b) => a.properties.name !== b.properties.name);
  return { landGeoJson: { type: 'Feature', geometry: landGeom, properties: {} }, borderGeoJson };
}
const { landGeoJson, borderGeoJson } = loadCountries('countries-coarse.json');
const { landGeoJson: landDetailGeoJson, borderGeoJson: borderDetailGeoJson } = loadCountries('countries-detail.json');

function polygonPiecesOf(geometry) {
  if (!geometry) return { pieces: [], bboxes: [] };
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  return { pieces: polygons, bboxes: polygons.map(bboxOf) };
}
const { pieces: landDetailPiecesAll, bboxes: landDetailBboxesAll } = polygonPiecesOf(landDetailGeoJson.geometry);
const borderDetailArcs = borderDetailGeoJson.coordinates;

const TINY_ISLAND_MAX_DEG = 0.75;
function isTinyBbox(bbox) {
  return bbox !== null && Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) < TINY_ISLAND_MAX_DEG;
}
const landDetailPieces = [];
const landDetailBboxes = [];
const tinyIslandPieces = [];
const tinyIslandBboxes = [];
landDetailPiecesAll.forEach((piece, i) => {
  const bbox = landDetailBboxesAll[i];
  if (isTinyBbox(bbox)) {
    tinyIslandPieces.push(piece);
    tinyIslandBboxes.push(bbox);
  } else {
    landDetailPieces.push(piece);
    landDetailBboxes.push(bbox);
  }
});
const { pieces: landCoarsePiecesAll, bboxes: landCoarseBboxesAll } = polygonPiecesOf(landGeoJson.geometry);
const landCoarseMainPieces = landCoarsePiecesAll.filter((_, i) => !isTinyBbox(landCoarseBboxesAll[i]));
landGeoJson.geometry = { type: 'MultiPolygon', coordinates: landCoarseMainPieces };
const borderDetailBboxes = borderDetailArcs.map(bboxOf);

const regionsTopology = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data/admin1-provinces.json'), 'utf8'));
const regionsObject = regionsTopology.objects.ne_10m_admin_1_states_provinces;
const isUSState = (f) => f.properties.admin === 'United States of America';
const regionBorderGeoJson = mesh(
  regionsTopology,
  regionsObject,
  (a, b) =>
    isUSState(a) && isUSState(b) && a.properties.name + '|' + a.properties.admin !== b.properties.name + '|' + b.properties.admin
);
const regionBorderArcs = regionBorderGeoJson.coordinates;
const regionBorderBboxes = regionBorderArcs.map(bboxOf);

const regionFeatures = feature(regionsTopology, regionsObject).features.filter((f) => f.geometry);
regionFeatures.forEach((f) => rewindGeometry(f.geometry));
const largestPiecePerRegion = new Map();
for (const f of regionFeatures) {
  const key = f.properties.name + '|' + f.properties.admin;
  const area = Math.abs(geoArea(f));
  const existing = largestPiecePerRegion.get(key);
  if (!existing || area > existing.area) {
    largestPiecePerRegion.set(key, { name: f.properties.name, area, centroid: geoCentroid(f), feature: f });
  }
}

function regionOrientation(f, lon0, lat0) {
  const cosLat0 = Math.cos((lat0 * Math.PI) / 180);
  const ring = f.geometry.coordinates[0];
  const pts = ring.map(([lon, lat]) => [(lon - lon0) * cosLat0, lat - lat0]);
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  for (const [x, y] of pts) {
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }
  const n = pts.length;
  const covXX = sumXX / n;
  const covYY = sumYY / n;
  const covXY = sumXY / n;
  const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const [x, y] of pts) {
    const proj = x * dirX + y * dirY;
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
  }
  let bearingDeg = 90 - (angle * 180) / Math.PI;
  bearingDeg = ((bearingDeg % 180) + 180) % 180;
  return { bearingDeg, majorSpanDeg: maxProj - minProj };
}
const REGION_LABEL_BASE_MIN_ZOOM = 1.6;
const REGION_LABEL_LOG_AREA_MAX = Math.log10(0.25);
const REGION_LABEL_ZOOM_PER_LOG_AREA = 0.55;
function minZoomForArea(area) {
  const logArea = Math.log10(Math.max(area, 1e-8));
  return (
    Math.round(
      (REGION_LABEL_BASE_MIN_ZOOM + Math.max(0, REGION_LABEL_LOG_AREA_MAX - logArea) * REGION_LABEL_ZOOM_PER_LOG_AREA) * 100
    ) / 100
  );
}
const regionLabels = Array.from(largestPiecePerRegion.values())
  .filter(({ name }) => typeof name === 'string' && name.trim().length > 0)
  .map(({ name, area, centroid, feature: f }) => {
    const { bearingDeg, majorSpanDeg } = regionOrientation(f, centroid[0], centroid[1]);
    return [
      name,
      Math.round(centroid[0] * 1e5) / 1e5,
      Math.round(centroid[1] * 1e5) / 1e5,
      minZoomForArea(area),
      Math.round(bearingDeg * 100) / 100,
      Math.round(majorSpanDeg * 1e4) / 1e4,
    ];
  });

const US_STATE_ABBREVIATIONS = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO',
  Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY',
  Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH',
  'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND',
  Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};
const usStateLabels = Array.from(largestPiecePerRegion.values())
  .filter(({ feature: f, name }) => f.properties.admin === 'United States of America' && name !== 'District of Columbia')
  .map(({ name, centroid }) => [
    US_STATE_ABBREVIATIONS[name] || name,
    Math.round(centroid[0] * 1e5) / 1e5,
    Math.round(centroid[1] * 1e5) / 1e5,
  ]);

const CITY_BASE_MIN_ZOOM = 3;
const CITY_LOG_POP_MAX = 7.4;
const CITY_ZOOM_PER_LOG_POP = 1.3;
function minZoomForPopulation(population) {
  const logPop = Math.log10(Math.max(population, 10));
  return Math.round((CITY_BASE_MIN_ZOOM + Math.max(0, CITY_LOG_POP_MAX - logPop) * CITY_ZOOM_PER_LOG_POP) * 100) / 100;
}
const cities = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data/cities.json'), 'utf8')).map(
  ([name, lon, lat, population]) => [name, lon, lat, minZoomForPopulation(population)]
);

const CITY_CELL_SIZE_DEG = 10;
const cityCells = new Map();
cities.forEach(([, lon, lat], index) => {
  const col = Math.floor((lon + 180) / CITY_CELL_SIZE_DEG);
  const row = Math.floor((lat + 90) / CITY_CELL_SIZE_DEG);
  const key = col + ',' + row;
  if (!cityCells.has(key)) cityCells.set(key, []);
  cityCells.get(key).push(index);
});
const cityCellsObj = Object.fromEntries(cityCells);

const theme = {
  oceanLight: '#fbfdfe',
  oceanDeep: '#fbfdfe',
  land: '#FFFFFF',
  landStroke: '#A3A3A3',
  countryBorder: '#A3A3A3',
  regionBorder: '#A3A3A3',
  globeOutline: '#A3A3A3',
  cityDot: '#8FA396',
  cityLabel: '#5B655F',
  regionLabel: '#7A6A4F',
};

function embedAsJson(data) {
  const json = JSON.stringify(data);
  const jsStringLiteral = JSON.stringify(json).replace(/<\/script/gi, '<\\/script');
  return `JSON.parse(${jsStringLiteral})`;
}

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
<title>Two-tier mapshaper globe — frozen snapshot</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #FFFFFF; overscroll-behavior: none; }
  #globe { display: block; width: 100%; height: 100%; touch-action: none; }
</style>
</head>
<body>
<canvas id="globe"></canvas>
<script>
window.LAND_GEOJSON = ${embedAsJson(landGeoJson)};
window.BORDER_GEOJSON = ${embedAsJson(borderGeoJson)};
window.LAND_DETAIL_PIECES = ${embedAsJson(landDetailPieces)};
window.LAND_DETAIL_BBOXES = ${embedAsJson(landDetailBboxes)};
window.TINY_ISLAND_PIECES = ${embedAsJson(tinyIslandPieces)};
window.TINY_ISLAND_BBOXES = ${embedAsJson(tinyIslandBboxes)};
window.BORDER_DETAIL_ARCS = ${embedAsJson(borderDetailArcs)};
window.BORDER_DETAIL_BBOXES = ${embedAsJson(borderDetailBboxes)};
window.REGION_BORDER_ARCS = ${embedAsJson(regionBorderArcs)};
window.REGION_BORDER_BBOXES = ${embedAsJson(regionBorderBboxes)};
window.REGION_LABELS = ${embedAsJson(regionLabels)};
window.US_STATE_LABELS = ${embedAsJson(usStateLabels)};
window.CITIES = ${embedAsJson(cities)};
window.CITY_CELLS = ${embedAsJson(cityCellsObj)};
window.CITY_CELL_SIZE_DEG = ${embedAsJson(CITY_CELL_SIZE_DEG)};
window.THEME = ${embedAsJson(theme)};
</script>
<script>
${bundledJs}
</script>
</body>
</html>
`;

const outPath = path.join(root, 'dist/index.html');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`Wrote ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
