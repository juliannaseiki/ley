import { geoOrthographic, geoPath } from 'd3-geo';
import { angularDistanceDeg, clamp, isFrontFacing as geoIsFrontFacing, visibleCapRadiusDeg as geoVisibleCapRadiusDeg } from './city-labels/geo.js';
import { selectCityLabels, CITY_RETAIN_HYSTERESIS, CITY_BASE_MIN_ZOOM } from './city-labels/selection.js';
import { createLabelStateStore, applySelection, dropStaleByZoom, advance as advanceLabelState } from './city-labels/stateMachine.js';
import { drawCityLabels, cityLabelFont } from './city-labels/render.js';

// LAND_GEOJSON, BORDER_GEOJSON, LAND_DETAIL_PIECES, LAND_DETAIL_BBOXES, BORDER_DETAIL_ARCS,
// BORDER_DETAIL_BBOXES, REGION_BORDER_ARCS, REGION_BORDER_BBOXES, REGION_LABELS,
// LAKES_MAJOR_GEOJSON, LAKES_DETAIL_GEOJSON, MOUNTAINS, RIVERS_GEOJSON, CITIES, and THEME are
// injected as globals by the HTML wrapper at build time.
/* global LAND_GEOJSON, BORDER_GEOJSON, LAND_DETAIL_PIECES, LAND_DETAIL_BBOXES, BORDER_DETAIL_ARCS, BORDER_DETAIL_BBOXES, REGION_BORDER_ARCS, REGION_BORDER_BBOXES, REGION_LABELS, LAKES_MAJOR_GEOJSON, LAKES_DETAIL_GEOJSON, MOUNTAINS, RIVERS_GEOJSON, CITIES, THEME */

// Temporary flags — mountains and region labels are getting a hand-drawn redesign, so they're
// switched off here rather than removed: the data pipeline, curve-fitting, and recompute logic
// underneath are all still intact and ready to reuse once new artwork/fonts are ready, this just
// skips drawing (and, for region labels, the recompute itself) in the meantime.
const SHOW_MOUNTAINS = false;
const SHOW_REGION_LABELS = false;
// On-canvas zoom readout for tuning reveal thresholds — see the draw site in renderInner.
const SHOW_ZOOM_DEBUG = true;

const canvas = document.getElementById('globe');
const ctx = canvas.getContext('2d');

const projection = geoOrthographic().clipAngle(90).precision(0.3);
const path = geoPath(projection, ctx);

// Real coastlines, lake shores, rivers, and borders read as a handful of straight segments
// meeting at sharp points once simplified enough to be practical data at deep zoom — the actual
// geography they represent is basically never that angular. Restoring more of the original detail
// to fix it was tried and rejected: even one extra round of it made the bundle 1.5-2.5x bigger for
// the same visual result. This gets the same smoothing for free at render time instead, by
// rounding the corners of the EXISTING (already-simplified) point sequence rather than adding any
// new ones — for each vertex, curve from the previous edge's midpoint through the vertex itself
// (as the quadratic control point) to the next edge's midpoint. Standard technique, no added data.
//
// geoPath()'s context.js confirms this is safe to intercept this way: it only ever calls
// moveTo/lineTo/closePath on whatever raw context it's given (never beginPath, and arc() only for
// Point geometries, which none of the smoothed layers below are) — so a stand-in object
// implementing just those three methods is a complete, faithful substitute for the real ctx from
// d3-geo's point of view. It buffers each subpath (a moveTo starts a new one, for any reason:
// a new disjoint piece, a polygon hole, a fresh segment after clipping at the visible horizon) and
// only actually draws once that subpath is complete, as this smoothed curve instead of the
// straight lines d3-geo would otherwise ask for.
function drawSmoothSubpath(targetCtx, points, closed) {
  const n = points.length;
  if (n < 3) {
    targetCtx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < n; i++) targetCtx.lineTo(points[i][0], points[i][1]);
    if (closed) targetCtx.closePath();
    return;
  }
  if (closed) {
    const midX = (points[n - 1][0] + points[0][0]) / 2;
    const midY = (points[n - 1][1] + points[0][1]) / 2;
    targetCtx.moveTo(midX, midY);
    for (let i = 0; i < n; i++) {
      const next = points[(i + 1) % n];
      const mx = (points[i][0] + next[0]) / 2;
      const my = (points[i][1] + next[1]) / 2;
      targetCtx.quadraticCurveTo(points[i][0], points[i][1], mx, my);
    }
    targetCtx.closePath();
  } else {
    // An open path (a border arc, a river) keeps its own two endpoints exactly where they are —
    // only the interior corners round off — so a piece's ends still meet cleanly wherever another
    // piece's cull/clip boundary or an adjacent arc needs them to.
    targetCtx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (points[i][0] + points[i + 1][0]) / 2;
      const my = (points[i][1] + points[i + 1][1]) / 2;
      targetCtx.quadraticCurveTo(points[i][0], points[i][1], mx, my);
    }
    targetCtx.lineTo(points[n - 1][0], points[n - 1][1]);
  }
}
// flush() must be called once after the last path() call in a beginPath()/fill()-or-stroke()
// sequence — the final subpath has no later moveTo to signal it's complete, so nothing else would
// ever draw it.
function createSmoothPathContext(targetCtx) {
  let current = [];
  let isClosed = false;
  function flushCurrent() {
    if (current.length > 0) drawSmoothSubpath(targetCtx, current, isClosed);
    current = [];
    isClosed = false;
  }
  return {
    moveTo(x, y) {
      flushCurrent();
      current = [[x, y]];
    },
    lineTo(x, y) {
      current.push([x, y]);
    },
    closePath() {
      isClosed = true;
      flushCurrent();
    },
    arc(x, y, r, a0, a1) {
      flushCurrent();
      targetCtx.arc(x, y, r, a0, a1);
    },
    flush: flushCurrent,
  };
}
const smoothPathContext = createSmoothPathContext(ctx);
const smoothPath = geoPath(projection, smoothPathContext);

let width = 0;
let height = 0;
// Capped at 2 rather than used raw — canvas backing-store pixel count (and so every fill/stroke's
// rasterization cost) scales with dpr squared, so an uncapped 3x device pays 2.25x the GPU work
// of a capped-at-2 one for a difference that's imperceptible on this style of flat vector map
// (thin lines, solid fills, no fine text at native res). This is the single biggest lever on
// higher-end phones, where dpr is 3 or more.
const DPR_CAP = 2;
let dpr = Math.min(DPR_CAP, Math.max(1, window.devicePixelRatio || 1));

let rotation = [10, -12]; // [lambda, phi], degrees
let zoom = 1;
const MIN_ZOOM = 1;
const MAX_ZOOM = 100;
// Exponent applied to the raw pinch finger-distance ratio (see onPointerMove) — tuned so a single
// comfortable pinch (roughly tripling finger distance) already clears every city reveal
// threshold.
const PINCH_ZOOM_POWER = 1.8;
// Region borders ramp in smoothly across this zoom range, rather than snapping on at a single
// threshold — same idea as Apple Maps/Flighty showing more map detail the deeper you zoom in.
const REGION_BORDER_FADE_START = 1.4;
const REGION_BORDER_FADE_END = 2.2;
// Line labels used to appear the instant zoom exceeded MIN_ZOOM at all — with up to 40 of them
// (10 bodies x 4 angles) all converging toward the poles, that meant a screenful of overlapping
// pills the moment a pinch even started. This is a hard cutoff, not a zoom-tied fade like region
// borders — recomputeLabels only runs at discrete moments (gesture end, new line data), not
// continuously as zoom changes, so a fade driven by the zoom value itself gets permanently stuck
// at whatever fraction the user's current (static) zoom happens to land on, the same bug already
// hit and fixed for city labels. The actual fade-in comes from labelsFadeStartAt (time-based,
// always resolves to fully opaque) — this constant only decides whether labels are eligible to
// draw at all.
const LABEL_MIN_ZOOM = 1.8;
// layoutLabels' ring search already skips a label rather than force it to truly overlap another,
// but with up to 40 possible candidates (10 bodies x 4 line kinds) all converging toward a pole at
// once, that search can still end up filling every nearby ring with SOMETHING, packed tightly
// enough to read as illegible clutter even where no two boxes technically intersect. Capping how
// many candidates even compete — tighter the more zoomed out the view is, since more of the globe
// (and so more lines) is visible at once — gives the search room to actually keep the labels that
// do show clearly apart, rather than spreading thin across too many. Ramps from
// LABEL_MAX_COUNT_MIN at LABEL_MIN_ZOOM up to LABEL_MAX_COUNT_MAX (every line gets its own
// label, effectively uncapped) by LABEL_DENSITY_FULL_ZOOM.
const LABEL_MAX_COUNT_MIN = 6;
const LABEL_MAX_COUNT_MAX = 40;
const LABEL_DENSITY_FULL_ZOOM = 12;
function labelCapForZoom() {
  const t = clamp((zoom - LABEL_MIN_ZOOM) / (LABEL_DENSITY_FULL_ZOOM - LABEL_MIN_ZOOM), 0, 1);
  return Math.round(LABEL_MAX_COUNT_MIN + t * (LABEL_MAX_COUNT_MAX - LABEL_MAX_COUNT_MIN));
}
// The city-label selection algorithm's own tuning (CITY_MAX_LABELS, CITY_GRID_COLS/ROWS) now
// lives entirely in city-labels/selection.js — this file only imports the two constants that also
// affect drawing here: CITY_BASE_MIN_ZOOM (the fade-eligibility gate below) and
// CITY_RETAIN_HYSTERESIS (the live per-frame check in updateCityLabelAnimation). CITY_BASE_MIN_ZOOM
// must stay numerically in sync with build-globe-html.mjs's own copy (which derives every city's
// per-city minZoom from population) — a pre-existing cross-file constant, not a new duplication.
//
// City/town label fade timing (CITY_LABEL_FADE_MS) and the fadingIn/visible/fadingOut phase
// machinery now live in city-labels/stateMachine.js.
//
// The full candidate scan + collision layout (recomputeCityLabels/selectCityLabels) is too
// expensive to run on every single animation frame now that CITIES has grown to 170k+ entries —
// a drag gesture fires render() on every pointermove, so "every frame" during an active drag was
// actually more like "every few milliseconds". cityLabelState is the cache — keyed by each city's
// stable index into CITIES (see the cityCells comment in build-globe-html.mjs) rather than the old
// name+lon+lat string key — the per-frame render path just reprojects each already-tracked city's
// lon/lat live (cheap) so labels still track the globe smoothly as it rotates even between actual
// recomputes.
//
// An earlier version of this recomputed on a plain timer during a drag and that read as labels
// randomly vanishing while just panning around — but the actual cause was that collision placement
// was order-dependent on screen position AND already-visible labels had no special standing, so a
// label already showing could lose a placement slot to a fresh competitor purely because a new
// snapshot's collisions shook out differently, with nothing about its own relevance having
// changed. That's fixed now at the source (see the "already-shown labels skip collision" comment
// in selection.js), not worked around by recomputing rarely — an already-visible label can only
// lose its slot by crossing back below its own zoom threshold or by the cap trimming the least
// significant labels when there are genuinely more qualifying places than room, never by collision
// order. That's what makes it safe to recompute more often than "only at gesture end" now: see
// maybeRecomputeCityLabelsDuringGesture below.
const cityLabelState = createLabelStateStore();
let baseScale = 100;

// Recomputing on every single pointermove would mean a real spatial-index query + placement pass
// every few milliseconds during a drag — the spatial index (see city-labels/spatialIndex.js) made
// that pass cheap relative to the old 170k-brute-force scan, but "cheap" isn't "free", and nothing
// is gained recomputing more often than the view has actually moved enough to matter (retained
// labels are already being reprojected live every frame regardless of whether a recompute ran).
// Gating on real movement — either the look-at point has rotated past
// CITY_RECOMPUTE_ROTATION_THRESHOLD_DEG or zoom has changed by more than
// CITY_RECOMPUTE_ZOOM_RATIO_THRESHOLD since the last recompute — means a slow, careful drag or a
// pinch that's barely moving doesn't recompute at all, while a real pan/zoom keeps labels updating
// live instead of only once the gesture ends. CITY_RECOMPUTE_MIN_INTERVAL_MS is a hard ceiling on
// top of that (never more than ~8 recomputes/sec) so a fast flick with many pointermove events in
// quick succession can't still force a recompute every single frame just because each individual
// frame's movement happened to clear the distance threshold.
const CITY_RECOMPUTE_MIN_INTERVAL_MS = 120;
const CITY_RECOMPUTE_ROTATION_THRESHOLD_DEG = 4;
const CITY_RECOMPUTE_ZOOM_RATIO_THRESHOLD = 0.15;
let lastCityRecomputeAt = 0;
let lastCityRecomputeLookLon = null;
let lastCityRecomputeLookLat = null;
let lastCityRecomputeZoom = null;

function shouldRecomputeCityLabelsNow(now) {
  if (lastCityRecomputeLookLon === null) return true;
  if (now - lastCityRecomputeAt < CITY_RECOMPUTE_MIN_INTERVAL_MS) return false;
  const lookLon = -rotation[0];
  const lookLat = -rotation[1];
  const rotationDelta = angularDistanceDeg(lookLon, lookLat, lastCityRecomputeLookLon, lastCityRecomputeLookLat);
  if (rotationDelta > CITY_RECOMPUTE_ROTATION_THRESHOLD_DEG) return true;
  const zoomRatio = Math.abs(zoom - lastCityRecomputeZoom) / lastCityRecomputeZoom;
  return zoomRatio > CITY_RECOMPUTE_ZOOM_RATIO_THRESHOLD;
}

// Called from onPointerMove — a real recompute mid-gesture, gated by shouldRecomputeCityLabelsNow
// above, rather than only ever at gesture end (onPointerUp still always recomputes unconditionally
// on release, as the final settle to an exact match for wherever the user ended up).
function maybeRecomputeCityLabelsDuringGesture() {
  const now = performance.now();
  if (!shouldRecomputeCityLabelsNow(now)) return;
  recomputeCityLabels();
}

// Curved region name labels (states/provinces) — laid out along the region's own line of
// latitude (see layoutCurvedLabel) so the curve is exactly how the globe's surface actually
// curves under the current rotation/zoom, not an arbitrary decorative arc. Same
// retained-first/hysteresis/gesture-end-recompute/fade in-out architecture as city labels — see
// the comment on recomputeCityLabels for why each of those pieces exists; recomputeRegionLabels
// mirrors it directly rather than re-deriving the reasoning here.
const REGION_LABEL_FONT = "600 20px Georgia, 'Times New Roman', serif";
const REGION_LABEL_LETTER_SPACING_PX = 2;
const REGION_LABEL_ASCENT = 15;
const REGION_LABEL_DESCENT = 5;
const REGION_LABEL_MAX_COUNT = 6;
const REGION_LABEL_RETAIN_HYSTERESIS = 0.4;
const REGION_LABEL_SAMPLE_STEPS = 240;
let regionLabels = []; // [{ name, lon, lat, minZoom, glyphs: [{lon, lat, char, width}], left, right, top, bottom, fadeStartAt }]
let fadingOutRegionLabels = []; // [{ name, glyphs, fadeOutStartAt }]

let astroLines = []; // [{ bodyId, kind, color, feature }]
let pin = null; // [lon, lat] or null

// U+FE0E (text presentation selector) forces plain text glyphs for Venus/Mars specifically —
// unlike the other astrological symbols here, ♀/♂ double as the "female"/"male" emoji and iOS
// renders them with emoji presentation (a differently shaped, differently metriced glyph) by
// default, which is what threw off their alignment even after correcting for font metrics.
const BODY_GLYPHS = {
  Sun: '☉',
  Moon: '☽',
  Mercury: '☿',
  Venus: '♀︎',
  Mars: '♂︎',
  Jupiter: '♃',
  Saturn: '♄',
  Uranus: '♅',
  Neptune: '♆',
  Pluto: '♇',
};

// Small manual correction layered on top of the measured glyphBaselineShift (negative moves a
// glyph up). Empirical — only touch a body here if its label visibly sits off after the measured
// correction.
const GLYPH_BASELINE_FINE_TUNE = {
  Venus: -1.5,
  Mars: -1.5,
};
const GLYPH_KIND_GAP = 3;
const LABEL_PADDING_X = 4;
// Bounds in a font's own metrics for the alphabetic baseline (ascent above, descent below).
const LABEL_ASCENT = 9;
const LABEL_DESCENT = 3;

// Laid-out labels, refreshed only by recomputeLabels() — not on every frame. Each keeps the
// geographic anchor point it was placed relative to, plus the stagger offset layoutLabels chose
// to avoid overlapping neighbors; render() re-projects the anchor live every frame (so the label
// rotates naturally with its line) and re-applies the same offset (so the overlap-avoidance
// layout doesn't need re-solving every frame, which is what made labels crawl before).
let renderedLabels = [];
// Timestamp of the last recomputeLabels() call, used to fade labels in over LABEL_FADE_MS rather
// than having them snap straight to full opacity whenever they refresh.
let labelsFadeStartAt = 0;
const LABEL_FADE_MS = 220;

const AUTO_ROTATE_DEG_PER_MS = 360 / (1000 * 60 * 4.5); // one turn per 4.5 minutes
const IDLE_DELAY_MS = 1400;
let lastInteractionAt = 0;
let lastFrameAt = null;

function resize() {
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  dpr = Math.min(DPR_CAP, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  baseScale = Math.min(width, height) * 0.47;
  projection.translate([width / 2, height / 2]);
  applyScale();
  render();
}

function applyScale() {
  projection.scale(baseScale * zoom);
}

function render() {
  try {
    renderInner();
  } catch (err) {
    // Swallow: a single bad frame shouldn't kill tick()'s requestAnimationFrame chain and
    // permanently freeze the globe.
  }
}

// The full recompute only runs at gesture end (see recomputeCityLabels), so during an active,
// continuous zoom-out (finger still down) cityLabelState still holds whatever was showing before
// the gesture started — a screen's worth of small towns from a much deeper zoom. Without this,
// those stale labels would sit there at full opacity for the whole gesture, not clearing until the
// user lifted their finger and the next recompute finally pruned them — reads as "places aren't
// fading out on zoom out." Starting each label's fade-out live, every frame, as zoom actually
// crosses its own threshold (dropStaleByZoom) — not just once the gesture happens to end — and
// then always advancing every tracked label's animation by elapsed time (advanceLabelState,
// unconditional: it has to run even when nothing new just went stale, or an in-progress fade would
// never actually finish playing) is what makes the fade continuous instead of stuck-then-sudden.
function updateCityLabelAnimation(now) {
  dropStaleByZoom(cityLabelState, zoom, CITY_RETAIN_HYSTERESIS, now);
  advanceLabelState(cityLabelState, now);
}

function renderInner() {
  projection.rotate(rotation);
  ctx.clearRect(0, 0, width, height);
  updateCityLabelAnimation(performance.now());

  const center = [width / 2, height / 2];
  const radius = baseScale * zoom;
  // Computed once per frame and reused by every detail layer's per-piece cull check below — see
  // visibleCapRadiusDeg/cullByBbox.
  const capRadiusDeg = visibleCapRadiusDeg();

  // Ocean sphere fill with a soft radial shade for a gentle 3D feel.
  const oceanGradient = ctx.createRadialGradient(
    center[0] - radius * 0.3,
    center[1] - radius * 0.35,
    radius * 0.05,
    center[0],
    center[1],
    radius
  );
  oceanGradient.addColorStop(0, THEME.oceanLight);
  oceanGradient.addColorStop(1, THEME.oceanDeep);

  ctx.beginPath();
  path({ type: 'Sphere' });
  ctx.fillStyle = oceanGradient;
  ctx.fill();

  // Land — a flat single-color fill, no elevation/terrain tinting. Finer coastline detail (same
  // color) fades in on top once zoomed in: LAND_GEOJSON is a coarse (~2% simplified) always-on
  // base so idle auto-rotation never pays for more resolution than it needs, LAND_DETAIL_PIECES
  // is the same source simplified far less, revealing smaller islands and more accurate
  // coastlines the coarse tier smooths away or drops entirely.
  //
  // The coarse tier only actually needs to draw while the detail tier is transparent or fading
  // in — once detail reaches full opacity it completely covers the coarse shape underneath, so
  // drawing (and clipping, the more expensive part) the coarse tier too past that point is pure
  // wasted work. Same reasoning applies everywhere else a coarse/detail pair appears below.
  const landDetailAlpha = clamp(
    (zoom - REGION_BORDER_FADE_START) / (REGION_BORDER_FADE_END - REGION_BORDER_FADE_START),
    0,
    1
  );
  if (landDetailAlpha < 1) {
    ctx.beginPath();
    path(LAND_GEOJSON);
    ctx.fillStyle = THEME.land;
    ctx.fill();
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = THEME.landStroke;
    ctx.stroke();
  }
  if (landDetailAlpha > 0) {
    ctx.globalAlpha = landDetailAlpha;
    ctx.beginPath();
    for (let i = 0; i < LAND_DETAIL_PIECES.length; i++) {
      if (cullByBbox(LAND_DETAIL_BBOXES[i], capRadiusDeg)) {
        smoothPath({ type: 'Polygon', coordinates: LAND_DETAIL_PIECES[i] });
      }
    }
    smoothPathContext.flush();
    ctx.fillStyle = THEME.land;
    ctx.fill();
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = THEME.landStroke;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Lakes and other inland water — filled with the exact same gradient as the ocean (rather than
  // a separate flat white) so they read as one continuous idea of "water" instead of two
  // similar-but-not-quite-identical whites.
  //
  // Two tiers, same idea as region borders/cities: LAKES_MAJOR_GEOJSON (the ~400 largest lakes
  // worldwide, at land's own coarse resolution) draws every frame unconditionally, including
  // through continuous idle auto-rotation — cheap by design. LAKES_DETAIL_GEOJSON (~1,350 lakes,
  // covers regionally-notable ones the major tier misses) is 10x finer and only fades in once
  // zoomed in, so that cost is never paid at rest.
  const lakeDetailAlpha = clamp(
    (zoom - REGION_BORDER_FADE_START) / (REGION_BORDER_FADE_END - REGION_BORDER_FADE_START),
    0,
    1
  );
  if (lakeDetailAlpha < 1) {
    ctx.beginPath();
    path(LAKES_MAJOR_GEOJSON);
    ctx.fillStyle = oceanGradient;
    ctx.fill();
  }
  if (lakeDetailAlpha > 0) {
    ctx.globalAlpha = lakeDetailAlpha;
    ctx.beginPath();
    for (const lakeFeature of LAKES_DETAIL_GEOJSON.features) {
      if (cullByBbox(lakeFeature.properties.bbox, capRadiusDeg)) smoothPath(lakeFeature);
    }
    smoothPathContext.flush();
    ctx.fillStyle = oceanGradient;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Mountain icons — a Middle-earth-map-style flourish: illustrated peaks stamped at named
  // mountain locations (see build-globe-html.mjs) rather than left to plain terrain color. Only
  // 633 points worldwide, so unlike cities/regions this doesn't need the gesture-end-recompute +
  // cache architecture — a direct per-frame scan is cheap enough at this size. Drawn at a fixed
  // pixel size regardless of zoom (translated into place, not scaled), the same "always the same
  // size" fix applied to the region labels — simpler and more predictable than trying to size the
  // icon to some geographic footprint.
  if (SHOW_MOUNTAINS) {
    for (const mountain of MOUNTAINS) {
      const [, lon, lat, minZoom] = mountain; // name unused for now — no label yet, just the icon
      if (zoom <= minZoom) continue;
      if (!isFrontFacing([lon, lat])) continue;
      const p = projection([lon, lat]);
      if (!p || p[0] < 0 || p[0] > width || p[1] < 0 || p[1] > height) continue;
      drawMountainIcon(p[0], p[1], mountainSeed(lon, lat));
    }
  }

  // Rivers (and lake centerlines that continue a river's path through a lake, rather than
  // leaving a gap). Nothing here is always-on — each feature carries its own min_zoom (Natural
  // Earth's curated importance ranking, rescaled to our zoom scale in build-globe-html.mjs, same
  // idea as the mountains layer), and even the biggest rivers need real zoom before showing at
  // all, not just before showing in full detail.
  for (const riverFeature of RIVERS_GEOJSON.features) {
    if (zoom <= riverFeature.properties.min_zoom) continue;
    if (!cullByBbox(riverFeature.properties.bbox, capRadiusDeg)) continue;
    ctx.beginPath();
    smoothPath(riverFeature);
    smoothPathContext.flush();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = THEME.river;
    ctx.stroke();
  }

  // State/province borders for every country, drawn under country borders (so the country
  // outline reads as the more prominent line) and only faded in once zoomed in a bit — at full
  // zoom-out, this level of detail is just noise, the same reasoning as the line labels.
  const regionBorderAlpha = clamp(
    (zoom - REGION_BORDER_FADE_START) / (REGION_BORDER_FADE_END - REGION_BORDER_FADE_START),
    0,
    1
  );
  if (regionBorderAlpha > 0) {
    ctx.beginPath();
    for (let i = 0; i < REGION_BORDER_ARCS.length; i++) {
      if (cullByBbox(REGION_BORDER_BBOXES[i], capRadiusDeg)) {
        // Sharp, not smoothed — administrative borders often follow straight surveyed lines
        // (Vermont's own southern edge among them), so rounding their corners would be a less
        // accurate picture, not a better-looking one, unlike a coastline/lake/river's real curves.
        path({ type: 'LineString', coordinates: REGION_BORDER_ARCS[i] });
      }
    }
    ctx.lineWidth = 0.4;
    ctx.strokeStyle = THEME.regionBorder;
    ctx.globalAlpha = regionBorderAlpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Region name labels — the recompute (layoutCurvedLabel/recomputeRegionLabels) only runs at
  // gesture end, same reasoning as city labels; here we just reproject each already-placed
  // glyph's (lon, lat) live and redraw, so the curve tracks the globe's rotation every frame
  // without redoing the expensive parallel-sampling fit.
  if (SHOW_REGION_LABELS && (regionLabels.length > 0 || fadingOutRegionLabels.length > 0)) {
    ctx.font = REGION_LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = THEME.regionLabel;
    const nowMs = performance.now();
    const drawCurvedLabel = (glyphs, alpha) => {
      if (alpha <= 0) return;
      // Project every glyph first so rotation comes from real neighboring screen positions
      // (which foreshorten with the actual projection near the limb) rather than the
      // (lon, lat)-space neighbor, which wouldn't match what's on screen.
      const projected = glyphs.map((g) => (isFrontFacing([g.lon, g.lat]) ? projection([g.lon, g.lat]) : null));
      if (projected.some((p) => !p)) return; // any glyph rotated out of view — skip the whole label
      ctx.globalAlpha = alpha;
      for (let i = 0; i < glyphs.length; i++) {
        const prev = projected[Math.max(i - 1, 0)];
        const next = projected[Math.min(i + 1, glyphs.length - 1)];
        const angle = Math.atan2(next[1] - prev[1], next[0] - prev[0]);
        ctx.save();
        ctx.translate(projected[i][0], projected[i][1]);
        ctx.rotate(angle);
        ctx.fillText(glyphs[i].char, 0, 0);
        ctx.restore();
      }
    };
    for (const c of fadingOutRegionLabels) {
      drawCurvedLabel(c.glyphs, 1 - (nowMs - c.fadeOutStartAt) / LABEL_FADE_MS);
    }
    for (const c of regionLabels) {
      drawCurvedLabel(c.glyphs, Math.min(1, (nowMs - c.fadeStartAt) / LABEL_FADE_MS));
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
  }

  // Country borders — coarse tier always-on, finer tier fades in on top once zoomed in, same
  // two-tier idea as the land/coastline detail above (including skipping the coarse tier once
  // the detail tier is fully opaque and covering it).
  const borderDetailAlpha = clamp(
    (zoom - REGION_BORDER_FADE_START) / (REGION_BORDER_FADE_END - REGION_BORDER_FADE_START),
    0,
    1
  );
  if (borderDetailAlpha < 1) {
    ctx.beginPath();
    path(BORDER_GEOJSON);
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = THEME.countryBorder;
    ctx.stroke();
  }
  if (borderDetailAlpha > 0) {
    ctx.beginPath();
    for (let i = 0; i < BORDER_DETAIL_ARCS.length; i++) {
      if (cullByBbox(BORDER_DETAIL_BBOXES[i], capRadiusDeg)) {
        // Sharp, not smoothed — see the same note on the region-border loop above.
        path({ type: 'LineString', coordinates: BORDER_DETAIL_ARCS[i] });
      }
    }
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = THEME.countryBorder;
    ctx.globalAlpha = borderDetailAlpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // City labels — deepest level of map detail, so they only start appearing well into the region
  // border's own fade range and get progressively denser the further in you go, same idea as
  // Apple Maps/Flighty revealing more place names the deeper you zoom. The expensive part (the
  // full candidate scan + collision layout) only runs at the end of a gesture — see
  // recomputeCityLabels and its call site in onPointerUp — drawCityLabels just reprojects each
  // tracked label's (lon, lat) live and reads its current fade phase/opacity from the state
  // machine (updateCityLabelAnimation above already advanced it this frame), font size comes from
  // a continuous function of zoom instead of a fixed literal.
  drawCityLabels(ctx, cityLabelState, {
    projection,
    isFrontFacing: (lon, lat) => isFrontFacing([lon, lat]),
    width,
    height,
    zoom,
    dotColor: THEME.cityDot,
    textColor: THEME.cityLabel,
    now: performance.now(),
  });

  // Astrocartography lines. Round caps/joins matter here: many MC/IC meridians converge on the
  // same pole from different angles, and flat (default) caps leave a visible star-shaped gap
  // right at that shared point instead of a clean convergence.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const line of astroLines) {
    ctx.beginPath();
    path(line.feature);
    ctx.lineWidth = line.kind === 'MC' || line.kind === 'IC' ? 1.6 : 1.8;
    ctx.strokeStyle = line.color;
    ctx.globalAlpha = 0.92;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Line labels (planet glyph + angle), only shown once the user has zoomed in — at full
  // zoom-out there are too many of them, too close together, to read cleanly regardless of
  // layout. The overlap-avoiding stagger is computed by recomputeLabels(), not here (see its
  // comment for why), but each label's anchor is re-projected live every frame so it rotates
  // naturally with its line — it stays on the line, just riding along with the globe — rather
  // than sitting frozen at a fixed screen position while the line moves underneath it.
  if (zoom > LABEL_MIN_ZOOM) {
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = Math.min(1, (performance.now() - labelsFadeStartAt) / LABEL_FADE_MS);
    for (const label of renderedLabels) {
      const box = projectLabelBox(label);
      if (!box) continue;
      const { x, y, left, right, top, bottom } = box;
      ctx.beginPath();
      ctx.roundRect(left, top, right - left, bottom - top, (bottom - top) / 2);
      ctx.fillStyle = mixWithWhite(label.color, 0.03);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = hexToRgba(label.color, 0.4);
      ctx.stroke();

      const startX = x - label.width / 2;
      const glyphX = startX;
      const glyphY = y + label.glyphBaselineShift;
      const kindX = startX + label.glyphWidth + GLYPH_KIND_GAP;

      ctx.fillStyle = label.color;
      ctx.fillText(label.glyph, glyphX, glyphY);
      ctx.fillText(label.kind, kindX, y);
    }
    ctx.textAlign = 'center';
    ctx.globalAlpha = 1;
  }

  // Thin globe edge outline.
  ctx.beginPath();
  path({ type: 'Sphere' });
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = THEME.globeOutline;
  ctx.stroke();

  // Tapped-location pin, drawn last so it sits on top of everything else.
  if (pin && isFrontFacing(pin)) {
    const p = projection(pin);
    if (p) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], 7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
      ctx.fillStyle = THEME.pin;
      ctx.fill();
    }
  }

  // Temporary debug readout — current zoom, for tuning reveal thresholds (rivers, cities, region
  // borders, etc. all key off this same value). Drawn last, top-left, so it's always legible
  // regardless of what's underneath. Remove once the thresholds this is being used to tune are
  // settled.
  if (SHOW_ZOOM_DEBUG) {
    const label = `zoom ${zoom.toFixed(2)}`;
    ctx.font = '600 12px monospace';
    const textWidth = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(8, 8, textWidth + 12, 20);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 14, 18);
  }
}

// Deterministic hash of a mountain's own (lon, lat) into a pseudo-random integer seed — every
// mountain gets a fixed, individually-jittered cluster shape (computed the same way every frame,
// not re-randomized each time, which would make it crawl/flicker as the globe rotates), but
// neighboring mountains don't all look like a stamped repeat of the same icon.
function mountainSeed(lon, lat) {
  const h = Math.sin(lon * 12.9898 + lat * 78.233) * 43758.5453;
  return Math.floor((h - Math.floor(h)) * 2147483647);
}

// A hand-drawn-style mountain cluster, closer to the sketched relief symbols on old and
// fantasy-style maps than a clean geometric icon: several overlapping peaks with irregular
// (jittered, not perfectly triangular) outlines, shaded with hachures — short pen strokes along
// each peak's shadowed slope — rather than a flat fill block. seed (see mountainSeed) drives a
// small deterministic PRNG so peak count/height/width/jitter vary per mountain.
function drawMountainIcon(x, y, seed) {
  ctx.save();
  ctx.translate(x, y);

  let s = seed;
  function rand() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  }

  const peakCount = 3 + Math.floor(rand() * 3); // 3-5 peaks
  const spread = 16;
  ctx.lineJoin = 'round';
  ctx.fillStyle = THEME.mountainFill;
  ctx.strokeStyle = THEME.mountainStroke;

  for (let i = 0; i < peakCount; i++) {
    const jitter = () => (rand() - 0.5) * 1.4;
    const baseX = -spread / 2 + (spread * i) / Math.max(peakCount - 1, 1) + jitter();
    const isMiddlePeak = i === Math.floor(peakCount / 2);
    const apex = 7 + rand() * 5 + (isMiddlePeak ? 3 : 0);
    const halfWidth = 3.5 + rand() * 2;

    // An irregular silhouette — five jittered points rather than a clean three-point triangle,
    // sketched as straight segments rather than a smooth curve, mimicking a quick pen outline.
    ctx.beginPath();
    ctx.moveTo(baseX - halfWidth, 0);
    ctx.lineTo(baseX - halfWidth * 0.45 + jitter(), -apex * 0.5 + jitter());
    ctx.lineTo(baseX + jitter(), -apex);
    ctx.lineTo(baseX + halfWidth * 0.5 + jitter(), -apex * 0.45 + jitter());
    ctx.lineTo(baseX + halfWidth, 0);
    ctx.closePath();
    ctx.lineWidth = 0.9;
    ctx.fill();
    ctx.stroke();

    // Hachures — a few short strokes climbing the shadowed (right) side of the peak, the classic
    // pen-and-ink technique for suggesting a slope's form without a flat tone.
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let h = 1; h <= 3; h++) {
      const t = h / 4;
      const hx = baseX + halfWidth * (0.15 + t * 0.5);
      const hy = -apex * (0.85 - t * 0.7);
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx + 1.6, hy + 2.4);
    }
    ctx.stroke();
  }

  ctx.restore();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Blends a hex color toward white and returns an opaque rgb() — used for the label pill fill so
// it actually covers whatever's underneath (an alpha-transparent wash still let lines show
// through) while still reading as close to white, just tinted with a whisper of the line's color.
function mixWithWhite(hex, colorWeight) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = (channel) => Math.round(channel * colorWeight + 255 * (1 - colorWeight));
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

// Whether a [lon, lat] point currently faces the viewer, given the globe's rotation. Thin wrapper
// over city-labels/geo.js's parameterized version (which the label modules also use directly,
// without this closure) — kept as a same-signature wrapper here rather than rewriting every one of
// this file's many call sites to pass rotation explicitly.
function isFrontFacing([lon, lat]) {
  return geoIsFrontFacing(lon, lat, -rotation[0], -rotation[1]);
}

// Once zoomed in enough that the canvas shows only a slice of the front hemisphere, most of a
// detail layer's geometry (land-detail polygons, border/region-border arcs, rivers, lakes) is
// still technically "front-facing" by isFrontFacing's hemisphere test but projects way outside the
// canvas — full path tracing (project every point, emit canvas path commands) still happens for
// all of it every frame otherwise, for zero visible benefit. capRadiusDeg is the farthest angular
// distance from the current look-at point that can possibly land inside the canvas rectangle; a
// piece whose own bbox is farther than that, plus its own angular size and a safety margin, can
// only be off-screen. Below the zoom where the canvas already shows the whole front hemisphere,
// capRadiusDeg is 90 and nothing gets culled — there's nothing to gain and every early-return here
// is a no-op. Thin wrapper over city-labels/geo.js's parameterized version, same reasoning as
// isFrontFacing above.
function visibleCapRadiusDeg() {
  return geoVisibleCapRadiusDeg(width, height, baseScale, zoom);
}

// Margin is generous and additive, not multiplicative — a false negative here (treating something
// truly on-screen as culled) is a real visual bug, a false positive (tracing something that turns
// out to be just off-screen) is only ever a little wasted work. bbox is null for anything that
// wrapped the antimeridian at build time (see bboxOf in build-globe-html.mjs) or has no precomputed
// bbox at all — both treated as always-visible.
const CULL_MARGIN_DEG = 15;
function cullByBbox(bbox, capRadiusDeg) {
  if (!bbox || capRadiusDeg >= 90) return true;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const bboxRadius = Math.max(maxLon - minLon, maxLat - minLat) / 2;
  const lookLon = -rotation[0];
  const lookLat = -rotation[1];
  const dist = angularDistanceDeg(centerLon, centerLat, lookLon, lookLat);
  return dist - bboxRadius <= capRadiusDeg + CULL_MARGIN_DEG;
}

// A line label's current screen-space pill box, re-derived live every frame from its geographic
// anchor + cached offset (see recomputeLabels) — shared by the draw loop and by tap hit-testing
// (hitTestLabel) so the two can never disagree about where a label actually is.
function projectLabelBox(label) {
  if (!isFrontFacing(label.anchor)) return null;
  const p = projection(label.anchor);
  if (!p) return null;
  const x = p[0] + label.offsetX;
  const y = p[1] + label.offsetY;
  return {
    x,
    y,
    left: x - label.width / 2 - LABEL_PADDING_X,
    right: x + label.width / 2 + LABEL_PADDING_X,
    top: y - LABEL_ASCENT,
    bottom: y + LABEL_DESCENT,
  };
}

// Hit-testing for taps on a line or its label, used by handleTap. Checked in this order because
// a label can sit slightly off its own line (the stagger layout nudges it to avoid overlapping
// neighbors) — testing the label's actual drawn box first means tapping the pill always works,
// even when it's no longer sitting right on top of the stroke.
function hitTestLabel(x, y) {
  if (zoom <= LABEL_MIN_ZOOM) return null; // labels aren't drawn at all below this zoom
  for (const label of renderedLabels) {
    const box = projectLabelBox(label);
    if (!box) continue;
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return label;
  }
  return null;
}

// Path2D implements the same moveTo/lineTo/arc subset geoPath draws through, so building one per
// line lets ctx.isPointInStroke do real hit-testing against the line's actual curved geometry —
// far more accurate than an approximate screen-space bounding box, and cheap enough since this
// only runs on an actual tap, not every frame.
const LINE_HIT_WIDTH = 20; // generous finger-sized tap target, well beyond the ~1.8px visual stroke
function hitTestLine(x, y) {
  for (const line of astroLines) {
    const hitPath = new Path2D();
    geoPath(projection, hitPath)(line.feature);
    ctx.lineWidth = LINE_HIT_WIDTH;
    if (ctx.isPointInStroke(hitPath, x, y)) return line;
  }
  return null;
}

// The selection algorithm itself (retained-first, grid-based fairness, priority-capped collision)
// lives in city-labels/selection.js — see that file for the full reasoning. This is just the call
// site: still only invoked at the end of a gesture (see onPointerUp). previouslyVisible is built
// from the current state store (every tracked label, regardless of phase — including ones already
// fading out, so one can resume smoothly rather than pop if it's re-selected before its fade-out
// finishes; see applySelection in stateMachine.js). Font is set here to whatever size the current
// zoom will actually render at, so the collision boxes selectCityLabels computes from measured
// text width match what drawCityLabels later draws.
function recomputeCityLabels() {
  ctx.font = cityLabelFont(zoom);
  const now = performance.now();

  const previouslyVisible = [...cityLabelState.entries()].map(([index, e]) => ({
    index,
    name: e.name,
    lon: e.lon,
    lat: e.lat,
    minZoom: e.minZoom,
  }));

  const placed = selectCityLabels({
    cities: CITIES,
    previouslyVisible,
    zoom,
    rotation,
    projection,
    width,
    height,
    baseScale,
    measureTextWidth: (name) => ctx.measureText(name).width,
  });

  applySelection(cityLabelState, placed, now);

  lastCityRecomputeAt = now;
  lastCityRecomputeLookLon = -rotation[0];
  lastCityRecomputeLookLat = -rotation[1];
  lastCityRecomputeZoom = zoom;
}

// Standard spherical "destination point given distance and bearing" formula — walks a great
// circle from (lon0, lat0), bearingDeg clockwise from north, distDeg degrees of arc along it.
// This is what lets layoutCurvedLabel sample along the region's own major axis (any bearing)
// instead of only ever due east-west along a parallel: same idea (a real spherical curve that
// projects and re-curves correctly under rotation), generalized to an arbitrary direction.
function destinationPoint(lon0, lat0, bearingDeg, distDeg) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const lat1 = lat0 * toRad;
  const theta = bearingDeg * toRad;
  const delta = distDeg * toRad;
  const sinLat2 = Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(theta);
  const lat2 = Math.asin(clamp(sinLat2, -1, 1));
  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(lat1);
  const x = Math.cos(delta) - Math.sin(lat1) * sinLat2;
  const lon2 = lon0 * toRad + Math.atan2(y, x);
  return [lon2 * toDeg, lat2 * toDeg];
}

// How pronounced the artistic bow is, as a fraction of the label's own half-span. A real
// great-circle arc over a modest span barely bends once projected — geographically correct, but
// reads as "sitting on a flat line" rather than a hand-lettered map label. This is deliberately
// NOT derived from the region's actual geography (unlike the bearing and span, which are) — it's
// a fixed decorative curve on top of the straight axis, same spirit as the exaggerated arcs on
// the Middle-earth map.
const REGION_LABEL_BOW_FACTOR = 0.3;
// The label's angular footprint is a fixed fraction of the region's own measured extent along its
// major axis (majorSpanDeg, from build time), not re-derived from the current zoom/pixel-width
// target the way an earlier version worked. That dynamic approach kept trying to hit an exact
// pixel width every recompute, which is sensitive to foreshortening near the globe's limb (the
// same degree span covers fewer real pixels there than near the sub-point) and could pick a
// meaningfully different curve span from one recompute to the next — labels that visibly changed
// size, or failed to fit at all, for reasons that weren't obvious just looking at the screen. A
// fixed geographic footprint sidesteps both: the label simply doesn't show until zoomed in enough
// for that fixed span to comfortably fit the text, and zooming in deeper only ever helps (more
// pixels across the same span) — a plain, monotonic reveal, with about half the per-candidate
// cost too, since there's no more oversample-then-search, just one pass over exactly the span
// that'll be used.
const REGION_LABEL_SPAN_FRACTION = 0.8;

// Fits `name` (rendered upper-case, letter-spaced, bowed for visible curvature) along the great
// circle through (lon0, lat0) at bearingDeg — the region's own major axis (see regionOrientation
// in build-globe-html.mjs) — spanning majorSpanDeg * REGION_LABEL_SPAN_FRACTION, a fixed
// geographic footprint rather than one re-fit to the current zoom. Gives up (returns null) if any
// sample lands off screen or the fixed span doesn't yet contain enough on-screen pixel distance
// for the text — same "skip rather than force it" choice layoutLabels makes for astro line
// labels; the region simply appears once zoomed in enough rather than trying to always show at a
// possibly-illegible size. Each glyph keeps its own (lon, lat) anchor (interpolated along the
// bowed arc, not a cached screen position), so the caller can re-project — and therefore re-curve
// — live every frame as the globe rotates, rather than freezing the curve's shape at layout time.
function layoutCurvedLabel(name, lon0, lat0, bearingDeg, majorSpanDeg) {
  ctx.font = REGION_LABEL_FONT;
  const chars = [...name.toUpperCase()];
  const charWidths = chars.map((ch) => ctx.measureText(ch).width);
  const totalTextWidth =
    charWidths.reduce((a, b) => a + b, 0) + REGION_LABEL_LETTER_SPACING_PX * (chars.length - 1);

  const spanDeg = majorSpanDeg * REGION_LABEL_SPAN_FRACTION;
  const halfSpanDeg = spanDeg / 2;

  const segment = [];
  for (let i = 0; i <= REGION_LABEL_SAMPLE_STEPS; i++) {
    const distDeg = -halfSpanDeg + (spanDeg * i) / REGION_LABEL_SAMPLE_STEPS;
    const t = halfSpanDeg > 0 ? distDeg / halfSpanDeg : 0;
    const bowDeg = REGION_LABEL_BOW_FACTOR * halfSpanDeg * (1 - t * t);
    const [midLon, midLat] = destinationPoint(lon0, lat0, bearingDeg, distDeg);
    const [lon, lat] = destinationPoint(midLon, midLat, bearingDeg + 90, bowDeg);
    if (!isFrontFacing([lon, lat])) return null; // any point off screen — not zoomed in enough yet
    const p = projection([lon, lat]);
    if (!p || p[0] < 0 || p[0] > width || p[1] < 0 || p[1] > height) return null;
    segment.push({ lon, lat, x: p[0], y: p[1] });
  }

  const cum = [0];
  for (let i = 1; i < segment.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(segment[i].x - segment[i - 1].x, segment[i].y - segment[i - 1].y));
  }
  const totalDist = cum[cum.length - 1];
  if (totalDist < totalTextWidth) return null; // fixed span doesn't have enough pixels yet
  const startOffset = (totalDist - totalTextWidth) / 2; // centers the text within the fixed span

  const glyphs = [];
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let advance = startOffset;
  for (let ci = 0; ci < chars.length; ci++) {
    const charCenterDist = advance + charWidths[ci] / 2;
    let idx = 0;
    while (idx < cum.length - 2 && cum[idx + 1] < charCenterDist) idx++;
    const segLen = cum[idx + 1] - cum[idx];
    const t = segLen > 0 ? clamp((charCenterDist - cum[idx]) / segLen, 0, 1) : 0;
    const lon = segment[idx].lon + (segment[idx + 1].lon - segment[idx].lon) * t;
    const lat = segment[idx].lat + (segment[idx + 1].lat - segment[idx].lat) * t;
    const x = segment[idx].x + (segment[idx + 1].x - segment[idx].x) * t;
    const y = segment[idx].y + (segment[idx + 1].y - segment[idx].y) * t;
    glyphs.push({ lon, lat, char: chars[ci], width: charWidths[ci] });
    left = Math.min(left, x - charWidths[ci] / 2);
    right = Math.max(right, x + charWidths[ci] / 2);
    top = Math.min(top, y - REGION_LABEL_ASCENT);
    bottom = Math.max(bottom, y + REGION_LABEL_DESCENT);
    advance += charWidths[ci] + REGION_LABEL_LETTER_SPACING_PX;
  }
  return { glyphs, left, right, top, bottom };
}

// Same retained-first/hysteresis/collision/fade architecture as recomputeCityLabels — see its
// comment for the reasoning — adapted for curved labels: a "candidate" only becomes placeable
// once layoutCurvedLabel actually fits it, and the collision box is the curved label's own
// glyph-spanning bounding box rather than a simple rectangle at one anchor point.
function recomputeRegionLabels() {
  const now = performance.now();

  const retained = [];
  const retainedKeys = new Set();
  for (const r of regionLabels) {
    if (zoom <= r.minZoom - REGION_LABEL_RETAIN_HYSTERESIS) continue;
    const layout = layoutCurvedLabel(r.name, r.lon, r.lat, r.bearingDeg, r.majorSpanDeg);
    if (!layout) continue;
    retained.push({
      name: r.name,
      lon: r.lon,
      lat: r.lat,
      minZoom: r.minZoom,
      bearingDeg: r.bearingDeg,
      majorSpanDeg: r.majorSpanDeg,
      fadeStartAt: r.fadeStartAt,
      ...layout,
    });
    retainedKeys.add(r.name + '|' + r.lon + '|' + r.lat);
  }
  retained.sort((a, b) => a.minZoom - b.minZoom);

  const candidates = [];
  for (const region of REGION_LABELS) {
    const [name, lon, lat, minZoom, bearingDeg, majorSpanDeg] = region;
    if (zoom <= minZoom) continue;
    if (retainedKeys.has(name + '|' + lon + '|' + lat)) continue;
    if (!isFrontFacing([lon, lat])) continue;
    candidates.push({ name, lon, lat, minZoom, bearingDeg, majorSpanDeg });
  }
  candidates.sort((a, b) => a.minZoom - b.minZoom);

  const placed = [];
  function tryPlace(c, fadeStartAt) {
    if (placed.length >= REGION_LABEL_MAX_COUNT) return;
    const layout = c.glyphs ? c : layoutCurvedLabel(c.name, c.lon, c.lat, c.bearingDeg, c.majorSpanDeg);
    if (!layout) return;
    const { left, right, top, bottom } = layout;
    const collides = placed.some((p) => !(right < p.left || left > p.right || bottom < p.top || top > p.bottom));
    if (collides) return;
    placed.push({
      name: c.name,
      lon: c.lon,
      lat: c.lat,
      minZoom: c.minZoom,
      bearingDeg: c.bearingDeg,
      majorSpanDeg: c.majorSpanDeg,
      glyphs: layout.glyphs,
      left,
      right,
      top,
      bottom,
      fadeStartAt,
    });
  }
  for (const c of retained) tryPlace(c, c.fadeStartAt);
  for (const c of candidates) tryPlace(c, now);

  const placedKeys = new Set(placed.map((c) => c.name + '|' + c.lon + '|' + c.lat));
  const freshlyDropped = regionLabels
    .filter((c) => !placedKeys.has(c.name + '|' + c.lon + '|' + c.lat))
    .map((c) => ({ name: c.name, glyphs: c.glyphs, fadeOutStartAt: now }));
  fadingOutRegionLabels = fadingOutRegionLabels
    .filter((c) => now - c.fadeOutStartAt < LABEL_FADE_MS)
    .concat(freshlyDropped);

  regionLabels = placed;
}

// Greedily nudges each label upward past any already-placed label its bounding box would
// overlap, so a cluster of lines crossing the equator nearby doesn't render as illegible mush.
// Places each label as close as possible to its true anchor without overlapping an
// already-placed one, searching outward ring by ring (radius = ring * RING_STEP) and trying
// several angles per ring rather than only straight up — a dense cluster (e.g. many meridians
// converging near a pole, or now every line's own closest-to-screen-center point) fans out
// around the cluster instead of piling into a single increasingly-tall column. Returns one entry
// per candidate, in the same order, with `null` for any candidate that found no clear spot within
// the search radius — better to skip a label in an extremely crowded spot than force it to
// overlap another.
//
// LABEL_MAX_RINGS needs real headroom now that every line's anchor (pickCenterAnchor) converges
// on the same screen point rather than spreading out on its own — with up to ~40 candidates all
// wanting nearly the same spot, 6 rings (84px radius, 49 slots) wasn't enough room and candidates
// past that point were silently dropped entirely rather than pushed further out, which is what
// made a line's label (Mars, among others) sometimes just not appear at all. 24 rings (336px
// radius, ~193 slots) gives far more capacity than the ~40-candidate ceiling could ever need, so a
// label essentially never gets fully dropped for running out of search room — only genuinely
// duplicate anchors (impossible in practice) would exhaust it. Labels not in a crowded cluster
// still land at or near ring 0 either way; only the crowded ones get pushed out this much further.
const LABEL_RING_STEP = 14;
const LABEL_ANGLES_PER_RING = 8;
const LABEL_MAX_RINGS = 24;
function layoutLabels(candidates) {
  const placed = [];
  const results = [];
  for (const c of candidates) {
    let found = null;
    for (let ring = 0; ring <= LABEL_MAX_RINGS && !found; ring++) {
      const radius = ring * LABEL_RING_STEP;
      const angleCount = ring === 0 ? 1 : LABEL_ANGLES_PER_RING;
      // Offsetting alternate rings by half a step keeps them from all lining up into straight
      // spokes radiating from the anchor.
      const angleOffset = (ring % 2) * (Math.PI / LABEL_ANGLES_PER_RING);
      for (let a = 0; a < angleCount; a++) {
        const angle = angleOffset + (a / LABEL_ANGLES_PER_RING) * Math.PI * 2;
        const x = ring === 0 ? c.x : c.x + radius * Math.cos(angle);
        const y = ring === 0 ? c.y - 8 : c.y - 8 + radius * Math.sin(angle);
        const left = x - c.width / 2 - LABEL_PADDING_X;
        const right = x + c.width / 2 + LABEL_PADDING_X;
        const top = y - LABEL_ASCENT;
        const bottom = y + LABEL_DESCENT;
        const collides = placed.some((p) => !(right < p.left || left > p.right || bottom < p.top || top > p.bottom));
        if (!collides) {
          found = { x, y, left, right, top, bottom };
          break;
        }
      }
    }
    if (!found) {
      results.push(null);
      continue;
    }
    placed.push(found);
    results.push({
      x: found.x,
      y: found.y,
      bodyId: c.bodyId,
      glyph: c.glyph,
      kind: c.kind,
      glyphWidth: c.glyphWidth,
      glyphBaselineShift: c.glyphBaselineShift,
      width: c.width,
      color: c.color,
      left: found.left,
      right: found.right,
      top: found.top,
      bottom: found.bottom,
    });
  }
  return results;
}

// One chosen anchor point per line, keyed by body+kind. Re-picking every frame made labels crawl
// continuously along their line during rotation — distracting, and nothing like a label "staying
// put". Instead we pick once (see recomputeLabels()) and keep it as long as it still faces the
// viewer, so the label rotates naturally with the sphere (like the line itself) and only
// relocates on the rare occasion its current spot rotates out of view.
const labelAnchors = new Map();
// Facing the viewer isn't enough on its own — that's an angular/hemisphere check, unrelated to
// the current zoom. Zooming in crops the view to a smaller area of the globe, so a point chosen
// while more zoomed out can still "face the viewer" while sitting well outside the visible
// canvas, and the label would silently render off-screen. A margin keeps the whole pill
// comfortably inside the edges, not just its anchor point.
const LABEL_EDGE_MARGIN = 40;
function isOnScreen(point) {
  if (!isFrontFacing(point)) return false;
  const p = projection(point);
  if (!p) return false;
  return (
    p[0] >= LABEL_EDGE_MARGIN &&
    p[0] <= width - LABEL_EDGE_MARGIN &&
    p[1] >= LABEL_EDGE_MARGIN &&
    p[1] <= height - LABEL_EDGE_MARGIN
  );
}

// Picks the on-screen point along a line closest to the screen's center — every line's label
// sits wherever that line itself passes nearest the middle of the current view, the most direct
// reading of "the label is on its line, in the center of the screen." Ties/near-ties (two lines
// both passing close to center at similar points) are expected and fine here — layoutLabels'
// collision search is what actually keeps two labels from overlapping, nudging one only as far
// from its true nearest-to-center point as it needs to; this function's job is just picking each
// line's ideal spot before that local nudging happens.
//
// Candidates are restricted to a central zone (LABEL_CENTER_RADIUS_FRACTION of the screen's
// shorter dimension) wherever the line has any points there — a line that doesn't pass anywhere
// near the middle of the screen still needs an anchor somewhere, so falls back to its closest
// approach even outside the zone, rather than getting no label at all.
const LABEL_CENTER_RADIUS_FRACTION = 0.42;
function pickCenterAnchor(line, center) {
  const maxRadius = Math.min(width, height) * LABEL_CENTER_RADIUS_FRACTION;
  let best = null;
  let bestScore = Infinity; // distance to screen center — lower is better
  let bestFallback = null;
  let bestFallbackScore = Infinity;
  for (const segment of line.feature.coordinates) {
    for (const point of segment) {
      if (!isOnScreen(point)) continue;
      const p = projection(point);
      if (!p) continue;
      const centerDist = Math.hypot(p[0] - center[0], p[1] - center[1]);
      // Track the best in-zone candidate, and separately the best overall in case the line
      // never enters the zone (e.g. it only clips a far corner of the current view).
      if (centerDist < bestFallbackScore) {
        bestFallbackScore = centerDist;
        bestFallback = point;
      }
      if (centerDist <= maxRadius && centerDist < bestScore) {
        bestScore = centerDist;
        best = point;
      }
    }
  }
  return best || bestFallback;
}

// Recomputes label positions from scratch — candidate anchors, glyph/kind metrics, and the
// overlap-avoiding stagger layout — caching the result in renderedLabels for render() to just
// redraw every frame without recalculating. Call this only at discrete moments (new line data,
// an interaction ending), never from inside the per-frame render path, or labels are back to
// sliding continuously during rotation.
function recomputeLabels() {
  const center = [width / 2, height / 2];
  ctx.font = '600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

  // Pass 1: keep any still-valid cached anchor as-is — still on-screen, so still a fine spot on
  // (or near) the ring.
  const anchorForLine = new Map();
  for (const line of astroLines) {
    const key = line.bodyId + ':' + line.kind;
    const cached = labelAnchors.get(key);
    if (cached && isOnScreen(cached)) anchorForLine.set(key, cached);
  }
  // Pass 2: everything else gets a fresh anchor at its own closest approach to center (see
  // pickCenterAnchor) — each line is scored independently against the same fixed center point,
  // not against where other lines already landed, so this doesn't need to run in any particular
  // order.
  for (const line of astroLines) {
    const key = line.bodyId + ':' + line.kind;
    if (anchorForLine.has(key)) continue;
    const fresh = pickCenterAnchor(line, center);
    if (fresh) {
      anchorForLine.set(key, fresh);
      labelAnchors.set(key, fresh);
    } else {
      labelAnchors.delete(key);
    }
  }

  const candidates = [];
  for (const line of astroLines) {
    const anchor = anchorForLine.get(line.bodyId + ':' + line.kind);
    if (!anchor) continue;
    const p = projection(anchor);
    if (!p) continue;
    const glyph = BODY_GLYPHS[line.bodyId] || line.bodyId;
    const kind = line.kind;
    const glyphMetrics = ctx.measureText(glyph);
    const kindMetrics = ctx.measureText(kind);
    const labelWidth = glyphMetrics.width + GLYPH_KIND_GAP + kindMetrics.width;
    candidates.push({
      anchor,
      bodyId: line.bodyId,
      x: p[0],
      y: p[1],
      glyph,
      kind,
      glyphWidth: glyphMetrics.width,
      // Baseline offset that aligns this glyph's visual vertical center with the kind text's.
      // The measured correction leaves Venus/Mars sitting slightly low regardless — the
      // fallback symbol font's reported bounding box for those two is a bit imprecise — so
      // nudge them up a touch on top of the measured value.
      glyphBaselineShift:
        (kindMetrics.actualBoundingBoxAscent - kindMetrics.actualBoundingBoxDescent) / 2 -
        (glyphMetrics.actualBoundingBoxAscent - glyphMetrics.actualBoundingBoxDescent) / 2 +
        (GLYPH_BASELINE_FINE_TUNE[line.bodyId] || 0),
      color: line.color,
      width: labelWidth,
    });
  }
  // Keep only the labels closest to wherever the user is actually looking (screen center) when
  // there are more candidates than labelCapForZoom() allows at the current zoom — a neutral
  // criterion that doesn't have to decide any one body/line kind matters more than another.
  candidates.sort((a, b) => {
    const da = (a.x - center[0]) ** 2 + (a.y - center[1]) ** 2;
    const db = (b.x - center[0]) ** 2 + (b.y - center[1]) ** 2;
    return da - db;
  });
  const cappedCandidates = candidates.slice(0, labelCapForZoom());

  // layoutLabels doesn't reorder or drop entries, so placed[i] always corresponds to
  // cappedCandidates[i] — used below to recover each label's offset from its raw anchor
  // projection.
  const placed = layoutLabels(cappedCandidates);
  renderedLabels = placed
    .map((label, i) =>
      label && {
        anchor: cappedCandidates[i].anchor,
        bodyId: label.bodyId,
        offsetX: label.x - candidates[i].x,
        offsetY: label.y - candidates[i].y,
        glyph: label.glyph,
        kind: label.kind,
        glyphWidth: label.glyphWidth,
        glyphBaselineShift: label.glyphBaselineShift,
        color: label.color,
        width: label.width,
      }
    )
    .filter(Boolean);
  labelsFadeStartAt = performance.now();
}

function tick(now) {
  if (lastFrameAt === null) lastFrameAt = now;
  const dt = now - lastFrameAt;
  lastFrameAt = now;

  const idle = pointers.size === 0 && now - lastInteractionAt > IDLE_DELAY_MS && zoom === MIN_ZOOM && !pin;
  if (idle) {
    rotation[0] += AUTO_ROTATE_DEG_PER_MS * dt;
  }
  // Keep rendering through an in-progress label fade (in or out) even when otherwise idle-still,
  // so the animation actually plays instead of snapping straight to its end state on the next
  // redraw — matters most for city labels, since a fade starts right at gesture end, when nothing
  // else is left to keep triggering renders.
  let cityFading = false;
  for (const entry of cityLabelState.values()) {
    if (entry.phase !== 'visible') {
      cityFading = true;
      break;
    }
  }
  const regionLabelFading =
    regionLabels.some((c) => now - c.fadeStartAt < LABEL_FADE_MS) ||
    fadingOutRegionLabels.some((c) => now - c.fadeOutStartAt < LABEL_FADE_MS);
  const fading = now - labelsFadeStartAt < LABEL_FADE_MS || cityFading || regionLabelFading;
  if (idle || fading) {
    render();
  }
  requestAnimationFrame(tick);
}

// --- Gesture handling -------------------------------------------------

const pointers = new Map();
let dragLast = null;
let pinchStart = null; // { distance, zoom }
let tapCandidate = null; // { x, y, t }

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function onPointerDown(e) {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  lastInteractionAt = performance.now();

  if (pointers.size === 1) {
    dragLast = { x: e.clientX, y: e.clientY };
    tapCandidate = { x: e.clientX, y: e.clientY, t: Date.now() };
  } else {
    tapCandidate = null;
  }
  if (pointers.size === 2) {
    const [a, b] = Array.from(pointers.values());
    pinchStart = { distance: distanceBetween(a, b), zoom };
  }
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  lastInteractionAt = performance.now();

  if (pointers.size === 1 && dragLast) {
    const dx = e.clientX - dragLast.x;
    const dy = e.clientY - dragLast.y;
    dragLast = { x: e.clientX, y: e.clientY };

    if (tapCandidate) {
      const moved = Math.hypot(e.clientX - tapCandidate.x, e.clientY - tapCandidate.y);
      if (moved > 6) tapCandidate = null;
    }

    const rotSpeed = 220 / (baseScale * zoom);
    rotation[0] += dx * rotSpeed;
    rotation[1] = clamp(rotation[1] - dy * rotSpeed, -85, 85);
    maybeRecomputeCityLabelsDuringGesture();
    render();
  } else if (pointers.size === 2 && pinchStart) {
    const [a, b] = Array.from(pointers.values());
    const dist = distanceBetween(a, b);
    if (pinchStart.distance > 0) {
      // Raising the raw finger-distance ratio to a power (rather than using it directly) means a
      // single comfortable pinch reaches deep zoom on its own, rather than needing finger distance
      // to grow by the same multiple as the zoom change (awkward on a phone screen for anything
      // past a couple of x). This only changes how fast a pinch moves through the range, not the
      // range itself.
      const ratio = Math.pow(dist / pinchStart.distance, PINCH_ZOOM_POWER);
      zoom = clamp(ratio * pinchStart.zoom, MIN_ZOOM, MAX_ZOOM);
      applyScale();
      maybeRecomputeCityLabelsDuringGesture();
      render();
    }
  }
}

function onPointerUp(e) {
  const wasSingle = pointers.size === 1 && pointers.has(e.pointerId);
  pointers.delete(e.pointerId);
  lastInteractionAt = performance.now();
  dragLast = null;
  pinchStart = null;

  if (wasSingle && tapCandidate) {
    const elapsed = Date.now() - tapCandidate.t;
    const moved = Math.hypot(e.clientX - tapCandidate.x, e.clientY - tapCandidate.y);
    if (elapsed < 500 && moved < 6) {
      handleTap(e.clientX, e.clientY);
    }
  }
  tapCandidate = null;

  // Astro line labels and region labels still only ever recompute here, at gesture end — city
  // labels now also recompute continuously during the gesture itself, gated by real movement (see
  // maybeRecomputeCityLabelsDuringGesture), but this unconditional call on release is still what
  // guarantees the final state exactly matches wherever the user actually ended up, rather than
  // "close enough as of the last gated recompute".
  if (pointers.size === 0) {
    recomputeLabels();
    recomputeCityLabels();
    if (SHOW_REGION_LABELS) recomputeRegionLabels();
    render();
  }
}

function handleTap(x, y) {
  const hitLabel = hitTestLabel(x, y);
  if (hitLabel) {
    postToRN({ type: 'lineTap', bodyId: hitLabel.bodyId, kind: hitLabel.kind });
    return;
  }
  const hitLine = hitTestLine(x, y);
  if (hitLine) {
    postToRN({ type: 'lineTap', bodyId: hitLine.bodyId, kind: hitLine.kind });
    return;
  }

  const lonLat = projection.invert([x, y]);
  if (!lonLat) return;
  const roundTrip = projection(lonLat);
  if (!roundTrip || Math.hypot(roundTrip[0] - x, roundTrip[1] - y) > 2) return;

  const [lon, lat] = lonLat;
  postToRN({ type: 'tap', lon, lat });
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
window.addEventListener('resize', resize);

// --- RN <-> WebView messaging ------------------------------------------

function postToRN(message) {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
}

function handleRNMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (err) {
    return;
  }
  if (message.type === 'lines') {
    astroLines = (message.lines || []).map((line) => ({
      bodyId: line.bodyId,
      kind: line.kind,
      color: line.color,
      feature: { type: 'MultiLineString', coordinates: line.segments },
    }));
    recomputeLabels();
    render();
  } else if (message.type === 'pin') {
    pin = message.lon != null && message.lat != null ? [message.lon, message.lat] : null;
    render();
  }
}

document.addEventListener('message', (e) => handleRNMessage(e.data));
window.addEventListener('message', (e) => handleRNMessage(e.data));

resize();
requestAnimationFrame(tick);
postToRN({ type: 'ready' });
