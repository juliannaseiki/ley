// One-time (re-run on globe changes) build step: bundles the webview globe
// renderer and inlines it, along with simplified world landmass data, into a
// single self-contained HTML string committed as src/webview/globeHtml.ts.
// Keeping this as a generated file (rather than loading assets at runtime)
// sidesteps WebView local-asset path quirks on Android/iOS entirely.
import { build } from 'esbuild';
import { feature, mesh, merge } from 'topojson-client';
import { geoArea, geoCentroid } from 'd3-geo';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// d3-geo's polygon clipping (used here via clipAngle for the orthographic projection) uses ring
// winding to decide which side of a clipped edge is "inside"; get it backwards and a shape can
// clip to its complement instead — the entire visible hemisphere renders in that shape's fill
// color (or, for geoArea/geoCentroid, computes the area/centroid of the complement instead of the
// actual shape — same underlying issue, different symptom, found while computing region label
// placement). Confirmed empirically against d3-geo directly (not just by re-deriving the same
// formula used to "fix" it, which is tautological — see the lakes bug this was first found for):
// d3-geo wants a ring wound so that its OWN enclosed area is the smaller of the two complementary
// regions on the sphere — i.e. under 2π steradians (half the sphere) — not the larger one.
//
// An earlier version of this detected orientation via a planar shoelace formula on raw lon/lat
// coordinates (clockwise = correct). That works for any normally-sized ring, but breaks down for
// a ring whose true area is near zero — degenerate slivers left over from simplifying a tiny
// island down to a handful of points. The shoelace sum for a near-zero-area ring is itself near
// zero, and floating-point noise in that computation can land on either side of zero regardless
// of the ring's actual (correct or incorrect) orientation, silently flipping already-correct tiny
// rings into broken ones. Testing with geoArea directly — is this ring's own enclosed area more or
// less than half the sphere — doesn't have that failure mode: a genuinely near-zero-area ring
// reports a near-zero area either way and never gets flipped, while a ring that's actually wound
// backwards reliably reports close to 4π and gets corrected.
//
// Rewinding here, right before injection, is deliberate: mapshaper normalizes ring order to its
// own convention when it builds the topology, so fixing the source .geojson before that step
// doesn't stick — this has to be the last operation before the data reaches the renderer. Applies
// separately to merge() output too, not just feature() output — merge resolves to real coordinate
// rings same as feature() does, but starting from raw (unwound) topology geometries, so merging
// already-rewound features doesn't carry the fix through; the merged result needs its own pass.
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

// Bounding box (lon/lat) for one drawable piece — a river, a lake, one arc of a border mesh, one
// polygon of the merged landmass — so the renderer can skip projecting/tracing it entirely once
// zoomed in far enough that it's nowhere near what's on screen (see cullByBbox in
// webview-src/globe-entry.js). Works on a ring, a polygon's rings, or a whole MultiPolygon's
// coordinates indifferently — it just walks however deep the array nests until it hits [lon, lat]
// leaves. A piece whose longitude span comes out over 180° almost certainly wrapped around the
// antimeridian rather than genuinely spanning half the globe (-explode keeps individual
// landmasses/arcs small, so a legitimate piece that wide would be unusual) — treating that as
// "always visible" rather than computing a meaningless center point is the safe fallback: it costs
// a bit of unneeded drawing, never a wrongly-hidden feature.
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

// Land and country borders, two tiers, same idea as lakes/region borders/cities — a coarse layer
// that's always drawn, and a finer layer that only costs anything once zoomed in. world-atlas's
// land-110m/countries-110m (the previous source) don't carve out anything smaller than a large
// island, so plenty of real places — many Greek islands among them — were simply missing from
// the map entirely, not just under-detailed. Natural Earth's ne_10m_admin_0_countries is both the
// land shape (via topojson-client's merge, unioning every country into one fillable shape) and
// the country border lines (via mesh) from a single higher-resolution source, so the coastline
// and the border along it can't disagree the way two independently-sourced layers could.
//
// -explode matters here for the same reason it does for the admin-1 regions below: keep-shapes
// only protects whole FEATURES from disappearing during simplification, not individual rings
// within one feature's MultiPolygon. Greece is a single feature with 74 disjoint landmasses
// (mainland + islands) in the raw data; without exploding each into its own feature first, a
// plain "-simplify keep-shapes" collapsed that down to 3, keep-shapes having done its job only
// for the handful of pieces mapshaper considered significant enough to bother protecting.
//   npx mapshaper -i ne_10m_admin_0_countries.geojson -explode -simplify 2% keep-shapes \
//     -filter-fields ADMIN -rename-fields name=ADMIN \
//     -o format=topojson quantization=1e5 countries-coarse.json
//   npx mapshaper -i ne_10m_admin_0_countries.geojson -explode -simplify 15% keep-shapes \
//     -filter-fields ADMIN -rename-fields name=ADMIN \
//     -o format=topojson quantization=1e5 countries-detail.json
//
// mesh()'s adjacency filter normally compares geometry objects by reference — fine when every
// feature is one country, but after exploding, a country's own separate island pieces are
// distinct objects too, and a naive `(a, b) => a !== b` would draw a spurious border line
// wherever two pieces of the *same* country happen to touch. Comparing by name instead treats
// same-country pieces as the same and different countries as different, which is what actually
// determines a border.
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

// Split the detail tiers' single merged geometries into individually-cullable pieces, each paired
// with its own bbox — see bboxOf above and cullByBbox in webview-src/globe-entry.js. Only the
// detail tiers need this: the coarse tiers stay always-on but are only ever drawn below
// REGION_BORDER_FADE_END (zoom 2.2, see renderInner), where the whole front hemisphere still fits
// on screen and there's nothing to cull anyway. landDetailGeoJson.geometry is one MultiPolygon
// (merge() unions every country into a single shape) — each polygon in it becomes its own piece.
// borderDetailGeoJson is a single MultiLineString from mesh() — each arc becomes its own piece.
function polygonPiecesOf(geometry) {
  if (!geometry) return { pieces: [], bboxes: [] };
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  return { pieces: polygons, bboxes: polygons.map(bboxOf) };
}
const { pieces: landDetailPieces, bboxes: landDetailBboxes } = polygonPiecesOf(landDetailGeoJson.geometry);
const borderDetailArcs = borderDetailGeoJson.coordinates;
const borderDetailBboxes = borderDetailArcs.map(bboxOf);

// State/province-level boundaries for every country, not just the US. world-atlas/us-atlas only
// bundle country-level and US-only data respectively; no npm package wraps Natural Earth's global
// admin-1 set, so this is our own locally-committed conversion. Source: Natural Earth's
// ne_10m_admin_1_states_provinces (the only admin-1 resolution with full global coverage — 110m/
// 50m only cover the US and a handful of other countries), fetched from
// https://github.com/nvkelso/natural-earth-vector. This layer is zoom-gated (never drawn at
// rest, so idle auto-rotation never pays for it), but it's still a real per-frame cost while
// actually zoomed in and interacting — 8,535 exploded features add up. Simplified 10% (previously
// 1%, which read as blocky/inaccurate at any real zoom, and briefly 25%, which fixed that but was
// heavy enough combined with the other detail tiers below to make the whole globe sluggish once
// zoomed in) with -explode and keep-shapes for the same reason as the countries layer (protects
// disjoint island provinces from collapsing):
//   npx mapshaper -i ne_10m_admin_1_states_provinces.geojson -explode -simplify 10% keep-shapes \
//     -filter-fields name,admin -o format=topojson quantization=1e5 admin1-provinces.json
const regionsTopology = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/data/admin1-provinces.json'), 'utf8')
);
const regionsObject = regionsTopology.objects.ne_10m_admin_1_states_provinces;
const regionBorderGeoJson = mesh(
  regionsTopology,
  regionsObject,
  (a, b) => a.properties.name + '|' + a.properties.admin !== b.properties.name + '|' + b.properties.admin
);
// Same per-arc bbox split as the country border mesh above — this is the layer the "8,535
// exploded features add up" comment is about, so it's the one that benefits most from being able
// to skip most of its arcs once zoomed in on one small area.
const regionBorderArcs = regionBorderGeoJson.coordinates;
const regionBorderBboxes = regionBorderArcs.map(bboxOf);

// Curved region name labels (states/provinces) — one per named region, not per exploded piece:
// grouping by name+admin and picking the largest piece's centroid means an archipelago province's
// tiny outlying-island fragments don't each try to claim their own label. Reveal zoom is derived
// from each region's area the same way city reveal zoom is derived from population (see
// minZoomForPopulation below) — bigger regions (Texas, Western Australia) are legible, and worth
// showing, at a shallower zoom than a small one squeezed between neighbors.
// geoArea/geoCentroid are just as winding-sensitive as the polygon clipping that caused the
// lakes bug — a wrongly-wound ring makes them compute the area (and centroid!) of the
// complement instead. mesh() doesn't care about winding so this was never fixed for these
// pieces; it has to be, here, since a few tiny islands were otherwise coming out with the
// biggest-region priority in the map (their area computed as most of the sphere) and their
// centroid pointing at the wrong side of the globe entirely.
const regionFeatures = feature(regionsTopology, regionsObject).features.filter((f) => f.geometry);
regionFeatures.forEach((f) => rewindGeometry(f.geometry));
const largestPiecePerRegion = new Map();
for (const f of regionFeatures) {
  const key = f.properties.name + '|' + f.properties.admin;
  const area = Math.abs(geoArea(f)); // steradians
  const existing = largestPiecePerRegion.get(key);
  if (!existing || area > existing.area) {
    largestPiecePerRegion.set(key, { name: f.properties.name, area, centroid: geoCentroid(f), feature: f });
  }
}

// So the label curves along the region's own shape (a Middle-earth-map-style fit — "ROHAN" tracks
// the valley it names, not an arbitrary line of latitude) rather than always running due
// east-west: the region's principal axis, via PCA on its boundary ring in a local flattened frame
// centered at the centroid (a small-region-scale approximation — good enough to orient a label,
// not meant to be geodesically precise). majorSpanDeg (the boundary's actual extent projected
// onto that axis, not the covariance-derived size, which is a rougher estimate) caps how far the
// renderer's curve-fit is allowed to sample, so a small region doesn't stretch its label out past
// its own borders into its neighbors just because the estimated pixel width said there was room.
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
  const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY); // radians, CCW from local east
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const [x, y] of pts) {
    const proj = x * dirX + y * dirY;
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
  }
  // Bearing (clockwise from north, matching the great-circle destination-point formula the
  // renderer samples along) rather than the standard CCW-from-east angle PCA naturally gives;
  // normalized to [0, 180) since an axis is the same line at 0° and 180°.
  let bearingDeg = 90 - (angle * 180) / Math.PI;
  bearingDeg = ((bearingDeg % 180) + 180) % 180;
  return { bearingDeg, majorSpanDeg: maxProj - minProj };
}
// Calibrated against the actual computed spread of areas (steradians) across every named region:
// the largest (e.g. Sakha Republic, Western Australia) lands close to REGION_LABEL_LOG_AREA_MAX,
// the smallest well below it, so the reveal zoom range spans roughly base..base+3 across the full
// dataset — similar spread to the city population curve.
const REGION_LABEL_BASE_MIN_ZOOM = 1.6;
const REGION_LABEL_LOG_AREA_MAX = Math.log10(0.25);
const REGION_LABEL_ZOOM_PER_LOG_AREA = 0.55;
function minZoomForArea(area) {
  const logArea = Math.log10(Math.max(area, 1e-8));
  return (
    Math.round(
      (REGION_LABEL_BASE_MIN_ZOOM + Math.max(0, REGION_LABEL_LOG_AREA_MAX - logArea) * REGION_LABEL_ZOOM_PER_LOG_AREA) *
        100
    ) / 100
  );
}
const regionLabels = Array.from(largestPiecePerRegion.values())
  // A handful of tiny unclaimed territories have no name at all.
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

// Mountain icons — a Middle-earth-map-style flourish: illustrated peaks stamped at named mountain
// locations instead of leaving terrain to plain flat color. Source: Natural Earth's
// ne_10m_geography_regions_elevation_points, filtered to featurecla === 'mountain' (633 named
// peaks worldwide, Everest down to regionally-notable ones), fetched from
// https://github.com/nvkelso/natural-earth-vector. No mapshaper step — these are standalone
// points with no geometry to simplify, just [name, lon, lat, min_zoom] pulled straight from the
// source and written to scripts/data/mountains.json.
//
// Natural Earth ships its own scalerank/min_zoom for this layer (their own curated "how important
// is this peak" ranking) — rescaled here from their [4, 8] range to ours, so Everest shows up
// early like a landmark while more obscure peaks need real zoom, the same reveal idea already
// used for cities/regions. Already computed into scripts/data/mountains.json, so this is just a
// straight read, no rescaling logic needed here.
const mountains = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data/mountains.json'), 'utf8'));

// Rivers (and lake centerlines — segments that continue a river's path through a lake it flows
// into, rather than leaving a visible gap where the river meets the lake). Natural Earth's global
// ne_10m_rivers_lake_centerlines (1,455 features) on its own was missing a lot of real rivers —
// that layer is deliberately sparse at the global scale, with the actual detail split out into
// separate continent supplements. Only three exist (Europe, North America, Australia — no
// supplement for South America, Asia, or Africa, a real gap in the source data itself, not
// something fixable here), but combining all four gets meaningfully closer to complete than the
// global layer alone: 7,997 features after merging, up from 1,455. Fetched from
// https://github.com/nvkelso/natural-earth-vector:
//   ne_10m_rivers_lake_centerlines.geojson, ne_10m_rivers_europe.geojson,
//   ne_10m_rivers_north_america.geojson, ne_10m_rivers_australia.geojson
//
// Each source's own min_zoom (Natural Earth's curated "how important is this river" reveal
// zoom, same idea as the mountains layer) is rescaled from their combined [2, 7.5] range to ours
// ([2, 5]) in a one-off merge script before mapshaper ever sees the data — simplest to do once,
// up front, rather than repeating scalerank-to-zoom logic in the renderer per feature per frame.
// Nothing in this layer is always-on: even the biggest rivers need real zoom before they show.
//   npx mapshaper -i rivers-merged.geojson -simplify 15% keep-shapes \
//     -filter-fields name,min_zoom -o format=topojson quantization=1e5 rivers.json
//
// Lines, unlike the polygon layers elsewhere in this file, don't have an "inside" for d3-geo's
// clipping to get backwards — no winding fix needed here.
const riversTopology = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data/rivers.json'), 'utf8'));
const riversGeoJson = feature(riversTopology, riversTopology.objects['rivers-merged']);
// A bbox per river, same reasoning as the border/land pieces above — cullByBbox in
// webview-src/globe-entry.js uses this alongside the existing per-feature min_zoom check so a
// river that has crossed its reveal threshold but sits nowhere near the current view still skips
// tracing, not just the (much rarer) ones that haven't reached their threshold at all.
riversGeoJson.features = riversGeoJson.features.filter((f) => f.geometry);
riversGeoJson.features.forEach((f) => {
  f.properties.bbox = bboxOf(f.geometry.coordinates);
});

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

// A coarse lon/lat grid over `cities`, so the renderer can look up "what's near this point on the
// globe" without scanning all 170k+ entries — see webview-src/city-labels/spatialIndex.js for the
// runtime query side. Built here, once, rather than at runtime on WebView load: bucketing by index
// (not by copying each city's data into every cell) keeps the injected payload small, and a city's
// position in `cities` is already stable — the array is written straight through in source order
// and never reordered — so "index into `cities`" doubles as a perfectly good stable id for the
// label state machine (selection.js/stateMachine.js) without needing a separate id field.
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
//   npx mapshaper -i ne_10m_lakes.geojson -simplify 15% keep-shapes -filter-fields name \
//     -o format=topojson quantization=1e5 lakes-detail.json
//
// See ringSignedArea/rewindGeometry above (defined once, next to the land/country loading that
// needs the same fix) for why every filled polygon here gets rewound before injection.
function loadLakes(fileName, objectKey) {
  const topology = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data', fileName), 'utf8'));
  const geoJson = feature(topology, topology.objects[objectKey]);
  geoJson.features = geoJson.features.filter((f) => f.geometry);
  geoJson.features.forEach((f) => rewindGeometry(f.geometry));
  return geoJson;
}

const lakesMajorGeoJson = loadLakes('lakes-major.json', 'ne_50m_lakes');
// Deliberately NOT excluding lakes already present in the major tier by name: the two tiers
// aren't the same shape at different resolutions of the same authoritative extent — the 50m
// source for e.g. Lake Champlain caps out at 44.94°N, south of the US/Canada border, while the
// 10m source correctly continues to 45.08°N into Quebec. An earlier version deduped by name to
// save a little render time, which silently threw away the detail tier's more accurate shape for
// every lake that happened to also appear (usually less accurately) in the coarse tier — worse
// trade than the extra draw cost, which only applies once actually zoomed in anyway.
const lakesDetailGeoJson = loadLakes('lakes-detail.json', 'ne_10m_lakes');
// Bbox per lake, same reasoning as the other detail tiers — see bboxOf above.
lakesDetailGeoJson.features.forEach((f) => {
  f.properties.bbox = bboxOf(f.geometry.coordinates);
});

const theme = {
  oceanLight: '#FFFFFF',
  oceanDeep: '#FFFFFF',
  land: '#F4FAF2',
  landStroke: '#DCEEDA',
  countryBorder: '#cde2d0',
  regionBorder: '#c9decc',
  globeOutline: '#EAF3FA',
  pin: '#28312C',
  cityDot: '#8FA396',
  cityLabel: '#5B655F',
  regionLabel: '#7A6A4F',
  mountainFill: '#EDE6D6',
  mountainStroke: '#5B4A38',
  river: '#FFFFFF',
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
window.LAND_DETAIL_PIECES = ${JSON.stringify(landDetailPieces)};
window.LAND_DETAIL_BBOXES = ${JSON.stringify(landDetailBboxes)};
window.BORDER_DETAIL_ARCS = ${JSON.stringify(borderDetailArcs)};
window.BORDER_DETAIL_BBOXES = ${JSON.stringify(borderDetailBboxes)};
window.REGION_BORDER_ARCS = ${JSON.stringify(regionBorderArcs)};
window.REGION_BORDER_BBOXES = ${JSON.stringify(regionBorderBboxes)};
window.REGION_LABELS = ${JSON.stringify(regionLabels)};
window.LAKES_MAJOR_GEOJSON = ${JSON.stringify(lakesMajorGeoJson)};
window.LAKES_DETAIL_GEOJSON = ${JSON.stringify(lakesDetailGeoJson)};
window.MOUNTAINS = ${JSON.stringify(mountains)};
window.RIVERS_GEOJSON = ${JSON.stringify(riversGeoJson)};
window.CITIES = ${JSON.stringify(cities)};
window.CITY_CELLS = ${JSON.stringify(cityCellsObj)};
window.CITY_CELL_SIZE_DEG = ${JSON.stringify(CITY_CELL_SIZE_DEG)};
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
