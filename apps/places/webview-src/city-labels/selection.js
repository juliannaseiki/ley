// The core selection algorithm: given the current view and what's already showing, decide what
// the new "should be visible" set of city labels is — purely a question of WHO should be visible.
// WHEN/HOW that visibility change animates is entirely stateMachine.js's concern now: this module
// has no notion of time at all (no `now`, no fade timestamps), it just returns the winning set for
// this pass. stateMachine.js's applySelection() is what diffs this against what's currently on
// screen and decides which labels start fading in or out.
//
// One intentional behavior change versus the pre-refactor version: eligibility now comes from
// scoring.js's smooth visibilityScore instead of a hard `zoom > minZoom` cutoff, so a city can
// become a real candidate slightly before the old hard threshold (see scoring.js for why that's
// still just a gate, not the rendered opacity).

import { queryNear } from './spatialIndex.js';
import { visibilityScore } from './scoring.js';
import { isFrontFacing, visibleCapRadiusDeg, clamp } from './geo.js';

export const CITY_MAX_LABELS = 12;
// Screen-fixed grid used for spatial fairness among fresh candidates — coarse enough that a real
// region (a state, a metro area) reliably lands in its own cell or two, fine enough that two
// genuinely distant areas sharing a screen don't get lumped into one.
export const CITY_GRID_COLS = 4;
export const CITY_GRID_ROWS = 6;
// Margin below a city's own reveal threshold that zoom has to actually cross before an
// already-shown city drops for that reason, so a sub-threshold zoom wobble mid-gesture doesn't
// read as random flicker.
export const CITY_RETAIN_HYSTERESIS = 0.4;
// The lowest minZoom in the whole dataset (the single biggest city on Earth) — used to gate the
// fallback pass below so it doesn't start hunting for sub-threshold candidates before cities are
// showing at all. Must stay numerically in sync with CITY_BASE_MIN_ZOOM in build-globe-html.mjs
// (which derives every city's own minZoom from population) — same cross-file constant this
// codebase already keeps in a couple of places, not a new kind of duplication.
export const CITY_BASE_MIN_ZOOM = 3;
// Fixed to lon/lat, not screen position — see the comment above the fallback loop below for why
// the fallback winner specifically needs a rotation-stable cell, unlike the screen-fixed
// CITY_GRID_COLS/ROWS used for breadth fairness. Deliberately its own constant rather than reusing
// CITY_CELL_SIZE_DEG (the spatial index's build-time grid, injected as a global) — that grid is
// sized for query performance, this one for fairness granularity, and there's no reason those two
// concerns should have to move together just because they happen to coincide today.
const FALLBACK_GEO_CELL_SIZE_DEG = 8;

function isOnScreen(p, width, height) {
  return !!p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height;
}

// A plain on-screen check has zero margin, same problem CITY_RETAIN_HYSTERESIS already solves for
// the zoom boundary: a retained label sitting right at the screen edge can wobble in and out of
// the exact rectangle from step to step as projection distortion near the limb amplifies small
// rotation deltas — most pronounced at a deep zoom, where the visible area is a small angular
// slice and edge effects are proportionally larger. Applied only to retained labels below, not to
// fresh candidates — a brand-new label still has to be genuinely on screen to be picked at all,
// this only stops an already-shown one from being dropped over a few pixels of edge wobble.
const CITY_RETAIN_SCREEN_MARGIN_PX = 60;
function isOnScreenWithMargin(p, width, height, margin) {
  return !!p && p[0] >= -margin && p[0] <= width + margin && p[1] >= -margin && p[1] <= height + margin;
}

export function selectCityLabels({
  cities,
  previouslyVisible,
  zoom,
  rotation,
  projection,
  width,
  height,
  baseScale,
  measureTextWidth,
}) {
  const lookLon = -rotation[0];
  const lookLat = -rotation[1];

  function cellKeyOf(x, y) {
    const col = clamp(Math.floor((x / width) * CITY_GRID_COLS), 0, CITY_GRID_COLS - 1);
    const row = clamp(Math.floor((y / height) * CITY_GRID_ROWS), 0, CITY_GRID_ROWS - 1);
    return col + ',' + row;
  }

  // Retained: cities already showing that are still eligible to keep their spot. Sorted most
  // important first (lowest minZoom) so the cap slice below keeps the biggest places when there
  // are more retained cities than room allows. `previouslyVisible` is whatever the caller is
  // currently tracking (visible, fading in, or fading out) — passing fading-out entries through
  // too lets one un-drop smoothly (stateMachine.js resumes its fade rather than popping) if it
  // still qualifies by the time the next selection runs.
  const retained = [];
  const retainedIndices = new Set();
  for (const c of previouslyVisible) {
    if (zoom <= c.minZoom - CITY_RETAIN_HYSTERESIS) continue;
    if (!isFrontFacing(c.lon, c.lat, lookLon, lookLat)) continue;
    const p = projection([c.lon, c.lat]);
    if (!isOnScreenWithMargin(p, width, height, CITY_RETAIN_SCREEN_MARGIN_PX)) continue;
    retained.push({ index: c.index, name: c.name, lon: c.lon, lat: c.lat, minZoom: c.minZoom, x: p[0], y: p[1] });
    retainedIndices.add(c.index);
  }
  retained.sort((a, b) => a.minZoom - b.minZoom);

  const placed = [];
  function tryPlace(c) {
    if (placed.length >= CITY_MAX_LABELS) return false;
    const textWidth = measureTextWidth(c.name);
    const left = c.x - 4;
    const right = c.x + 5 + textWidth + 10;
    const top = c.y - 9;
    const bottom = c.y + 9;
    const collides = placed.some((p) => !(right < p.left || left > p.right || bottom < p.top || top > p.bottom));
    if (collides) return false;
    placed.push({ index: c.index, name: c.name, lon: c.lon, lat: c.lat, minZoom: c.minZoom, left, right, top, bottom });
    return true;
  }

  // Already-shown labels get first claim on a slot, most-significant-first (retained is already
  // sorted by minZoom above) — and DO collision-check against each other via the same tryPlace
  // used for everything else. This used to be an unconditional push with no collision check at
  // all, to fix a specific bug where rotating the globe could let a completely unrelated FRESH
  // candidate bump an already-shown label for no good reason. But it went too far: with retained
  // labels never checking collision against each other either, zooming OUT — which compresses
  // every point's screen position toward the center, unlike rotation, which mostly just moves
  // things around — could bring two already-shown labels close enough to genuinely overlap, with
  // nothing to stop it. tryPlace's significance-first order means that when two retained labels
  // do end up overlapping, the bigger place wins and the smaller one eases out through the normal
  // fade — a deserved outcome, not an arbitrary one — and fresh candidates below still can't bump
  // a retained label, since every retained label gets its turn before any fresh one is considered.
  const keptRetained = retained.slice(0, CITY_MAX_LABELS);
  const cellsFulfilled = new Set();
  for (const c of keptRetained) {
    if (tryPlace(c)) cellsFulfilled.add(cellKeyOf(c.x, c.y));
  }

  // One pass over just what's near the current view (via the spatial index) instead of two
  // brute-force scans over all of `cities` — splits into real candidates (score > 0) and
  // fallback-eligible ones (score === 0 but still genuinely on screen) as it goes, since the two
  // are mutually exclusive and neither depends on the other having been collected first.
  const capRadiusDeg = visibleCapRadiusDeg(width, height, baseScale, zoom);
  const nearbyIndices = queryNear(lookLon, lookLat, capRadiusDeg);
  const includeFallback = zoom > CITY_BASE_MIN_ZOOM;

  // A fallback pick's own minZoom sits below current zoom by definition (that's what makes it
  // fallback, not a real candidate) — often by a lot, for a small enough town, which means it can
  // NEVER pass the retained-eligibility check above (that check requires clearing minZoom within
  // CITY_RETAIN_HYSTERESIS, and a fallback pick is by construction further from its own threshold
  // than that). So a fallback pick has no persistence via the normal retained path at all — every
  // recompute re-decides its cell's winner from scratch. That was harmless when recomputes only
  // happened once per gesture (whatever won just stayed until the next gesture), but once
  // recomputes happen several times per gesture (see maybeRecomputeCityLabelsDuringGesture in
  // globe-entry.js), the actual bug shows up: fallback winners were being decided per SCREEN cell,
  // and a screen cell's geographic footprint shifts as the globe rotates — so the exact same two
  // remote, roughly-tied towns can trade a cell back and forth purely because the screen-space grid
  // moved under them, not because either town's own relevance changed. (A tried fix — giving a
  // previously-shown pick a fixed head start — turned out to be whack-a-mole: it just changed
  // *which* town flickered, and could even displace a genuinely-still-winning neighbor instead.)
  //
  // The actual fix: decide each fallback WINNER per geographic cell (fixed to lon/lat, immune to
  // rotation) instead of per screen cell, then place that winner into whichever screen cell it
  // currently projects into for the breadth-fairness competition below. A given remote town's
  // geographic cell never changes, so it keeps winning against the exact same neighbors regardless
  // of how the view has rotated — it only loses if a genuinely better candidate shows up in the
  // same patch of geography, which is a deserved change, not rotation noise.
  const geoCellKeyOf = (lon, lat) => {
    const col = Math.floor((lon + 180) / FALLBACK_GEO_CELL_SIZE_DEG);
    const row = Math.floor((lat + 90) / FALLBACK_GEO_CELL_SIZE_DEG);
    return col + ',' + row;
  };

  const cellBuckets = new Map();
  const fallbackBest = new Map(); // keyed by geo cell, not screen cell
  for (const index of nearbyIndices) {
    if (retainedIndices.has(index)) continue;
    const [name, lon, lat, minZoom] = cities[index];
    if (!isFrontFacing(lon, lat, lookLon, lookLat)) continue;
    const p = projection([lon, lat]);
    if (!isOnScreen(p, width, height)) continue;
    if (visibilityScore(minZoom, zoom) > 0) {
      const key = cellKeyOf(p[0], p[1]);
      if (!cellBuckets.has(key)) cellBuckets.set(key, []);
      cellBuckets.get(key).push({ index, name, lon, lat, minZoom, x: p[0], y: p[1] });
    } else if (includeFallback) {
      // Vermont-style fallback: a cell with no real candidate deserves a shot too, once the user
      // is zoomed in past the point cities show at all — global population is the wrong yardstick
      // for "does this specific visible area deserve a label right now."
      const geoKey = geoCellKeyOf(lon, lat);
      const existing = fallbackBest.get(geoKey);
      if (!existing || minZoom < existing.minZoom) {
        fallbackBest.set(geoKey, { index, name, lon, lat, minZoom, x: p[0], y: p[1] });
      }
    }
  }
  for (const [, c] of fallbackBest) {
    const screenKey = cellKeyOf(c.x, c.y);
    if (cellsFulfilled.has(screenKey) || cellBuckets.has(screenKey)) continue;
    cellBuckets.set(screenKey, [c]);
  }

  const buckets = [...cellBuckets.entries()];
  for (const [, bucket] of buckets) bucket.sort((a, b) => a.minZoom - b.minZoom);

  // Round 1 (breadth): every occupied cell gets a shot at its single best pick before any cell
  // gets a second (round 2 below) — capped, but prioritized by minZoom so a cutoff (when there
  // are more occupied cells than room) drops the objectively weaker candidates first, not
  // whichever cell happened to be enumerated first.
  const roundOnePicks = buckets
    .filter(([, bucket]) => bucket.length > 0)
    .map(([key, bucket]) => ({ key, bucket, item: bucket[0] }))
    .sort((a, b) => a.item.minZoom - b.item.minZoom);
  for (const { bucket, item } of roundOnePicks) {
    bucket.shift();
    tryPlace(item);
  }

  // Round 2+ (depth): a cell dense enough to have more than one real candidate can add more, up
  // to the cap — this is the cap doing its actual job, limiting how much any one busy area piles
  // on top of the one-per-area guarantee above.
  let remaining = 0;
  for (const [, bucket] of buckets) remaining += bucket.length;
  let bucketIndex = 0;
  while (remaining > 0 && placed.length < CITY_MAX_LABELS && buckets.length > 0) {
    const [, bucket] = buckets[bucketIndex % buckets.length];
    bucketIndex++;
    if (bucket.length > 0) {
      tryPlace(bucket.shift());
      remaining--;
    }
  }

  return placed.map((c) => ({ index: c.index, name: c.name, lon: c.lon, lat: c.lat, minZoom: c.minZoom }));
}
