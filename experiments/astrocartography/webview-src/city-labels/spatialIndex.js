// Runtime query side of the coarse lon/lat grid built at build time (see the `cityCells`
// construction in build-globe-html.mjs) — CITY_CELLS ("col,row" -> array of indices into CITIES)
// and CITY_CELL_SIZE_DEG are injected as globals, same pattern as CITIES/THEME/etc.
/* global CITY_CELLS, CITY_CELL_SIZE_DEG */

import { angularDistanceDeg } from './geo.js';

// Cells are iterated directly rather than derived from lookLon/lookLat with a bounding box in
// lon/lat space — degrees of longitude compress toward the poles, so a naive box test would
// under-include near the equator or over-include near a pole depending on how it's sized. Real
// great-circle distance from each candidate cell's center is correct at any latitude, and with
// only 360/CITY_CELL_SIZE_DEG * 180/CITY_CELL_SIZE_DEG cells total (648 at a 10° grid), checking
// every cell's distance is still far cheaper than scanning all 170k+ cities directly — this is the
// whole point of having the grid.
const COLS = 360 / CITY_CELL_SIZE_DEG;
const ROWS = 180 / CITY_CELL_SIZE_DEG;

// Half of a cell's diagonal, in degrees — a city near a cell's corner (not its center) is up to
// this much farther from the look-at point than the center-to-center distance says, so this has
// to be added as margin before comparing against radiusDeg. A false negative here (silently
// skipping a cell that actually has a visible city in it) is a real bug — a missing label with no
// visible cause — so this is a genuine geometric bound, not just a tunable safety margin like
// CULL_MARGIN_DEG elsewhere.
const CELL_DIAGONAL_MARGIN_DEG = (CITY_CELL_SIZE_DEG * Math.SQRT2) / 2;

// Returns indices into CITIES for every city in a cell that could plausibly fall within
// radiusDeg of (lookLon, lookLat). Over-includes at the margins (that's the point of the margin
// above) — callers still need their own real eligibility/visibility check on each candidate, this
// is a coarse pre-filter, not the final answer.
export function queryNear(lookLon, lookLat, radiusDeg) {
  const indices = [];
  // At radiusDeg >= 180 nothing can be excluded — walking every listed cell directly (rather than
  // computing distances just to have them all pass anyway) is both simpler and cheaper.
  if (radiusDeg >= 180) {
    for (const key in CITY_CELLS) {
      const bucket = CITY_CELLS[key];
      for (let i = 0; i < bucket.length; i++) indices.push(bucket[i]);
    }
    return indices;
  }
  for (let col = 0; col < COLS; col++) {
    const cellLon = col * CITY_CELL_SIZE_DEG - 180 + CITY_CELL_SIZE_DEG / 2;
    for (let row = 0; row < ROWS; row++) {
      const key = col + ',' + row;
      const bucket = CITY_CELLS[key];
      if (!bucket) continue; // no cities in this cell at all (open ocean, etc.)
      const cellLat = row * CITY_CELL_SIZE_DEG - 90 + CITY_CELL_SIZE_DEG / 2;
      const dist = angularDistanceDeg(cellLon, cellLat, lookLon, lookLat);
      if (dist - CELL_DIAGONAL_MARGIN_DEG > radiusDeg) continue;
      for (let i = 0; i < bucket.length; i++) indices.push(bucket[i]);
    }
  }
  return indices;
}
