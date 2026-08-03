import { geoOrthographic, geoPath } from 'd3-geo';

// LAND_GEOJSON, BORDER_GEOJSON, US_STATE_BORDER_GEOJSON, and THEME are injected as globals by the
// HTML wrapper at build time.
/* global LAND_GEOJSON, BORDER_GEOJSON, US_STATE_BORDER_GEOJSON, THEME */

const canvas = document.getElementById('globe');
const ctx = canvas.getContext('2d');

const projection = geoOrthographic().clipAngle(90).precision(0.3);
const path = geoPath(projection, ctx);

let width = 0;
let height = 0;
let dpr = Math.max(1, window.devicePixelRatio || 1);

let rotation = [10, -12]; // [lambda, phi], degrees
let zoom = 1;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4.5;
let baseScale = 100;

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
  dpr = Math.max(1, window.devicePixelRatio || 1);
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

function renderInner() {
  projection.rotate(rotation);
  ctx.clearRect(0, 0, width, height);

  const center = [width / 2, height / 2];
  const radius = baseScale * zoom;

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

  // Land.
  ctx.beginPath();
  path(LAND_GEOJSON);
  ctx.fillStyle = THEME.land;
  ctx.fill();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = THEME.landStroke;
  ctx.stroke();

  // US state borders (drawn under country borders, since state lines end at the coast/border
  // and the country outline should read as the more prominent line).
  ctx.beginPath();
  path(US_STATE_BORDER_GEOJSON);
  ctx.lineWidth = 0.4;
  ctx.strokeStyle = THEME.usStateBorder;
  ctx.stroke();

  // Country borders.
  ctx.beginPath();
  path(BORDER_GEOJSON);
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = THEME.countryBorder;
  ctx.stroke();

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
  if (zoom > MIN_ZOOM) {
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = Math.min(1, (performance.now() - labelsFadeStartAt) / LABEL_FADE_MS);
    for (const label of renderedLabels) {
      if (!isFrontFacing(label.anchor)) continue;
      const p = projection(label.anchor);
      if (!p) continue;
      const x = p[0] + label.offsetX;
      const y = p[1] + label.offsetY;

      const left = x - label.width / 2 - LABEL_PADDING_X;
      const right = x + label.width / 2 + LABEL_PADDING_X;
      const top = y - LABEL_ASCENT;
      const bottom = y + LABEL_DESCENT;
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

// Whether a [lon, lat] point currently faces the viewer, given the globe's rotation.
function isFrontFacing([lon, lat]) {
  const toRad = Math.PI / 180;
  const lambda0 = -rotation[0] * toRad;
  const phi0 = -rotation[1] * toRad;
  const lambda = lon * toRad;
  const phi = lat * toRad;
  const cosc = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0);
  return cosc > 0;
}

// Greedily nudges each label upward past any already-placed label its bounding box would
// overlap, so a cluster of lines crossing the equator nearby doesn't render as illegible mush.
// Places each label as close as possible to its true anchor without overlapping an
// already-placed one, searching outward ring by ring (radius = ring * RING_STEP) and trying
// several angles per ring rather than only straight up — a dense cluster (e.g. many meridians
// converging near a pole) fans out around the cluster instead of piling into a single
// increasingly-tall column. Returns one entry per candidate, in the same order, with `null`
// for any candidate that found no clear spot within the search radius — better to skip a label
// in an extremely crowded spot than force it to overlap another.
const LABEL_RING_STEP = 14;
const LABEL_ANGLES_PER_RING = 8;
const LABEL_MAX_RINGS = 6;
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

// Picks the on-screen point along a line that's farthest from every already-chosen label
// position this pass, with a mild pull toward the screen center as a tie-breaker (and as the
// sole criterion for the very first label placed, when there's nothing yet to spread away from).
// This is what makes labels spread out along each line's own visible length to fill empty space,
// rather than every line racing toward the single point nearest the center — which piled a wall
// of labels into one spot while the rest of the screen sat empty.
//
// Candidates are restricted to a central zone (LABEL_CENTER_RADIUS_FRACTION of the screen's
// shorter dimension) wherever the line has any points there — spreading is only applied within
// that zone, not the line's full length. Without this cap, "farthest from everything else" alone
// tends to win by pushing labels out to the far reaches of a long line, scattered nowhere near
// where the eye is actually looking, rather than gently spread within the area of interest.
const LABEL_CENTER_BIAS = 0.05;
const LABEL_CENTER_RADIUS_FRACTION = 0.42;
function pickSpreadAnchor(line, chosenPositions, center) {
  const maxRadius = Math.min(width, height) * LABEL_CENTER_RADIUS_FRACTION;
  let best = null;
  let bestScore = -Infinity;
  let bestFallback = null;
  let bestFallbackScore = -Infinity;
  for (const segment of line.feature.coordinates) {
    for (const point of segment) {
      if (!isOnScreen(point)) continue;
      const p = projection(point);
      if (!p) continue;
      const centerDist = Math.hypot(p[0] - center[0], p[1] - center[1]);
      let score;
      if (chosenPositions.length === 0) {
        score = -centerDist;
      } else {
        let minDist = Infinity;
        for (const c of chosenPositions) {
          const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
          if (d < minDist) minDist = d;
        }
        score = minDist - centerDist * LABEL_CENTER_BIAS;
      }
      // Track the best in-zone candidate, and separately the best overall in case the line
      // never enters the zone (e.g. it only clips a far corner of the current view).
      if (score > bestFallbackScore) {
        bestFallbackScore = score;
        bestFallback = point;
      }
      if (centerDist <= maxRadius && score > bestScore) {
        bestScore = score;
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

  // Pass 1: keep any still-valid cached anchor as-is, registering its screen position so pass 2
  // can spread fresh picks away from it rather than ignoring where existing labels already sit.
  const anchorForLine = new Map();
  const chosenPositions = [];
  for (const line of astroLines) {
    const key = line.bodyId + ':' + line.kind;
    const cached = labelAnchors.get(key);
    if (cached && isOnScreen(cached)) {
      anchorForLine.set(key, cached);
      const p = projection(cached);
      if (p) chosenPositions.push(p);
    }
  }
  // Pass 2: everything else gets a fresh anchor, chosen to spread away from what pass 1 (and
  // each prior fresh pick this pass) already claimed.
  for (const line of astroLines) {
    const key = line.bodyId + ':' + line.kind;
    if (anchorForLine.has(key)) continue;
    const fresh = pickSpreadAnchor(line, chosenPositions, center);
    if (fresh) {
      anchorForLine.set(key, fresh);
      labelAnchors.set(key, fresh);
      const p = projection(fresh);
      if (p) chosenPositions.push(p);
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
  // layoutLabels doesn't reorder or drop entries, so placed[i] always corresponds to
  // candidates[i] — used below to recover each label's offset from its raw anchor projection.
  const placed = layoutLabels(candidates);
  renderedLabels = placed
    .map((label, i) =>
      label && {
        anchor: candidates[i].anchor,
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
  // Keep rendering through an in-progress label fade even when otherwise idle-still, so the
  // animation actually plays instead of jumping straight to full opacity on the next redraw.
  const fading = now - labelsFadeStartAt < LABEL_FADE_MS;
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
    render();
  } else if (pointers.size === 2 && pinchStart) {
    const [a, b] = Array.from(pointers.values());
    const dist = distanceBetween(a, b);
    if (pinchStart.distance > 0) {
      zoom = clamp((dist / pinchStart.distance) * pinchStart.zoom, MIN_ZOOM, MAX_ZOOM);
      applyScale();
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

  // Labels hold their positions during the drag/pinch itself; once every finger has lifted,
  // refresh them to match wherever the user ended up.
  if (pointers.size === 0) {
    recomputeLabels();
    render();
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function handleTap(x, y) {
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
