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
  // layout. Staggered vertically so nearby labels don't overlap.
  //
  // The glyph and the "MC"/"IC"/etc. text are measured and drawn as two separate pieces rather
  // than one string: the astrological glyphs render in a different fallback font than the Latin
  // text, and that font's own idea of vertical center rarely matches — no shared textBaseline
  // setting fixes that, since it's a font-metric mismatch, not a baseline one. Measuring each
  // piece's actual rendered bounding box and aligning their visual centers works regardless of
  // which font actually renders the glyph.
  if (zoom > MIN_ZOOM) {
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const GLYPH_KIND_GAP = 3;
    const candidates = [];
    for (const line of astroLines) {
      if (!line.anchor || !isFrontFacing(line.anchor)) continue;
      const p = projection(line.anchor);
      if (!p) continue;
      const glyph = BODY_GLYPHS[line.bodyId] || line.bodyId;
      const kind = line.kind;
      const glyphMetrics = ctx.measureText(glyph);
      const kindMetrics = ctx.measureText(kind);
      const width = glyphMetrics.width + GLYPH_KIND_GAP + kindMetrics.width;
      candidates.push({
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
        width,
      });
    }
    for (const label of layoutLabels(candidates)) {
      const startX = label.x - label.width / 2;
      const glyphX = startX;
      const glyphY = label.y + label.glyphBaselineShift;
      const kindX = startX + label.glyphWidth + GLYPH_KIND_GAP;

      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(label.glyph, glyphX, glyphY);
      ctx.strokeText(label.kind, kindX, label.y);
      ctx.fillStyle = label.color;
      ctx.fillText(label.glyph, glyphX, glyphY);
      ctx.fillText(label.kind, kindX, label.y);
    }
    ctx.textAlign = 'center';
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
function layoutLabels(candidates) {
  const lineHeight = 13;
  const paddingX = 4;
  // Bounds in a font's own metrics for the alphabetic baseline (ascent above, descent below).
  const ascent = 9;
  const descent = 3;
  // Cap how far a label can be nudged away from its true anchor — better to accept some overlap
  // in a dense cluster than to let a long collision chain fling a label off-screen.
  const maxAttempts = 6;
  const placed = [];
  for (const c of candidates) {
    let y = c.y - 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const left = c.x - c.width / 2 - paddingX;
      const right = c.x + c.width / 2 + paddingX;
      const top = y - ascent;
      const bottom = y + descent;
      const collides = placed.some((p) => !(right < p.left || left > p.right || bottom < p.top || top > p.bottom));
      if (!collides) break;
      y -= lineHeight;
    }
    placed.push({
      x: c.x,
      y,
      glyph: c.glyph,
      kind: c.kind,
      glyphWidth: c.glyphWidth,
      glyphBaselineShift: c.glyphBaselineShift,
      width: c.width,
      color: c.color,
      left: c.x - c.width / 2 - paddingX,
      right: c.x + c.width / 2 + paddingX,
      top: y - ascent,
      bottom: y + descent,
    });
  }
  return placed;
}

// Picks the point closest to the equator along a line's segments as its label anchor —
// astrocartography lines run pole-to-pole, so this keeps labels off the crowded polar caps.
function findLabelAnchor(segments) {
  let best = null;
  let bestAbsLat = Infinity;
  for (const segment of segments) {
    for (const point of segment) {
      const absLat = Math.abs(point[1]);
      if (absLat < bestAbsLat) {
        bestAbsLat = absLat;
        best = point;
      }
    }
  }
  return best;
}

function tick(now) {
  if (lastFrameAt === null) lastFrameAt = now;
  const dt = now - lastFrameAt;
  lastFrameAt = now;

  const idle = pointers.size === 0 && now - lastInteractionAt > IDLE_DELAY_MS && zoom === MIN_ZOOM && !pin;
  if (idle) {
    rotation[0] += AUTO_ROTATE_DEG_PER_MS * dt;
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
      anchor: findLabelAnchor(line.segments),
    }));
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
