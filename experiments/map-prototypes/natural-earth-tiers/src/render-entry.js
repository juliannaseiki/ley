// Canvas 2D orthographic-globe renderer for eyeballing the three-tier Natural Earth LOD setup.
// Bundled by scripts/build.mjs into dist/index.html alongside the data (window.TIERS,
// window.LOD_BREAKPOINTS) it reads. Deliberately standalone — no shared code with
// apps/places/webview-src/globe-entry.js, since this is meant to be thrown away or hand-ported
// once the approach is validated, not maintained in parallel with the real renderer.
import { geoOrthographic, geoPath, geoGraticule10 } from 'd3-geo';

const TIERS = window.TIERS;
const LOD_BREAKPOINTS = { ...window.LOD_BREAKPOINTS };

const MIN_ZOOM = 1;
const MAX_ZOOM = 40;

const canvas = document.getElementById('globe');
const ctx = canvas.getContext('2d');

let width = 0;
let height = 0;
let baseScale = 0;
const projection = geoOrthographic().clipAngle(90);
const geoPathGen = geoPath(projection, ctx);
const graticule = geoGraticule10();

function resize() {
  const dpr = window.devicePixelRatio || 1;
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  baseScale = Math.min(width, height) * 0.45;
  projection.translate([width / 2, height / 2]).scale(baseScale * zoom);
  render();
}

let zoom = 2.2; // default view: whole globe comfortably visible with some room to zoom in immediately
let rotation = [0, -20, 0];
projection.rotate(rotation);

function angularDistanceDeg(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const dPhi = (lat2 - lat1) * toRad;
  const dLambda = (lon2 - lon1) * toRad;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 180) / Math.PI;
}

// Cheap per-piece visibility test so a rotation doesn't have to project every ring in the active
// tier (up to ~4,300 pieces at 10m) just to find out most of them are on the far side of the
// globe. Not exact — a generous margin trades a little unnecessary drawing for never wrongly
// hiding a piece near the limb.
function bboxVisible(bbox) {
  if (!bbox) return true;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const midLon = (minLon + maxLon) / 2;
  const midLat = (minLat + maxLat) / 2;
  const halfSpan = Math.max(maxLon - minLon, maxLat - minLat) / 2;
  const viewLon = -rotation[0];
  const viewLat = -rotation[1];
  const d = angularDistanceDeg(midLon, midLat, viewLon, viewLat);
  return d < 90 + halfSpan + 3;
}

function tierForZoom(z) {
  if (z < LOD_BREAKPOINTS.toMid) return '110m';
  if (z < LOD_BREAKPOINTS.toFine) return '50m';
  return '10m';
}

function render() {
  const tierName = tierForZoom(zoom);
  const tier = TIERS[tierName];
  const [cx, cy] = projection.translate();
  const r = projection.scale();

  ctx.clearRect(0, 0, width, height);

  // Ocean
  ctx.fillStyle = '#0f1b2d';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fill();

  // Graticule (faint, just for orientation reference while eyeballing)
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  geoPathGen(graticule);
  ctx.stroke();

  const visibleLand = tier.landPieces.filter((_, i) => bboxVisible(tier.landBboxes[i]));
  const visibleBorders = tier.borderArcs.filter((_, i) => bboxVisible(tier.borderBboxes[i]));

  // Land fill
  ctx.fillStyle = '#334155';
  ctx.beginPath();
  for (const piece of visibleLand) geoPathGen({ type: 'Polygon', coordinates: piece });
  ctx.fill();

  // Coastline / continent outline — heavier weight, per the line-weight hierarchy this prototype
  // is testing.
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const piece of visibleLand) geoPathGen({ type: 'Polygon', coordinates: piece });
  ctx.stroke();

  // Country borders — lighter weight.
  ctx.lineWidth = 0.4;
  ctx.strokeStyle = '#94a3b8';
  ctx.beginPath();
  for (const arc of visibleBorders) geoPathGen({ type: 'LineString', coordinates: arc });
  ctx.stroke();

  // Globe limb
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.stroke();

  zoomVal.textContent = zoom.toFixed(2);
  tierVal.textContent = `${tierName}  (${visibleLand.length}/${tier.landPieces.length} land, ${visibleBorders.length}/${tier.borderArcs.length} border pieces drawn)`;
}

// --- Pointer input: drag to rotate, wheel/pinch to zoom ---
const activePointers = new Map();
let dragStart = null; // { x, y, rotation }
let pinchStart = null; // { dist, zoom }

function pointerDistance() {
  const pts = [...activePointers.values()];
  const dx = pts[0].x - pts[1].x;
  const dy = pts[0].y - pts[1].y;
  return Math.hypot(dx, dy);
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 1) {
    dragStart = { x: e.clientX, y: e.clientY, rotation: [...rotation] };
  } else if (activePointers.size === 2) {
    dragStart = null;
    pinchStart = { dist: pointerDistance(), zoom };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2 && pinchStart) {
    const ratio = pointerDistance() / pinchStart.dist;
    setZoom(pinchStart.zoom * ratio);
    return;
  }

  if (activePointers.size === 1 && dragStart) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    // Orthographic projection: the globe's limb sits 90° of arc out at radius `r` pixels from
    // center, so 90/r is a reasonable constant-feeling degrees-per-pixel drag rate at any zoom
    // (exact right at the center, mildly optimistic near the limb — fine for interaction feel).
    const r = baseScale * zoom;
    const degPerPixel = 90 / r;
    const lambda = dragStart.rotation[0] + dx * degPerPixel;
    const phi = Math.max(-90, Math.min(90, dragStart.rotation[1] - dy * degPerPixel));
    rotation = [lambda, phi, 0];
    projection.rotate(rotation);
    render();
  }
});

function endPointer(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinchStart = null;
  if (activePointers.size === 1) {
    const [remaining] = activePointers.values();
    dragStart = { x: remaining.x, y: remaining.y, rotation: [...rotation] };
  } else if (activePointers.size === 0) {
    dragStart = null;
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function setZoom(z) {
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  projection.scale(baseScale * zoom);
  render();
}

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.001);
    setZoom(zoom * factor);
  },
  { passive: false }
);

// --- HUD: live-tunable LOD breakpoints ---
const zoomVal = document.getElementById('zoomVal');
const tierVal = document.getElementById('tierVal');
const bp50 = document.getElementById('bp50');
const bp10 = document.getElementById('bp10');
const bp50Val = document.getElementById('bp50Val');
const bp10Val = document.getElementById('bp10Val');

bp50.value = LOD_BREAKPOINTS.toMid;
bp10.value = LOD_BREAKPOINTS.toFine;
bp50Val.textContent = LOD_BREAKPOINTS.toMid;
bp10Val.textContent = LOD_BREAKPOINTS.toFine;

bp50.addEventListener('input', () => {
  LOD_BREAKPOINTS.toMid = Math.min(parseFloat(bp50.value), LOD_BREAKPOINTS.toFine - 0.1);
  bp50Val.textContent = LOD_BREAKPOINTS.toMid.toFixed(1);
  render();
});
bp10.addEventListener('input', () => {
  LOD_BREAKPOINTS.toFine = Math.max(parseFloat(bp10.value), LOD_BREAKPOINTS.toMid + 0.1);
  bp10Val.textContent = LOD_BREAKPOINTS.toFine.toFixed(1);
  render();
});

window.addEventListener('resize', resize);
resize();
