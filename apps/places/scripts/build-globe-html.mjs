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

// Land and country borders, three zoom-gated tiers (110m/50m/10m) instead of a single fixed
// resolution — see webview-src/globe-entry.js's countryTierForZoom for the zoom breakpoints.
// Natural Earth's ne_{110m,50m,10m}_admin_0_countries.geojson (fetched from
// https://github.com/nvkelso/natural-earth-vector, the same upstream repo already used for the
// admin-1 data below) is both the land shape (via topojson-client's merge, unioning every country
// into one fillable shape) and the country border lines (via mesh) at each scale, from a single
// source per tier — so the coastline and the border along it can't disagree the way two
// independently-sourced layers could. 110m isn't run through mapshaper's -simplify: it's Natural
// Earth's own named-scale, already-generalized file, so an additional arbitrary simplification
// percentage isn't needed on top, and its piece count is small enough (~120) that there's nothing
// to gain simplifying it further.
//
//   npx mapshaper -i ne_110m_admin_0_countries.geojson -explode \
//     -filter-fields ADMIN -rename-fields name=ADMIN \
//     -o format=topojson quantization=1e5 countries-110m.json
//
// 50m and 10m both get an extra -simplify pass on top, for the same underlying reason: each is
// the tier actually drawn at the low end of its own zoom range, where bbox culling is doing
// little or no filtering (50m from MIN_ZOOM — see COUNTRY_TIER_50M_MIN_ZOOM in globe-entry.js —
// 10m from COUNTRY_TIER_10M_MIN_ZOOM), so its full, un-thinned point density gets traced every
// frame. Measured directly: even after culling, 10m's per-frame point count at zoom 12 was ~13x
// 50m's (101 points/piece raw average vs 50m's already-halved 23) — the dominant cause of a real,
// user-reported slowdown right at the 10m handoff. -simplify thins redundant points along each
// piece's existing coastline (a gentler reduction than dropping whole small islands/features,
// which reads as visibly "too simple" — tried and rejected for exactly that reason) without
// changing which land is present. 10m's percentage (35%) is more conservative than 50m's (50%)
// since it's used at a deeper zoom, where individual points cover more of the screen and are more
// noticeable if thinned too aggressively; keep-shapes on both protects small pieces (islands,
// etc.) from disappearing entirely the way plain -simplify can.
//   npx mapshaper -i ne_50m_admin_0_countries.geojson -explode -simplify 50% keep-shapes \
//     -filter-fields ADMIN -rename-fields name=ADMIN \
//     -o format=topojson quantization=1e5 countries-50m.json
//   npx mapshaper -i ne_10m_admin_0_countries.geojson -explode -simplify 35% keep-shapes \
//     -filter-fields ADMIN -rename-fields name=ADMIN \
//     -o format=topojson quantization=1e5 countries-10m.json
//
// -explode matters for all three tiers for the same reason: mesh()'s adjacency filter (below)
// needs every disjoint landmass in its own feature to tell "two pieces of the same country
// touching" apart from "two different countries sharing a border" — Greece's 74 mainland+island
// pieces would otherwise all be one feature.
//
// mesh()'s adjacency filter normally compares geometry objects by reference — fine when every
// feature is one country, but after exploding, a country's own separate island pieces are
// distinct objects too, and a naive `(a, b) => a !== b` would draw a spurious border line
// wherever two pieces of the *same* country happen to touch. Comparing by name instead treats
// same-country pieces as the same and different countries as different, which is what actually
// determines a border.
function polygonPiecesOf(geometry) {
  if (!geometry) return { pieces: [], bboxes: [] };
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  return { pieces: polygons, bboxes: polygons.map(bboxOf) };
}

// Only the 110m tier (zoom 1-4, where the whole front hemisphere is on screen at once) gets
// tiny-feature dropping — at that zoom, every disjoint landmass down to the smallest uninhabited
// rock reads as a fleck of dirt scattered across the ocean rather than actual geography. The
// 50m/10m tiers only ever draw once zoomed in past that, where the same size feature is a
// legitimate, recognizable place, so they're left unfiltered. Same 0.75°-longest-bbox-dimension
// cutoff as the old TINY_ISLAND_MAX_DEG, calibrated the same way: the median piece is ~0.11°, and
// 0.75° sits well clear of every genuinely tiny atoll/reef while keeping every recognizable island
// nation and archipelago (Fiji's main islands at 1.4°, the Bahamas' chain at 0.8°, Jamaica at
// 1.8°) on screen. Real small countries (Singapore, Bahrain, Malta, Barbados) fall under this too
// — an inherent tradeoff of a pure size cutoff, not a curated exceptions list.
const TINY_ISLAND_MAX_DEG = 0.75;
function isTinyBbox(bbox) {
  return bbox !== null && Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) < TINY_ISLAND_MAX_DEG;
}

function loadCountryTier(scale) {
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

const countryTiers = {
  '110m': loadCountryTier('110m'),
  '50m': loadCountryTier('50m'),
  '10m': loadCountryTier('10m'),
};

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
// US-only for now — every other country's state/province borders are in the source data (global
// coverage) but held back entirely rather than drawn, same "only show what's deliberately been
// designed for" reasoning as everything else built out one country at a time in this app so far.
const isUSState = (f) => f.properties.admin === 'United States of America';
const regionBorderGeoJson = mesh(
  regionsTopology,
  regionsObject,
  (a, b) =>
    isUSState(a) && isUSState(b) && a.properties.name + '|' + a.properties.admin !== b.properties.name + '|' + b.properties.admin
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

// US state postal abbreviations, shown centered in each state once state borders are visible (see
// STATE_BORDER_MIN_ZOOM in globe-entry.js) — the plain "two letters, dead center" style Apple Maps
// uses, not the curved full-name labels above (which stay off, see SHOW_REGION_LABELS). Every
// state shows together at the same threshold rather than a per-state reveal zoom like the curved
// labels use, matching how Apple Maps reveals them.
//
// Not derived from the source data — the admin1 layer was filtered down to just name/admin at
// mapshaper time (see the admin1-provinces.json comment above), so there's no postal-code field to
// read; a plain lookup table for the 50 states + DC is simpler than regenerating that data file
// just to carry one more property.
const US_STATE_ABBREVIATIONS = {
  Alabama: 'AL',
  Alaska: 'AK',
  Arizona: 'AZ',
  Arkansas: 'AR',
  California: 'CA',
  Colorado: 'CO',
  Connecticut: 'CT',
  Delaware: 'DE',
  'District of Columbia': 'DC',
  Florida: 'FL',
  Georgia: 'GA',
  Hawaii: 'HI',
  Idaho: 'ID',
  Illinois: 'IL',
  Indiana: 'IN',
  Iowa: 'IA',
  Kansas: 'KS',
  Kentucky: 'KY',
  Louisiana: 'LA',
  Maine: 'ME',
  Maryland: 'MD',
  Massachusetts: 'MA',
  Michigan: 'MI',
  Minnesota: 'MN',
  Mississippi: 'MS',
  Missouri: 'MO',
  Montana: 'MT',
  Nebraska: 'NE',
  Nevada: 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  Ohio: 'OH',
  Oklahoma: 'OK',
  Oregon: 'OR',
  Pennsylvania: 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  Tennessee: 'TN',
  Texas: 'TX',
  Utah: 'UT',
  Vermont: 'VT',
  Virginia: 'VA',
  Washington: 'WA',
  'West Virginia': 'WV',
  Wisconsin: 'WI',
  Wyoming: 'WY',
};
const usStateLabels = Array.from(largestPiecePerRegion.values())
  // DC isn't a state, and its centroid label reads as clutter squeezed in among Maryland/Virginia
  // rather than useful information at any zoom this map reaches.
  .filter(({ feature: f, name }) => f.properties.admin === 'United States of America' && name !== 'District of Columbia')
  .map(({ name, centroid }) => [
    US_STATE_ABBREVIATIONS[name] || name,
    Math.round(centroid[0] * 1e5) / 1e5,
    Math.round(centroid[1] * 1e5) / 1e5,
  ]);

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
const CITY_BASE_MIN_ZOOM = 3; // cities start at the same zoom as state/province borders
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

// Embeds `data` as `JSON.parse("...")` rather than a raw JS array/object literal. For data this
// large (CITIES alone is 170k+ entries), parsing it as JS source means the engine has to build a
// full AST for one enormous expression before any app code can run — JSON.parse uses a much
// simpler, purpose-built parser that's dramatically faster for the same bytes (V8's own writeup
// on this: https://v8.dev/blog/cost-of-javascript-2019#parsing). JSON.stringify of the JSON text
// itself produces a correctly-escaped JS string literal for free (backslashes, quotes, control
// chars); the only extra guard needed is against a literal "</script" substring inside any string
// value (a place/region name, in principle), which would otherwise prematurely close the
// surrounding <script> tag once this is spliced into the HTML template.
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
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #FFFFFF; overscroll-behavior: none; }
  #globe { display: block; width: 100%; height: 100%; touch-action: none; }
</style>
</head>
<body>
<canvas id="globe"></canvas>
<script>
window.COUNTRY_TIERS = ${embedAsJson(countryTiers)};
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

const output = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/build-globe-html.mjs
export const GLOBE_HTML = ${JSON.stringify(html)};
`;

const outPath = path.join(root, 'src/webview/globeHtml.ts');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, output);
console.log(`Wrote ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
