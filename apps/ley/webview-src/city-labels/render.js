// Draws from the current state store — position comes from re-projecting each label's (lon, lat)
// live every frame (cheap; bounded by however many labels are actually tracked, at most a couple
// dozen), opacity comes from stateMachine.opacityFor, font size comes from a continuous function
// of zoom instead of the old fixed 11px literal.

import { fontSizeForZoom } from './scoring.js';
import { opacityFor } from './stateMachine.js';

const CITY_LABEL_FONT_STYLE = "500";
const CITY_LABEL_FONT_FAMILY = "Georgia, 'Times New Roman', serif";
const CITY_DOT_RADIUS = 1.6;
const CITY_LABEL_OFFSET_X = 3;
const CITY_LABEL_OFFSET_Y = 0.5;
// A white halo behind each name keeps it legible over borders/coastlines/other labels crossing
// underneath, without needing a solid background pill.
const CITY_LABEL_OUTLINE_COLOR = '#FFFFFF';
const CITY_LABEL_OUTLINE_WIDTH = 3;

export function cityLabelFont(zoom) {
  return `${CITY_LABEL_FONT_STYLE} ${fontSizeForZoom(zoom)}px ${CITY_LABEL_FONT_FAMILY}`;
}

// isFrontFacing here is a caller-supplied (lon, lat) => boolean, not city-labels/geo.js's
// (lon, lat, lookLon, lookLat) form — keeps this module from needing to know about rotation at
// all, matching how globe-entry.js's own closures already work for every other layer it draws.
export function drawCityLabels(ctx, store, { projection, isFrontFacing, width, height, zoom, dotColor, textColor, now }) {
  if (store.size === 0) return;
  ctx.font = cityLabelFont(zoom);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const entry of store.values()) {
    const alpha = opacityFor(entry, now);
    if (alpha <= 0) continue;
    if (!isFrontFacing(entry.lon, entry.lat)) continue;
    const p = projection([entry.lon, entry.lat]);
    if (!p || p[0] < 0 || p[0] > width || p[1] < 0 || p[1] > height) continue;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(p[0], p[1], CITY_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = CITY_LABEL_OUTLINE_WIDTH;
    ctx.strokeStyle = CITY_LABEL_OUTLINE_COLOR;
    ctx.strokeText(entry.name, p[0] + CITY_LABEL_OFFSET_X, p[1] + CITY_LABEL_OFFSET_Y);
    ctx.fillStyle = textColor;
    ctx.fillText(entry.name, p[0] + CITY_LABEL_OFFSET_X, p[1] + CITY_LABEL_OFFSET_Y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
}
