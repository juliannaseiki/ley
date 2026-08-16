// A real per-label state machine — hidden -> fadingIn -> visible -> fadingOut -> hidden — replacing
// the old two-array (cityLabels with a one-way fadeStartAt, fadingOutCityLabels with a separate
// fadeOutStartAt) bookkeeping. One Map entry per label, keyed by its stable CITIES index, carrying
// its own phase and when that phase started; opacity is always derived from elapsed time against
// that single timestamp (see opacityFor), never restamped just because a selection pass happened
// to run again — that's what makes an already-visible label immune to popping when nothing about
// its own relevance changed.
//
// "hidden" is a transient value returned by opacityFor/phaseOf for a label that's not tracked at
// all — a completed fade-out deletes the entry outright (see advance) rather than leaving a
// permanent "hidden" entry sitting in the map forever.

import { visibilityScore } from './scoring.js';

export const CITY_LABEL_FADE_MS = 250;

export function createLabelStateStore() {
  return new Map(); // index -> { phase: 'fadingIn' | 'visible' | 'fadingOut', phaseStartedAt, name, lon, lat, minZoom }
}

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// 0 (not yet visible) -> 1 (fully visible) -> 0 (fully faded out), purely a function of the
// entry's own phase and how long it's been in that phase — never reset by an unrelated selection
// pass, never tied directly to zoom (see scoring.js's visibilityScore for why: a value that could
// get stuck part-way whenever the user stops zooming inside its band is exactly the bug this
// whole state machine exists to avoid).
export function opacityFor(entry, now) {
  if (!entry) return 0;
  const t = clamp01((now - entry.phaseStartedAt) / CITY_LABEL_FADE_MS);
  if (entry.phase === 'fadingIn') return t;
  if (entry.phase === 'fadingOut') return 1 - t;
  return 1; // 'visible'
}

// Diffs the latest "who should be visible" result (from selection.js) against the current store
// and starts new transitions — this is the only place a label's phaseStartedAt gets set to `now`,
// and only when its visibility is actually changing, so a label that was already fadingIn/visible
// last time selection ran and still is now is left completely untouched.
export function applySelection(store, selected, now) {
  const selectedByIndex = new Map(selected.map((c) => [c.index, c]));

  for (const [index, c] of selectedByIndex) {
    const existing = store.get(index);
    if (!existing) {
      store.set(index, { phase: 'fadingIn', phaseStartedAt: now, name: c.name, lon: c.lon, lat: c.lat, minZoom: c.minZoom });
    } else if (existing.phase === 'fadingOut') {
      // Resume from wherever its fade-out currently is, rather than snapping back to fully
      // invisible and re-fading from zero — a real, if narrow, case: dropped for being over the
      // cap in one selection pass, still mid fade-out when a later pass (e.g. the cap freeing up)
      // picks it again. Backdating phaseStartedAt so opacityFor's elapsed-time math already
      // equals the current fade-out opacity is what makes the fade continue smoothly instead of
      // popping.
      const currentOpacity = opacityFor(existing, now);
      existing.phase = 'fadingIn';
      existing.phaseStartedAt = now - currentOpacity * CITY_LABEL_FADE_MS;
      existing.name = c.name;
      existing.lon = c.lon;
      existing.lat = c.lat;
      existing.minZoom = c.minZoom;
    } else {
      // Already fadingIn or visible — refresh geo data (shouldn't meaningfully change) without
      // touching phase/phaseStartedAt at all.
      existing.name = c.name;
      existing.lon = c.lon;
      existing.lat = c.lat;
      existing.minZoom = c.minZoom;
    }
  }

  for (const [index, entry] of store) {
    if (selectedByIndex.has(index)) continue;
    if (entry.phase === 'fadingOut') continue; // already on its way out
    entry.phase = 'fadingOut';
    entry.phaseStartedAt = now;
  }
}

// Starts a fade-out for anything that's crossed back below its own zoom threshold, live, every
// frame — not just when a new selection pass happens to run. Without this, a label picked at a
// deep zoom stays at full opacity for the rest of an active zoom-out gesture (selection only runs
// at gesture end today), only clearing once the user lifts their finger.
//
// Skips anything that isn't currently a real (score > 0) candidate — a fallback-tier pick (see
// selection.js) is selected precisely BECAUSE zoom is nowhere near its own minZoom, often by
// several zoom units at a sparse enough spot (a small Arctic town might only need to be the best
// available option in an otherwise-empty screen area, not actually past its own threshold at all).
// That gap is always bigger than `hysteresis`, so without this check every fallback label would
// fail it on the very next frame after being selected — a real label flashing in and immediately
// fading back out, for no reason the user did. A fallback pick's own minZoom was never a
// meaningful "drop point" for it to begin with; it only leaves when the next recompute decides
// something else deserves its spot, or it's no longer genuinely on screen — not from this live
// per-frame check.
export function dropStaleByZoom(store, zoom, hysteresis, now) {
  for (const [, entry] of store) {
    if (entry.phase === 'fadingOut') continue;
    if (visibilityScore(entry.minZoom, zoom) <= 0) continue;
    if (zoom <= entry.minZoom - hysteresis) {
      entry.phase = 'fadingOut';
      entry.phaseStartedAt = now;
    }
  }
}

// Advances every tracked label's animation by elapsed time — called every frame, unconditionally,
// regardless of whether a new selection just ran. This is what actually turns a phase transition
// into a played-out animation rather than an instant jump: fadingIn completes into visible,
// fadingOut completes by being deleted outright (no lingering "hidden" entries).
export function advance(store, now) {
  for (const [index, entry] of store) {
    if (entry.phase === 'fadingIn' && now - entry.phaseStartedAt >= CITY_LABEL_FADE_MS) {
      entry.phase = 'visible';
    } else if (entry.phase === 'fadingOut' && now - entry.phaseStartedAt >= CITY_LABEL_FADE_MS) {
      store.delete(index);
    }
  }
}
