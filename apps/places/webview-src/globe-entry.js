import { geoOrthographic, geoPath } from 'd3-geo';
import { angularDistanceDeg, clamp, isFrontFacing as geoIsFrontFacing, visibleCapRadiusDeg as geoVisibleCapRadiusDeg } from './city-labels/geo.js';
import { selectCityLabels, CITY_RETAIN_HYSTERESIS, CITY_BASE_MIN_ZOOM } from './city-labels/selection.js';
import { createLabelStateStore, applySelection, dropStaleByZoom, advance as advanceLabelState } from './city-labels/stateMachine.js';
import { drawCityLabels, cityLabelFont } from './city-labels/render.js';

// LAND_GEOJSON, BORDER_GEOJSON, LAND_DETAIL_PIECES, LAND_DETAIL_BBOXES, TINY_ISLAND_PIECES,
// TINY_ISLAND_BBOXES, BORDER_DETAIL_ARCS, BORDER_DETAIL_BBOXES, REGION_BORDER_ARCS,
// REGION_BORDER_BBOXES, REGION_LABELS, US_STATE_LABELS, CITIES, and THEME are injected as globals
// by the HTML wrapper at build time.
/* global LAND_GEOJSON, BORDER_GEOJSON, LAND_DETAIL_PIECES, LAND_DETAIL_BBOXES, TINY_ISLAND_PIECES, TINY_ISLAND_BBOXES, BORDER_DETAIL_ARCS, BORDER_DETAIL_BBOXES, REGION_BORDER_ARCS, REGION_BORDER_BBOXES, REGION_LABELS, US_STATE_LABELS, CITIES, THEME */

// Temporary flag — region labels are getting a hand-drawn redesign, so they're switched off here
// rather than removed: the curve-fitting and recompute logic underneath is all still intact and
// ready to reuse once new artwork/fonts are ready, this just skips the recompute and drawing in
// the meantime.
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
let zoom = 2;
const MIN_ZOOM = 1;
const MAX_ZOOM = 1000;
// Exponent applied to the raw pinch finger-distance ratio (see onPointerMove) — tuned so a single
// comfortable pinch (roughly tripling finger distance) already clears every city reveal
// threshold.
const PINCH_ZOOM_POWER = 1.8;
// The land "detail" tier ramps in smoothly across this zoom range, rather than snapping on at a
// single threshold — same idea as Apple Maps/Flighty showing more map detail the deeper you zoom
// in. Pushed out to a much deeper zoom than a purely visual choice would call for: the coarse
// tier is what's on screen for most of the zoom range now, so there's simply far fewer vertices
// to re-trace on every frame during ordinary panning/pinching — a static, zoom-only threshold
// rather than switching tiers based on live interaction state, which read as popping/flickering
// when it was tried. Land gets this deep threshold (rather than sharing one with country borders,
// like it used to) because it's the more expensive layer to trace either way — its detail tier is
// smoothPath-rendered (quadratic-curve corner rounding, extra per-vertex math on top of the raw
// point count the border layers don't pay).
const LAND_DETAIL_FADE_START = 10;
const LAND_DETAIL_FADE_END = 10.8;
// State/province borders finish fading in by this zoom — not pushed out deep like land's, above.
const STATE_BORDER_MIN_ZOOM = 3;
// State borders, their abbreviation labels, and country-border detail all fade in together over
// this same window, reaching full opacity together at STATE_BORDER_MIN_ZOOM — a popped-in state
// line next to a still-fading (or still-coarse) country border would visibly read as mismatched
// fidelity right next to each other, and an instant on/off snap for state borders/labels read as a
// glitch rather than a deliberate reveal (both tried and rejected — see BORDER_DETAIL_FADE_START's
// use at each of those draw sites for the actual alpha value shared by all three). Tied to
// STATE_BORDER_MIN_ZOOM by construction, not just matched by coincidence, so the three can't drift
// apart again if the threshold changes later.
const BORDER_DETAIL_FADE_END = STATE_BORDER_MIN_ZOOM;
const BORDER_DETAIL_FADE_START = STATE_BORDER_MIN_ZOOM - 0.8;
// Tiny islands (see TINY_ISLAND_MAX_DEG in build-globe-html.mjs — every uninhabited rock/atoll
// -explode split into its own piece) are held out of both the coarse and detail land tiers
// entirely below this zoom; at a zoomed-out view they read as flecks of dirt scattered across the
// ocean rather than actual geography. A hard cutoff, not a fade, same reasoning as state borders.
const TINY_ISLAND_MIN_ZOOM = 10;
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

// US state abbreviation labels (Apple Maps-style — plain, bold, dead center in the state, all
// shown together rather than curved/staggered like the region name labels above). Bold sans-serif
// rather than the city labels' italic serif, so the two read as distinct kinds of information at a
// glance, but the same fill color as city labels (THEME.cityLabel, at the draw site) so they read
// as part of the same map-label family rather than a third, competing color. Same white-halo
// technique as city labels (see city-labels/render.js) for legibility crossing over state/country
// border lines and coastlines underneath.
const US_STATE_LABEL_FONT = '700 9px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
const US_STATE_LABEL_OUTLINE_COLOR = '#FFFFFF';
const US_STATE_LABEL_OUTLINE_WIDTH = 3;
let regionLabels = []; // [{ name, lon, lat, minZoom, glyphs: [{lon, lat, char, width}], left, right, top, bottom, fadeStartAt }]
let fadingOutRegionLabels = []; // [{ name, glyphs, fadeOutStartAt }]

// Shared fade duration for region labels' own fade in/out (see the draw and recompute sites
// below) — was also shared with astro line labels before those were removed for this app.
const LABEL_FADE_MS = 220;

// Saved-place pins — chat-bubble markers for the user's saved places. Pushed in live from React
// Native via postMessage (see the RN<->WebView messaging section below) rather than baked in at
// build time like the rest of the map, since this data is per-user and changes at runtime.
const PIN_FLOWER_EMOJIS = ['🌸', '🌷', '🌹', '🌺', '🌻', '🌼'];
const PIN_BUBBLE_SIZE = 34; // diameter of the bubble body, CSS px
const PIN_BUBBLE_RADIUS = 10; // corner radius of the bubble body
const PIN_TAIL_HEIGHT = 9; // gap between the bubble's bottom edge and the exact lat/lon point
const PIN_FONT = `${Math.round(PIN_BUBBLE_SIZE * 0.55)}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
let savedPlacePins = []; // [{ id, lon, lat, emoji }] — set via the 'setSavedPlaces' RN message
let pinHitboxes = []; // rebuilt every frame in drawSavedPlacePins; consumed by handleTap

// A stable (not random-per-frame) emoji per place, so a given pin always shows the same flower —
// derived from the place id itself rather than stored separately, so there's nothing to keep in
// sync if the same place list gets pushed in again.
function emojiForPlaceId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PIN_FLOWER_EMOJIS[hash % PIN_FLOWER_EMOJIS.length];
}

// Manual rounded-rect path (arcTo is far more broadly supported than ctx.roundRect) for the
// bubble body below.
function traceRoundedRectPath(cx, left, top, size, radius) {
  const right = left + size;
  const bottom = top + size;
  cx.beginPath();
  cx.moveTo(left + radius, top);
  cx.lineTo(right - radius, top);
  cx.arcTo(right, top, right, top + radius, radius);
  cx.lineTo(right, bottom - radius);
  cx.arcTo(right, bottom, right - radius, bottom, radius);
  cx.lineTo(left + radius, bottom);
  cx.arcTo(left, bottom, left, bottom - radius, radius);
  cx.lineTo(left, top + radius);
  cx.arcTo(left, top, left + radius, top, radius);
  cx.closePath();
}

// Drawn last (after everything else, including labels) so pins are never hidden underneath the
// map itself — see the call site in renderInner.
function drawSavedPlacePins() {
  pinHitboxes = [];
  if (savedPlacePins.length === 0) return;

  const half = PIN_BUBBLE_SIZE / 2;
  ctx.font = PIN_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const pin of savedPlacePins) {
    if (!isFrontFacing([pin.lon, pin.lat])) continue;
    const p = projection([pin.lon, pin.lat]);
    if (!p) continue;
    const [x, y] = p;
    if (x < -half || x > width + half || y < -PIN_BUBBLE_SIZE || y > height + half) continue;

    const bubbleBottom = y - PIN_TAIL_HEIGHT;
    const bubbleTop = bubbleBottom - PIN_BUBBLE_SIZE;
    const left = x - half;

    // Tail: filled only (no stroke), so it reads as a seamless extension of the bubble above it
    // rather than a separately outlined shape.
    ctx.beginPath();
    ctx.moveTo(x - 6, bubbleBottom - 1);
    ctx.lineTo(x, y);
    ctx.lineTo(x + 6, bubbleBottom - 1);
    ctx.closePath();
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();

    traceRoundedRectPath(ctx, left, bubbleTop, PIN_BUBBLE_SIZE, PIN_BUBBLE_RADIUS);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = THEME.landStroke;
    ctx.stroke();

    ctx.fillText(pin.emoji, x, bubbleTop + half);

    pinHitboxes.push({
      id: pin.id,
      lon: pin.lon,
      lat: pin.lat,
      x,
      y,
      radius: half + PIN_TAIL_HEIGHT + 6,
    });
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

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

  // Land — flat white fill (THEME.land), separating it from the now-tinted ocean rather than
  // leaving it unfilled to just show ocean color through the gap, for the most minimal version of
  // the map. Finer coastline detail fades in on top once zoomed in: LAND_GEOJSON is a coarse (~2%
  // simplified) always-on base so the resting/at-rest view never pays for more resolution than it
  // needs, LAND_DETAIL_PIECES is
  // the same source simplified far less, revealing smaller islands and more accurate coastlines
  // the coarse tier smooths away or drops entirely — except the very smallest islands, which are
  // held out of both tiers and shown separately below (see TINY_ISLAND_MIN_ZOOM).
  //
  // The coarse tier only actually needs to draw while the detail tier is transparent or fading
  // in — once detail reaches full opacity it completely covers the coarse shape underneath, so
  // drawing (and clipping, the more expensive part) the coarse tier too past that point is pure
  // wasted work. Same reasoning applies everywhere else a coarse/detail pair appears below.
  const landDetailAlpha = clamp((zoom - LAND_DETAIL_FADE_START) / (LAND_DETAIL_FADE_END - LAND_DETAIL_FADE_START), 0, 1);
  if (landDetailAlpha < 1) {
    ctx.beginPath();
    path(LAND_GEOJSON);
    ctx.fillStyle = THEME.land;
    ctx.fill();
    ctx.lineWidth = 0.5;
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
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = THEME.landStroke;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Tiny islands — held out of both tiers above entirely below TINY_ISLAND_MIN_ZOOM (see its
  // comment). Same draw style as the detail tier (smoothed, filled, same stroke) since it's
  // really just that tier's own leftover pieces, revealed on their own deeper threshold rather
  // than dropped.
  if (zoom >= TINY_ISLAND_MIN_ZOOM) {
    ctx.beginPath();
    for (let i = 0; i < TINY_ISLAND_PIECES.length; i++) {
      if (cullByBbox(TINY_ISLAND_BBOXES[i], capRadiusDeg)) {
        smoothPath({ type: 'Polygon', coordinates: TINY_ISLAND_PIECES[i] });
      }
    }
    smoothPathContext.flush();
    ctx.fillStyle = THEME.land;
    ctx.fill();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = THEME.landStroke;
    ctx.stroke();
  }

  // State/province borders for every country, drawn under country borders (so the country
  // outline reads as the more prominent line). Fades in over BORDER_DETAIL_FADE_START..END, the
  // same window (and the same computed alpha, borderDetailAlpha below) shared with the country
  // border detail tier and the US state abbreviation labels — see the comment on
  // BORDER_DETAIL_FADE_START above for why all three move together rather than each fading (or
  // snapping) on its own schedule. At full zoom-out this level of detail is just noise, the same
  // reasoning as the line labels.
  const borderDetailAlpha = clamp((zoom - BORDER_DETAIL_FADE_START) / (BORDER_DETAIL_FADE_END - BORDER_DETAIL_FADE_START), 0, 1);
  if (borderDetailAlpha > 0) {
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
    ctx.globalAlpha = borderDetailAlpha;
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

  // Country borders — coarse tier always-on, finer tier fades in on top once zoomed in (same
  // borderDetailAlpha computed above, alongside state borders), same two-tier idea as the
  // land/coastline detail above (including skipping the coarse tier once the detail tier is fully
  // opaque and covering it).
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

  // US state abbreviations — same fade window as the state borders themselves (borderDetailAlpha,
  // computed above); every state's label fades in together rather than a per-state reveal,
  // matching Apple Maps rather than the population/area-scaled reveal city and (disabled)
  // region-name labels use.
  if (borderDetailAlpha > 0) {
    ctx.font = US_STATE_LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = borderDetailAlpha;
    for (const [abbr, lon, lat] of US_STATE_LABELS) {
      if (!isFrontFacing([lon, lat])) continue;
      const p = projection([lon, lat]);
      if (!p || p[0] < 0 || p[0] > width || p[1] < 0 || p[1] > height) continue;
      ctx.lineWidth = US_STATE_LABEL_OUTLINE_WIDTH;
      ctx.strokeStyle = US_STATE_LABEL_OUTLINE_COLOR;
      ctx.strokeText(abbr, p[0], p[1]);
      ctx.fillStyle = THEME.cityLabel;
      ctx.fillText(abbr, p[0], p[1]);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
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

  // Globe edge outline, same weight as country borders.
  ctx.beginPath();
  path({ type: 'Sphere' });
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = THEME.globeOutline;
  ctx.stroke();

  // Saved-place pins — drawn after everything else on the map so they always sit on top.
  drawSavedPlacePins();

  // On-screen zoom readout, top-left, drawn last so it's always legible regardless of what's
  // underneath.
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

// Whether a [lon, lat] point currently faces the viewer, given the globe's rotation. Thin wrapper
// over city-labels/geo.js's parameterized version (which the label modules also use directly,
// without this closure) — kept as a same-signature wrapper here rather than rewriting every one of
// this file's many call sites to pass rotation explicitly.
function isFrontFacing([lon, lat]) {
  return geoIsFrontFacing(lon, lat, -rotation[0], -rotation[1]);
}

// Once zoomed in enough that the canvas shows only a slice of the front hemisphere, most of a
// detail layer's geometry (land-detail polygons, border/region-border arcs) is still technically
// "front-facing" by isFrontFacing's hemisphere test but projects way outside the
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
// for the text — the region simply appears once zoomed in enough rather than trying to always
// show at a possibly-illegible size. Each glyph keeps its own (lon, lat) anchor (interpolated along the
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

function tick(now) {
  if (flyToAnimation) {
    const t = clamp((now - flyToAnimation.startTime) / FLY_TO_DURATION_MS, 0, 1);
    const eased = easeInOutCubic(t);
    rotation[0] = flyToAnimation.startLambda + flyToAnimation.lambdaDelta * eased;
    rotation[1] = flyToAnimation.startPhi + flyToAnimation.phiDelta * eased;
    zoom = flyToAnimation.startZoom + flyToAnimation.zoomDelta * eased;
    applyScale();
    render();
    if (t >= 1) {
      flyToAnimation = null;
      // Same "exact match at the end of a camera move" recompute already done at ordinary
      // gesture end (see onPointerUp) — the flight is a camera move too, just not driven by a
      // pointer gesture.
      recomputeCityLabels();
      if (SHOW_REGION_LABELS) recomputeRegionLabels();
    }
    requestAnimationFrame(tick);
    return;
  }

  // Keep rendering through an in-progress label fade (in or out) even when otherwise still, so
  // the animation actually plays instead of snapping straight to its end state on the next
  // redraw — matters most for city labels, since a fade starts right at gesture end, when nothing
  // else is left to keep triggering renders. No idle auto-rotation here: the globe stays exactly
  // where the user left it until their next gesture.
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
  if (cityFading || regionLabelFading) {
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

  // Region labels still only ever recompute here, at gesture end — city labels now also
  // recompute continuously during the gesture itself, gated by real movement (see
  // maybeRecomputeCityLabelsDuringGesture), but this unconditional call on release is still what
  // guarantees the final state exactly matches wherever the user actually ended up, rather than
  // "close enough as of the last gated recompute".
  if (pointers.size === 0) {
    recomputeCityLabels();
    if (SHOW_REGION_LABELS) recomputeRegionLabels();
    render();
  }
}

// Animated camera move to center a tapped pin at max zoom — driven every frame from tick() below
// while active (tick otherwise stays idle when nothing needs to redraw, per its own comment).
// null when no flight is in progress.
let flyToAnimation = null; // { startLambda, lambdaDelta, startPhi, phiDelta, startZoom, zoomDelta, startTime }
const FLY_TO_DURATION_MS = 700;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Longitude wraps at +-180 — always taking the shortest way round rather than the raw numeric
// difference means a pin near the antimeridian never spins the long way across the globe.
function shortestAngleDeltaDeg(from, to) {
  return (((to - from + 180) % 360) + 360) % 360 - 180;
}

// The place-detail panel covers the bottom of the screen at this fraction of its height (see
// PlaceDetailPanel.tsx's `panel.height` style — RN and this WebView bundle are separate build
// contexts, so this can't be a literal shared constant, just kept in sync by hand).
const PANEL_HEIGHT_FRACTION = 0.58;

function flyToLocation(lon, lat, targetZoom) {
  const targetLambda = -lon;
  // Centering the raw target latitude would put the pin at the canvas's true vertical center —
  // which sits behind the panel. Nudging the "look-at" latitude south by a small angle shifts the
  // point north within the projection, landing it in the middle of the exposed strip above the
  // panel instead. The angle is computed from a fixed screen-pixel offset converted at the
  // *target* zoom/scale (small-angle approximation, accurate here since this only ever targets
  // MAX_ZOOM, where the resulting angle is tiny).
  const targetScale = baseScale * targetZoom;
  const exposedCenterY = (height * (1 - PANEL_HEIGHT_FRACTION)) / 2;
  const offsetPx = height / 2 - exposedCenterY;
  const offsetDeg = (offsetPx / targetScale) * (180 / Math.PI);
  const targetPhi = -lat + offsetDeg;
  flyToAnimation = {
    startLambda: rotation[0],
    lambdaDelta: shortestAngleDeltaDeg(rotation[0], targetLambda),
    startPhi: rotation[1],
    phiDelta: targetPhi - rotation[1],
    startZoom: zoom,
    zoomDelta: targetZoom - zoom,
    startTime: performance.now(),
  };
}

// Only saved-place pins respond to a tap — pinHitboxes is rebuilt every frame by
// drawSavedPlacePins, so this always checks against wherever pins were actually last drawn.
// Tapping empty map (not a pin) is intentionally a no-op; there's no RN listener for a generic
// lon/lat tap anymore.
function handleTap(x, y) {
  for (const hitbox of pinHitboxes) {
    if (Math.hypot(x - hitbox.x, y - hitbox.y) <= hitbox.radius) {
      postToRN({ type: 'pinTap', placeId: hitbox.id });
      flyToLocation(hitbox.lon, hitbox.lat, MAX_ZOOM);
      return;
    }
  }
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
window.addEventListener('resize', resize);

// --- RN <-> WebView messaging ------------------------------------------
// Outbound: 'ready' below, 'tap'/'pinTap' from handleTap. Inbound: 'setSavedPlaces', pushed from
// React Native whenever the user's saved-places list changes — that data is per-user and can't be
// baked in at build time like the rest of the map.

function postToRN(message) {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
}

function handleRNMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.type === 'setSavedPlaces' && Array.isArray(message.places)) {
    savedPlacePins = message.places.map((place) => ({
      id: place.id,
      lon: place.lon,
      lat: place.lat,
      emoji: emojiForPlaceId(place.id),
    }));
    render();
  }
}
// react-native-webview fires the message event on document on Android and window on iOS —
// listening on both is the standard cross-platform way to handle it.
window.addEventListener('message', handleRNMessage);
document.addEventListener('message', handleRNMessage);

resize();
requestAnimationFrame(tick);
postToRN({ type: 'ready' });
