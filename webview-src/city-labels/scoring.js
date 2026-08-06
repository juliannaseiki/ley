// Pure scoring functions — no state, no drawing, no knowledge of CITIES/the DOM/the projection.
// Everything here takes plain numbers and returns plain numbers so selection.js and tests can
// reason about it in isolation.

import { clamp } from './geo.js';

// Smooth eligibility instead of a hard `zoom > minZoom` cutoff. Below minZoom - CITY_SCORE_BAND,
// a city isn't a candidate at all (score 0). Between minZoom - band and minZoom + band, score
// ramps 0 -> 1 via smoothstep (eases at both ends, unlike a linear ramp which kinks where it meets
// the flat 0 and flat 1 regions). Above minZoom + band, score is fully 1 — further zooming past
// that point doesn't make an already-eligible city "more" eligible; selection.js still ranks
// eligible candidates against each other by raw minZoom (lower = bigger population = higher
// priority), which never changes with zoom, so ranking doesn't churn as the user keeps zooming in
// past two cities' thresholds.
//
// This score decides WHEN a city crosses from "not a candidate" to "a candidate" (and back), for
// selection.js to act on — it is NOT the opacity a viewer sees. The actual rendered alpha comes
// from a label's own elapsed-time fade in stateMachine.js. Wiring alpha directly to a zoom-derived
// value is what caused the earlier "label stuck part-faded if the user stops zooming mid-band" bug
// (fixed once already this session for the old hard-cutoff version); keeping this purely as a gate
// that triggers a time-based transition, rather than the animated value itself, avoids repeating
// it under the new smooth-score version.
export const CITY_SCORE_BAND = 0.6;

export function visibilityScore(minZoom, zoom) {
  const t = clamp((zoom - (minZoom - CITY_SCORE_BAND)) / (2 * CITY_SCORE_BAND), 0, 1);
  return t * t * (3 - 2 * t);
}

// Continuous font size, replacing the fixed 11px literal globe-entry.js used to draw every city
// label at — text visibly grows as the user zooms in rather than snapping between fixed sizes.
// Deliberately a function of zoom ALONE, not of any per-city value: every visible label grows
// together as you zoom in, the same way map tile labels do — population/minZoom already decides
// which cities are eligible at all, it doesn't need to also decide how big their text renders once
// they are.
//
// CITY_FONT_MIN_ZOOM mirrors CITY_BASE_MIN_ZOOM in selection.js/build-globe-html.mjs — kept as its
// own copy since it's tuning a visual detail (where text growth starts) that doesn't need to move
// in lockstep with the selection algorithm's own eligibility gate, even though they happen to
// start at the same zoom today.
const CITY_FONT_MIN_ZOOM = 2.8;
const CITY_FONT_MAX_ZOOM = 8;
const CITY_FONT_MIN_PX = 10;
const CITY_FONT_MAX_PX = 13;

export function fontSizeForZoom(zoom) {
  const t = clamp((zoom - CITY_FONT_MIN_ZOOM) / (CITY_FONT_MAX_ZOOM - CITY_FONT_MIN_ZOOM), 0, 1);
  const px = CITY_FONT_MIN_PX + t * (CITY_FONT_MAX_PX - CITY_FONT_MIN_PX);
  // Rounded to a tenth of a pixel — canvas ctx.font would happily take the full-precision value,
  // but there's no visible difference at this size and a tidy number is easier to spot-check.
  return Math.round(px * 10) / 10;
}
