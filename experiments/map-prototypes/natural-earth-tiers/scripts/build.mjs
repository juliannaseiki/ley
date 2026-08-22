// Build step for this prototype: reads the three committed per-tier TopoJSON files (see
// scripts/data/*.json and this directory's README for how they were generated), converts each to
// plain GeoJSON pieces via topojson-client (same library/technique apps/places uses at its own
// build time — see apps/places/scripts/build-globe-html.mjs), bundles the Canvas renderer with
// esbuild, and writes one self-contained dist/index.html with the data inlined. Mirrors
// build-globe-html.mjs's structure closely on purpose, so anything proven out here ports back
// with minimal translation.
import { build } from 'esbuild';
import { mesh, merge } from 'topojson-client';
import { geoArea } from 'd3-geo';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Same winding fix as build-globe-html.mjs — see that file's comment for the full derivation.
// Needed here too: merge() resolves raw (unwound) topology geometries into real coordinate rings,
// and mapshaper's own ring-order convention doesn't match what d3-geo's clipping/geoArea want.
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

// Same bbox helper as build-globe-html.mjs — lets the renderer skip projecting/tracing a piece
// once it's nowhere near what's on screen.
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
function polygonPiecesOf(geometry) {
  if (!geometry) return { pieces: [], bboxes: [] };
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  return { pieces: polygons, bboxes: polygons.map(bboxOf) };
}

// Only the 110m tier gets tiny-feature dropping — at that tier's zoom range (see LOD_BREAKPOINTS
// in src/render-entry.js) a stray uninhabited rock reads as a fleck of dirt rather than actual
// geography, the same reasoning as TINY_ISLAND_MAX_DEG in build-globe-html.mjs. The 50m/10m tiers
// only ever draw once zoomed in past that, where the same size piece is a legitimate, recognizable
// feature, so they're left unfiltered.
const TINY_ISLAND_MAX_DEG = 0.75;
function isTinyBbox(bbox) {
  return bbox !== null && Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) < TINY_ISLAND_MAX_DEG;
}

// mesh()'s adjacency filter compares geometry objects by reference by default — wrong after
// -explode, which splits one country into per-island pieces that are distinct objects. Comparing
// by name instead (same technique as build-globe-html.mjs's loadCountries) treats same-country
// pieces as non-borders and different countries as borders.
function loadTier(scale) {
  const fileName = `countries-${scale}.json`;
  const topology = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data', fileName), 'utf8'));
  const objectName = `ne_${scale}_admin_0_countries`;
  const object = topology.objects[objectName];

  const landGeom = merge(topology, object.geometries);
  rewindGeometry(landGeom);
  const { pieces: landPiecesAll, bboxes: landBboxesAll } = polygonPiecesOf(landGeom);

  const borderGeoJson = mesh(topology, object, (a, b) => a.properties.name !== b.properties.name);
  const borderArcsAll = borderGeoJson.coordinates;
  const borderBboxesAll = borderArcsAll.map(bboxOf);

  if (scale !== '110m') {
    return { landPieces: landPiecesAll, landBboxes: landBboxesAll, borderArcs: borderArcsAll, borderBboxes: borderBboxesAll };
  }

  const landPieces = [];
  const landBboxes = [];
  landPiecesAll.forEach((piece, i) => {
    if (!isTinyBbox(landBboxesAll[i])) {
      landPieces.push(piece);
      landBboxes.push(landBboxesAll[i]);
    }
  });
  // Border arcs belonging entirely to a dropped tiny piece would draw a border line with no land
  // beneath it, so they're dropped by the same size test rather than by cross-referencing which
  // country each arc came from.
  const borderArcs = [];
  const borderBboxes = [];
  borderArcsAll.forEach((arc, i) => {
    if (!isTinyBbox(borderBboxesAll[i])) {
      borderArcs.push(arc);
      borderBboxes.push(borderBboxesAll[i]);
    }
  });
  return { landPieces, landBboxes, borderArcs, borderBboxes };
}

const tiers = {
  '110m': loadTier('110m'),
  '50m': loadTier('50m'),
  '10m': loadTier('10m'),
};

function embedAsJson(data) {
  const json = JSON.stringify(data);
  const jsStringLiteral = JSON.stringify(json).replace(/<\/script/gi, '<\\/script');
  return `JSON.parse(${jsStringLiteral})`;
}

const bundle = await build({
  entryPoints: [path.join(root, 'src/render-entry.js')],
  bundle: true,
  format: 'iife',
  target: 'es2019',
  write: false,
});
const bundledJs = bundle.outputFiles[0].text;

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Natural Earth tiers — LOD prototype</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #0b1220; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  #globe { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
  #globe:active { cursor: grabbing; }
  #hud { position: fixed; top: 12px; left: 12px; background: rgba(15, 23, 42, 0.85); color: #e2e8f0;
         padding: 12px 14px; border-radius: 8px; font-size: 12px; line-height: 1.6; min-width: 240px; }
  #hud label { display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; }
  #hud input[type="range"] { width: 120px; }
  #hud .row { display: flex; justify-content: space-between; }
  #hud .tier { font-weight: 600; color: #7dd3fc; }
  #hud hr { border: none; border-top: 1px solid rgba(226,232,240,0.2); margin: 8px 0; }
</style>
</head>
<body>
<canvas id="globe"></canvas>
<div id="hud">
  <div class="row"><span>zoom</span><span id="zoomVal">–</span></div>
  <div class="row"><span>tier</span><span id="tierVal" class="tier">–</span></div>
  <hr />
  <label>50m breakpoint <input id="bp50" type="range" min="1.5" max="20" step="0.1" /><span id="bp50Val"></span></label>
  <label>10m breakpoint <input id="bp10" type="range" min="2" max="30" step="0.1" /><span id="bp10Val"></span></label>
  <hr />
  <div style="opacity:0.7">drag to rotate · wheel/pinch to zoom</div>
</div>
<script>
window.TIERS = ${embedAsJson(tiers)};
window.LOD_BREAKPOINTS = ${embedAsJson({ toMid: 4, toFine: 12 })};
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
for (const [scale, t] of Object.entries(tiers)) {
  console.log(`  ${scale}: ${t.landPieces.length} land pieces, ${t.borderArcs.length} border arcs`);
}
