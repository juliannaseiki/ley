// One-time (re-run on globe changes) build step: bundles the webview globe
// renderer and inlines it, along with simplified world landmass data, into a
// single self-contained HTML string committed as src/webview/globeHtml.ts.
// Keeping this as a generated file (rather than loading assets at runtime)
// sidesteps WebView local-asset path quirks on Android/iOS entirely.
import { build } from 'esbuild';
import { feature, mesh, merge } from 'topojson-client';
import { geoArea, geoCentroid } from 'd3-geo';
import polygonClipping from 'polygon-clipping';
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
// resolution — see webview-src/globe-entry.js's tierScaleForZoom for the zoom breakpoints.
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

// merge() dissolves every touching country into one shape, and a handful of the resulting pieces
// are enormous — the merged Afro-Eurasian landmass alone is ~29,000 vertices, the merged Americas
// ~22,000 (measured directly against the actual 10m tier output). cullByBbox in
// webview-src/globe-entry.js can never drop any of that: its bbox always overlaps the visible area
// for anyone zoomed in anywhere on the actual continent it belongs to, which is most of the
// populated world — the single biggest lever on deep-zoom performance found for this app (a real
// user-reported slowdown once zoomed in). This splits any piece over LAND_TILE_VERTEX_THRESHOLD
// into a grid of LAND_TILE_SIZE_DEG-wide tiles (via polygon-clipping's exact intersection) so the
// renderer can finally drop the off-screen bulk of one of these once zoomed in on a small part of
// it, the same way every other, smaller piece already could.
//
// A tile's fill can just reuse the ordinary closed-Polygon rendering (landPath in globe-entry.js)
// completely unchanged — cutting a solid-filled shape into abutting tiles is invisible once filled,
// since there's no gap or overlap at a shared tile edge. Its OUTLINE can't reuse that same geometry
// for stroke, though: stroking every tile's own boundary would draw the synthetic cut lines running
// through the middle of a continent as if they were real coastline. So each tile also gets its
// real-coastline-only edges split out separately (see realEdgeArcsOf below) — an edge whose
// endpoints both sit exactly on the tile's own clip boundary is synthetic and dropped; only edges
// that survive from the original ring are kept, as open LineString runs the renderer strokes
// (bbox-culled the same way as everything else) instead of closing them into the tile shape itself.
const LAND_TILE_VERTEX_THRESHOLD = 1000;
const LAND_TILE_SIZE_DEG = 20;
// Real coastline points are arbitrary real-world decimals; the grid lines below are round numbers
// chosen here — the two essentially never coincide by accident, so "is this vertex within a hair of
// one of the tile's 4 boundary lines" reliably tells a clip-introduced point apart from a genuine
// one, without needing polygon-clipping to report provenance itself.
const TILE_BOUNDARY_EPSILON_DEG = 1e-7;

// A ring's stored longitudes jump by ~360 at the antimeridian if the landmass crosses it (Russia's
// Chukotka peninsula, the Aleutians, Antarctica's every-longitude sweep near the pole) — meaningless
// for grid tiling in raw form, since a "20°-wide tile" isn't well-defined across a discontinuity.
// Every consumer of this data downstream (d3-geo's projection, and this file's own/
// globe-entry.js's angularDistanceDeg-based helpers) works entirely through cos/sin of longitude,
// which are already 360°-periodic — so a ring can just be walked once, nudging each point by
// whatever multiple of 360 keeps it within 180° of the previous point, and the result is safe to
// tile/clip/ship as-is, with no need to ever wrap it back into the conventional -180..180 range
// afterward (that periodicity is exactly why cullByBbox's law-of-cosines distance still comes out
// correct for an out-of-range longitude like 190° — cos(190 - x) is identical to cos(-170 - x)).
function unwrapRing(ring) {
  const out = [ring[0].slice()];
  for (let i = 1; i < ring.length; i++) {
    let [lon, lat] = ring[i];
    const prevLon = out[i - 1][0];
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    out.push([lon, lat]);
  }
  return out;
}

function ringsBounds(rings) {
  const b = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < b.minLon) b.minLon = lon;
      if (lon > b.maxLon) b.maxLon = lon;
      if (lat < b.minLat) b.minLat = lat;
      if (lat > b.maxLat) b.maxLat = lat;
    }
  }
  return b;
}

function isOnTileBoundary(lon, lat, tx0, ty0, tx1, ty1) {
  return (
    Math.abs(lon - tx0) < TILE_BOUNDARY_EPSILON_DEG ||
    Math.abs(lon - tx1) < TILE_BOUNDARY_EPSILON_DEG ||
    Math.abs(lat - ty0) < TILE_BOUNDARY_EPSILON_DEG ||
    Math.abs(lat - ty1) < TILE_BOUNDARY_EPSILON_DEG
  );
}

// Walks every ring of one clipped tile (its outer boundary and any holes alike — a hole's shore is
// real coastline too, e.g. the Caspian Sea) and breaks each into the open LineString runs that
// survive as real coastline, dropping any edge that's synthetic (introduced by clipping against
// this tile's own boundary) per isOnTileBoundary above. Ring coordinate arrays are self-closing
// (first point repeats as the last), so a plain consecutive walk already covers the full loop with
// no separate wrap-around case to handle.
function realEdgeArcsOf(rings, tx0, ty0, tx1, ty1) {
  const arcs = [];
  for (const ring of rings) {
    let current = [ring[0]];
    for (let i = 1; i < ring.length; i++) {
      const prev = ring[i - 1];
      const point = ring[i];
      const edgeIsSynthetic =
        isOnTileBoundary(prev[0], prev[1], tx0, ty0, tx1, ty1) &&
        isOnTileBoundary(point[0], point[1], tx0, ty0, tx1, ty1);
      if (edgeIsSynthetic) {
        if (current.length > 1) arcs.push(current);
        current = [point];
      } else {
        current.push(point);
      }
    }
    if (current.length > 1) arcs.push(current);
  }
  return arcs;
}

function subdividePiece(piece) {
  const unwrapped = piece.map(unwrapRing);
  const bounds = ringsBounds(unwrapped);

  const tileFillPieces = [];
  const tileFillBboxes = [];
  const outlineArcs = [];
  const outlineBboxes = [];

  const startCol = Math.floor(bounds.minLon / LAND_TILE_SIZE_DEG);
  const endCol = Math.ceil(bounds.maxLon / LAND_TILE_SIZE_DEG);
  const startRow = Math.floor(bounds.minLat / LAND_TILE_SIZE_DEG);
  const endRow = Math.ceil(bounds.maxLat / LAND_TILE_SIZE_DEG);

  for (let col = startCol; col < endCol; col++) {
    const tx0 = col * LAND_TILE_SIZE_DEG;
    const tx1 = tx0 + LAND_TILE_SIZE_DEG;
    for (let row = startRow; row < endRow; row++) {
      const ty0 = row * LAND_TILE_SIZE_DEG;
      const ty1 = ty0 + LAND_TILE_SIZE_DEG;
      const clipBox = [
        [
          [tx0, ty0],
          [tx1, ty0],
          [tx1, ty1],
          [tx0, ty1],
          [tx0, ty0],
        ],
      ];
      const clipped = polygonClipping.intersection(unwrapped, clipBox);
      for (const polygon of clipped) {
        // polygon-clipping winds rings by its own (planar, CCW-exterior) convention, not
        // necessarily d3-geo's spherical one (enclosed area under half the sphere — see the
        // rewindGeometry comment at the top of this file) — every tile is small enough here
        // (well under half the sphere) that the same per-ring area check applies cleanly.
        // Skipping this produced tiles whose winding disagreed with d3-geo's convention, which
        // clips them to their *complement* at render time — caught by summing geoArea across
        // every tile and finding it wildly exceeded the sphere's own total surface area.
        rewindPolygonCoords(polygon);
        tileFillPieces.push(polygon);
        tileFillBboxes.push([tx0, ty0, tx1, ty1]);
        for (const arc of realEdgeArcsOf(polygon, tx0, ty0, tx1, ty1)) {
          outlineArcs.push(arc);
          outlineBboxes.push(bboxOf(arc));
        }
      }
    }
  }

  return { tileFillPieces, tileFillBboxes, outlineArcs, outlineBboxes };
}

// Call site: replaces any piece over the threshold with its tile decomposition; every other piece
// (the vast majority — small and medium countries/islands, already cullable as a whole) passes
// through untouched.
function subdivideOversizedLandPieces(pieces, bboxes) {
  const keptPieces = [];
  const keptBboxes = [];
  const tileFillPieces = [];
  const tileFillBboxes = [];
  const outlineArcs = [];
  const outlineBboxes = [];

  pieces.forEach((piece, i) => {
    const vertexCount = piece.reduce((sum, ring) => sum + ring.length, 0);
    if (vertexCount <= LAND_TILE_VERTEX_THRESHOLD) {
      keptPieces.push(piece);
      keptBboxes.push(bboxes[i]);
      return;
    }
    const subdivided = subdividePiece(piece);
    tileFillPieces.push(...subdivided.tileFillPieces);
    tileFillBboxes.push(...subdivided.tileFillBboxes);
    outlineArcs.push(...subdivided.outlineArcs);
    outlineBboxes.push(...subdivided.outlineBboxes);
  });

  return { keptPieces, keptBboxes, tileFillPieces, tileFillBboxes, outlineArcs, outlineBboxes };
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

  let landPieces = landPiecesAll;
  let landBboxes = landBboxesAll;
  let borderArcs = borderArcsAll;
  let borderBboxes = borderBboxesAll;

  if (scale === '110m') {
    landPieces = [];
    landBboxes = [];
    landPiecesAll.forEach((piece, i) => {
      if (!isTinyBbox(landBboxesAll[i])) {
        landPieces.push(piece);
        landBboxes.push(landBboxesAll[i]);
      }
    });
    // Border arcs belonging entirely to a dropped tiny piece would draw a border line with no land
    // beneath it, so they're dropped by the same size test rather than by cross-referencing which
    // country each arc came from.
    borderArcs = [];
    borderBboxes = [];
    borderArcsAll.forEach((arc, i) => {
      if (!isTinyBbox(borderBboxesAll[i])) {
        borderArcs.push(arc);
        borderBboxes.push(borderBboxesAll[i]);
      }
    });
  }

  // See subdivideOversizedLandPieces above — the merged landmass's few enormous pieces (whole
  // dissolved continents) get replaced here by a tile decomposition; everything else passes
  // through unchanged.
  const { keptPieces, keptBboxes, tileFillPieces, tileFillBboxes, outlineArcs, outlineBboxes } =
    subdivideOversizedLandPieces(landPieces, landBboxes);

  return {
    landPieces: keptPieces,
    landBboxes: keptBboxes,
    landTileFillPieces: tileFillPieces,
    landTileFillBboxes: tileFillBboxes,
    landOutlineArcs: outlineArcs,
    landOutlineBboxes: outlineBboxes,
    borderArcs,
    borderBboxes,
  };
}

const countryTiers = {
  '110m': loadCountryTier('110m'),
  '50m': loadCountryTier('50m'),
  '10m': loadCountryTier('10m'),
};

// Lakes — filled the same as the ocean (see THEME below and the fill in globe-entry.js) so they
// read as water rather than a land-colored gap; Natural Earth's land/coastline layer above doesn't
// carve them out as holes. Only the 10m tier is loaded: lakes are drawn exclusively past
// LAKE_MIN_ZOOM in globe-entry.js — even the largest lakes read as noise at 110m/50m's zoom-out, so
// there's no reason to ship the 110m/50m lake data (both tried, both rejected by eye) in the bundle
// at all.
//
//   npx mapshaper -i ne_10m_lakes.geojson -simplify 15% keep-shapes -filter-fields name \
//     -o format=topojson quantization=1e5 lakes-10m.json
//
// 15%, not the 35% used for the 10m country tier: measured directly (simulating the same bbox-cull
// a real frame does, centered on lake-dense regions like the Canadian Shield/Finland), 35% still
// left 7,600-10,200 points surviving culling in those regions at a typical LAKE_MIN_ZOOM frame —
// real per-frame cost on top of the already-heavy 10m country/border tier, and the actual cause of
// a user-reported slowdown once lakes reached the screen. 15% cuts that to roughly 2,200-3,200 in
// the same regions (and the total dataset from 58,254 to 27,048 points) while keep-shapes protects
// every lake from disappearing outright — this is a real quality-vs-speed tradeoff, not a free win,
// so if lake outlines read as visibly too coarse up close, that's the dial to reconsider, the same
// as it was for the country tiers' own simplify percentages.
//
// keep-shapes matters more here than it does for land/borders: lakes are small relative to the
// whole dataset, and a plain simplify at this percentage collapses most of them to null geometry
// entirely — dropped, not just less detailed — rather than just thinning their outlines.
// merge() dissolves the tier's 1,355 individual lake polygons into one mergeable shape the same way
// land does; lakes never touch each other, so the result is equivalent to -explode's per-lake
// pieces without needing a separate explode step — reusing polygonPiecesOf and rewindGeometry
// instead of a parallel lake-specific code path.
function loadLakes() {
  const topology = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data/lakes-10m.json'), 'utf8'));
  const object = topology.objects.ne_10m_lakes;
  const geom = merge(topology, object.geometries);
  rewindGeometry(geom);
  return polygonPiecesOf(geom);
}

const lakes = loadLakes();

// Rivers — drawn as open lines (not filled, unlike land/lakes above). Two reveal tiers, both
// sourced from the same combined file and split by Natural Earth's own scalerank field rather
// than separately per source file: "major" (scalerank <= RIVER_DETAIL_SCALERANK_CUTOFF) past
// RIVER_MIN_ZOOM in globe-entry.js, "detail" (the smaller streams above that cutoff) past the
// deeper RIVER_DETAIL_MIN_ZOOM — at any shallower zoom either set reads as visual noise crossing
// the coastlines and borders that are the point at that scale, the same reasoning lakes' own
// LAKE_MIN_ZOOM uses. Only the 10m tier is loaded for the same reason lakes only load one tier —
// there's nothing to gain shipping a coarser version of a layer that's already zoom-gated this deep.
//
// Source is four Natural Earth files combined, not one — first tried just the global
// ne_10m_rivers_lake_centerlines_scale_rank file, but even at ~4,200 features that one is still a
// *generalized* compilation: checked directly against a real saved place (Burlington, VT), and it
// carries only 4 rivers anywhere near it (none of them the Winooski the place's own address is
// named after), while Natural Earth's separate supplementary "plus" files — regional data with
// finer local source hydrography, published only for North America/Europe/Australia — carry 16 in
// that same small area, the Winooski included. Confirmed these supplementary files are additive,
// not overlapping duplicates of the global one, before combining them: only 4.9% of North
// America's named rivers even share a name with the global file, and where a name does match
// (e.g. "Mississippi" appears in both) the geometries are two entirely different real rivers, not
// the same one twice — and every regional feature's own scalerank lands at 10+ (checked each
// file's distribution directly), meaning they only ever add to the "detail" tier above, never the
// "major" one.
//
//   node -e '
//     const fs = require("fs");
//     const files = [
//       "ne_10m_rivers_lake_centerlines_scale_rank.geojson",
//       "ne_10m_rivers_north_america.geojson",
//       "ne_10m_rivers_europe.geojson",
//       "ne_10m_rivers_australia.geojson",
//     ];
//     const combined = { type: "FeatureCollection", features: [] };
//     for (const file of files) {
//       for (const f of JSON.parse(fs.readFileSync(file, "utf8")).features) {
//         if (!f.geometry) continue;
//         combined.features.push({
//           type: "Feature",
//           properties: { name: f.properties.name || null, featurecla: f.properties.featurecla || null, scalerank: f.properties.scalerank },
//           geometry: f.geometry,
//         });
//       }
//     }
//     fs.writeFileSync("rivers-combined-raw.geojson", JSON.stringify(combined));
//   '
//   npx mapshaper -i rivers-combined-raw.geojson -simplify 35% keep-shapes \
//     -filter-fields name,featurecla,scalerank -rename-layers rivers \
//     -o format=topojson quantization=1e5 rivers-10m.json
//
// 35%, matching the 10m country tier rather than lakes' more conservative 15%: rivers are already
// far cheaper in aggregate than lakes' pre-cull total, and no single river comes close to land's
// giant-merged-piece problem (653 points for the largest in the original global-only file, the
// Niger — see subdivideOversizedLandPieces above for why that specifically mattered there and
// doesn't here), so there was no measured per-frame cost to trade against the way there was for
// lakes.
//
// "rivers_lake_centerlines" (not a plain rivers file) for the global component is deliberate:
// Natural Earth's plain river layer stops a river's line at a lake's edge, which would read as the
// river vanishing where it actually just widens into the lake already drawn as its own polygon —
// this dataset instead carries a synthetic centerline straight through, so a river that flows
// through a lake (the St. Lawrence through the Great Lakes, e.g.) still reads as one continuous
// line on top of it.
//
// No merge()/polygonPiecesOf here: unlike land/lakes, individual rivers were never meant to dissolve
// into one shape (two rivers happening to touch isn't the same "same country" relationship two
// land pieces sharing a border have) — feature() keeps them as the separate named rivers they are,
// which is also what a MultiLineString entry (a river Natural Earth split into multiple segments)
// needs to become multiple independently-cullable arcs rather than one bbox spanning the whole
// river's total extent.
// Raised from 5 after a user report that RIVER_MIN_ZOOM "wasn't working" — no code bug: traced
// the actual cull+draw path and separately ran a real orthographic-projection on-screen check
// against the shipped data, both confirmed major-tier rivers genuinely do render at zoom 20
// wherever one happens to be nearby. The problem was the cutoff being too strict — at 5, only
// ~1,048 arcs qualify as "major" globally, sparse enough that a random zoom-20 view had *no*
// major river on screen 44.5% of the time in a 200-sample check (vs. 24% for the far denser
// detail tier — roughly the fraction of views that are just open ocean/desert with nothing to
// show regardless of tier). At 9, ~4,171 arcs qualify, cutting that empty-view rate to 27.5% —
// close to the same "genuinely nothing here" floor the detail tier already has. Re-run the same
// check (see this constant's own git history for the sampling script) before tuning further.
const RIVER_DETAIL_SCALERANK_CUTOFF = 9;

// Rivers used to render as a flat-width stroked line. Requested instead: a tapered, filled shape —
// full width where a river meets the sea, narrowing to a point at its headwater (see the reference
// image this was built against — a hand-drawn Taiwan map where rivers read as solid wedges, not
// lines). Natural Earth digitizes each river segment in flow direction — checked directly against
// this exact dataset: the Rhine's, Danube's, and Nile's segments all run source-end-first,
// mouth-end-last — so a segment's own point order doubles as the taper direction with no separate
// flow-direction data needed.
//
// A single named river is usually many separate segments chained end-to-end rather than one long
// line (the Nile alone is 17 in this dataset, the Volga 32), so naively tapering each segment from
// its own 0% to 100% would reset the width at every segment boundary — confirmed 50.9% of all
// 11,338 segments in this file connect unambiguously to another one, so that reset would happen at
// roughly every other joint, reading as a visible "pulse" running down a river instead of one smooth
// widening. buildRiverChains below walks chains of unambiguously-sequential segments (this one's end
// point is the next one's start point, and neither point is shared with any third segment — an
// actual confluence, where a real width step is expected anyway, breaks the chain there on purpose)
// so each point's width comes from its position along the WHOLE chain's length, not just its own
// segment's — while the ribbon polygon is still built and culled per original segment, so this only
// changes which width number a point gets, not the per-piece culling granularity every other layer
// in this file relies on.
const RIVER_ENDPOINT_PRECISION = 5; // matches this file's own 1e5 topojson quantization
function riverEndpointKey(point) {
  return point[0].toFixed(RIVER_ENDPOINT_PRECISION) + ',' + point[1].toFixed(RIVER_ENDPOINT_PRECISION);
}
// cos(lat)-scaled equirectangular approximation — plenty accurate for a taper that's read as a
// stylized visual cue, not a real hydrological measurement.
function segmentLengths(line) {
  const lengths = [0];
  for (let i = 1; i < line.length; i++) {
    const [lon0, lat0] = line[i - 1];
    const [lon1, lat1] = line[i];
    const latMid = (lat0 + lat1) / 2;
    const dx = (lon1 - lon0) * Math.cos((latMid * Math.PI) / 180);
    const dy = lat1 - lat0;
    lengths.push(lengths[i - 1] + Math.hypot(dx, dy));
  }
  return lengths;
}
function buildRiverChains(lines) {
  const startMap = new Map();
  const endMap = new Map();
  lines.forEach((line, i) => {
    const startKey = riverEndpointKey(line[0]);
    const endKey = riverEndpointKey(line[line.length - 1]);
    if (!startMap.has(startKey)) startMap.set(startKey, []);
    startMap.get(startKey).push(i);
    if (!endMap.has(endKey)) endMap.set(endKey, []);
    endMap.get(endKey).push(i);
  });
  const nextOf = new Map();
  lines.forEach((line, i) => {
    const endKey = riverEndpointKey(line[line.length - 1]);
    const forward = startMap.get(endKey);
    const backward = endMap.get(endKey);
    if (forward && forward.length === 1 && backward && backward.length === 1 && forward[0] !== i) {
      nextOf.set(i, forward[0]);
    }
  });
  const prevOf = new Map();
  for (const [a, b] of nextOf) prevOf.set(b, a);
  const globalLengthAtPoint = new Array(lines.length);
  const chainTotalLength = new Array(lines.length).fill(0);
  const visited = new Set();
  // Walk from every chain head (a segment with no unambiguous predecessor) so each segment is
  // visited exactly once, in flow order, however long its chain runs.
  for (let head = 0; head < lines.length; head++) {
    if (prevOf.has(head) || visited.has(head)) continue;
    let cumulative = 0;
    let cursor = head;
    const chainSegments = [];
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      chainSegments.push(cursor);
      const lengths = segmentLengths(lines[cursor]).map((l) => l + cumulative);
      globalLengthAtPoint[cursor] = lengths;
      cumulative = lengths[lengths.length - 1];
      cursor = nextOf.get(cursor);
    }
    for (const segIndex of chainSegments) chainTotalLength[segIndex] = cumulative;
  }
  return { globalLengthAtPoint, chainTotalLength };
}
function riverWidthsOf(lines, widthSourceDeg, widthMouthDeg) {
  const { globalLengthAtPoint, chainTotalLength } = buildRiverChains(lines);
  return lines.map((line, segIndex) => {
    const lengths = globalLengthAtPoint[segIndex];
    const total = chainTotalLength[segIndex];
    return line.map((_, i) => {
      const t = total > 0 ? lengths[i] / total : 0;
      return widthSourceDeg + (widthMouthDeg - widthSourceDeg) * t;
    });
  });
}
// Offsets each centerline point perpendicular to its local tangent by half its precomputed width,
// in a cos(lat)-scaled "flat" space so the offset looks visually even instead of skewed by
// longitude compression away from the equator (undone again converting back to lon/lat degrees).
// Left offsets forward + right offsets reversed forms one closed simple ring, same convention as
// every other polygon ring in this file.
//
// The offset magnitude (half-width) is capped against the shorter of the point's own two adjacent
// segment lengths: averaging the incoming/outgoing tangent direction (a cheap stand-in for a real
// miter join) overshoots badly at a sharp bend, since the correct miter length grows without bound
// as the turn angle shrinks — left uncapped, this measurably self-intersected ("bowtie") 14.2% of
// major-tier ribbons in this dataset (0.53% of detail's, which run narrower and so hit this far less
// often) at exactly the tight, kinked bends real river centerlines are full of. Capping to a fraction
// of the local segment length keeps the offset from ever running past where the next/previous point
// already turns the line, which is what actually causes the crossing.
const RIVER_OFFSET_LOCAL_LENGTH_FRACTION = 0.45;
function riverRibbonOf(line, widths) {
  if (line.length < 2) return null;
  const n = line.length;
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const [lon, lat] = line[i];
    const cosLat = Math.cos((lat * Math.PI) / 180) || 1e-6;
    const prev = line[Math.max(i - 1, 0)];
    const next = line[Math.min(i + 1, n - 1)];
    const toPrevLen = i > 0 ? Math.hypot((lon - prev[0]) * cosLat, lat - prev[1]) : Infinity;
    const toNextLen = i < n - 1 ? Math.hypot((next[0] - lon) * cosLat, next[1] - lat) : Infinity;
    const tx = (next[0] - prev[0]) * cosLat;
    const ty = next[1] - prev[1];
    const tlen = Math.hypot(tx, ty) || 1e-9;
    const px = -ty / tlen;
    const py = tx / tlen;
    const maxHalf = Math.min(toPrevLen, toNextLen) * RIVER_OFFSET_LOCAL_LENGTH_FRACTION;
    const half = Math.min(widths[i] / 2, maxHalf);
    left.push([lon + (px * half) / cosLat, lat + py * half]);
    right.push([lon - (px * half) / cosLat, lat - py * half]);
  }
  const ring = left.concat(right.reverse());
  ring.push(ring[0]);
  return [ring];
}
// Tuned so a major river's mouth reads as a solid few-pixel-wide shape right where RIVER_MIN_ZOOM
// first reveals it (baseScale*zoom*(pi/180) pixels-per-degree — at a representative phone's
// baseScale, ~64 px/deg at zoom 20 — puts the 0.045° mouth width at ~2.9px, the 0.012° source width
// at ~0.8px); detail rivers get a narrower range of their own since they're meant to read as
// smaller streams layered on top once RIVER_DETAIL_MIN_ZOOM reveals them. All four are degrees, so
// (like every other layer here) they scale up naturally as zoom deepens further, the same as land or
// lake geometry does.
const RIVER_MAJOR_WIDTH_SOURCE_DEG = 0.012;
const RIVER_MAJOR_WIDTH_MOUTH_DEG = 0.045;
const RIVER_DETAIL_WIDTH_SOURCE_DEG = 0.006;
const RIVER_DETAIL_WIDTH_MOUTH_DEG = 0.02;
function ribbonsOf(lines, widthSourceDeg, widthMouthDeg) {
  const widths = riverWidthsOf(lines, widthSourceDeg, widthMouthDeg);
  const ribbons = [];
  const bboxes = [];
  lines.forEach((line, i) => {
    const ribbon = riverRibbonOf(line, widths[i]);
    if (!ribbon) return;
    ribbons.push(ribbon);
    bboxes.push(bboxOf(ribbon));
  });
  return { ribbons, bboxes };
}
function loadRivers() {
  const topology = JSON.parse(fs.readFileSync(path.join(root, 'scripts/data/rivers-10m.json'), 'utf8'));
  const object = topology.objects.rivers;
  const riverFeatures = feature(topology, object).features.filter((f) => f.geometry);
  const majorArcs = [];
  const detailArcs = [];
  for (const f of riverFeatures) {
    const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    const bucket = f.properties.scalerank <= RIVER_DETAIL_SCALERANK_CUTOFF ? majorArcs : detailArcs;
    bucket.push(...lines);
  }
  const major = ribbonsOf(majorArcs, RIVER_MAJOR_WIDTH_SOURCE_DEG, RIVER_MAJOR_WIDTH_MOUTH_DEG);
  const detail = ribbonsOf(detailArcs, RIVER_DETAIL_WIDTH_SOURCE_DEG, RIVER_DETAIL_WIDTH_MOUTH_DEG);
  return {
    majorRibbons: major.ribbons,
    majorRibbonBboxes: major.bboxes,
    detailRibbons: detail.ribbons,
    detailRibbonBboxes: detail.bboxes,
  };
}

const rivers = loadRivers();

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
window.LAKES = ${embedAsJson(lakes)};
window.RIVERS = ${embedAsJson(rivers)};
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
